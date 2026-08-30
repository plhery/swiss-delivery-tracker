import 'server-only';

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { decodeText, fetchBounded, UpstreamHttpError } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';

const TRACKING_ENDPOINT = 'https://secure.extranet.ciblex.fr/extranet/client/corps.php';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 750_000;
const MAX_ROWS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
  description: string;
}

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  index: number;
}

function clean(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function comparableText(value: string): string {
  return clean(value)
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

function classifyStatus(rawDescription: string): ClassifiedStatus {
  const value = comparableText(rawDescription);
  if (includesAny(value, ['retour expediteur', 'retourne a l expediteur', 'retour a l expediteur'])) {
    return { status: 'exception', stage: 'returned', description: 'Returned to sender' };
  }
  if (includesAny(value, ['colis livre', 'livraison effectuee', 'remis au destinataire'])) {
    return { status: 'delivered', stage: 'delivered', description: 'Delivered' };
  }
  if (includesAny(value, ['mis en livraison', 'mise en livraison', 'en cours de livraison'])) {
    return { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' };
  }
  if (includesAny(value, ['disponible en relais', 'disponible au relais', 'mis a disposition'])) {
    return { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup' };
  }
  if (includesAny(value, [
    'complement adresse',
    'adresse incorrecte',
    'destinataire absent',
    'incident',
    'anomalie',
    'non livre',
    'refuse',
  ])) {
    return { status: 'exception', stage: 'failed_attempt', description: 'Delivery issue' };
  }
  if (includesAny(value, ['colis controle', 'colis en transit', 'arrive agence', 'depart agence'])) {
    return { status: 'in_transit', stage: 'in_transit', description: 'Parcel processed at Ciblex facility' };
  }
  if (includesAny(value, ['colis pris en charge', 'prise en charge'])) {
    return { status: 'in_transit', stage: 'accepted', description: 'Shipment collected' };
  }
  if (includesAny(value, ['annonce', 'information recue'])) {
    return { status: 'pending', stage: 'registered', description: 'Shipment information received' };
  }
  return { status: 'unknown', stage: 'in_transit', description: 'Ciblex tracking update' };
}

function parseEventTime(rawDate: string, rawTime: string): { iso: string; timestamp: number } | null {
  const value = `${clean(rawDate, 16)} ${clean(rawTime, 16)}`.trim();
  for (const format of ['dd/MM/yyyy HH:mm:ss', 'dd/MM/yyyy HH:mm', 'dd/MM/yyyy']) {
    const parsed = DateTime.fromFormat(value, format, { zone: 'Europe/Paris' });
    const iso = parsed.toISO({ suppressMilliseconds: true });
    if (parsed.isValid && iso) return { iso, timestamp: parsed.toMillis() };
  }
  return null;
}

function safeLocation(value: string): string {
  const location = clean(value, 100);
  // The public page formats Ciblex depots as "CITY 68 (68)". Requiring the
  // same department code both before and inside parentheses keeps this field
  // to operational depots instead of forwarding a free-form recipient address.
  const match = /^([\p{Letter}\p{Mark} .'\/-]{1,70}) (\d{2,3}) \(\2\)$/u.exec(location);
  return match ? location : '';
}

export class CiblexTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Ciblex could not locate the shipment');
    this.name = 'CiblexTrackingError';
  }
}

export function normalizeCiblexTrackingNumber(raw: string): string {
  const trackingNumber = raw.replace(/\s/g, '');
  if (!/^\d{14}$/.test(trackingNumber)) {
    throw new TypeError('Ciblex tracking numbers must contain exactly 14 digits');
  }
  return trackingNumber;
}

export function ciblexTrackingUrl(rawTrackingNumber: string): string {
  const trackingNumber = normalizeCiblexTrackingNumber(rawTrackingNumber);
  const url = new URL(TRACKING_ENDPOINT);
  url.search = new URLSearchParams({ module: 'colis', colis: trackingNumber }).toString();
  return url.toString();
}

function responseTrackingNumber(page: ReturnType<typeof load>): string {
  for (const element of page('.t_bandeau_detail td').toArray()) {
    const match = /SUIVI\s+COLIS\s*:\s*(\d{14})/i.exec(clean(page(element).text(), 100));
    if (match) return match[1]!;
  }
  return '';
}

export function parseCiblexTrackingHtml(
  html: string,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeCiblexTrackingNumber(rawTrackingNumber);
  // A valid unknown parcel normally returns an echoed empty table. A completely
  // empty 200 has also appeared transiently, so do not mislabel that outage as 404.
  if (!html.trim()) throw new TypeError('Ciblex returned an empty tracking response');
  const $ = load(html);
  const returnedNumber = responseTrackingNumber($);
  if (!returnedNumber) {
    if ($('.f_erreur').length > 0) throw new CiblexTrackingError();
    throw new TypeError('Ciblex did not return a shipment identifier');
  }
  if (returnedNumber !== trackingNumber) throw new RangeError('Ciblex returned a different shipment');

  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  $('table[border="2"] tr').slice(0, MAX_ROWS_TO_INSPECT).each((index, element) => {
    const cells = $(element).children('td').toArray().map((cell) => clean($(cell).text(), 200));
    if (cells.length !== 4 || comparableText(cells[0] ?? '') === 'date') return;
    const time = parseEventTime(cells[0] ?? '', cells[1] ?? '');
    const rawDescription = clean(cells[2], 200);
    if (!time || !rawDescription) return;
    const classified = classifyStatus(rawDescription);
    // Failure rows frequently describe recipient-address problems. Do not
    // retain their location cell even if it happens to resemble a depot.
    const location = classified.status === 'exception' ? '' : safeLocation(cells[3] ?? '');
    const identity = `${time.iso}\u0000${classified.stage}\u0000${location}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    parsed.push({
      event: {
        time: time.iso,
        location,
        description: classified.description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: time.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const limited = parsed.slice(0, MAX_EVENTS_TO_RETURN);
  if (limited.length === 0) throw new CiblexTrackingError();
  const latest = limited[0]!;
  const latestKnown = limited.find((item) => item.status !== 'unknown');
  return {
    status: latest.status !== 'unknown' ? latest.status : latestKnown?.status ?? 'unknown',
    current_stage: latest.status !== 'unknown'
      ? latest.event.stage ?? 'in_transit'
      : latestKnown?.event.stage ?? 'in_transit',
    last_status_text: latest.event.description ?? 'Tracking information received',
    last_update: latest.event.time ?? null,
    expected_delivery: null,
    timezone: 'Europe/Paris',
    events: limited.map(({ event }) => event),
  };
}

export class CiblexTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Ciblex timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeCiblexTrackingNumber(rawTrackingNumber);
    const result = await fetchBounded(ciblexTrackingUrl(trackingNumber), {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: 'https://ciblex.eu/suivi-colis-express/',
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
    }, {
      provider: 'Ciblex tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
    });
    if (result.response.status === 404) throw new CiblexTrackingError();
    if (!result.response.ok) {
      throw new UpstreamHttpError('Ciblex tracking', result.response.status);
    }
    return parseCiblexTrackingHtml(decodeText(result.bytes), trackingNumber);
  }
}
