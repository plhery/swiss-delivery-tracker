import { isRecord, type JsonObject } from './types';

export type CarrierStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface CarrierEvent extends JsonObject {
  time?: string;
  location?: string;
  description?: string;
  stage?: string;
  provider_code?: string;
}

export interface CarrierResult extends JsonObject {
  status?: CarrierStatus;
  last_status_text?: string | null;
  last_update?: string | null;
  expected_delivery?: string | null;
  timezone?: string;
  events?: CarrierEvent[];
}

const STATUSES = new Set<CarrierStatus>([
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
]);
const OPTIONAL_TEXT_FIELDS = [
  'last_status_text',
  'last_update',
  'expected_delivery',
  'timezone',
] as const;
const EVENT_TEXT_FIELDS = ['time', 'location', 'description', 'stage'] as const;

export function normalizeCarrierResult(value: unknown): CarrierResult {
  if (!isRecord(value)) throw new TypeError('The carrier adapter returned an invalid response');
  const normalized: CarrierResult = { ...value };
  normalized.status = typeof value.status === 'string' && STATUSES.has(value.status as CarrierStatus)
    ? value.status as CarrierStatus
    : 'unknown';

  for (const field of OPTIONAL_TEXT_FIELDS) {
    const fieldValue = normalized[field];
    if (fieldValue != null && typeof fieldValue !== 'string') {
      throw new TypeError(`The carrier adapter returned an invalid ${field.replaceAll('_', ' ')}`);
    }
  }

  const rawEvents = normalized.events ?? [];
  if (!Array.isArray(rawEvents)) {
    throw new TypeError('The carrier adapter returned invalid tracking events');
  }
  normalized.events = rawEvents.map((rawEvent) => {
    if (!isRecord(rawEvent)) {
      throw new TypeError('The carrier adapter returned an invalid tracking event');
    }
    for (const field of EVENT_TEXT_FIELDS) {
      const fieldValue = rawEvent[field];
      if (fieldValue != null && typeof fieldValue !== 'string') {
        throw new TypeError('The carrier adapter returned an invalid tracking event');
      }
    }
    return { ...rawEvent } as CarrierEvent;
  });
  return normalized;
}
