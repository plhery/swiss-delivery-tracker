import 'server-only';

import { Buffer } from 'node:buffer';
import { DateTime } from 'luxon';
import {
  decodeText,
  fetchBounded,
  parseJsonBytes,
  UpstreamHttpError,
} from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const SEARCH_ENDPOINT = 'https://myportal.heppner-group.com/api/recipient/search/expedition';
const DETAIL_ENDPOINT = 'https://myportal.heppner-group.com/api/recipient/search/detailexpedition';
const TRACKING_PAGE = 'https://myportal.heppner-group.com/tracking';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface HeppnerCredential {
  trackingNumber: string;
  postcode: string;
  countryCode: 'CH' | 'FR';
}

interface ClassifiedEvent {
  status: CarrierStatus;
  stage: string;
  description: string;
}

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  index: number;
}

function clean(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
}

function code(value: unknown): string {
  const normalized = clean(value, 64).toLocaleUpperCase('en-US');
  return /^[A-Z0-9]{2,32}(?:_[A-Z0-9]{2,32})*$/.test(normalized) ? normalized : '';
}

function eventTime(value: unknown): { iso: string; timestamp: number } | null {
  const raw = clean(value, 64);
  if (!raw) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true });
  const iso = parsed.toUTC().toISO({ suppressMilliseconds: true });
  return parsed.isValid && iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function classifyEvent(stepValue: unknown, stateValue: unknown, codeValue: unknown): ClassifiedEvent {
  const step = code(stepValue);
  const state = code(stateValue);
  const providerCode = code(codeValue);

  if (step === 'MARCHANDISE_RETOURNEE' || /^(?:SOL|RET)_/.test(providerCode)) {
    return { status: 'exception', stage: 'returned', description: 'Returned to sender' };
  }
  if (step === 'LIVREE' || /^(?:LIV|POD)_/.test(providerCode)) {
    return { status: 'delivered', stage: 'delivered', description: 'Delivered' };
  }
  if (state === 'ANOMALIE' || step === 'EN_ATTENTE_INSTRUCTIONS') {
    return {
      status: 'exception',
      stage: 'failed_attempt',
      description: step === 'EN_ATTENTE_INSTRUCTIONS'
        ? 'Delivery instructions required'
        : 'Shipment exception',
    };
  }
  if (step === 'LIVRAISON' || providerCode.startsWith('MLV_')) {
    return { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' };
  }
  if (step === 'PRISE_EN_CHARGE' || providerCode.startsWith('PCH_')) {
    return { status: 'in_transit', stage: 'accepted', description: 'Shipment collected' };
  }
  if (step === 'MARCHANDISE_REEXPEDIEE') {
    return { status: 'in_transit', stage: 'in_transit', description: 'Shipment forwarded' };
  }
  if (step === 'ACHEMINEMENT') {
    return { status: 'in_transit', stage: 'in_transit', description: 'In transit' };
  }
  return { status: 'unknown', stage: 'in_transit', description: 'Heppner tracking update' };
}

export class HeppnerTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Heppner could not locate the shipment');
    this.name = 'HeppnerTrackingError';
  }
}

export function normalizeHeppnerTrackingNumber(raw: string): string {
  const trackingNumber = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(trackingNumber)) {
    throw new TypeError('Heppner tracking numbers must contain exactly 8 digits');
  }
  return trackingNumber;
}

export function normalizeHeppnerCredential(
  rawTrackingNumber: string,
  rawPostcode: string,
): HeppnerCredential {
  const trackingNumber = normalizeHeppnerTrackingNumber(rawTrackingNumber);
  const postcode = rawPostcode.trim();
  if (!/^\d{4,5}$/.test(postcode)) {
    throw new TypeError('Heppner requires a four-digit Swiss or five-digit French delivery postcode');
  }
  return {
    trackingNumber,
    postcode,
    countryCode: postcode.length === 4 ? 'CH' : 'FR',
  };
}

export function heppnerSearchUrl(rawTrackingNumber: string, rawPostcode: string): string {
  const credential = normalizeHeppnerCredential(rawTrackingNumber, rawPostcode);
  const url = new URL(SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    zipCode: credential.postcode,
    receipt: credential.trackingNumber,
    countryCode: credential.countryCode,
  }).toString();
  return url.toString();
}

function expectedCapabilityValue(credential: HeppnerCredential): string {
  return `${credential.trackingNumber}&${credential.postcode}&${credential.countryCode}`;
}

export function parseHeppnerCapability(
  rawCapability: string,
  rawTrackingNumber: string,
  rawPostcode: string,
): string {
  const credential = normalizeHeppnerCredential(rawTrackingNumber, rawPostcode);
  const capability = clean(rawCapability, 512);
  if (
    !capability
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(capability)
  ) {
    throw new TypeError('Heppner returned an invalid tracking capability');
  }
  let decoded = '';
  try {
    decoded = Buffer.from(capability, 'base64').toString('utf8');
  } catch {
    throw new TypeError('Heppner returned an invalid tracking capability');
  }
  if (decoded !== expectedCapabilityValue(credential)) {
    throw new RangeError('Heppner returned a capability for a different shipment');
  }
  return capability;
}

export function heppnerDetailUrl(capability: string): string {
  const normalized = clean(capability, 512);
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new TypeError('Heppner tracking capability is invalid');
  }
  const url = new URL(DETAIL_ENDPOINT);
  url.searchParams.set('expedition', normalized);
  return url.toString();
}

export function heppnerTrackingPageUrl(capability: string): string {
  const normalized = clean(capability, 512);
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new TypeError('Heppner tracking capability is invalid');
  }
  return `${TRACKING_PAGE}/${encodeURIComponent(normalized)}`;
}

function responseReceipt(value: unknown): string {
  const normalized = clean(value, 32);
  return /^\d{8}$/.test(normalized) ? normalized : '';
}

function rawEvents(shipment: JsonObject): JsonObject[] {
  return Array.isArray(shipment.events) ? shipment.events.filter(isRecord) : [];
}

function parseEvents(shipment: JsonObject): ParsedEvent[] {
  const parsedEvents: ParsedEvent[] = [];
  const seen = new Set<string>();
  rawEvents(shipment).slice(0, MAX_EVENTS_TO_INSPECT).forEach((rawEvent, index) => {
    const providerCode = code(rawEvent.code) || code(rawEvent.event);
    const time = eventTime(rawEvent.event_date) ?? eventTime(rawEvent.date);
    if (!time) return;
    const classified = classifyEvent(rawEvent.step, rawEvent.state, providerCode);
    const identity = `${time.iso}\u0000${providerCode}\u0000${classified.stage}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push({
      event: {
        time: time.iso,
        location: '',
        description: classified.description,
        stage: classified.stage,
        ...(providerCode ? { provider_code: providerCode } : {}),
      },
      status: classified.status,
      timestamp: time.timestamp,
      index,
    });
  });
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  return parsedEvents.slice(0, MAX_EVENTS_TO_RETURN);
}

export function parseHeppnerTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeHeppnerTrackingNumber(rawTrackingNumber);
  if (!Array.isArray(payload)) {
    throw new TypeError('Heppner returned an invalid tracking response');
  }
  if (payload.length === 0) throw new HeppnerTrackingError();
  const shipments = payload.filter(isRecord);
  if (shipments.length !== payload.length) {
    throw new TypeError('Heppner returned an invalid shipment entry');
  }
  const matching = shipments.find((shipment) => responseReceipt(shipment.receipt) === trackingNumber);
  if (!matching) {
    const hasIdentifier = shipments.some((shipment) => responseReceipt(shipment.receipt));
    if (hasIdentifier) throw new RangeError('Heppner returned a different shipment');
    throw new TypeError('Heppner did not return a shipment identifier');
  }

  const parsed = parseEvents(matching);
  if (parsed.length === 0) throw new TypeError('Heppner did not return tracking history');
  const latest = parsed[0]!;
  const latestKnown = parsed.find((item) => item.status !== 'unknown');
  return {
    status: latest.status !== 'unknown' ? latest.status : latestKnown?.status ?? 'unknown',
    current_stage: latest.status !== 'unknown'
      ? latest.event.stage ?? 'in_transit'
      : latestKnown?.event.stage ?? 'in_transit',
    last_status_text: latest.event.description ?? 'Tracking information received',
    last_update: latest.event.time ?? null,
    expected_delivery: null,
    timezone: 'Europe/Paris',
    events: parsed.map(({ event }) => event),
  };
}

function requestHeaders(
  accept: string,
  origin = 'https://www.heppner-group.com',
): Record<string, string> {
  return {
    Accept: accept,
    'Accept-Language': 'fr-FR,fr;q=0.9',
    Origin: origin,
    Referer: 'https://www.heppner-group.com/destinataire-suivez-votre-marchandise/',
    'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
  };
}

export class HeppnerTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Heppner timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, rawPostcode: string): Promise<CarrierResult> {
    const credential = normalizeHeppnerCredential(rawTrackingNumber, rawPostcode);
    const search = await fetchBounded(
      heppnerSearchUrl(credential.trackingNumber, credential.postcode),
      { headers: requestHeaders('text/plain,*/*;q=0.8') },
      {
        provider: 'Heppner shipment search',
        timeoutMs: this.timeoutMs,
        maxBytes: 2_048,
        allowHttpError: true,
      },
    );
    if (search.response.status === 404) throw new HeppnerTrackingError();
    if (!search.response.ok) {
      throw new UpstreamHttpError('Heppner shipment search', search.response.status);
    }
    const capability = parseHeppnerCapability(
      decodeText(search.bytes),
      credential.trackingNumber,
      credential.postcode,
    );

    const detail = await fetchBounded(heppnerDetailUrl(capability), {
      headers: {
        ...requestHeaders('application/json', 'https://myportal.heppner-group.com'),
        Referer: heppnerTrackingPageUrl(capability),
      },
    }, {
      provider: 'Heppner tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
    });
    if (detail.response.status === 404) throw new HeppnerTrackingError();
    if (!detail.response.ok) {
      throw new UpstreamHttpError('Heppner tracking', detail.response.status);
    }
    return parseHeppnerTrackingResponse(
      parseJsonBytes(detail.bytes, 'Heppner'),
      credential.trackingNumber,
    );
  }
}
