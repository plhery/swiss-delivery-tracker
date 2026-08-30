import 'server-only';

import { DateTime } from 'luxon';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_API =
  'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes';
const TRACKING_PAGE = 'https://moncolis.gls-france.com/fr';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 750_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface GLSStatusMetadata {
  status: CarrierStatus;
  stage: string;
  description: string;
}

const DELAYED_DELIVERY: GLSStatusMetadata = {
  status: 'in_transit',
  stage: 'in_transit',
  description: 'Delivery delayed',
};
const FAILED_DELAYED_DELIVERY: GLSStatusMetadata = {
  status: 'exception',
  stage: 'failed_attempt',
  description: 'Delivery delayed',
};

const GLS_STATUSES = new Map<string, GLSStatusMetadata>([
  ['CON', { status: 'pending', stage: 'registered', description: 'Shipment information received' }],
  ['REC', { status: 'in_transit', stage: 'accepted', description: 'Parcel received at GLS depot' }],
  ['EXP', { status: 'in_transit', stage: 'in_transit', description: 'Parcel in transit' }],
  ['PBC', { status: 'in_transit', stage: 'in_transit', description: 'Parcel in transit' }],
  ['DOU', { status: 'in_transit', stage: 'customs', description: 'Parcel in customs clearance' }],
  ['TRV', { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' }],
  ['LIV', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['LTV', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['LTL', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['LIL', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['LIT', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['LTT', { status: 'delivered', stage: 'delivered', description: 'Delivered' }],
  ['INC', { status: 'exception', stage: 'failed_attempt', description: 'Incomplete delivery information' }],
  ['PBP', { status: 'exception', stage: 'failed_attempt', description: 'Parcel delivery issue' }],
  ['NLI', { status: 'exception', stage: 'failed_attempt', description: 'Delivery attempt unsuccessful' }],
  ['NLK', { status: 'exception', stage: 'failed_attempt', description: 'Locker delivery unsuccessful' }],
  ['NLP', { status: 'exception', stage: 'failed_attempt', description: 'ParcelShop delivery unsuccessful' }],
  ['RET', { status: 'exception', stage: 'returned', description: 'Returning to sender' }],
  ['PBA', { status: 'exception', stage: 'failed_attempt', description: 'Parcel delivery issue' }],
  ['SIN', { status: 'exception', stage: 'failed_attempt', description: 'Shipment incident' }],
  ['LIP', { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup at GLS ParcelShop' }],
  ['LTP', { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup at GLS ParcelShop' }],
  ['LIK', { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup at GLS Locker' }],
  ['LTK', { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup at GLS Locker' }],
  ['PAQ', { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup at GLS depot' }],
  // These additional values are present in the current official tracking frontend.
  ['DEP', { status: 'in_transit', stage: 'in_transit', description: 'ParcelShop delivery planned' }],
  ['DEK', { status: 'in_transit', stage: 'in_transit', description: 'Locker delivery planned' }],
  // GLS's frontend treats DEL as a rescheduled delay by default. It only marks
  // the parcel as failed when the newest event has typeEvenement=LIV.
  ['DEL', DELAYED_DELIVERY],
  ['LIR', { status: 'exception', stage: 'returned', description: 'Returned to sender' }],
]);

function clean(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? value.trim().split(/\s+/).filter(Boolean).join(' ').slice(0, maxLength)
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : '';
}

function statusCode(value: unknown): string {
  const code = clean(value, 12).toLocaleUpperCase('en-US');
  return /^[A-Z]{2,4}$/.test(code) ? code : '';
}

function locationCode(value: unknown): string {
  const code = clean(value, 16).toLocaleUpperCase('en-US');
  return /^[A-Z]{2}[A-Z0-9]{2,8}$/.test(code) ? code : '';
}

function statusMetadata(value: unknown): GLSStatusMetadata | null {
  return GLS_STATUSES.get(statusCode(value)) ?? null;
}

export function glsFranceStatus(value: unknown): CarrierStatus {
  return statusMetadata(value)?.status ?? 'unknown';
}

interface ParsedDate {
  iso: string;
  timestamp: number;
}

function parseDate(value: unknown): ParsedDate | null {
  const raw = clean(value, 64);
  if (!raw || raw.startsWith('0001-')) return null;
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  let parsed = raw.includes('T')
    ? DateTime.fromISO(raw, { setZone: hasExplicitZone, zone: 'Europe/Paris' })
    : DateTime.fromSQL(raw, { zone: 'Europe/Paris' });
  if (!parsed.isValid && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsed = DateTime.fromISO(raw, { zone: 'Europe/Paris' });
  }
  if (!parsed.isValid) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function expectedDelivery(value: unknown): string | null {
  return parseDate(value)?.iso.slice(0, 10) ?? null;
}

function normalizedCandidate(value: unknown): string {
  const candidate = clean(value, 32).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  return /^(?:[A-Z0-9]{8}|\d{11})$/.test(candidate) ? candidate : '';
}

export function normalizeGLSFranceTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?:[A-Z0-9]{8}|\d{11})$/.test(value)) {
    throw new TypeError('GLS France tracking numbers must contain 8 letters or digits, or 11 digits');
  }
  return value;
}

export function glsFranceTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

export function glsFranceTrackingApiUrl(trackingNumber: string): string {
  return `${TRACKING_API}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function responseIdentifiers(parcel: JsonObject): string[] {
  return [parcel.trackid, parcel.numeroalphaColis, parcel.numeroGp]
    .map(normalizedCandidate)
    .filter(Boolean);
}

interface ParsedEvent {
  event: CarrierEvent;
  timestamp: number;
  sourceIndex: number;
  typeCode: string;
  metadata: GLSStatusMetadata | null;
}

function parseEvent(raw: JsonObject, sourceIndex: number): ParsedEvent | null {
  const eventStatusCode = statusCode(raw.statutEvenement);
  const typeCode = statusCode(raw.typeEvenement);
  const code = eventStatusCode || typeCode;
  const metadata = eventStatusCode === 'DEL' && typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : statusMetadata(code);
  const time = parseDate(raw.datereference) ?? parseDate(raw.datecreation);
  if (!code && !time) return null;
  const location = locationCode(raw.codelieuEvenement);
  return {
    timestamp: time?.timestamp ?? Number.NEGATIVE_INFINITY,
    sourceIndex,
    typeCode,
    metadata,
    event: {
      ...(time ? { time: time.iso } : {}),
      ...(location ? { location } : {}),
      description: metadata?.description ?? 'GLS France tracking update',
      stage: metadata?.stage ?? 'in_transit',
      ...(code ? { provider_code: code } : {}),
    },
  };
}

export function parseGLSFranceTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  const requested = normalizeGLSFranceTrackingNumber(trackingNumber);
  if (!isRecord(payload) || !isRecord(payload.colis)) {
    throw new TypeError('GLS France returned an invalid tracking response');
  }

  const parcel = payload.colis;
  const identifiers = responseIdentifiers(parcel);
  if (identifiers.length === 0) {
    throw new TypeError('GLS France did not return a shipment identifier');
  }
  if (!identifiers.includes(requested)) {
    throw new RangeError('GLS France returned a different shipment');
  }

  const seen = new Set<string>();
  const parsedEvents: ParsedEvent[] = [];
  records(payload.evenements).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, index) => {
    const parsed = parseEvent(raw, index);
    if (!parsed) return;
    const identity = JSON.stringify([
      parsed.event.time ?? '',
      parsed.event.location ?? '',
      parsed.event.provider_code ?? '',
    ]);
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push(parsed);
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const latestParsedEvent = parsedEvents[0];
  const events = parsedEvents
    .slice(0, MAX_EVENTS_TO_RETURN)
    .map(({ event }) => event);

  const currentCode = statusCode(parcel.statutColis);
  const current = currentCode === 'DEL' && latestParsedEvent?.typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : statusMetadata(currentCode);
  const latestEvent = events[0];
  const latestEventStatus = latestParsedEvent?.metadata ?? statusMetadata(latestEvent?.provider_code);
  const fallbackUpdate = parseDate(parcel.dateActionColis);
  return {
    status: current?.status ?? latestEventStatus?.status ?? 'unknown',
    last_status_text: current?.description
      ?? latestEvent?.description
      ?? 'Tracking information received',
    last_update: latestEvent?.time ?? fallbackUpdate?.iso ?? null,
    expected_delivery: expectedDelivery(parcel.dateTheoriqueLivraison),
    timezone: 'Europe/Paris',
    events,
  };
}

export class GLSFranceTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('GLS France timeout must be positive');
    }
  }

  async fetch(trackingNumber: string): Promise<CarrierResult> {
    const normalized = normalizeGLSFranceTrackingNumber(trackingNumber);
    const { bytes } = await fetchBounded(glsFranceTrackingApiUrl(normalized), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Origin: 'https://moncolis.gls-france.com',
        Referer: `${TRACKING_PAGE}/`,
        'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
      },
    }, {
      provider: 'GLS France tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return parseGLSFranceTrackingResponse(parseJsonBytes(bytes, 'GLS France'), normalized);
  }
}
