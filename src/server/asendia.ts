import 'server-only';

import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import {
  decodeText,
  fetchBounded,
  parseJsonBytes,
  UpstreamHttpError,
} from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

// Protocol provenance (inspected 2026-08-30):
// https://track.asendia.com/track
// https://track.asendia.com/_next/static/chunks/pages/track/%5B%5B...tracking_id%5D%5D-d2fd6dd3353e50f8.js
// https://track.asendia.com/_next/static/chunks/pages/_app-65ac15f78f4fd695.js
// The official frontend loads a tenant config and a public daily checksum key,
// then POSTs to branded-parcel-search. A fresh Cloudflare Turnstile token is a
// required body field; callers must obtain that token through an approved
// interactive browser flow and inject it into this adapter.
const TRACKING_ORIGIN = 'https://track.asendia.com';
const TRACKING_PAGE = `${TRACKING_ORIGIN}/track`;
const TRACKING_API = `${TRACKING_ORIGIN}/api/1.0/branded-url/branded-parcel-search`;
const CONFIG_API = `${TRACKING_ORIGIN}/api/1.0/branded-url/get-config-data/track.asendia.com`;
const ENVIRONMENT_SCRIPT = `${TRACKING_ORIGIN}/__env.js`;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  sourceIndex: number;
}

interface AsendiaTenantConfig {
  id: string | number;
  subsidiary: string;
  subsidiaryId: string | number;
  brandId: string | string[];
}

export class AsendiaTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Asendia could not locate the shipment');
    this.name = 'AsendiaTrackingError';
  }
}

export class AsendiaChallengeError extends Error {
  readonly status = 503;

  constructor(message = 'Asendia requires a fresh Cloudflare Turnstile token') {
    super(message);
    this.name = 'AsendiaChallengeError';
  }
}

function text(value: unknown, maxLength = 500): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function plainText(value: unknown, maxLength = 500): string {
  const raw = text(value, Math.max(5_000, maxLength * 10));
  return raw ? text(load(raw).text(), maxLength) : '';
}

function comparableText(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value: string, phrases: string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

function classifyStatus(description: string): { status: CarrierStatus; stage: string } {
  const value = comparableText(description);
  if (includesAny(value, [
    'return to sender',
    'returned to sender',
    'return initiated',
    'shipment returned',
  ])) return { status: 'exception', stage: 'returned' };
  if (includesAny(value, [
    'delivery failed',
    'failed attempt',
    'delivery exception',
    'unable to deliver',
    'not delivered',
    'undelivered',
    'non livre',
    'delivery delayed',
    'damaged',
    'refused',
    'lost',
  ])) return { status: 'exception', stage: 'failed_attempt' };
  if (includesAny(value, [
    'delivered',
    'collected by recipient',
    'handed to recipient',
  ])) return { status: 'delivered', stage: 'delivered' };
  if (includesAny(value, [
    'ready for pickup',
    'ready for collection',
    'available for pickup',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  if (includesAny(value, [
    'out for delivery',
    'in delivery',
    'with delivery courier',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  if (includesAny(value, [
    'information received',
    'shipment created',
    'label created',
    'pre advised',
    'pre advice',
  ])) return { status: 'pending', stage: 'registered' };
  if (includesAny(value, [
    'handed to asendia',
    'departed from asendia',
    'arrived at destination',
    'in transit',
    'processed at',
    'customs',
  ])) return {
    status: 'in_transit',
    stage: value.includes('customs') ? 'customs' : 'in_transit',
  };
  return { status: 'unknown', stage: 'in_transit' };
}

export function normalizeAsendiaTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{8,40}$/.test(value) || !/\d/.test(value)) {
    throw new TypeError('Asendia tracking numbers must contain 8 to 40 ASCII letters and digits');
  }
  return value;
}

export function asendiaTrackingUrl(rawTrackingNumber: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeAsendiaTrackingNumber(rawTrackingNumber))}`;
}

export function asendiaTrackingApiUrl(): string {
  const url = new URL(TRACKING_API);
  url.searchParams.set('sort', 'shipment_date');
  return url.toString();
}

export function asendiaConfigApiUrl(): string {
  return CONFIG_API;
}

export function asendiaEnvironmentUrl(): string {
  return ENVIRONMENT_SCRIPT;
}

export function parseAsendiaPublicHitKey(script: string): string {
  const match = /window\.__ENV\s*=\s*(\{[^;]*\})\s*;?/.exec(script);
  if (!match) throw new TypeError('Asendia returned an invalid public environment script');
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]!);
  } catch (error) {
    throw new TypeError('Asendia returned an invalid public environment script', { cause: error });
  }
  const key = isRecord(payload) ? text(payload.NEXT_PUBLIC_BRANDED_HIT_KEY, 128) : '';
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new TypeError('Asendia did not publish a valid request checksum key');
  }
  return key.toLocaleLowerCase('en-US');
}

export function asendiaHitToken(
  rawTrackingNumber: string,
  isoDate: string,
  publicHitKey: string,
): string {
  const trackingNumber = normalizeAsendiaTrackingNumber(rawTrackingNumber);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !DateTime.fromISO(isoDate).isValid) {
    throw new TypeError('Asendia request dates must use YYYY-MM-DD');
  }
  if (!/^[a-f0-9]{64}$/i.test(publicHitKey)) {
    throw new TypeError('Asendia request checksum keys must contain 64 hexadecimal characters');
  }
  return createHash('sha256')
    .update(`${trackingNumber}${isoDate}${publicHitKey.toLocaleLowerCase('en-US')}`)
    .digest('hex');
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseTenantConfig(payload: unknown): AsendiaTenantConfig {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new TypeError('Asendia returned an invalid tracking configuration');
  }
  const data = payload.data;
  const id = typeof data.id === 'number' || typeof data.id === 'string' ? data.id : '';
  const subsidiary = text(data.subsidiary_name, 128);
  const subsidiaryId = typeof data.subsidiary === 'number' || typeof data.subsidiary === 'string'
    ? data.subsidiary
    : '';
  const brands = records(data.brand_id)
    .map((brand) => text(brand.customer_id, 128))
    .filter(Boolean);
  if (id === '' || !subsidiary || subsidiaryId === '' || brands.length === 0) {
    throw new TypeError('Asendia returned an incomplete tracking configuration');
  }
  return {
    id,
    subsidiary,
    subsidiaryId,
    brandId: brands.includes('*') ? '*' : brands,
  };
}

function responseIdentifier(parcel: JsonObject): string {
  for (const value of [parcel.tracking_id, parcel.upper_tracking_id]) {
    try {
      return normalizeAsendiaTrackingNumber(text(value, 64));
    } catch {
      // Try the alternate provider field.
    }
  }
  return '';
}

function selectParcel(payload: unknown, rawTrackingNumber: string): JsonObject {
  const trackingNumber = normalizeAsendiaTrackingNumber(rawTrackingNumber);
  if (!isRecord(payload)) throw new TypeError('Asendia returned an invalid tracking response');
  const parcels = records(payload.data);
  if (parcels.length === 0) throw new AsendiaTrackingError();
  const matches = parcels.filter((parcel) => responseIdentifier(parcel) === trackingNumber);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new RangeError('Asendia returned an ambiguous shipment');
  throw new RangeError('Asendia returned a different shipment');
}

function parseEventTime(value: unknown): { iso: string; timestamp: number } | null {
  const raw = text(value, 64);
  if (!raw) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  let parsed = DateTime.fromISO(raw, hasOffset
    ? { setZone: true }
    : { zone: 'Europe/Zurich' });
  if (!parsed.isValid) {
    for (const format of [
      'dd/MM/yyyy HH:mm:ss',
      'dd/MM/yyyy HH:mm',
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd HH:mm',
      'dd/MM/yyyy',
      'yyyy-MM-dd',
    ]) {
      parsed = DateTime.fromFormat(raw, format, { zone: 'Europe/Zurich' });
      if (parsed.isValid) break;
    }
  }
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return parsed.isValid && iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function safeEventCode(value: unknown): string {
  const code = text(value, 32).toLocaleUpperCase('en-US');
  return /^[A-Z0-9._-]{1,32}$/.test(code) ? code : '';
}

function parseEvents(parcel: JsonObject): ParsedEvent[] {
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  records(parcel.events).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, sourceIndex) => {
    const time = parseEventTime(raw.eventDateTime ?? raw.event_datetime ?? raw.datetime);
    const description = plainText(raw.harmonizedEvent)
      || plainText(raw.harmonized_event)
      || plainText(raw.eventDesc)
      || plainText(raw.description);
    if (!time || !description) return;
    const location = plainText(raw.scanningLocation ?? raw.scanning_location, 200);
    const code = safeEventCode(raw.harmonizedCode ?? raw.eventId ?? raw.event_id);
    const identity = JSON.stringify([time.iso, location, description, code]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsed.push({
      sourceIndex,
      timestamp: time.timestamp,
      status: classified.status,
      event: {
        time: time.iso,
        location,
        description,
        stage: classified.stage,
        ...(code ? { provider_code: code } : {}),
      },
    });
  });
  parsed.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  return parsed.slice(0, MAX_EVENTS_TO_RETURN);
}

function expectedDelivery(parcel: JsonObject): string | null {
  for (const value of [parcel.estimated_delivery_date, parcel.delivery_date]) {
    const raw = text(value, 64);
    if (!raw) continue;
    let parsed = DateTime.fromISO(raw, { zone: 'Europe/Zurich' });
    if (!parsed.isValid) parsed = DateTime.fromFormat(raw, 'dd/MM/yyyy', { zone: 'Europe/Zurich' });
    if (parsed.isValid) return parsed.toISODate();
  }
  return null;
}

export function parseAsendiaTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const parcel = selectParcel(payload, rawTrackingNumber);
  const parsedEvents = parseEvents(parcel);
  const events = parsedEvents.map(({ event }) => event);
  const currentText = plainText(parcel.status)
    || plainText(parcel.parcel_progress)
    || events[0]?.description
    || 'Tracking information received';
  const current = classifyStatus(currentText);
  const latestKnown = parsedEvents.find((event) => event.status !== 'unknown');
  const status = current.status !== 'unknown'
    ? current.status
    : latestKnown?.status ?? 'unknown';
  return {
    status,
    last_status_text: events[0]?.description ?? currentText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status)
      ? null
      : expectedDelivery(parcel),
    timezone: 'Europe/Zurich',
    events,
  };
}

function challengeToken(value: unknown): string {
  const token = text(value, 4_096);
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(token)) throw new AsendiaChallengeError();
  return token;
}

function baseHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'Content-Type': 'application/json',
    'x-tenant-id': 'track.asendia.com',
    'X-Language': 'en',
    'X-Timezone': 'Europe/Zurich',
    Origin: TRACKING_ORIGIN,
    Referer: `${TRACKING_PAGE}/`,
    'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
  };
}

export interface AsendiaTrackerOptions {
  timeoutMs?: number;
  now?: () => Date;
  turnstileTokenProvider?: () => string | Promise<string>;
}

export class AsendiaTracker {
  readonly timeoutMs: number;
  readonly now: () => Date;
  readonly turnstileTokenProvider: () => string | Promise<string>;

  constructor(options: AsendiaTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.turnstileTokenProvider = options.turnstileTokenProvider
      ?? (() => process.env.ASENDIA_TURNSTILE_TOKEN ?? '');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Asendia timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeAsendiaTrackingNumber(rawTrackingNumber);
    const token = challengeToken(await this.turnstileTokenProvider());
    const [environmentScript, configPayload] = await Promise.all([
      this.requestText(ENVIRONMENT_SCRIPT, 'Asendia public environment'),
      this.requestJson(CONFIG_API, { headers: baseHeaders() }, 'Asendia tracking configuration'),
    ]);
    const publicHitKey = parseAsendiaPublicHitKey(environmentScript);
    const config = parseTenantConfig(configPayload);
    const date = this.now().toISOString().slice(0, 10);
    const hitToken = asendiaHitToken(trackingNumber, date, publicHitKey);
    const payload = await this.requestJson(asendiaTrackingApiUrl(), {
      method: 'POST',
      headers: { ...baseHeaders(), 'X-Hit-Token': hitToken },
      body: JSON.stringify({
        ids: [trackingNumber],
        id: config.id,
        subsidiary: [config.subsidiary],
        subsidiary_id: [config.subsidiaryId],
        ...(config.brandId === '*' ? { brand_id: '*' } : { customer: config.brandId }),
        turnstile_token: token,
      }),
    }, 'Asendia tracking');
    const result = parseAsendiaTrackingResponse(payload, trackingNumber);
    result.tracking_url = asendiaTrackingUrl(trackingNumber);
    result.tracking_source = 'structured-web-response';
    return result;
  }

  private async requestText(url: string, provider: string): Promise<string> {
    const { bytes } = await fetchBounded(url, {
      headers: {
        Accept: 'application/javascript,text/javascript,*/*;q=0.8',
        Referer: `${TRACKING_PAGE}/`,
      },
    }, {
      provider,
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return decodeText(bytes);
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    provider: string,
  ): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, init, {
      provider,
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
    });
    const payload = bytes.byteLength > 0 ? parseJsonBytes(bytes, 'Asendia') : null;
    if (response.status === 404) throw new AsendiaTrackingError();
    if (response.status === 403 && provider === 'Asendia tracking') {
      throw new AsendiaChallengeError('Asendia rejected the Cloudflare Turnstile token');
    }
    if (response.status === 400 && isRecord(payload)
      && /turnstile/i.test(text(payload.summary, 256))) {
      throw new AsendiaChallengeError('Asendia rejected the Cloudflare Turnstile token');
    }
    if (!response.ok) throw new UpstreamHttpError(provider, response.status);
    return payload;
  }
}
