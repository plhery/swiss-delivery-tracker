import 'server-only';

import { decodeText, fetchBounded, parseJsonBytes, UpstreamHttpError } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord } from './types';

const TRACKING_ENDPOINT = 'https://www.colisweb.com/api/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 500_000;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
  description: string;
}

export class ColiswebTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Colisweb could not locate the shipment');
    this.name = 'ColiswebTrackingError';
  }
}

export class ColiswebIndeterminateLookupError extends Error {
  readonly status = 502;
  readonly upstreamStatus = 500;

  constructor() {
    super('Colisweb returned an empty HTTP 500 for the shipment lookup');
    this.name = 'ColiswebIndeterminateLookupError';
  }
}

function cleanText(value: string, maxLength = 100): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function statusKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '')
    : '';
}

function classifyStatus(value: unknown): ClassifiedStatus {
  const key = statusKey(value);
  if (['delivered', 'deliverypbok'].includes(key)) {
    return { status: 'delivered', stage: 'delivered', description: 'Livraison effectuée' };
  }
  if (['packagereturned', 'deliveryreturned', 'packagereturnfailed', 'deliveryreturnfailed']
    .includes(key)) {
    return { status: 'exception', stage: 'returned', description: 'Colis retourné' };
  }
  if (['canceled', 'cancelled', 'deliverycanceled', 'deliverycancelled'].includes(key)) {
    return { status: 'exception', stage: 'returned', description: 'Livraison annulée' };
  }
  if (['nondeliverable', 'pickupfailed', 'packagewithdrawalfailed', 'deliveryfailed']
    .includes(key)) {
    return { status: 'exception', stage: 'failed_attempt', description: 'Incident de livraison' };
  }
  if (['outfordelivery', 'deliveryinprogress'].includes(key)) {
    return {
      status: 'out_for_delivery',
      stage: 'out_for_delivery',
      description: 'Livraison en cours',
    };
  }
  if (['pickedup', 'packagewithdrawn', 'packagewithdrawalpbok'].includes(key)) {
    return { status: 'in_transit', stage: 'in_transit', description: 'Colis pris en charge' };
  }
  if (['idle', 'confirmed', 'courseaccepted'].includes(key)) {
    return { status: 'pending', stage: 'registered', description: 'Livraison confirmée' };
  }
  return { status: 'unknown', stage: 'in_transit', description: 'Mise à jour Colisweb' };
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = cleanText(value, 64);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : null;
}

function normalizedDate(value: unknown): string | null {
  const timestamp = normalizedTimestamp(value);
  if (!timestamp) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
  return match?.[1] ?? new Date(timestamp).toISOString().slice(0, 10);
}

function saysNotFound(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const text = [value.error, value.message, value.texteErreur]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return /not[ -]?found|introuvable|inconnu|aucun(?:e)? livraison/i.test(text);
}

export function normalizeColiswebTrackingNumber(raw: string): string {
  const value = raw.replace(/\s/g, '');
  if (!/^\d{8,32}$/.test(value)) {
    throw new TypeError('Colisweb tracking numbers must contain at least 8 digits');
  }
  return value;
}

export function coliswebTrackingUrl(): string {
  return TRACKING_ENDPOINT;
}

export function coliswebRequestBody(rawTrackingNumber: string): string {
  return JSON.stringify({ value: normalizeColiswebTrackingNumber(rawTrackingNumber) });
}

export function parseColiswebTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeColiswebTrackingNumber(rawTrackingNumber);
  if (saysNotFound(payload)) throw new ColiswebTrackingError();
  if (!isRecord(payload)) throw new TypeError('Colisweb returned an invalid tracking response');

  const responseNumber = typeof payload.searchValue === 'string'
    ? payload.searchValue.replace(/\s/g, '')
    : '';
  if (!/^\d{8,32}$/.test(responseNumber)) {
    throw new TypeError('Colisweb returned incomplete tracking details');
  }
  if (responseNumber !== trackingNumber) throw new RangeError('Colisweb returned a different shipment');

  const current = classifyStatus(payload.step);
  const milestones: Array<{ value: unknown; classified: ClassifiedStatus }> = [
    {
      value: payload.deliveredDate,
      classified: classifyStatus('delivered'),
    },
    {
      value: payload.pickedUpDate,
      classified: classifyStatus('pickedUp'),
    },
    {
      value: payload.deliveryConfirmationDate,
      classified: classifyStatus('confirmed'),
    },
  ];
  const events: CarrierEvent[] = milestones.flatMap(({ value, classified }) => {
    const time = normalizedTimestamp(value);
    return time ? [{ time, description: classified.description, stage: classified.stage }] : [];
  });
  if (!events.some((event) => event.stage === current.stage)) {
    events.unshift({ description: current.description, stage: current.stage });
  }
  const lastUpdate = events.find((event) => event.time)?.time ?? null;

  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: current.description,
    last_update: lastUpdate,
    expected_delivery: ['delivered', 'exception'].includes(current.status)
      ? null
      : normalizedDate(payload.startsAt),
    timezone: 'Europe/Paris',
    events,
  };
}

export class ColiswebTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Colisweb timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeColiswebTrackingNumber(rawTrackingNumber);
    const { response, bytes } = await fetchBounded(coliswebTrackingUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://www.colisweb.com',
        Referer: 'https://www.colisweb.com/suivi-livraison',
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
      body: coliswebRequestBody(trackingNumber),
    }, {
      provider: 'Colisweb tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'error',
      allowHttpError: true,
    });

    if ([400, 404, 422].includes(response.status)) throw new ColiswebTrackingError();
    if (response.status === 500 && bytes.byteLength === 0) {
      throw new ColiswebIndeterminateLookupError();
    }
    if (!response.ok) {
      const text = decodeText(bytes);
      if (/not[ -]?found|introuvable|inconnu/i.test(text)) throw new ColiswebTrackingError();
      throw new UpstreamHttpError('Colisweb tracking', response.status);
    }
    return parseColiswebTrackingResponse(
      parseJsonBytes(bytes, 'Colisweb tracking'),
      trackingNumber,
    );
  }
}
