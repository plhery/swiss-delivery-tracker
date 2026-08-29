import 'server-only';

import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { DateTime } from 'luxon';
import { CookieJar } from 'tough-cookie';
import { decodeText, fetchBounded, UpstreamHttpError } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';

const TRACKING_PAGE = 'https://www.relaiscolis.com/colis/suivre';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 750_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0';

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

function cleanText(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
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
    'retourne a votre vendeur',
    'retour a votre vendeur',
    'retour vendeur',
  ])) return { status: 'exception', stage: 'returned' };

  if (includesAny(value, [
    'livraison impossible',
    'echec de livraison',
    'incident de livraison',
    'adresse incorrecte',
    'colis endommage',
    'colis refuse',
    'colis perdu',
    'destinataire absent',
    'n a pas pu etre livre',
  ])) return { status: 'exception', stage: 'failed_attempt' };

  if (includesAny(value, [
    'disponible dans votre relais',
    'disponible au relais',
    'disponible en relais',
    'mis a disposition dans votre relais',
    'vous attend dans votre relais',
    'a retirer dans votre relais',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };

  if (includesAny(value, [
    'en cours de livraison',
    'en cours de distribution',
    'livraison dans votre relais',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };

  if (includesAny(value, [
    'retire par le destinataire',
    'remis au destinataire',
    'remis a son destinataire',
    'livraison effectuee',
  ]) || /\b(?:colis|commande) (?:a ete|est) livre\b/.test(value)) {
    return { status: 'delivered', stage: 'delivered' };
  }

  if (includesAny(value, [
    'commande enregistree',
    'colis annonce',
    'colis a ete annonce',
    'information transmise',
    'en attente de prise en charge',
    'sera prochainement confie',
  ])) return { status: 'pending', stage: 'registered' };

  if (includesAny(value, [
    'pris en charge',
    'en cours d acheminement',
    'en transit',
    'arrive dans notre agence',
    'arrive sur notre agence',
    'a quitte notre agence',
    'achemine vers',
    'expedie vers',
  ])) return { status: 'in_transit', stage: 'in_transit' };

  return { status: 'unknown', stage: 'in_transit' };
}

function parsedEventTime(value: string): { iso: string; timestamp: number } | null {
  const normalized = value.replace(/\s+(?:a|à)\s+/i, ' ').replace(/(\d{1,2})h(\d{2})/i, '$1:$2');
  for (const format of ['dd/MM/yyyy HH:mm', 'dd/MM/yyyy']) {
    const parsed = DateTime.fromFormat(normalized, format, { zone: 'Europe/Paris' });
    const iso = parsed.toISO({ suppressMilliseconds: true });
    if (parsed.isValid && iso) return { iso, timestamp: parsed.toMillis() };
  }
  return null;
}

export class RelaisColisTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Relais Colis could not locate the shipment');
    this.name = 'RelaisColisTrackingError';
  }
}

export function normalizeRelaisColisTrackingNumber(raw: string): string {
  const trackingNumber = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{10,16}$/.test(trackingNumber) || !/\d/.test(trackingNumber)) {
    throw new TypeError('Relais Colis tracking numbers must contain 10 to 16 letters and digits');
  }
  return trackingNumber;
}

export function relaisColisTrackingUrl(): string {
  return TRACKING_PAGE;
}

function responseTrackingNumber(page: ReturnType<typeof load>): string {
  const value = cleanText(page('#track_package_trackingNumber').first().attr('value'), 32);
  if (!value) return '';
  try {
    return normalizeRelaisColisTrackingNumber(value);
  } catch {
    return '';
  }
}

export function parseRelaisColisTrackingHtml(
  html: string,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeRelaisColisTrackingNumber(rawTrackingNumber);
  if (!html.trim()) throw new TypeError('Relais Colis returned an empty tracking response');

  const $ = load(html);
  const returnedNumber = responseTrackingNumber($);
  if (!returnedNumber) throw new TypeError('Relais Colis did not return a shipment identifier');
  if (returnedNumber !== trackingNumber) throw new RangeError('Relais Colis returned a different shipment');

  // These blocks can contain the recipient, delivery address, phone number and
  // pickup-point details. Remove them before reading any response text, and emit
  // only the provider's status/date fields below.
  $('.follow-address, .follow-address-box, [data-recipient], [data-delivery-address]').remove();
  $('script, style, noscript').remove();

  const errorText = cleanText(
    $('.field-error, .follow-text--error, .error').first().text(),
  );
  if (errorText && $('.follow-step').length === 0) throw new RelaisColisTrackingError();

  const parsedEvents: ParsedEvent[] = [];
  const seen = new Set<string>();
  $('.follow-step').slice(0, 250).each((index, element) => {
    const row = $(element);
    const description = cleanText(row.find('.follow-step-text').first().text());
    const time = cleanText(row.find('.follow-step-date').first().text(), 64);
    const parsedTime = parsedEventTime(time);
    if (!description || !parsedTime) return;
    const identity = `${time}\u0000${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsedEvents.push({
      event: {
        time: parsedTime.iso,
        location: '',
        description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: parsedTime.timestamp,
      index,
    });
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.index - right.index
  ));
  const limitedEvents = parsedEvents.slice(0, 100);
  const events = limitedEvents.map(({ event }) => event);
  if (events.length === 0) {
    throw new TypeError('Relais Colis did not return tracking history');
  }

  const latest = limitedEvents[0]!;
  const latestKnown = limitedEvents.find((item) => item.status !== 'unknown');
  return {
    status: latest.status !== 'unknown' ? latest.status : latestKnown?.status ?? 'unknown',
    last_status_text: latest.event.description ?? 'Tracking information received',
    last_update: latest.event.time ?? null,
    expected_delivery: null,
    timezone: 'Europe/Paris',
    events,
  };
}

function csrfToken(html: string): string {
  const token = cleanText(load(html)('#track_package__token').first().attr('value'), 512);
  if (!token) throw new TypeError('Relais Colis did not return a CSRF token');
  return token;
}

function pageHeaders(): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'User-Agent': USER_AGENT,
  };
}

export class RelaisColisTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Relais Colis timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const trackingNumber = normalizeRelaisColisTrackingNumber(rawTrackingNumber);
    const sessionFetch = makeFetchCookie(fetch, new CookieJar());
    const bootstrap = await fetchBounded(TRACKING_PAGE, {
      headers: pageHeaders(),
    }, {
      provider: 'Relais Colis tracking page',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      fetcher: sessionFetch,
      allowHttpError: true,
    });
    if (!bootstrap.response.ok) {
      throw new UpstreamHttpError('Relais Colis tracking page', bootstrap.response.status);
    }

    const body = new URLSearchParams({
      'track_package[trackingNumber]': trackingNumber,
      'track_package[searchPackage]': '',
      'track_package[_token]': csrfToken(decodeText(bootstrap.bytes)),
    });
    const result = await fetchBounded(TRACKING_PAGE, {
      method: 'POST',
      headers: {
        ...pageHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.relaiscolis.com',
        Referer: TRACKING_PAGE,
      },
      body,
    }, {
      provider: 'Relais Colis tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      fetcher: sessionFetch,
      allowHttpError: true,
    });

    if ([301, 302, 303, 307, 308, 404].includes(result.response.status)) {
      throw new RelaisColisTrackingError();
    }
    if (!result.response.ok) {
      throw new UpstreamHttpError('Relais Colis tracking', result.response.status);
    }
    const parsed = parseRelaisColisTrackingHtml(decodeText(result.bytes), trackingNumber);
    parsed.tracking_url = TRACKING_PAGE;
    parsed.tracking_source = 'rendered-page';
    return parsed;
  }
}
