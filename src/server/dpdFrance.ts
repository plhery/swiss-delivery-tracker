import 'server-only';

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { decodeText, fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_BASE = 'https://trace.dpd.fr/fr/trace';
const DEFAULT_TIMEOUT_MS = 90_000;
const DIRECT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

interface ClassifiedStatus {
  status: CarrierStatus;
  stage: string;
}

interface TrawlResponse extends JsonObject {
  html: string;
}

export class DPDFranceChallengeError extends Error {
  constructor() {
    super('DPD France returned a Cloudflare browser challenge');
    this.name = 'DPDFranceChallengeError';
  }
}

export class DPDFranceTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('DPD France could not locate the shipment');
    this.name = 'DPDFranceTrackingError';
  }
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
    'sera retourne a l expediteur',
  ])) return { status: 'exception', stage: 'returned' };

  if (includesAny(value, [
    'reclamation',
    'enquete est ouverte',
    'echec de livraison',
    'livraison impossible',
    'n a pas pu etre livre',
    'tentative de livraison',
    'incident',
    'anomalie',
    'endommage',
    'refuse',
    'perdu',
    'retard',
  ])) return { status: 'exception', stage: 'failed_attempt' };

  if (includesAny(value, [
    'votre colis est livre',
    'votre colis a ete livre',
    'remis au destinataire',
    'livraison effectuee',
  ])) return { status: 'delivered', stage: 'delivered' };

  if (includesAny(value, [
    'disponible en relais',
    'disponible au relais',
    'disponible en agence',
    'disponible en consigne',
    'attend en relais',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };

  if (includesAny(value, [
    'en cours de livraison',
    'en tournee de livraison',
    'chauffeur a pris en charge',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };

  if (includesAny(value, [
    'en preparation chez l expediteur',
    'informations concernant votre colis ont ete transmises',
    'donnees du colis transmises',
  ])) return { status: 'pending', stage: 'registered' };

  if (includesAny(value, [
    'remis a dpd',
    'pris en charge par dpd',
    'en transit',
    'arrive en france',
    'arrive dans notre agence',
    'prochaine agence',
    'centre de tri',
  ])) return { status: 'in_transit', stage: 'in_transit' };

  return { status: 'unknown', stage: 'in_transit' };
}

function challenged(status: number, headers: Headers, html: string): boolean {
  return (status === 403 && headers.get('cf-mitigated') === 'challenge')
    || /Just a moment|Performing security verification|Enable JavaScript and cookies/i.test(html);
}

function parsedEventTime(date: string, clock: string): { iso: string; timestamp: number } | null {
  const parsed = DateTime.fromFormat(`${date} ${clock}`, 'dd/MM/yyyy HH:mm', {
    zone: 'Europe/Paris',
  });
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return parsed.isValid && iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function expectedDeliveryDate(value: string): string | null {
  const parsed = DateTime.fromFormat(cleanText(value, 32), 'dd/MM/yyyy', {
    zone: 'Europe/Paris',
  });
  return parsed.isValid ? parsed.toISODate() : null;
}

export function normalizeDPDFranceTrackingNumber(raw: string): string {
  const value = raw.replace(/[\s.-]/g, '');
  if (!/^(?:[01]\d{11,14}|250\d{9,12})$/.test(value)) {
    throw new TypeError(
      'DPD France tracking numbers must start with 0, 1, or 250 and contain 12 to 15 digits',
    );
  }
  return value;
}

export function dpdFranceTrackingUrl(raw: string): string {
  const number = normalizeDPDFranceTrackingNumber(raw);
  return `${TRACKING_BASE}/${encodeURIComponent(number)}`;
}

export function parseDPDFranceTrackingHtml(html: string, rawTrackingNumber: string): CarrierResult {
  const trackingNumber = normalizeDPDFranceTrackingNumber(rawTrackingNumber);
  if (!html.trim()) throw new TypeError('DPD France returned an empty tracking response');
  if (/Just a moment|Performing security verification|Enable JavaScript and cookies/i.test(html)) {
    throw new DPDFranceChallengeError();
  }

  const $ = load(html);
  const displayedNumbers = (selector: string) => $(selector).map((_, element) => (
    cleanText($(element).text(), 64).replace(/\D/g, '')
  )).get().filter(Boolean);
  const detailsNumbers = (selector: string) => $(`${selector} .tableInfosAR`).map((_, element) => {
    const row = $(element);
    return comparableText(row.find('strong').text()) === 'n colis'
      ? cleanText(row.find('.tdInfos').text(), 64).replace(/\D/g, '')
      : '';
  }).get().filter(Boolean);
  const outboundNumbers = [
    ...displayedNumbers('.parcelNumberAller'),
    ...detailsNumbers('#infos1'),
  ];
  const returnNumbers = [
    ...displayedNumbers('.parcelNumberRetour'),
    ...detailsNumbers('#infos2'),
  ];
  const responseNumbers = [...new Set([...outboundNumbers, ...returnNumbers])];

  if (responseNumbers.length === 0) {
    if (/pas en mesure de retrouver le num[eé]ro de colis|num[eé]ro de colis inconnu/i.test(html)) {
      throw new DPDFranceTrackingError();
    }
    throw new TypeError('DPD France did not return tracking details');
  }
  if (!responseNumbers.includes(trackingNumber)) {
    throw new RangeError('DPD France returned a different shipment');
  }
  const isReturn = !outboundNumbers.includes(trackingNumber) && returnNumbers.includes(trackingNumber);
  const eventSelector = isReturn
    ? '#tableTrace tr.tabTraceColisRetour'
    : '#tableTrace tr.tabTraceColisAller';
  const detailsSelector = isReturn ? '#infos2' : '#infos1';

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    sourceIndex: number;
  }> = [];
  const seen = new Set<string>();
  $(eventSelector).slice(0, MAX_EVENTS_TO_INSPECT).each((sourceIndex, element) => {
    const row = $(element);
    const cells = row.children('td');
    const date = cleanText(cells.eq(0).text(), 32);
    const clock = cleanText(cells.eq(1).text(), 32);
    const description = cleanText(cells.eq(2).text());
    const location = cleanText(cells.eq(3).text());
    const time = parsedEventTime(date, clock);
    if (!time || !description) return;
    const identity = JSON.stringify([time.iso, location, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsedEvents.push({
      event: {
        time: time.iso,
        location,
        description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: time.timestamp,
      sourceIndex,
    });
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const events = parsedEvents.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const latest = parsedEvents.find((event) => event.status !== 'unknown');
  const status = latest?.status ?? 'unknown';
  const lastStatusText = events[0]?.description ?? 'Tracking information received';

  let expectedDelivery: string | null = null;
  $(`${detailsSelector} .tableInfosAR`).each((_, element) => {
    if (expectedDelivery) return;
    const row = $(element);
    const label = comparableText(row.find('strong').text());
    if (includesAny(label, ['livraison prevue', 'date de livraison prevue'])) {
      expectedDelivery = expectedDeliveryDate(row.find('.tdInfos').text());
    }
  });

  return {
    status,
    last_status_text: lastStatusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status) ? null : expectedDelivery,
    timezone: 'Europe/Paris',
    events,
  };
}

export class DPDFranceTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly trawlUrl: string;

  constructor(options: {
    timeoutMs?: number;
    directTimeoutMs?: number;
    trawlUrl?: string;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DIRECT_TIMEOUT_MS,
    ));
    this.trawlUrl = (options.trawlUrl ?? process.env.FLARESOLVERR_URL ?? '').trim();
  }

  async fetch(rawTrackingNumber: string): Promise<CarrierResult> {
    const number = normalizeDPDFranceTrackingNumber(rawTrackingNumber);
    const url = dpdFranceTrackingUrl(number);
    let html: string;
    try {
      html = await this.directGet(url);
    } catch (error) {
      if (!(error instanceof DPDFranceChallengeError)) throw error;
      if (!this.trawlUrl) {
        throw new RangeError(
          'DPD France requires a browser challenge solver; configure FLARESOLVERR_URL',
          { cause: error },
        );
      }
      html = (await this.trawlRequest({
        url,
        skipHttp: true,
        maxTier: 3,
        maxTimeout: this.timeoutMs,
      })).html;
    }
    const result = parseDPDFranceTrackingHtml(html, number);
    result.tracking_url = url;
    result.tracking_source = 'rendered-page';
    return result;
  }

  private async directGet(url: string): Promise<string> {
    const result = await fetchBounded(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      },
    }, {
      provider: 'DPD France tracking',
      timeoutMs: this.directTimeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'follow',
      allowHttpError: true,
    });
    const html = decodeText(result.bytes);
    if (challenged(result.response.status, result.response.headers, html)) {
      throw new DPDFranceChallengeError();
    }
    if (!result.response.ok) {
      throw new Error(`DPD France tracking returned HTTP ${result.response.status}`);
    }
    return html;
  }

  private async trawlRequest(payload: JsonObject): Promise<TrawlResponse> {
    let endpoint: URL;
    try {
      endpoint = new URL(this.trawlUrl);
    } catch (error) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL', { cause: error });
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.host) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL');
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/(?:v1|scrape)\/?$/, '').replace(/\/$/, '')}/scrape`;
    const result = await fetchBounded(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, {
      provider: 'TRAWL while fetching DPD France',
      timeoutMs: this.timeoutMs + 15_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    const value = parseJsonBytes(result.bytes, 'TRAWL');
    if (!isRecord(value) || value.error) {
      throw new Error(cleanText(isRecord(value) ? String(value.error ?? '') : '')
        || 'TRAWL could not fetch DPD France');
    }
    if (![2, 3].includes(Number(value.tier)) || Number(value.statusCode) !== 200) {
      throw new Error('TRAWL did not solve the DPD France page');
    }
    if (typeof value.html !== 'string') {
      throw new TypeError('TRAWL returned an invalid DPD France page');
    }
    return { ...value, html: value.html };
  }
}
