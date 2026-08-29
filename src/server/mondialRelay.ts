import 'server-only';

import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { DateTime } from 'luxon';
import { CookieJar } from 'tough-cookie';
import {
  decodeText,
  fetchBounded,
  parseJsonBytes,
  UpstreamHttpError,
} from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

// Protocol provenance (inspected 2026-08-30):
// https://www.mondialrelay.fr/versioned-assets/2nMAiuVI9Rv9J3kZacblPYCfCABwzS-qZ3m7eFBQn4A/Scripts/vue/tracking/js/app.js
// SHA-256: da73008ae548f51bfd27791969c6e53d809f080070cd2faa6779bb7850509f80
// The current official bundle reads the server-rendered `token` attribute from
// #tracking and sends it as RequestVerificationToken to GET /api/tracking.
// Mondial Relay's current CONNECT guide documents 8-, 10-, and 12-digit IDs:
// https://www.mondialrelay.fr/media/124728/fr-documentation-utilisateur-connect-v-12.pdf
const TRACKING_PAGE = 'https://www.mondialrelay.fr/suivi-de-colis/';
const TRACKING_API = 'https://www.mondialrelay.fr/api/tracking';
const MAX_DIRECT_BYTES = 2_000_000;
const MAX_TRAWL_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

interface MondialRelayCredential {
  shipment: string;
  postcode: string;
}

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
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function plainText(value: unknown, limit = 500): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value).slice(0, Math.max(limit * 10, 5_000));
  return text(load(raw).text(), limit);
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
    'retour en cours',
  ])) return { status: 'exception', stage: 'returned' };

  if (includesAny(value, [
    'anomalie',
    'incident',
    'echec de livraison',
    'livraison impossible',
    'n a pas pu etre livre',
    'adresse incorrecte',
    'colis endommage',
    'colis refuse',
    'colis perdu',
  ])) return { status: 'exception', stage: 'failed_attempt' };

  if (includesAny(value, [
    'retire par le destinataire',
    'retrait effectue',
    'remis au destinataire',
    'livraison effectuee au destinataire',
    'colis livre au destinataire',
  ])) return { status: 'delivered', stage: 'delivered' };

  if (includesAny(value, [
    'disponible dans votre point relais',
    'disponible au point relais',
    'disponible dans votre locker',
    'disponible en consigne',
    'vous attend au point relais',
    'vous attend dans le locker',
    'pret a etre retire',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };

  if (includesAny(value, [
    'en cours de livraison',
    'livraison en cours',
    'en cours de distribution',
    'en cours de mise a disposition',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };

  if (includesAny(value, [
    'information transmise par l expediteur',
    'en cours de preparation par l expediteur',
    'etiquette creee',
    'colis enregistre',
  ])) return { status: 'pending', stage: 'registered' };

  if (includesAny(value, [
    'pris en charge',
    'en cours d acheminement',
    'en transit',
    'arrive sur l agence',
    'arrive a l agence',
    'arrive au centre',
    'depart de l agence',
    'expedie vers',
    'achemine vers',
  ])) return { status: 'in_transit', stage: 'in_transit' };

  return { status: 'unknown', stage: 'in_transit' };
}

function plausibleFrenchPostcode(value: string): boolean {
  return /^(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/.test(value);
}

export function normalizeMondialRelayCredential(
  rawShipment: string,
  rawPostcode = '',
): MondialRelayCredential {
  let shipment = rawShipment.trim();
  let postcode = rawPostcode.trim();
  if (!postcode && /^(?:\d{13}|\d{15}|\d{17})$/.test(shipment)) {
    postcode = shipment.slice(-5);
    shipment = shipment.slice(0, -5);
  }
  if (!/^(?:\d{8}|\d{10}|\d{12})$/.test(shipment)
    || !plausibleFrenchPostcode(postcode)) {
    throw new TypeError(
      'Mondial Relay tracking requires an 8-, 10-, or 12-digit shipment number followed by '
      + 'the 5-digit recipient postcode',
    );
  }
  return { shipment, postcode };
}

export function mondialRelayTrackingUrl(rawShipment: string, rawPostcode = ''): string {
  const credential = normalizeMondialRelayCredential(rawShipment, rawPostcode);
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('numeroExpedition', credential.shipment);
  return url.toString();
}

function trackingApiUrl(credential: MondialRelayCredential, brand = ''): string {
  const url = new URL(TRACKING_API);
  url.searchParams.set('shipment', credential.shipment);
  url.searchParams.set('postcode', credential.postcode);
  url.searchParams.set('brand', brand);
  url.searchParams.set('codePays', 'fr');
  return url.toString();
}

function verificationToken(html: string): string {
  const $ = load(html);
  const token = text($('#tracking').first().attr('token'), 4_096);
  if (!/^[A-Za-z0-9:_-]{20,4096}$/.test(token)) {
    throw new MondialRelaySessionRejected('Mondial Relay did not issue a request token');
  }
  return token;
}

function challengePage(status: number, html: string, headers: Headers): boolean {
  return [401, 403, 419, 429].includes(status)
    || headers.get('cf-mitigated') === 'challenge'
    || /Just a moment|Enable JavaScript and cookies|cf-chl-/i.test(html);
}

function eventTime(value: unknown): { value: string; timestamp: number } | null {
  const raw = text(value, 64);
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = DateTime.fromISO(raw, { zone: 'Europe/Paris' });
    return date.isValid ? { value: raw, timestamp: date.toMillis() } : null;
  }

  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  let date = DateTime.fromISO(raw, hasOffset
    ? { setZone: true }
    : { zone: 'Europe/Paris' });
  if (!date.isValid) {
    for (const format of ['dd/MM/yyyy HH:mm:ss', 'dd/MM/yyyy HH:mm', 'dd/MM/yyyy']) {
      date = DateTime.fromFormat(raw, format, { zone: 'Europe/Paris' });
      if (date.isValid) break;
    }
  }
  if (!date.isValid) return null;
  return {
    value: date.toISO({ suppressMilliseconds: true }) ?? raw,
    timestamp: date.toMillis(),
  };
}

function expectedDelivery(value: unknown): string | null {
  const raw = text(value, 64);
  if (!raw || raw.startsWith('0001-01-01')) return null;
  const date = DateTime.fromISO(raw, { zone: 'Europe/Paris' });
  return date.isValid ? date.toISODate() : null;
}

function parseEvents(expedition: JsonObject): ParsedEvent[] {
  if (!Array.isArray(expedition.Evenements)) return [];
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  expedition.Evenements.forEach((rawEvent, index) => {
    if (!isRecord(rawEvent)) return;
    const time = eventTime(rawEvent.Date);
    const description = plainText(rawEvent.Libelle);
    if (!time || !description) return;
    const identity = JSON.stringify([time.value, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsed.push({
      event: {
        time: time.value,
        location: '',
        description,
        stage: classified.stage,
      },
      status: classified.status,
      timestamp: time.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  return parsed.slice(0, 100);
}

function milestoneStatus(expedition: JsonObject): ClassifiedStatus | null {
  if (!isRecord(expedition.SuiviParEtapes)) return null;
  const reached: Array<{ number: number; status: ClassifiedStatus }> = [];
  for (const raw of Object.values(expedition.SuiviParEtapes)) {
    if (!isRecord(raw) || !isRecord(raw.Evenement) || !text(raw.Evenement.Date, 64)) continue;
    const number = Number(raw.Numero);
    const classified = classifyStatus(plainText(raw.Libelle));
    if (Number.isFinite(number)) reached.push({ number, status: classified });
  }
  reached.sort((left, right) => right.number - left.number);
  const latest = reached[0];
  if (!latest) return null;
  if (latest.status.status !== 'unknown') return latest.status;
  if (latest.number >= 5) return { status: 'delivered', stage: 'delivered' };
  if (latest.number === 4) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };
  if (latest.number >= 2) return { status: 'in_transit', stage: 'in_transit' };
  return { status: 'pending', stage: 'registered' };
}

export class MondialRelayTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Mondial Relay could not locate the shipment');
    this.name = 'MondialRelayTrackingError';
  }
}

export class MondialRelaySessionRejected extends Error {
  constructor(message = 'Mondial Relay rejected the tracking session') {
    super(message);
    this.name = 'MondialRelaySessionRejected';
  }
}

export function parseMondialRelayTrackingResponse(
  payload: unknown,
  rawShipment: string,
  rawPostcode = '',
): CarrierResult {
  const credential = normalizeMondialRelayCredential(rawShipment, rawPostcode);
  if (!isRecord(payload)) {
    throw new TypeError('Mondial Relay returned an invalid tracking response');
  }
  if (!isRecord(payload.Expedition)) {
    const warning = Array.isArray(payload.status)
      && payload.status.some((entry) => isRecord(entry) && text(entry.state, 32) === 'warn');
    if (warning || Array.isArray(payload.FiltresRecherche)) throw new MondialRelayTrackingError();
    throw new TypeError('Mondial Relay returned incomplete tracking details');
  }

  const expedition = payload.Expedition;
  const returnedShipment = text(expedition.Numero, 32).replace(/\s/g, '');
  if (!/^(?:\d{8}|\d{10}|\d{12})$/.test(returnedShipment)) {
    throw new TypeError('Mondial Relay returned an invalid shipment number');
  }
  if (returnedShipment !== credential.shipment) {
    throw new RangeError('Mondial Relay returned a different shipment');
  }

  const parsedEvents = parseEvents(expedition);
  const events = parsedEvents.map(({ event }) => event);
  const contextual = plainText(expedition.SuiviContextuel);
  const statusText = contextual || events[0]?.description || 'Tracking information received';
  const contextualStatus = classifyStatus(statusText);
  const status = contextualStatus.status !== 'unknown'
    ? contextualStatus.status
    : parsedEvents.find((event) => event.status !== 'unknown')?.status
      ?? milestoneStatus(expedition)?.status
      ?? 'unknown';

  return {
    status,
    last_status_text: statusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status)
      ? null
      : expectedDelivery(expedition.EstimatedDeliveryDate),
    timezone: 'Europe/Paris',
    events,
    source: 'mondial_relay_public_web',
  };
}

class MondialRelayHttpSession {
  readonly jar = new CookieJar();
  readonly fetcher: typeof fetch;

  constructor(readonly timeoutMs: number) {
    this.fetcher = makeFetchCookie(fetch, this.jar);
  }

  async page(): Promise<string> {
    const result = await fetchBounded(TRACKING_PAGE, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': USER_AGENT,
      },
    }, {
      provider: 'Mondial Relay tracking page',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_DIRECT_BYTES,
      redirect: 'follow',
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    const html = decodeText(result.bytes);
    if (challengePage(result.response.status, html, result.response.headers)) {
      throw new MondialRelaySessionRejected('Mondial Relay returned a browser challenge');
    }
    if (!result.response.ok) {
      throw new UpstreamHttpError('Mondial Relay tracking page', result.response.status);
    }
    return html;
  }

  async payload(credential: MondialRelayCredential, token: string): Promise<unknown> {
    const url = trackingApiUrl(credential);
    const result = await fetchBounded(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: token,
        'User-Agent': USER_AGENT,
      },
    }, {
      provider: 'Mondial Relay tracking API',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_DIRECT_BYTES,
      redirect: 'error',
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    const responseText = decodeText(result.bytes);
    if (challengePage(result.response.status, responseText, result.response.headers)) {
      throw new MondialRelaySessionRejected('Mondial Relay rejected the API session');
    }
    if (result.response.status === 404) throw new MondialRelayTrackingError();
    if (!result.response.ok) {
      throw new UpstreamHttpError('Mondial Relay tracking API', result.response.status);
    }
    return parseJsonBytes(result.bytes, 'Mondial Relay');
  }
}

function trawlBody(value: JsonObject): string {
  if (typeof value.body === 'string') return value.body;
  const rawBody = value.body;
  let bytes: number[] | null = null;
  if (Array.isArray(rawBody)) {
    bytes = rawBody.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
      ? rawBody as number[]
      : null;
  } else if (isRecord(rawBody)) {
    const entries = Object.entries(rawBody);
    if (entries.length > 0 && entries.length <= MAX_DIRECT_BYTES) {
      entries.sort((left, right) => Number(left[0]) - Number(right[0]));
      const sequential = entries.every(([key, entry], index) => String(index) === key
        && Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255);
      if (sequential) bytes = entries.map(([, entry]) => Number(entry));
    }
  }
  return bytes ? decodeText(Uint8Array.from(bytes)) : '';
}

function originalTrawlPage(value: JsonObject): string {
  const body = trawlBody(value);
  return body.includes('id="tracking"') || body.includes("id='tracking'")
    ? body
    : typeof value.html === 'string' ? value.html : '';
}

function trawlJson(value: JsonObject): unknown {
  const candidates = [trawlBody(value)];
  if (typeof value.html === 'string') {
    const $ = load(value.html);
    candidates.push($('pre').first().text(), $('body').text(), value.html);
  }
  for (const candidate of candidates) {
    const cleaned = candidate.trim().replace(/^\uFEFF/, '');
    if (!cleaned) continue;
    try {
      return JSON.parse(cleaned);
    } catch {
      // Try the next representation. Browser navigations wrap JSON in a <pre>.
    }
  }
  throw new TypeError('Mondial Relay browser fallback returned invalid tracking data');
}

function assertTrawlTarget(value: JsonObject, expectedUrl: string): void {
  const returned = text(value.url, 2_048);
  if (!returned) return;
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(returned);
    expected = new URL(expectedUrl);
  } catch (error) {
    throw new TypeError('Mondial Relay browser fallback returned an invalid URL', { cause: error });
  }
  if (actual.origin !== expected.origin
    || actual.pathname !== expected.pathname
    || actual.searchParams.get('shipment') !== expected.searchParams.get('shipment')
    || actual.searchParams.get('postcode') !== expected.searchParams.get('postcode')) {
    throw new RangeError('Mondial Relay browser fallback returned a different shipment');
  }
}

export class MondialRelayTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly trawlUrl: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    timeoutMs?: number;
    directTimeoutMs?: number;
    trawlUrl?: string;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
    ));
    this.trawlUrl = (options.trawlUrl ?? process.env.FLARESOLVERR_URL ?? '').trim();
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Mondial Relay timeout must be positive');
    }
  }

  async fetch(rawShipment: string, rawPostcode = ''): Promise<CarrierResult> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await this.fetchLocked(normalizeMondialRelayCredential(rawShipment, rawPostcode));
    } finally {
      release();
    }
  }

  private async fetchLocked(credential: MondialRelayCredential): Promise<CarrierResult> {
    const direct = new MondialRelayHttpSession(this.directTimeoutMs);
    let directError: unknown;
    try {
      const token = verificationToken(await direct.page());
      return this.finish(await direct.payload(credential, token), credential, 'structured-web-response');
    } catch (error) {
      if (!(error instanceof MondialRelaySessionRejected)) throw error;
      directError = error;
    }

    if (!this.trawlUrl) {
      throw new RangeError(
        'Mondial Relay challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
        { cause: directError },
      );
    }

    const bootstrap = await this.trawlRequest({
      url: TRACKING_PAGE,
      skipHttp: true,
      maxTier: 3,
      maxTimeout: this.timeoutMs,
    });
    const token = verificationToken(originalTrawlPage(bootstrap));
    const apiUrl = trackingApiUrl(credential);
    const tracked = await this.trawlRequest({
      url: apiUrl,
      skipHttp: true,
      maxTier: 3,
      maxTimeout: this.timeoutMs,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: token,
      },
    });
    assertTrawlTarget(tracked, apiUrl);
    return this.finish(trawlJson(tracked), credential, 'browser-session-response');
  }

  private finish(
    payload: unknown,
    credential: MondialRelayCredential,
    trackingSource: string,
  ): CarrierResult {
    const result = parseMondialRelayTrackingResponse(
      payload,
      credential.shipment,
      credential.postcode,
    );
    result.tracking_url = mondialRelayTrackingUrl(credential.shipment, credential.postcode);
    result.tracking_source = trackingSource;
    return result;
  }

  private async trawlRequest(payload: JsonObject): Promise<JsonObject> {
    let endpoint: URL;
    try {
      endpoint = new URL(this.trawlUrl);
    } catch (error) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL', { cause: error });
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.host) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL');
    }
    endpoint.pathname = `${endpoint.pathname
      .replace(/\/(?:v1|scrape)\/?$/, '')
      .replace(/\/$/, '')}/scrape`;

    const result = await fetchBounded(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, {
      provider: 'TRAWL while fetching Mondial Relay',
      timeoutMs: this.timeoutMs + 15_000,
      maxBytes: MAX_TRAWL_BYTES,
      allowHttpError: true,
    });
    if (!result.response.ok) {
      throw new Error('Mondial Relay browser fallback is unavailable');
    }
    const value = parseJsonBytes(result.bytes, 'TRAWL');
    if (!isRecord(value) || value.error) {
      throw new Error('Mondial Relay browser fallback failed');
    }
    if (![2, 3].includes(Number(value.tier)) || Number(value.statusCode) !== 200) {
      throw new Error('Mondial Relay browser fallback did not establish a usable session');
    }
    return value;
  }
}
