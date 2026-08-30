import 'server-only';

import { DateTime } from 'luxon';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord } from './types';

// Protocol provenance (inspected 2026-08-30): the source map published by the
// official public tracker posts { Identifier } to this anonymous endpoint and
// treats a null Data property as a clean not-found result.
// https://apv.swisspost-cargo.com/static/js/907.9a0b939a.chunk.js.map
const TRACKING_API = 'https://eosapi.swisspost-cargo.com/api/trackandtrace/public';
const TRACKING_PAGE = 'https://apv.swisspost-cargo.com/public/trackandtrace';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;

function clean(value: unknown, limit = 500): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function comparable(value: unknown): string {
  return clean(value)
    .toLocaleLowerCase('de-CH')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function statusFor(code: string, description: string): { status: CarrierStatus; stage: string } {
  const normalizedCode = code.toLocaleUpperCase('en-US');
  const text = comparable(description);
  if (['retour', 'return', 'zuruck'].some((term) => text.includes(term))) {
    return { status: 'exception', stage: 'returned' };
  }
  if (['incident', 'echec', 'failed', 'not delivered', 'non livre', 'nicht zugestellt',
    'refuse', 'damage', 'verzoger']
    .some((term) => text.includes(term))) {
    return { status: 'exception', stage: 'failed_attempt' };
  }
  if (['DLV', 'POD', 'P40', 'IMG', 'SIG'].includes(normalizedCode)
    || ['delivered', 'livre', 'zugestellt', 'consegnat'].some((term) => text.includes(term))) {
    return { status: 'delivered', stage: 'delivered' };
  }
  if (['out for delivery', 'en livraison', 'in zustellung', 'in consegna']
    .some((term) => text.includes(term))) {
    return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  }
  if (normalizedCode === 'SCA') {
    return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  }
  if (normalizedCode === 'NTF'
    || ['annonce', 'registered', 'angemeldet', 'information received']
      .some((term) => text.includes(term))) {
    return { status: 'pending', stage: 'registered' };
  }
  return { status: 'in_transit', stage: normalizedCode === 'RFS' ? 'accepted' : 'in_transit' };
}

function eventTimestamp(value: unknown): { value: string; timestamp: number } | null {
  const raw = clean(value, 64);
  if (!raw) return null;
  let parsed = DateTime.fromISO(raw, { setZone: true });
  if (!parsed.isValid) {
    for (const format of ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd/MM/yyyy HH:mm:ss']) {
      parsed = DateTime.fromFormat(raw, format, { zone: 'Europe/Zurich' });
      if (parsed.isValid) break;
    }
  }
  if (!parsed.isValid) return null;
  return {
    value: parsed.toISO({ suppressMilliseconds: true }) ?? raw,
    timestamp: parsed.toMillis(),
  };
}

export class SwissPostCargoTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Swiss Post Cargo could not locate the shipment');
    this.name = 'SwissPostCargoTrackingError';
  }
}

export function normalizeSwissPostCargoTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{6,40}$/.test(value)) {
    throw new TypeError('Swiss Post Cargo tracking requires a 6- to 40-character barcode or reference');
  }
  return value;
}

export function swissPostCargoTrackingUrl(raw: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeSwissPostCargoTrackingNumber(raw))}`;
}

export function parseSwissPostCargoResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeSwissPostCargoTrackingNumber(rawTrackingNumber);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'Data')) {
    throw new TypeError('Swiss Post Cargo returned an invalid tracking response');
  }
  if (payload.Data === null) throw new SwissPostCargoTrackingError();
  if (!Array.isArray(payload.Data) || payload.Data.length === 0) {
    throw new TypeError('Swiss Post Cargo returned an invalid tracking response');
  }
  let shipments = payload.Data.filter(isRecord);
  if (shipments.length === 0) {
    throw new TypeError('Swiss Post Cargo returned an invalid tracking response');
  }
  const responseType = Number(payload.Type);
  if (responseType !== 1 && responseType !== 2) {
    throw new TypeError('Swiss Post Cargo returned an invalid tracking response type');
  }
  if (responseType === 1) {
    const identifiers = shipments
      .map((shipment) => clean(shipment.Identifier, 64).toLocaleUpperCase('en-US'))
      .filter(Boolean);
    if (identifiers.length === 0) {
      throw new TypeError('Swiss Post Cargo returned no shipment identifier');
    }
    if (!identifiers.includes(trackingNumber)) {
      throw new RangeError('Swiss Post Cargo returned a different shipment');
    }
    shipments = shipments.filter((shipment) => (
      clean(shipment.Identifier, 64).toLocaleUpperCase('en-US') === trackingNumber
    ));
  }

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  let index = 0;
  for (const shipment of shipments.slice(0, 100)) {
    if (!Array.isArray(shipment.History)) continue;
    for (const candidate of shipment.History.slice(0, 500)) {
      if (!isRecord(candidate)) continue;
      const time = eventTimestamp(candidate.TimeStamp);
      const description = clean(candidate.Description);
      if (!time || !description) continue;
      const location = clean(candidate.City, 120);
      const code = clean(candidate.Status, 32).toLocaleUpperCase('en-US');
      const identity = JSON.stringify([time.value, location, description, code]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const classified = statusFor(code, description);
      parsedEvents.push({
        event: {
          time: time.value,
          location,
          description,
          stage: classified.stage,
          ...(code ? { provider_code: code } : {}),
        },
        status: classified.status,
        timestamp: time.timestamp,
        index,
      });
      index += 1;
    }
  }
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsedEvents.slice(0, 100);
  if (events.length === 0) {
    throw new TypeError('Swiss Post Cargo returned no usable tracking events');
  }
  const latest = events[0]!;
  return {
    status: latest.status,
    current_stage: latest.event.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time,
    expected_delivery: null,
    timezone: 'Europe/Zurich',
    events: events.map(({ event }) => event),
    tracking_url: swissPostCargoTrackingUrl(trackingNumber),
  };
}

export class SwissPostCargoTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Swiss Post Cargo timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeSwissPostCargoTrackingNumber(rawTrackingNumber);
    const { bytes } = await fetchBounded(TRACKING_API, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-CH,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://apv.swisspost-cargo.com',
        Referer: `${TRACKING_PAGE}/`,
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
      body: JSON.stringify({ Identifier: trackingNumber }),
    }, {
      provider: 'Swiss Post Cargo tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return parseSwissPostCargoResponse(parseJsonBytes(bytes, 'Swiss Post Cargo'), trackingNumber);
  }
}
