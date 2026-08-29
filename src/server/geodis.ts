import 'server-only';

import { createHash } from 'node:crypto';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_ENDPOINT =
  'https://espace-client.geodis.com/services/api/destinataire/recherche-envoi-anonyme';
const TRACKING_PAGE = 'https://espace-client.geodis.com/services/destinataires/';
const SIGNED_API_PATH = 'api/destinataire/recherche-envoi-anonyme';
const PUBLIC_SPA_APP_ID = '$DESTINATAIRE';
// This is a public client identifier shipped in GEODIS's anonymous recipient SPA,
// not an account credential. It can rotate when that SPA is deployed.
const PUBLIC_SPA_APP_KEY = '21aed7a2f03d45ab9cbcd61cd7a2461d'; // gitleaks:allow
const LANGUAGE = 'fr';
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
}

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  index: number;
}

function text(value: unknown, limit = 500): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function comparableText(value: string): string {
  return text(value)
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value: string, phrases: string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

function classifyStatus(description: string): ClassifiedStatus {
  const value = comparableText(description);
  if (includesAny(value, [
    'retour a l expediteur',
    'retourne a l expediteur',
    'retour expediteur',
  ])) return { status: 'exception', stage: 'returned' };
  if (includesAny(value, [
    'non livre',
    'impossible de livrer',
    'echec de livraison',
    'livraison echouee',
    'incident',
    'anomalie',
    'avarie',
    'endommage',
    'refuse',
    'destinataire absent',
  ])) return { status: 'exception', stage: 'failed_attempt' };
  if (includesAny(value, [
    'pret a etre retire',
    'disponible pour retrait',
    'mis a disposition',
    'a retirer en agence',
    'retrait disponible',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  if (includesAny(value, [
    'en cours de livraison',
    'livraison en cours',
    'en distribution',
    'tournee de livraison',
    'conducteur en route',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  if (includesAny(value, [
    'va etre livre',
    'sera livre',
    'doit etre livre',
    'pret a etre livre',
  ])) return { status: 'in_transit', stage: 'in_transit' };
  if (
    /^(?:livre|livree|livres|livrees)\b/.test(value)
    || /\b(?:a ete|est) (?:livre|livree|livres|livrees)\b/.test(value)
    || /\b(?:colis|courrier|envoi|pli) (?:livre|livree|livres|livrees)\b/.test(value)
    || includesAny(value, [
      'livraison effectuee',
      'remis au destinataire',
      'retire par le destinataire',
    ])
  ) return { status: 'delivered', stage: 'delivered' };
  if (includesAny(value, [
    'en attente de recuperation',
    'en attente de prise en charge',
    'information transmise',
    'commande recue',
    'enregistre',
  ])) return { status: 'pending', stage: 'registered' };
  if (includesAny(value, [
    'pris en charge',
    'acheminement',
    'en transit',
    'arrive',
    'depart',
    'agence',
    'centre',
    'transport',
  ])) return { status: 'in_transit', stage: 'in_transit' };
  return { status: 'unknown', stage: 'in_transit' };
}

function dateTimestamp(value: string): number | null {
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  let year: number;
  let month: number;
  let day: number;
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? timestamp
    : null;
}

function eventTime(dateValue: unknown, timeValue: unknown): { value: string; timestamp: number } | null {
  const date = text(dateValue, 32);
  const timestamp = dateTimestamp(date);
  if (timestamp === null) return null;
  const clock = text(timeValue, 16);
  if (!clock) return { value: date, timestamp };
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(clock);
  if (!match) return { value: date, timestamp };
  const withClock = timestamp
    + Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3] ?? 0) * 1_000;
  return { value: `${date} ${clock}`, timestamp: withClock };
}

function expectedDelivery(value: unknown): string | null {
  const raw = text(value, 32);
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = french
    ? `${french[3]}-${french[2]}-${french[1]}`
    : iso
      ? raw
      : '';
  return date && dateTimestamp(date) !== null ? date : null;
}

function parseEvents(content: JsonObject): ParsedEvent[] {
  if (!Array.isArray(content.listJoursSuivis)) return [];
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const rawDay of content.listJoursSuivis) {
    if (!isRecord(rawDay) || !Array.isArray(rawDay.suivis)) continue;
    for (const rawEvent of rawDay.suivis) {
      const currentIndex = index++;
      if (!isRecord(rawEvent)) continue;
      const time = eventTime(rawDay.dateSuivi, rawEvent.heureSuivi);
      const description = text(rawEvent.libelleSuivi);
      if (!time || !description) continue;
      const location = text(rawEvent.libelleCentre, 160);
      const identity = JSON.stringify([time.value, location, description]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const classified = classifyStatus(description);
      parsed.push({
        event: {
          time: time.value,
          location,
          description,
          stage: classified.stage,
        },
        status: classified.status,
        timestamp: time.timestamp,
        index: currentIndex,
      });
    }
  }
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  return parsed.slice(0, 100);
}

function activeTimelineLabel(content: JsonObject): string {
  if (!isRecord(content.timeline) || !Array.isArray(content.timeline.listTimesteps)) return '';
  for (const rawStep of content.timeline.listTimesteps) {
    if (isRecord(rawStep) && rawStep.actif === true) return text(rawStep.libelle);
  }
  return '';
}

export class GeodisTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('GEODIS could not locate the shipment');
    this.name = 'GeodisTrackingError';
  }
}

function isNotFoundCode(value: unknown): boolean {
  const code = comparableText(text(value, 100));
  return includesAny(code, ['envoi non trouve', 'shipment not found', 'tracking not found']);
}

export function normalizeGeodisTrackingNumber(raw: string): string {
  const trackingNumber = raw.trim().toLocaleUpperCase('en-US');
  if (!/^1G[A-Z0-9]{10}$/.test(trackingNumber)) {
    throw new TypeError('GEODIS tracking numbers must start with 1G and contain 12 letters and digits');
  }
  return trackingNumber;
}

export function geodisTrackingUrl(): string {
  return TRACKING_ENDPOINT;
}

export function geodisRequestBody(rawTrackingNumber: string): string {
  return JSON.stringify({ noSuivi: normalizeGeodisTrackingNumber(rawTrackingNumber) });
}

export function geodisServiceHeader(
  rawTrackingNumber: string,
  timestamp: number,
  language = LANGUAGE,
): string {
  const trackingNumber = normalizeGeodisTrackingNumber(rawTrackingNumber);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError('GEODIS signature timestamp must be a positive integer');
  }
  if (!/^[a-z]{2}$/.test(language)) throw new TypeError('GEODIS signature language is invalid');
  const body = geodisRequestBody(trackingNumber);
  const material = [
    PUBLIC_SPA_APP_KEY,
    PUBLIC_SPA_APP_ID,
    String(timestamp),
    language,
    SIGNED_API_PATH,
    body,
  ].join(';');
  const digest = createHash('sha256').update(material).digest('hex');
  return [PUBLIC_SPA_APP_ID, String(timestamp), language, digest].join(';');
}

export function parseGeodisTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeGeodisTrackingNumber(rawTrackingNumber);
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
    throw new TypeError('GEODIS returned an invalid tracking response');
  }
  if (!payload.ok) {
    if (isNotFoundCode(payload.codeErreur)) throw new GeodisTrackingError();
    throw new Error('GEODIS tracking is unavailable');
  }
  if (!isRecord(payload.contenu)) {
    throw new TypeError('GEODIS returned incomplete tracking details');
  }
  const content = payload.contenu;
  const responseNumber = text(content.noSuivi, 32).toLocaleUpperCase('en-US');
  if (!/^1G[A-Z0-9]{10}$/.test(responseNumber)) {
    throw new TypeError('GEODIS returned an invalid shipment number');
  }
  if (responseNumber !== trackingNumber) throw new RangeError('GEODIS returned a different shipment');

  const parsedEvents = parseEvents(content);
  const events = parsedEvents.map(({ event }) => event);
  const timelineLabel = activeTimelineLabel(content);
  const latestDescription = events[0]?.description ?? '';
  const currentDescription = timelineLabel || latestDescription || 'Tracking information received';
  const current = classifyStatus(currentDescription);
  const latestKnown = parsedEvents.find((event) => event.status !== 'unknown')?.status ?? 'unknown';
  let status = current.status !== 'unknown' ? current.status : latestKnown;
  if (content.etatLivre === true || content.etatRetire === true) status = 'delivered';
  else if (content.finDeVie === true && status !== 'delivered') status = 'exception';
  const isFinal = content.etatLivre === true
    || content.etatRetire === true
    || content.finDeVie === true;

  return {
    status,
    last_status_text: currentDescription,
    last_update: events[0]?.time ?? null,
    expected_delivery: isFinal
      ? null
      : expectedDelivery(content.dateLivraisonPrevue)
        ?? expectedDelivery(content.dateLivraisonSouhaitee),
    timezone: 'Europe/Paris',
    events,
  };
}

export class GeodisTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('GEODIS timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeGeodisTrackingNumber(rawTrackingNumber);
    const body = geodisRequestBody(trackingNumber);
    const timestamp = Date.now();
    const { bytes } = await fetchBounded(geodisTrackingUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://espace-client.geodis.com',
        Referer: TRACKING_PAGE,
        'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
        'X-GEODIS-Service': geodisServiceHeader(trackingNumber, timestamp),
      },
      body,
    }, {
      provider: 'GEODIS tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    return parseGeodisTrackingResponse(parseJsonBytes(bytes, 'GEODIS'), trackingNumber);
  }
}
