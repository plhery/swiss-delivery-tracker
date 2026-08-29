import 'server-only';

import { load } from 'cheerio';
import { decodeText, fetchBounded, UpstreamHttpError } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';

const TRACKING_ENDPOINT = 'https://colisprive.com/moncolis/pages/DetailColis.aspx';
const MAX_RESPONSE_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
}

function cleanText(value: string, maxLength = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function comparableText(value: string): string {
  return cleanText(value)
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
    'avons tente de livrer',
    'n avons pas pu livrer',
    'echec de livraison',
    'n a pas pu etre livre',
    'subi un retard',
    'adresse incorrecte',
    'incident',
    'anomalie',
    'endommage',
    'refuse',
    'perdu',
  ])) return { status: 'exception', stage: 'failed_attempt' };

  if (includesAny(value, [
    'a ete livre',
    'vous a ete remis au relais',
    'remis au destinataire',
    'livraison effectuee',
  ])) return { status: 'delivered', stage: 'delivered' };

  if (includesAny(value, [
    'vous attend au relais',
    'disponible au relais',
    'disponible en point relais',
    'disponible en consigne',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };

  if (includesAny(value, [
    'en cours de distribution par le livreur',
    'en cours de livraison par le livreur',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };

  if (includesAny(value, [
    'en cours de preparation par l expediteur',
    'sera confie prochainement',
    'information transmise par l expediteur',
  ])) return { status: 'pending', stage: 'registered' };

  if (includesAny(value, [
    'pris en charge',
    'en cours d acheminement',
    'arrive sur notre agence',
    'arrive dans notre agence',
    'expedie vers',
    'va etre prochainement depose',
    'a ete collecte',
  ])) return { status: 'in_transit', stage: 'in_transit' };

  return { status: 'unknown', stage: 'in_transit' };
}

function shipmentPart(credential: string): string {
  return credential.slice(0, 12);
}

function displayedShipmentNumber(value: string): string {
  return value.replace(/\s/g, '').toLocaleUpperCase('en-US');
}

function dateKey(value: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return timestamp;
}

export class ColisPriveTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Colis Privé could not locate the shipment');
    this.name = 'ColisPriveTrackingError';
  }
}

export function normalizeColisPriveCredential(raw: string): string {
  const credential = raw.trim().toLocaleUpperCase('en-US');
  if (!/^[A-Z0-9]{12}(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/.test(credential)) {
    throw new TypeError(
      'Colis Privé tracking requires the 12-character shipment number followed by the 5-digit recipient postcode',
    );
  }
  return credential;
}

export function colisPriveTrackingUrl(rawCredential: string): string {
  const credential = normalizeColisPriveCredential(rawCredential);
  const url = new URL(TRACKING_ENDPOINT);
  url.searchParams.set('numColis', credential);
  url.searchParams.set('lang', 'fr');
  return url.toString();
}

export function parseColisPriveTrackingHtml(
  html: string,
  rawCredential: string,
): CarrierResult {
  const credential = normalizeColisPriveCredential(rawCredential);
  if (!html.trim()) throw new TypeError('Colis Privé returned an empty tracking response');

  const $ = load(html);
  // This section contains the recipient's name and full delivery address. Remove it
  // before reading any text from the response and never include it in adapter output.
  $('.divDesti').remove();

  const banner = $('.BandeauInfoColis').first();
  if (banner.length === 0) {
    throw new TypeError('Colis Privé did not return tracking details');
  }

  const responseNumber = displayedShipmentNumber(banner.find('.divColis .tdText').first().text());
  if (!/^[A-Z0-9]{12}$/.test(responseNumber)) {
    throw new TypeError('Colis Privé returned an invalid shipment number');
  }
  if (responseNumber !== shipmentPart(credential)) {
    throw new RangeError('Colis Privé returned a different shipment');
  }

  const statusText = cleanText(banner.find('.divStatut .tdText').first().text());
  if (!statusText) throw new TypeError('Colis Privé did not return a shipment status');

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  $('.tableHistoriqueColis tr.bandeauText').each((index, element) => {
    const row = $(element);
    const time = cleanText(row.children('td[headers="th-date"]').first().text(), 32);
    const description = cleanText(row.children('td[headers="th-statut"]').first().text());
    const timestamp = dateKey(time);
    if (timestamp === null || !description) return;
    const identity = `${time}\u0000${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsedEvents.push({
      event: {
        time,
        location: '',
        description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp,
      index,
    });
  });
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsedEvents.slice(0, 100).map(({ event }) => event);

  const current = classifyStatus(statusText);
  const status = current.status !== 'unknown'
    ? current.status
    : parsedEvents.find((event) => event.status !== 'unknown')?.status ?? 'unknown';
  return {
    status,
    last_status_text: statusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    timezone: 'Europe/Paris',
    events,
  };
}

export class ColisPriveTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Colis Privé timeout must be positive');
    }
  }

  async fetch(rawCredential: string): Promise<CarrierResult> {
    const credential = normalizeColisPriveCredential(rawCredential);
    const { response, bytes } = await fetchBounded(colisPriveTrackingUrl(credential), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
      },
    }, {
      provider: 'Colis Privé tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      allowHttpError: true,
    });

    if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
      throw new ColisPriveTrackingError();
    }
    if (!response.ok) {
      throw new UpstreamHttpError('Colis Privé tracking', response.status);
    }
    return parseColisPriveTrackingHtml(decodeText(bytes), credential);
  }
}
