import 'server-only';

import { DateTime } from 'luxon';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_API = 'https://www.laposte.fr/ssu/sun/back/suivi-unifie';
const TRACKING_PAGE = 'https://www.laposte.fr/outils/suivre-vos-envois';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;

const GROUP_STATUSES = new Map<string, CarrierStatus>([
  ['EXPANN', 'pending'],
  ['ACHNAT', 'in_transit'],
  ['DISARR', 'in_transit'],
  ['DISTOU', 'out_for_delivery'],
  ['DISMAD', 'out_for_delivery'],
  ['DESBAL', 'delivered'],
  ['DESTIN', 'delivered'],
  ['DESLIVD', 'delivered'],
  ['RETOUR', 'exception'],
]);

const CODE_STATUSES = new Map<string, CarrierStatus>([
  ['DR1', 'pending'],
  ['PC1', 'in_transit'],
  ['ET1', 'in_transit'],
  ['EP1', 'in_transit'],
  ['MD1', 'out_for_delivery'],
  ['DI1', 'delivered'],
]);

function clean(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? value.trim().split(/\s+/).filter(Boolean).join(' ').slice(0, maxLength)
    : '';
}

function comparable(value: unknown): string {
  return clean(value)
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function labelStatus(label: string, hasEvents: boolean): CarrierStatus {
  const value = comparable(label);
  if (['retour', 'incident', 'echec', 'impossible', 'refuse', 'non livre']
    .some((term) => value.includes(term))) return 'exception';
  if (['tournee', 'en cours de livraison', 'distribution ce jour']
    .some((term) => value.includes(term))) return 'out_for_delivery';
  if (['va etre livre', 'sera livre', 'doit etre livre', 'pret a etre livre']
    .some((term) => value.includes(term))) return 'in_transit';
  if (
    /^(?:livre|livree|livres|livrees)\b/.test(value)
    || /\b(?:a ete|est) (?:livre|livree|livres|livrees)\b/.test(value)
    || /\b(?:colis|courrier|envoi|pli) (?:livre|livree|livres|livrees)\b/.test(value)
    || ['livraison effectuee', 'remis au destinataire', 'distribue']
      .some((term) => value.includes(term))
  ) return 'delivered';
  if (hasEvents || ['transit', 'acheminement', 'pris en charge', 'arrive']
    .some((term) => value.includes(term))) return 'in_transit';
  if (['annonce', 'information recue', 'prepare']
    .some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

function eventStatus(
  group: string,
  code: string,
  label: string,
  hasEvents: boolean,
): CarrierStatus {
  const described = labelStatus(label, false);
  if (described === 'exception') return described;
  return CODE_STATUSES.get(code.toLocaleUpperCase('en-US'))
    ?? GROUP_STATUSES.get(group.toLocaleUpperCase('en-US'))
    ?? (described !== 'unknown' ? described : labelStatus(label, hasEvents));
}

function eventStage(group: string, code: string, label: string): string {
  const normalizedGroup = group.toLocaleUpperCase('en-US');
  const normalizedCode = code.toLocaleUpperCase('en-US');
  const value = comparable(label);
  if (normalizedGroup === 'RETOUR' || value.includes('retour')) {
    return 'returned';
  }
  if (
    normalizedGroup === 'DISMAD'
    || ['disponible au point de retrait', 'disponible en point relais', 'attend au relais']
      .some((term) => value.includes(term))
  ) return 'ready_for_pickup';
  const status = eventStatus(normalizedGroup, normalizedCode, label, true);
  if (status === 'pending') return 'registered';
  if (status === 'out_for_delivery') return 'out_for_delivery';
  if (status === 'delivered') return 'delivered';
  if (status === 'exception') return 'failed_attempt';
  if (normalizedCode === 'PC1') return 'accepted';
  return 'in_transit';
}

function eventOrder(event: JsonObject): number {
  return number(event.order) ?? -1;
}

function safeDate(value: unknown): string {
  const raw = clean(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:+.Z-]+)?$/i.test(raw)) return '';
  return DateTime.fromISO(raw, { setZone: true }).isValid ? raw : '';
}

function expectedDate(value: unknown): string | null {
  const text = safeDate(value);
  return /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? null;
}

export class LaPosteTrackingError extends Error {
  readonly status: number | undefined;

  constructor(readonly code: number | null, message: string) {
    super(message);
    this.name = 'LaPosteTrackingError';
    this.status = code === 104 ? 404 : undefined;
  }
}

function laPosteError(code: number | null): LaPosteTrackingError {
  return new LaPosteTrackingError(
    code,
    code === 104 ? 'La Poste could not locate the shipment' : 'La Poste tracking is unavailable',
  );
}

export function normalizeLaPosteTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  const domestic = /^[A-Z0-9]{2}\d{11}$/.test(value);
  const international = /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(value);
  const foreignExpress = /^\d{14}[A-Z]$/.test(value);
  if (!domestic && !international && !foreignExpress) {
    throw new TypeError('La Poste tracking numbers must use a supported 13- or 15-character format');
  }
  return value;
}

export function laPosteTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('code', normalizeLaPosteTrackingNumber(trackingNumber));
  return url.toString();
}

export function laPosteTrackingApiUrl(trackingNumber: string): string {
  const normalized = normalizeLaPosteTrackingNumber(trackingNumber);
  const url = new URL(`${TRACKING_API}/${encodeURIComponent(normalized)}`);
  url.searchParams.set('lang', 'fr');
  return url.toString();
}

export function parseLaPosteTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  const requested = normalizeLaPosteTrackingNumber(trackingNumber);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new TypeError('La Poste returned an invalid tracking response');
  }

  const responses = payload.filter(isRecord);
  if (responses.length === 0) {
    throw new TypeError('La Poste returned an invalid tracking response');
  }
  const response = responses.find((candidate) => {
    const shipment = isRecord(candidate.shipment) ? candidate.shipment : {};
    return clean(shipment.idShip, 64).toLocaleUpperCase('en-US') === requested;
  });
  if (!response) {
    const providerError = responses.find((candidate) => ![0, 200].includes(number(candidate.returnCode) ?? -1));
    if (providerError) {
      throw laPosteError(number(providerError.returnCode));
    }
    throw new RangeError('La Poste returned a different shipment');
  }

  const returnCode = number(response.returnCode);
  if (returnCode === null || ![0, 200].includes(returnCode)) {
    throw laPosteError(returnCode);
  }
  const shipment = isRecord(response.shipment) ? response.shipment : {};
  const rawEvents = records(shipment.event).sort((left, right) => {
    const orderDifference = eventOrder(right) - eventOrder(left);
    if (orderDifference !== 0) return orderDifference;
    return safeDate(right.date).localeCompare(safeDate(left.date));
  });
  const events: CarrierEvent[] = rawEvents.slice(0, 100).flatMap((event) => {
    const description = clean(event.label);
    const time = safeDate(event.date);
    if (!description && !time) return [];
    const group = clean(event.group, 40).toLocaleUpperCase('en-US');
    const code = clean(event.code, 40).toLocaleUpperCase('en-US');
    return [{
      time,
      location: clean(event.country, 80),
      description: description || 'Tracking update',
      stage: eventStage(group, code, description),
      ...(group || code ? { provider_code: [group, code].filter(Boolean).join('/') } : {}),
    }];
  });

  const latestRaw = rawEvents[0] ?? {};
  const latest = events[0];
  const timeline = records(shipment.timeline)
    .filter((step) => step.status === true)
    .sort((left, right) => (number(right.id) ?? -1) - (number(left.id) ?? -1));
  const currentState = isRecord(shipment.currentState) ? shipment.currentState : {};
  const fallbackLabel = clean(currentState.shortLabel) || clean(timeline[0]?.shortLabel);
  const latestLabel = latest?.description || fallbackLabel || clean(response.returnMessage);
  const latestGroup = clean(latestRaw.group, 40);
  const latestCode = clean(latestRaw.code, 40);
  return {
    status: eventStatus(latestGroup, latestCode, latestLabel, events.length > 0),
    last_status_text: latestLabel || 'Tracking information received',
    last_update: latest?.time || safeDate(timeline[0]?.date) || null,
    expected_delivery: shipment.isFinal === true ? null : expectedDate(shipment.estimDate),
    timezone: 'Europe/Paris',
    events,
  };
}

export class LaPosteTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('La Poste timeout must be positive');
    }
  }

  async fetch(trackingNumber: string): Promise<CarrierResult> {
    const normalized = normalizeLaPosteTrackingNumber(trackingNumber);
    const { bytes } = await fetchBounded(laPosteTrackingApiUrl(normalized), {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: laPosteTrackingUrl(normalized),
        'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
      },
    }, {
      provider: 'La Poste tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return parseLaPosteTrackingResponse(parseJsonBytes(bytes, 'La Poste'), normalized);
  }
}
