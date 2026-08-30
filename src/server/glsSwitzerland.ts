import 'server-only';

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import {
  fetchBounded,
  parseJsonBytes,
  UpstreamHttpError,
} from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

// Protocol provenance (inspected 2026-08-30):
// https://gls-group.eu/EU/en/parcel-tracking
// https://gls-group.eu/media/gls_group_resources/gls_group_witt002_js.js
// The current official frontend uses rstt029 for an anonymous overview, then
// rstt028/<parcel> with the recipient postcode for the detailed event history.
const TRACKING_PAGE = 'https://gls-group.eu/EU/en/parcel-tracking';
const TRACKING_API = 'https://gls-group.eu/app/service/open/rest/GROUP/en';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface GLSStatusMetadata {
  status: CarrierStatus;
  stage: string;
}

const GLS_STATUSES = new Map<string, GLSStatusMetadata>([
  ['PREADVICE', { status: 'pending', stage: 'registered' }],
  ['NOTPICKEDUP', { status: 'pending', stage: 'registered' }],
  ['PLANNEDPICKUP', { status: 'pending', stage: 'registered' }],
  ['INPICKUP', { status: 'in_transit', stage: 'accepted' }],
  ['INTRANSIT', { status: 'in_transit', stage: 'in_transit' }],
  ['INWAREHOUSE', { status: 'in_transit', stage: 'in_transit' }],
  ['INDELIVERY', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['DELIVERED', { status: 'delivered', stage: 'delivered' }],
  ['DELIVEREDPS', { status: 'delivered', stage: 'delivered' }],
  ['NOTDELIVERED', { status: 'exception', stage: 'failed_attempt' }],
  ['CANCELED', { status: 'exception', stage: 'returned' }],
  ['CANCELLED', { status: 'exception', stage: 'returned' }],
  ['FINAL', { status: 'exception', stage: 'returned' }],
  ['NORECORD', { status: 'unknown', stage: 'pending' }],
]);

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  sourceIndex: number;
}

export class GLSSwitzerlandTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('GLS Switzerland could not locate the shipment');
    this.name = 'GLSSwitzerlandTrackingError';
  }
}

function text(value: unknown, maxLength = 500): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function plainText(value: unknown, maxLength = 500): string {
  const raw = text(value, Math.max(maxLength * 10, 5_000));
  return raw ? text(load(raw).text(), maxLength) : '';
}

function statusCode(value: unknown): string {
  const code = text(value, 32).toLocaleUpperCase('en-US');
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : '';
}

export function glsSwitzerlandStatus(value: unknown): CarrierStatus {
  return GLS_STATUSES.get(statusCode(value))?.status ?? 'unknown';
}

function classifyDescription(description: string): GLSStatusMetadata {
  const value = description
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (/(return(?:ed)? to sender|cancel(?:led|ed)|delivery (?:failed|impossible)|not delivered)/.test(value)) {
    return { status: 'exception', stage: value.includes('return') ? 'returned' : 'failed_attempt' };
  }
  if (/(delivered|handed to (?:the )?recipient|collected by (?:the )?recipient)/.test(value)) {
    return { status: 'delivered', stage: 'delivered' };
  }
  if (/(ready for (?:pickup|collection)|parcel ?shop|locker)/.test(value)) {
    return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  }
  if (/(out for delivery|in delivery|delivery vehicle)/.test(value)) {
    return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  }
  if (/(data (?:was )?entered|preadvice|announced|label created)/.test(value)) {
    return { status: 'pending', stage: 'registered' };
  }
  if (/(transit|parcel cent(?:er|re)|depot|left the gls|reached gls|customs)/.test(value)) {
    return { status: 'in_transit', stage: value.includes('customs') ? 'customs' : 'in_transit' };
  }
  return { status: 'unknown', stage: 'in_transit' };
}

export function normalizeGLSSwitzerlandTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?:(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8}|\d{11,14})$/.test(value)) {
    throw new TypeError(
      'GLS Switzerland tracking requires an 8-character Track ID or an 11-to-14-digit parcel number',
    );
  }
  return value;
}

export function normalizeGLSSwitzerlandPostcode(raw: string): string {
  const value = raw.trim();
  if (!/^\d{4}$/.test(value)) {
    throw new TypeError('GLS Switzerland detailed tracking requires the 4-digit recipient postcode');
  }
  return value;
}

export function glsSwitzerlandTrackingUrl(rawTrackingNumber: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('match', normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber));
  return url.toString();
}

export function glsSwitzerlandOverviewApiUrl(
  rawTrackingNumber: string,
  millis = Date.now(),
): string {
  const url = new URL(`${TRACKING_API}/rstt029`);
  url.searchParams.set('match', normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber));
  url.searchParams.set('type', '');
  url.searchParams.set('caller', 'witt002');
  url.searchParams.set('millis', String(millis));
  return url.toString();
}

export function glsSwitzerlandDetailApiUrl(
  rawParcelNumber: string,
  rawPostcode: string,
  millis = Date.now(),
  ownerCode = '',
): string {
  const parcelNumber = normalizeGLSSwitzerlandTrackingNumber(rawParcelNumber);
  if (!/^\d{11,14}$/.test(parcelNumber)) {
    throw new TypeError('GLS Switzerland details require the numeric parcel number');
  }
  const url = new URL(`${TRACKING_API}/rstt028/${encodeURIComponent(parcelNumber)}`);
  url.searchParams.set('caller', 'witt002');
  url.searchParams.set('millis', String(millis));
  url.searchParams.set('postalCode', normalizeGLSSwitzerlandPostcode(rawPostcode));
  const owner = text(ownerCode, 32);
  if (owner && /^[A-Z0-9_-]+$/i.test(owner)) url.searchParams.set('tuOwnerCode', owner);
  return url.toString();
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizedResponseIdentifier(value: unknown): string {
  try {
    return normalizeGLSSwitzerlandTrackingNumber(text(value, 32));
  } catch {
    return '';
  }
}

function referenceIdentifiers(parcel: JsonObject): string[] {
  return records(parcel.references)
    .filter((reference) => ['TRACKID', 'TRACK ID', 'PARCELNUMBER', 'TU'].includes(
      `${text(reference.type, 32)} ${text(reference.name, 32)}`.trim().toLocaleUpperCase('en-US'),
    ) || /track|parcel|paket/i.test(`${text(reference.type)} ${text(reference.name)}`))
    .map((reference) => normalizedResponseIdentifier(reference.value))
    .filter(Boolean);
}

function responseIdentifiers(parcel: JsonObject): string[] {
  return [
    normalizedResponseIdentifier(parcel.tuNo),
    normalizedResponseIdentifier(parcel.trackId),
    normalizedResponseIdentifier(parcel.trackingId),
    ...referenceIdentifiers(parcel),
  ].filter(Boolean);
}

function parcelRows(payload: unknown): JsonObject[] {
  if (!isRecord(payload)) throw new TypeError('GLS Switzerland returned an invalid tracking response');
  if (Array.isArray(payload.tuStatus)) return records(payload.tuStatus);
  if (payload.tuNo) return [payload];
  throw new TypeError('GLS Switzerland did not return tracking details');
}

function selectParcel(payload: unknown, rawTrackingNumber: string): JsonObject {
  const trackingNumber = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
  const parcels = parcelRows(payload);
  if (parcels.length === 0) throw new GLSSwitzerlandTrackingError();
  const matching = parcels.filter((parcel) => responseIdentifiers(parcel).includes(trackingNumber));
  if (matching.length === 1) return matching[0]!;
  // An eight-character Track ID is translated by the overview endpoint to its
  // numeric parcel number and is not echoed. A single result is unambiguous.
  if (/^[A-Z0-9]{8}$/.test(trackingNumber) && parcels.length === 1) return parcels[0]!;
  if (matching.length > 1) throw new RangeError('GLS Switzerland returned an ambiguous shipment');
  throw new RangeError('GLS Switzerland returned a different shipment');
}

function parseEventTime(dateValue: unknown, timeValue: unknown): {
  iso: string;
  timestamp: number;
} | null {
  const date = text(dateValue, 64);
  const time = text(timeValue, 32);
  const joined = `${date} ${time}`.trim();
  if (!joined) return null;
  let parsed = DateTime.fromISO(joined, { zone: 'Europe/Zurich' });
  if (!parsed.isValid) {
    for (const format of [
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd HH:mm',
      'dd-MMM-yyyy HH:mm:ss',
      'dd-MMM-yyyy HH:mm',
      'dd/MM/yyyy HH:mm',
      'dd.MM.yyyy HH:mm',
      'dd/MM/yyyy',
      'dd.MM.yyyy',
    ]) {
      parsed = DateTime.fromFormat(joined, format, { zone: 'Europe/Zurich', locale: 'en' });
      if (parsed.isValid) break;
    }
  }
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return parsed.isValid && iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function eventLocation(raw: JsonObject): string {
  if (!isRecord(raw.address)) return '';
  // Intentionally retain only coarse provider scan locations. Street, block,
  // postcode and recipient fields in the same object are never returned.
  return [plainText(raw.address.countryName, 80), plainText(raw.address.city, 120)]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);
}

function parseEvents(parcel: JsonObject): ParsedEvent[] {
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  records(parcel.history).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, sourceIndex) => {
    const description = plainText(raw.evtDscr) || plainText(raw.description);
    const time = parseEventTime(raw.date, raw.time);
    if (!description || !time) return;
    const location = eventLocation(raw);
    const code = text(raw.evtNo ?? raw.code, 32);
    const identity = JSON.stringify([time.iso, location, description, code]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = GLS_STATUSES.get(statusCode(raw.status)) ?? classifyDescription(description);
    parsed.push({
      sourceIndex,
      timestamp: time.timestamp,
      status: classified.status,
      event: {
        time: time.iso,
        location,
        description,
        stage: classified.stage,
        ...(/^[A-Z0-9._-]{1,32}$/i.test(code) ? { provider_code: code } : {}),
      },
    });
  });
  parsed.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  return parsed.slice(0, MAX_EVENTS_TO_RETURN);
}

function expectedDelivery(parcel: JsonObject): string | null {
  if (!isRecord(parcel.arrivalTime)) return null;
  const value = plainText(parcel.arrivalTime.value, 128);
  const match = value.match(/\b(\d{1,2}[-/.][A-Za-z]{3}|\d{1,2}[-/.]\d{1,2})[-/.](\d{4})\b/);
  if (!match) return null;
  const raw = match[0];
  for (const format of ['d-MMM-yyyy', 'd/MM/yyyy', 'd.MM.yyyy']) {
    const parsed = DateTime.fromFormat(raw, format, { zone: 'Europe/Zurich', locale: 'en' });
    if (parsed.isValid) return parsed.toISODate();
  }
  return null;
}

export function parseGLSSwitzerlandTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const parcel = selectParcel(payload, rawTrackingNumber);
  if (!isRecord(parcel.progressBar)) {
    throw new TypeError('GLS Switzerland did not return a shipment status');
  }
  const progress = parcel.progressBar;
  const current = records(progress.statusBar).find((entry) => (
    statusCode(entry.imageStatus) === 'CURRENT'
  ));
  const currentCode = statusCode(progress.statusInfo) || statusCode(current?.status);
  const currentMetadata = GLS_STATUSES.get(currentCode);
  const currentText = plainText(current?.statusText)
    || plainText(progress.statusText)
    || plainText(current?.imageText)
    || 'Tracking information received';
  const parsedEvents = parseEvents(parcel);
  const events = parsedEvents.map(({ event }) => event);
  const latestKnownEvent = parsedEvents.find((event) => event.status !== 'unknown');
  const status = currentMetadata?.status ?? latestKnownEvent?.status ?? 'unknown';
  return {
    status,
    current_stage: currentMetadata?.stage ?? latestKnownEvent?.event.stage ?? 'in_transit',
    last_status_text: events[0]?.description ?? currentText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status)
      ? null
      : expectedDelivery(parcel),
    timezone: 'Europe/Zurich',
    events,
  };
}

function ownerCode(parcel: JsonObject): string {
  return records(parcel.owners).reduce((found, owner) => (
    found || (statusCode(owner.type) === 'REQUEST' ? text(owner.code, 32) : '')
  ), '');
}

function pageHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Accept-Language': 'en-CH,en;q=0.9',
    Origin: 'https://gls-group.eu',
    Referer: `${TRACKING_PAGE}/`,
    'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
  };
}

export class GLSSwitzerlandTracker {
  constructor(
    readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('GLS Switzerland timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, rawPostcode = ''): Promise<CarrierResult> {
    const trackingNumber = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
    const overview = await this.request(glsSwitzerlandOverviewApiUrl(trackingNumber, this.now()));
    const parcel = selectParcel(overview, trackingNumber);
    if (!rawPostcode.trim()) return parseGLSSwitzerlandTrackingResponse(overview, trackingNumber);

    const parcelNumber = normalizedResponseIdentifier(parcel.tuNo);
    if (!/^\d{11,14}$/.test(parcelNumber)) {
      throw new TypeError('GLS Switzerland did not return a numeric parcel number');
    }
    const detail = await this.request(glsSwitzerlandDetailApiUrl(
      parcelNumber,
      rawPostcode,
      this.now(),
      ownerCode(parcel),
    ));
    return parseGLSSwitzerlandTrackingResponse(detail, parcelNumber);
  }

  private async request(url: string): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, {
      headers: pageHeaders(),
    }, {
      provider: 'GLS Switzerland tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
    });
    if ([400, 403, 404].includes(response.status)) throw new GLSSwitzerlandTrackingError();
    if (!response.ok) throw new UpstreamHttpError('GLS Switzerland tracking', response.status);
    return parseJsonBytes(bytes, 'GLS Switzerland');
  }
}
