import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const API_BASE = 'https://service.post.ch/ekp-web/api';
const TRANSLATIONS_URL = 'https://service.post.ch/ekp-web/core/rest/translations/en/shipment-text-messages';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-CH,en;q=0.9',
  Referer: 'https://service.post.ch/ekp-web/ui/',
};
const STATUS_MAP = new Map<string, CarrierStatus>([
  ['REPORTED', 'pending'],
  ['REGISTERED', 'pending'],
  ['TO_BE_DELIVERED', 'in_transit'],
  ['IN_DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['MISSED_DELIVERY', 'exception'],
  ['NOT_DELIVERED', 'exception'],
  ['RETURNED', 'exception'],
  ['CUSTOMS', 'in_transit'],
]);
const FALLBACK_EVENT_LABELS: Record<string, string> = {
  '600': 'Your shipment will shortly be handed over to Swiss Post',
  '1003': 'Loading into delivery vehicle',
  '1201': 'Sorted for delivery',
  '1202': 'Shipment was sorted',
};
const EVENT_STAGE_BY_CODE: Record<string, string> = {
  '600': 'registered',
  '1003': 'out_for_delivery',
  '1201': 'in_transit',
  '1202': 'in_transit',
  '3600': 'returned',
  '4600': 'delivered',
};

export class SwissPostTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Swiss Post could not locate the shipment');
    this.name = 'SwissPostTrackingError';
  }
}
const STAGE_STATUS: Record<string, CarrierStatus> = {
  registered: 'pending',
  accepted: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  customs: 'in_transit',
  failed_attempt: 'exception',
  ready_for_pickup: 'in_transit',
  returned: 'exception',
};

function text(value: unknown, limit = 500): string {
  return String(value ?? '').trim().slice(0, limit);
}

function comparableShipmentNumber(value: unknown): string {
  return String(value ?? '').replace(/[\s.-]/g, '').toUpperCase();
}

function datePart(value: unknown): string | null {
  return /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/.exec(text(value))?.[1] ?? null;
}

function clockParts(value: unknown): string[] {
  if (isRecord(value)) {
    return ['start', 'end', 'from', 'to'].flatMap((key) => clockParts(value[key]));
  }
  if (Array.isArray(value)) return value.flatMap(clockParts);
  const stringValue = text(value);
  const timestampClock = /T((?:[01]\d|2[0-3]):[0-5]\d)/.exec(stringValue)?.[1];
  if (timestampClock) return [timestampClock];
  const clocks = stringValue.match(/(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d/g) ?? [];
  if (clocks.length > 1 && /[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(stringValue)) {
    return clocks.slice(0, 1);
  }
  return clocks;
}

export function swissPostExpectedDelivery(item: JsonObject): string | null {
  const interval = item.deliveryTimeInterval;
  const range = isRecord(item.deliveryRange) ? item.deliveryRange : {};
  const date = [
    item.calculatedDeliveryDate,
    item.deliveryDate,
    interval,
    range.start,
    range.end,
  ].map(datePart).find(Boolean) ?? null;
  if (!date) return null;
  const clocks = clockParts(interval);
  if (clocks.length === 0) return date;
  if (clocks.length === 1 || clocks[0] === clocks[1]) return `${date} ${clocks[0]}`;
  return `${date} ${clocks[0]}–${clocks[1]}`;
}

function translationMatch(
  translations: Record<string, string>,
  segments: string[],
): string | null {
  let best: { score: number; description: string } | null = null;
  for (const [pattern, description] of Object.entries(translations)) {
    const patternSegments = pattern.split('.');
    if (patternSegments.length !== segments.length) continue;
    if (!patternSegments.every((expected, index) => expected === '*' || expected === segments[index])) {
      continue;
    }
    const score = patternSegments.filter((segment) => segment !== '*').length;
    if (!best || score > best.score) best = { score, description };
  }
  return best?.description ?? null;
}

function eventDescription(
  event: JsonObject,
  translations: Record<string, string>,
  internationalType: string,
): string {
  const eventCode = text(event.eventCode, 100);
  const segments = [...eventCode.split('.'), internationalType];
  let description = translationMatch(translations, segments);
  const subEventId = text(event.subEventId, 50);
  if (subEventId) {
    const subSegments = [...segments, subEventId];
    const detailCode = text(event.subEventDetailCode, 50);
    if (detailCode) subSegments.push(detailCode);
    const detail = translationMatch(translations, subSegments);
    if (detail && detail !== description) description = description ? `${description} — ${detail}` : detail;
  }
  const metadata = isRecord(event.externalMetadata) ? event.externalMetadata : {};
  const externalDescription = text(metadata.description);
  const code = eventCode.split('.').at(-1) ?? '';
  const value = description || externalDescription || FALLBACK_EVENT_LABELS[code] || eventCode;
  const $ = load(`<span>${value}</span>`);
  return $('span').text().trim().slice(0, 500) || 'Tracking update';
}

function eventLocation(event: JsonObject): string {
  return [text(event.city, 100), text(event.zip, 30)].filter(Boolean).join(' ').slice(0, 160);
}

function timestamp(value: string): number {
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function parseSwissPostShipment(
  item: JsonObject,
  rawEvents: unknown[],
  translations: Record<string, string> = {},
): CarrierResult {
  const globalStatus = text(item.globalStatus, 100);
  let status = STATUS_MAP.get(globalStatus) ?? 'in_transit';
  const internationalType = item.internationalImport
    ? 'IMPORT'
    : item.internationalExport
      ? 'EXPORT'
      : 'INLAND';
  const events: CarrierEvent[] = [];
  for (const rawEvent of rawEvents.slice(0, 100)) {
    if (!isRecord(rawEvent)) continue;
    const time = text(rawEvent.timestamp, 100);
    const eventCode = text(rawEvent.eventCode, 100);
    if (!time || !eventCode) continue;
    const event: CarrierEvent = {
      time,
      location: eventLocation(rawEvent),
      description: eventDescription(rawEvent, translations, internationalType),
      provider_code: eventCode,
    };
    const stage = EVENT_STAGE_BY_CODE[eventCode.split('.').at(-1) ?? ''];
    if (stage) event.stage = stage;
    events.push(event);
  }
  events.sort((left, right) => timestamp(right.time ?? '') - timestamp(left.time ?? ''));
  let lastStatusText: string;
  let lastUpdate: string | null;
  if (events[0]) {
    lastStatusText = events[0].description ?? 'Tracking update';
    if (events[0].stage && STAGE_STATUS[events[0].stage]) status = STAGE_STATUS[events[0].stage];
    lastUpdate = events[0].time ?? null;
  } else {
    lastStatusText = globalStatus;
    lastUpdate = text(item.lastEventDateTime, 100) || null;
  }
  return {
    status,
    last_status_text: lastStatusText,
    last_update: lastUpdate,
    expected_delivery: swissPostExpectedDelivery(item),
    timezone: 'Europe/Zurich',
    global_status: globalStatus,
    delivery_range: item.deliveryRange,
    delivery_time_interval: item.deliveryTimeInterval,
    events,
  };
}

export class SwissPostTracker {
  #translations: Record<string, string> | null = null;
  #translationAttempted = false;

  async readJson(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const { bytes } = await fetchBounded(url, init, {
      provider: 'Swiss Post tracking',
      timeoutMs: 10_000,
      fetcher,
    });
    return parseJsonBytes(bytes, 'Swiss Post');
  }

  async loadTranslations(fetcher: typeof fetch): Promise<Record<string, string>> {
    if (this.#translations) return this.#translations;
    if (this.#translationAttempted) return {};
    this.#translationAttempted = true;
    try {
      const payload = await this.readJson(fetcher, TRANSLATIONS_URL, { headers: HEADERS });
      const raw = isRecord(payload) && isRecord(payload['shipment-text--'])
        ? payload['shipment-text--']
        : {};
      this.#translations = Object.fromEntries(
        Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    } catch {
      return {};
    }
    return this.#translations;
  }

  async fetch(trackingNumber: string): Promise<CarrierResult> {
    const fetcher = makeFetchCookie(fetch, new CookieJar());
    const userResult = await fetchBounded(`${API_BASE}/user`, { headers: HEADERS }, {
      provider: 'Swiss Post tracking',
      timeoutMs: 10_000,
      fetcher,
    });
    const userPayload = parseJsonBytes(userResult.bytes, 'Swiss Post');
    if (!isRecord(userPayload)) throw new TypeError('Swiss Post returned an invalid anonymous user response');
    const userId = text(userPayload.userIdentifier);
    if (!userId) throw new TypeError('Swiss Post did not return an anonymous user identifier');
    const csrf = userResult.response.headers.get('x-csrf-token') ?? '';
    const headers = { ...HEADERS, 'x-csrf-token': csrf };
    const query = new URLSearchParams({ userId });
    const historyPayload = await this.readJson(fetcher, `${API_BASE}/history?${query}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchQuery: trackingNumber }),
    });
    const hash = isRecord(historyPayload) ? text(historyPayload.hash) : '';
    if (!hash) throw new TypeError('Swiss Post did not return a shipment search identifier');
    const items = await this.readJson(
      fetcher,
      `${API_BASE}/history/not-included/${encodeURIComponent(hash)}?${query}`,
      { headers },
    );
    if (!Array.isArray(items)) {
      throw new TypeError('Swiss Post returned an invalid shipment response');
    }
    if (items.length === 0) throw new SwissPostTrackingError();
    if (!items.every(isRecord)) {
      throw new TypeError('Swiss Post returned an invalid shipment response');
    }
    const requested = comparableShipmentNumber(trackingNumber);
    const identified = items.filter((candidate) => comparableShipmentNumber(candidate.shipmentNumber));
    if (identified.length === 0) {
      throw new TypeError('Swiss Post did not return a shipment identifier');
    }
    const item = identified.find(
      (candidate) => comparableShipmentNumber(candidate.shipmentNumber) === requested,
    );
    if (!item) throw new RangeError('Swiss Post returned a different shipment');
    const identity = text(item.identity);
    let events: unknown[] = [];
    if (identity) {
      try {
        const payload = await this.readJson(
          fetcher,
          `${API_BASE}/shipment/id/${encodeURIComponent(identity)}/events`,
          { headers },
        );
        if (Array.isArray(payload)) events = payload;
      } catch {
        // A shipment summary is still useful when the optional event call fails.
      }
    }
    const translations = events.length > 0 ? await this.loadTranslations(fetcher) : {};
    return parseSwissPostShipment(item, events, translations);
  }
}
