import 'server-only';

import { load } from 'cheerio';
import { decodeText, fetchBounded, UpstreamHttpError } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_ENDPOINT = 'https://mydeliveries.paack.app/tracking/order';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS = 100;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
  description: string;
}

export class PaackTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Paack could not locate the shipment');
    this.name = 'PaackTrackingError';
  }
}

function statusKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '')
    : '';
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function classifyEvent(value: JsonObject): ClassifiedStatus {
  const key = `${statusKey(value.label)} ${statusKey(value.id)}`;
  if (includesAny(key, [
    'returnedsender',
    'returnedtosender',
    'returnedtoretailer',
  ])) {
    return { status: 'exception', stage: 'returned', description: 'Shipment returned' };
  }
  if (includesAny(key, [
    'returntosenderscheduled',
    'returnabsent',
    'returnother',
    'incorrectaddress',
    'absent',
    'attempted',
    'deliveryfailed',
    'failedattempt',
    'notdelivered',
    'undelivered',
    'notaccepted',
    'rejected',
    'damaged',
    'lost',
    'nondeliverable',
    'integrationerror',
    'cancelled',
    'canceled',
  ])) return { status: 'exception', stage: 'failed_attempt', description: 'Delivery issue' };
  if (includesAny(key, ['delivered', 'deliverycompleted'])) {
    return { status: 'delivered', stage: 'delivered', description: 'Delivered' };
  }
  if (includesAny(key, ['readyforpickup', 'atpickuppoint'])) {
    return { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup' };
  }
  if (includesAny(key, ['outfordelivery', 'driverassigned', 'inprogress'])) {
    return {
      status: 'out_for_delivery',
      stage: 'out_for_delivery',
      description: 'Out for delivery',
    };
  }
  if (includesAny(key, [
    'manifested',
    'created',
    'notreceivedfromretailer',
    'additionaldeliveryattemptscheduled',
    'orderreactivated',
    'appointmentbroughtforward',
    'appointmentrescheduled',
    'appointmentscheduled',
  ])) return { status: 'pending', stage: 'registered', description: 'Shipment registered' };
  if (includesAny(key, ['scannedatorigin'])) {
    return { status: 'in_transit', stage: 'accepted', description: 'Shipment accepted' };
  }
  if (includesAny(key, [
    'received',
    'collected',
    'transit',
    'hub',
    'warehouse',
    'sorted',
    'pudoassigned',
  ])) {
    return { status: 'in_transit', stage: 'in_transit', description: 'In transit' };
  }
  return { status: 'unknown', stage: 'in_transit', description: 'Shipment update' };
}

function normalizedTimestamp(value: unknown): { iso: string; timestamp: number } | null {
  let timestamp: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    timestamp = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    timestamp = Date.parse(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), timestamp: date.getTime() };
}

function normalizedDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const candidate = value.trim();
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(candidate);
    if (match && !Number.isNaN(Date.parse(candidate))) return match[1];
  }
  return normalizedTimestamp(value)?.iso.slice(0, 10) ?? null;
}

function routeData(payload: unknown): JsonObject {
  if (!isRecord(payload)) throw new TypeError('Paack returned an invalid tracking response');
  if (isRecord(payload.orderTrackData)) return payload;
  const state = payload.state;
  if (!isRecord(state) || !isRecord(state.loaderData)) {
    throw new TypeError('Paack returned incomplete tracking details');
  }
  const route = state.loaderData['routes/tracking.order'];
  if (!isRecord(route)) throw new TypeError('Paack returned incomplete tracking details');
  return route;
}

function errorText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  return [payload.error, payload.message, payload.statusText]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function remixContext(html: string): unknown {
  const $ = load(html);
  let serialized = '';
  $('script').each((_, element) => {
    if (serialized) return;
    const script = $(element).html() ?? '';
    const marker = 'window.__remixContext';
    const markerIndex = script.indexOf(marker);
    if (markerIndex < 0) return;
    const equalsIndex = script.indexOf('=', markerIndex + marker.length);
    if (equalsIndex < 0) return;
    serialized = script.slice(equalsIndex + 1).trim().replace(/;\s*$/, '');
  });
  if (!serialized) throw new TypeError('Paack did not return tracking details');
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new TypeError('Paack returned an invalid tracking response', { cause: error });
  }
}

export function normalizePaackTrackingNumber(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US').replace(/\s/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{4,40}$/.test(value)) {
    throw new TypeError(
      'Paack tracking numbers must contain 4 to 40 ASCII letters and digits, including at least one digit',
    );
  }
  return value;
}

export function normalizePaackPostcode(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US');
  if (!/^(?=.{3,10}$)(?=.*\d)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/.test(value)) {
    throw new TypeError(
      'Paack tracking requires a 3- to 10-character alphanumeric delivery postcode',
    );
  }
  return value.replace(/\s+/g, '');
}

export function paackTrackingUrl(rawTrackingNumber: string, rawPostcode: string): string {
  const trackingNumber = normalizePaackTrackingNumber(rawTrackingNumber);
  const postcode = normalizePaackPostcode(rawPostcode);
  const url = new URL(TRACKING_ENDPOINT);
  url.searchParams.set('tracking_number', trackingNumber);
  url.searchParams.set('postal_code', postcode);
  return url.toString();
}

export function parsePaackTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizePaackTrackingNumber(rawTrackingNumber);
  if (/order not found|incorrect order number|commande introuvable|pedido no encontrado/i
    .test(errorText(payload))) throw new PaackTrackingError();
  const route = routeData(payload);
  if (/order not found|incorrect order number|commande introuvable|pedido no encontrado/i
    .test(errorText(route))) throw new PaackTrackingError();

  const order = route.orderTrackData;
  if (!isRecord(order)) throw new TypeError('Paack returned incomplete tracking details');
  const responseNumber = typeof order.external_id === 'string'
    ? normalizePaackTrackingNumber(order.external_id)
    : '';
  if (!responseNumber) throw new TypeError('Paack returned an invalid shipment number');
  if (responseNumber !== trackingNumber) throw new RangeError('Paack returned a different shipment');

  const rawEvents = Array.isArray(route.eventList) ? route.eventList : [];
  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    sourceIndex: number;
  }> = [];
  rawEvents.slice(0, 500).forEach((rawEvent, sourceIndex) => {
    if (!isRecord(rawEvent) || rawEvent.timeline === false) return;
    const classified = classifyEvent(rawEvent);
    const time = normalizedTimestamp(rawEvent.timestamp ?? rawEvent.time);
    if (!time) return;
    parsedEvents.push({
      event: {
        time: time.iso,
        description: classified.description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: time.timestamp,
      sourceIndex,
    });
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const events = parsedEvents.slice(0, MAX_EVENTS).map(({ event }) => event);
  const activeEvent = isRecord(route.activeEvent) ? route.activeEvent : null;
  const active = activeEvent ? classifyEvent(activeEvent) : null;
  const latest = parsedEvents.find((event) => event.status !== 'unknown');
  const current = active && active.status !== 'unknown'
    ? active
    : latest && {
      status: latest.status,
      stage: latest.event.stage ?? 'in_transit',
      description: latest.event.description ?? 'Shipment update',
    };
  if (!current) throw new TypeError('Paack returned incomplete tracking details');
  const activeTime = activeEvent
    ? normalizedTimestamp(activeEvent.timestamp ?? activeEvent.time)
    : null;

  const expected = isRecord(order.expected_delivery_ts)
    ? normalizedDate(order.expected_delivery_ts.end ?? order.expected_delivery_ts.start)
    : null;
  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: current.description,
    last_update: activeTime?.iso ?? events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(current.status) ? null : expected,
    timezone: 'Europe/Paris',
    events,
  };
}

export function parsePaackTrackingHtml(html: string, rawTrackingNumber: string): CarrierResult {
  if (!html.trim()) throw new TypeError('Paack returned an empty tracking response');
  if (/order not found|incorrect order number or postal code|commande introuvable|pedido no encontrado/i
    .test(html)) throw new PaackTrackingError();
  return parsePaackTrackingResponse(remixContext(html), rawTrackingNumber);
}

export class PaackTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Paack timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, rawPostcode: string): Promise<CarrierResult> {
    const trackingNumber = normalizePaackTrackingNumber(rawTrackingNumber);
    const postcode = normalizePaackPostcode(rawPostcode);
    const { response, bytes } = await fetchBounded(paackTrackingUrl(trackingNumber, postcode), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
    }, {
      provider: 'Paack tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      allowHttpError: true,
    });

    if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
      throw new PaackTrackingError();
    }
    if (!response.ok) throw new UpstreamHttpError('Paack tracking', response.status);
    return parsePaackTrackingHtml(decodeText(bytes), trackingNumber);
  }
}
