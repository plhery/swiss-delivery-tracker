import 'server-only';

import { DateTime } from 'luxon';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_ORIGIN = 'https://track.amazon.fr';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
  description: string;
}

interface ParsedDate {
  iso: string;
  timestamp: number;
}

interface ParsedEvent {
  event: CarrierEvent;
  classified: ClassifiedStatus;
  timestamp: number;
  sourceIndex: number;
}

const UNKNOWN_STATUS: ClassifiedStatus = {
  status: 'unknown',
  stage: 'in_transit',
  description: 'Amazon Shipping update',
};

export class AmazonLogisticsTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Amazon Shipping could not locate the shipment');
    this.name = 'AmazonLogisticsTrackingError';
  }
}

function clean(value: unknown, maxLength = 500): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function statusKey(value: unknown): string {
  return clean(value, 200).toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function classifyStatus(...values: unknown[]): ClassifiedStatus {
  const key = values.map(statusKey).filter(Boolean).join(' ');
  if (includesAny(key, [
    'returnedtoretailer',
    'returnedtomerchant',
    'returnedtoshopper',
    'returnedtoshipper',
    'returntosender',
    'returningtosender',
    'returnedtosender',
    'lostonreturn',
  ])) {
    return { status: 'exception', stage: 'returned', description: 'Returning to sender' };
  }
  if (includesAny(key, [
    'deliveryattempted',
    'failedattempt',
    'unabletodeliver',
    'undeliverable',
    'informationneeded',
    'addressproblem',
    'damaged',
    'destroyed',
    'rejected',
    'cancelled',
    'canceled',
    'lost',
  ])) {
    return { status: 'exception', stage: 'failed_attempt', description: 'Delivery issue' };
  }
  if (includesAny(key, ['delayed', 'late'])) {
    return { status: 'in_transit', stage: 'in_transit', description: 'Delivery delayed' };
  }
  if (includesAny(key, ['delivered'])) {
    return { status: 'delivered', stage: 'delivered', description: 'Delivered' };
  }
  if (includesAny(key, [
    'readyforpickup',
    'readyforcollection',
    'holdforpickup',
    'awaitingcustomerpickup',
  ])) {
    return {
      status: 'out_for_delivery',
      stage: 'ready_for_pickup',
      description: 'Ready for pickup',
    };
  }
  if (includesAny(key, ['outfordelivery', 'swarexofd'])) {
    return {
      status: 'out_for_delivery',
      stage: 'out_for_delivery',
      description: 'Out for delivery',
    };
  }
  if (includesAny(key, ['customs', 'clearance'])) {
    return { status: 'in_transit', stage: 'customs', description: 'In customs clearance' };
  }
  if (includesAny(key, [
    'pickupdone',
    'pickedup',
    'receivedfromseller',
    'receivedfromshipper',
    'acceptedbycarrier',
  ])) {
    return { status: 'in_transit', stage: 'accepted', description: 'Shipment picked up' };
  }
  if (includesAny(key, [
    'creationconfirmed',
    'labelcreated',
    'shippinglabelcreated',
    'shipmentcreated',
    'informationreceived',
    'registered',
  ])) {
    return {
      status: 'pending',
      stage: 'registered',
      description: 'Shipment information received',
    };
  }
  if (includesAny(key, [
    'intransit',
    'swarexintransit',
    'received',
    'departed',
    'arrived',
    'sortcenter',
    'deliverycenter',
    'transport',
  ])) {
    return { status: 'in_transit', stage: 'in_transit', description: 'In transit' };
  }
  return UNKNOWN_STATUS;
}

export function amazonLogisticsStatus(value: unknown): CarrierStatus {
  return classifyStatus(value).status;
}

function eventDescription(raw: JsonObject, classified: ClassifiedStatus): string {
  const summary = isRecord(raw.statusSummary) ? raw.statusSummary : {};
  const key = [summary.localisedStringId, raw.eventCode, raw.subReasonCode]
    .map(statusKey)
    .join(' ');
  if (key.includes('creationconfirmed')) return 'Shipment information received';
  if (key.includes('pickupdone') || key.includes('detailpickedup')) return 'Shipment picked up';
  if (key.includes('arrivedatdeliverycenter')) return 'Arrived at delivery center';
  if (key.includes('arrivedatsortcenter')) return 'Arrived at sorting center';
  if (key.includes('departed')) return 'Departed facility';
  return classified.description;
}

function parseDate(value: unknown): ParsedDate | null {
  const raw = clean(value, 100);
  if (!raw) return null;
  const isoHasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const candidates = [
    DateTime.fromISO(raw, { setZone: isoHasZone, zone: 'Europe/Paris' }),
    DateTime.fromRFC2822(raw, { setZone: true }),
    ...[
      'LLL d, yyyy, h:mm:ss a',
      'LLL d, yyyy, h:mm a',
      'LLLL d, yyyy, h:mm:ss a',
      'LLLL d, yyyy, h:mm a',
    ].map((format) => DateTime.fromFormat(raw, format, {
      locale: 'en-US',
      zone: 'Europe/Paris',
    })),
  ];
  const parsed = candidates.find((candidate) => candidate.isValid);
  if (!parsed) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function parseSerializedRecord(value: unknown, field: string): JsonObject {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Amazon Shipping returned an invalid ${field}`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    throw new TypeError(`Amazon Shipping returned an invalid ${field}`, { cause: error });
  }
  throw new TypeError(`Amazon Shipping returned an invalid ${field}`);
}

function optionalSerializedRecord(value: unknown, field: string): JsonObject | null {
  if (value == null || value === 'null' || value === '') return null;
  return parseSerializedRecord(value, field);
}

function isNotFoundError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const key = `${statusKey(value.errorCode)} ${statusKey(value.errorMessage)}`;
  return key.includes('trackingidnotfound') || key.includes('invalidtrackingid');
}

function location(raw: unknown): string {
  if (!isRecord(raw)) return '';
  const values = [raw.city, raw.stateProvince, raw.countryCode]
    .map((value) => clean(value, 100))
    .filter((value, index, all) => value
      && all.findIndex((candidate) => candidate.toLocaleLowerCase('en-US')
        === value.toLocaleLowerCase('en-US')) === index);
  return values.join(', ').slice(0, 250);
}

function providerCode(value: unknown): string {
  const code = clean(value, 64);
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : '';
}

function eventRecords(value: JsonObject | null): JsonObject[] {
  const events = value?.eventHistory;
  return Array.isArray(events) ? events.filter(isRecord) : [];
}

function parseEvent(raw: JsonObject, sourceIndex: number): ParsedEvent | null {
  const summary = isRecord(raw.statusSummary) ? raw.statusSummary : {};
  const classified = classifyStatus(
    summary.localisedStringId,
    raw.eventCode,
    raw.subReasonCode,
  );
  const time = parseDate(raw.eventTime);
  const code = providerCode(raw.eventCode);
  if (!time && !code && classified.status === 'unknown') return null;
  const eventLocation = location(raw.location);
  return {
    classified,
    timestamp: time?.timestamp ?? Number.NEGATIVE_INFINITY,
    sourceIndex,
    event: {
      ...(time ? { time: time.iso } : {}),
      ...(eventLocation ? { location: eventLocation } : {}),
      description: eventDescription(raw, classified),
      stage: classified.stage,
      ...(code ? { provider_code: code } : {}),
    },
  };
}

function metadataValue(metadata: JsonObject, field: string): unknown {
  const value = metadata[field];
  if (!isRecord(value)) return value;
  return value.stringValue ?? value.date ?? value.value;
}

export function normalizeAmazonLogisticsTrackingNumber(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^FR\d{10}$/.test(value)) {
    throw new TypeError('Amazon Shipping France tracking numbers must start with FR followed by 10 digits');
  }
  return value;
}

export function amazonLogisticsTrackingUrl(rawTrackingNumber: string): string {
  const trackingNumber = normalizeAmazonLogisticsTrackingNumber(rawTrackingNumber);
  return `${TRACKING_ORIGIN}/tracking/${encodeURIComponent(trackingNumber)}`;
}

export function amazonLogisticsTrackingApiUrl(rawTrackingNumber: string): string {
  const trackingNumber = normalizeAmazonLogisticsTrackingNumber(rawTrackingNumber);
  return `${TRACKING_ORIGIN}/api/tracker/${encodeURIComponent(trackingNumber)}`;
}

export function parseAmazonLogisticsTrackingResponse(payload: unknown): CarrierResult {
  if (!isRecord(payload)) {
    throw new TypeError('Amazon Shipping returned an invalid tracking response');
  }
  const progress = parseSerializedRecord(payload.progressTracker, 'progress tracker');
  const errors = Array.isArray(progress.errors) ? progress.errors : [];
  if (errors.some(isNotFoundError)) throw new AmazonLogisticsTrackingError();

  const history = optionalSerializedRecord(payload.eventHistory, 'event history');
  const seen = new Set<string>();
  const parsedEvents: ParsedEvent[] = [];
  eventRecords(history).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, index) => {
    const parsed = parseEvent(raw, index);
    if (!parsed) return;
    const identity = JSON.stringify([
      parsed.event.time ?? '',
      parsed.event.location ?? '',
      parsed.event.provider_code ?? '',
      parsed.event.description ?? '',
    ]);
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push(parsed);
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || right.sourceIndex - left.sourceIndex
  ));
  const events = parsedEvents.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);

  const summary = isRecord(progress.summary) ? progress.summary : {};
  const metadata = isRecord(summary.metadata) ? summary.metadata : {};
  const tags = Array.isArray(summary.containerStatusTags)
    ? summary.containerStatusTags.join(' ')
    : '';
  const current = classifyStatus(
    metadataValue(metadata, 'trackingStatus'),
    summary.status,
    tags,
  );
  const latestKnown = parsedEvents.find((item) => item.classified.status !== 'unknown');
  const active = current.status !== 'unknown' ? current : latestKnown?.classified;
  if (!active) {
    throw new TypeError('Amazon Shipping returned incomplete tracking details');
  }

  const fallbackUpdate = [
    'deliveryDate',
    'pickupEventDate',
    'creationDate',
  ].map((field) => parseDate(metadataValue(metadata, field))).find(Boolean) ?? null;
  const expected = parseDate(
    progress.expectedDeliveryDate
      ?? metadataValue(metadata, 'expectedDeliveryDate')
      ?? metadataValue(metadata, 'promisedDeliveryDate'),
  );
  return {
    status: active.status,
    current_stage: active.stage,
    last_status_text: active.description,
    last_update: events[0]?.time ?? fallbackUpdate?.iso ?? null,
    expected_delivery: expected?.iso.slice(0, 10) ?? null,
    timezone: 'Europe/Paris',
    events,
  };
}

export class AmazonLogisticsTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Amazon Shipping timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeAmazonLogisticsTrackingNumber(rawTrackingNumber);
    const { bytes } = await fetchBounded(amazonLogisticsTrackingApiUrl(trackingNumber), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        Referer: amazonLogisticsTrackingUrl(trackingNumber),
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
    }, {
      provider: 'Amazon Shipping tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return parseAmazonLogisticsTrackingResponse(parseJsonBytes(bytes, 'Amazon Shipping'));
  }
}
