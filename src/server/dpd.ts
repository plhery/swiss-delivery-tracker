import 'server-only';

import { randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { decodeText, fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_BASE = 'https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming';
const FETCH_BASE = 'https://www.dpdgroup.com/ch/mydpd/my-parcels/track';
const API_BASE = 'https://www.dpdgroup.com/concept/webservice';
const OAUTH_URL = `${API_BASE}/oauth/token?grant_type=client_credentials`;
const DETAILS_BASE = `${API_BASE}/v10/parcels/details`;
const FIREBASE_PROJECT = 'consignee-portal';
const FIREBASE_PROJECT_NUMBER = '959401347543';
const FIREBASE_APP_ID = '1:959401347543:android:8d1a84133332291109e392';
// Public, app-restricted identifier shipped in the myDPD Android application.
const FIREBASE_API_KEY = 'AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc'; // gitleaks:allow
const ANDROID_PACKAGE = 'com.dpdgroup.chatbot.lemny.prod';
const ANDROID_CERT = '3872ACD98DE975F69C68CAF5119A5A1B2024B873';
const CLIENT_VERSION = '3.79.14';
const INSTALLATIONS_URL = `https://firebaseinstallations.googleapis.com/v1/projects/${FIREBASE_PROJECT}/installations`;
const REMOTE_CONFIG_URL = `https://firebaseremoteconfig.googleapis.com/v1/projects/${FIREBASE_PROJECT_NUMBER}/namespaces/firebase:fetch`;
const MAX_BYTES = 10_000_000;

export class DPDChallengeError extends Error {
  constructor(message = 'DPD returned a Cloudflare browser challenge') {
    super(message);
    this.name = 'DPDChallengeError';
  }
}

export class DPDAPIError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DPDAPIError';
  }
}

class DPDAPIHttpError extends DPDAPIError {
  constructor(readonly status: number) {
    super(`DPD guest API returned HTTP ${status}`);
    this.name = 'DPDAPIHttpError';
  }
}

function clean(value: unknown): string {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
}

function optionalText(value: unknown): string | null {
  return clean(value) || null;
}

export function dpdTrackingUrl(trackingNumber: string, language?: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('parcelNumber', trackingNumber);
  if (language) url.searchParams.set('lang', language);
  return url.toString();
}

function eventTime(date: string, clock: string): string {
  const value = `${date} ${clock}`.trim();
  const formats = clock
    ? ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd.MM.yyyy']
    : ['dd.MM.yyyy'];
  for (const format of formats) {
    const parsed = DateTime.fromFormat(value, format, { zone: 'Europe/Zurich' });
    if (parsed.isValid) return parsed.toISO({ suppressMilliseconds: true }) ?? value;
  }
  return value;
}

function status(text: string, hasEvents: boolean): CarrierStatus {
  const value = text.toLocaleLowerCase('en-US');
  if (['failed', 'not delivered', 'unable', 'problem', 'retour', 'returned']
    .some((term) => value.includes(term))) return 'exception';
  if (['delivered', 'zugestellt', 'livré', 'consegnato']
    .some((term) => value.includes(term))) return 'delivered';
  if (['out for delivery', 'delivery today', 'in zustellung', 'en cours de livraison']
    .some((term) => value.includes(term))) return 'out_for_delivery';
  if (hasEvents || ['handed to dpd', 'on its way', 'arrived', 'depot', 'network']
    .some((term) => value.includes(term))) return 'in_transit';
  if (['data received', 'information received', 'announced', 'übergeben']
    .some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

const API_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PARCEL_HANDED: 'Parcel handed to DPD',
  IN_TRANSIT: 'Your parcel is on its way',
  AT_DELIVERY_CENTER: 'At delivery center',
  RETURN_TO_SENDER: 'Return to sender',
  PARCEL_OUT_FOR_DELIVERY: 'Parcel out for delivery',
  AVAILABLE_FOR_COLLECTION: 'Ready for collection',
  UNSUCCESSFUL_DELIVERY_ATTEMPT: 'Unsuccessful delivery attempt',
  DELIVERED: 'Delivered',
  OTHER: 'Other tracking update',
};

function apiDescription(value: unknown): string {
  const key = clean(value).toUpperCase().replaceAll(' ', '_');
  return API_LABELS[key] ?? key.toLocaleLowerCase('en-US')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function apiStatus(description: unknown, statusText: string, hasEvents: boolean): CarrierStatus {
  const key = String(description ?? '').toUpperCase();
  if (key === 'DELIVERED') return 'delivered';
  if (['PARCEL_OUT_FOR_DELIVERY', 'AVAILABLE_FOR_COLLECTION'].includes(key)) {
    return 'out_for_delivery';
  }
  if (['RETURN_TO_SENDER', 'UNSUCCESSFUL_DELIVERY_ATTEMPT'].includes(key)) return 'exception';
  if (key === 'ORDER_CREATED') return 'pending';
  if (['PARCEL_HANDED', 'IN_TRANSIT', 'AT_DELIVERY_CENTER'].includes(key)) return 'in_transit';
  return status(statusText, hasEvents);
}

function apiLocation(event: JsonObject): string {
  const city = clean(event.city);
  const country = clean(event.country ?? event.countryCode ?? event.depotCountry);
  return city && country && city.toLocaleLowerCase('en-US') !== country.toLocaleLowerCase('en-US')
    ? `${city}, ${country}`
    : city || country;
}

function apiEventTime(date: unknown, clock: unknown = '', timezoneName: unknown = null): string {
  const dateText = clean(date);
  const clockText = clean(clock);
  const value = clockText ? `${dateText}T${clockText}` : dateText;
  if (!value) return '';
  let parsed = DateTime.fromISO(value, { setZone: true });
  if (parsed.isValid && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return parsed.toISO({ suppressMilliseconds: true }) ?? value;
  }
  const zoneValue = clean(timezoneName);
  parsed = DateTime.fromISO(value, {
    zone: /^[+-]\d{2}:\d{2}$/.test(zoneValue) ? `UTC${zoneValue}` : zoneValue || 'Europe/Zurich',
  });
  if (!parsed.isValid && zoneValue) {
    parsed = DateTime.fromISO(value, { zone: 'Europe/Zurich' });
  }
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) ?? value : clean(`${dateText} ${clockText}`);
}

function expectedDelivery(payload: JsonObject): string | null {
  const rawDate = clean(payload.deliveryDate);
  if (!rawDate) return null;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(rawDate)?.[0] ?? rawDate;
  const shortTime = (value: unknown) => /^(\d{2}:\d{2})/.exec(clean(value))?.[1] ?? '';
  const from = shortTime(payload.deliveryTimeFrom);
  const to = shortTime(payload.deliveryTimeTo);
  if (from && to) return `${date} ${from}–${to}`;
  return from || to ? `${date} ${from || to}` : date;
}

export function parseDPDTrackingApi(
  payload: unknown,
  trackingNumber: string,
  postcodeVerified?: boolean,
): CarrierResult {
  if (!isRecord(payload)) throw new DPDAPIError('DPD guest API returned an invalid response');
  if (String(payload.parcelNumber ?? payload.shipmentId ?? '') !== trackingNumber) {
    throw new RangeError('DPD did not return the requested parcel');
  }
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  const append = (event: CarrierEvent) => {
    const key = JSON.stringify([event.time ?? '', event.location ?? '', event.description ?? '']);
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  };
  if (Array.isArray(payload.parcelEvents)) {
    for (const raw of payload.parcelEvents) {
      if (!isRecord(raw)) continue;
      append({
        time: apiEventTime(raw.date, raw.time),
        location: apiLocation(raw),
        description: clean(raw.translation ?? raw.eventTypeText ?? apiDescription(raw.eventType))
          || 'Tracking update',
      });
    }
  }
  if (events.length === 0 && Array.isArray(payload.parcelHistory)) {
    for (const raw of payload.parcelHistory) {
      if (!isRecord(raw)) continue;
      append({
        time: apiEventTime(raw.eventDateAndTime, '', raw.eventDateAndTimeZoneId),
        location: apiLocation(raw),
        description: apiDescription(raw.description),
      });
    }
  }
  const current = isRecord(payload.status) ? payload.status : {};
  const currentDescription = current.description;
  const statusText = events[0]?.description || apiDescription(currentDescription)
    || 'Tracking information received';
  const result: CarrierResult = {
    status: apiStatus(currentDescription, statusText, events.length > 0),
    last_status_text: statusText,
    last_update: events[0]?.time || apiEventTime(
      current.eventDateAndTime,
      '',
      current.eventDateAndTimeZoneId,
    ) || null,
    expected_delivery: expectedDelivery(payload),
    events,
    source: 'mydpd_guest_api',
    delivery_date: optionalText(payload.deliveryDate),
    delivery_time_from: optionalText(payload.deliveryTimeFrom),
    delivery_time_to: optionalText(payload.deliveryTimeTo),
    is_predictive_date: Boolean(payload.isPredictiveDate),
  };
  if (postcodeVerified !== undefined) result.dpd_postcode_verified = postcodeVerified;
  return result;
}

export function parseDPDTrackingHtml(html: string, trackingNumber: string): CarrierResult {
  if (/Just a moment|cf-mitigated|Enable JavaScript and cookies/i.test(html)) {
    throw new DPDChallengeError();
  }
  const $ = load(html);
  $('script, style').remove();
  const visible = clean($('body').text());
  if (!visible.includes(trackingNumber)) throw new RangeError('DPD did not return the requested parcel');
  if (/no parcel|not found|nicht gefunden|aucun colis/i.test(visible)) {
    return {
      status: 'unknown',
      last_status_text: 'No parcel found',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const events: CarrierEvent[] = [];
  $('li.content-item-track').each((_, element) => {
    const row = $(element);
    const description = clean(row.find('.entry-body').text());
    if (!description) return;
    events.push({
      time: eventTime(clean(row.find('.entry-date').text()), clean(row.find('.entry-time').text())),
      location: clean(row.find('.place-track').text()),
      description,
    });
  });
  if (events.length === 0) {
    const summary: Array<{ date: string; description: string }> = [];
    $('.parcelStatus .row').each((_, element) => {
      const row = $(element);
      const date = /\d{2}\.\d{2}\.\d{4}/.exec(clean(row.text()))?.[0] ?? '';
      const description = clean(row.find('.col-xs-7').text())
        || clean(row.text()).replace(date, '').trim();
      if (date && description) summary.push({ date, description });
    });
    const offsets = new Map<string, number>();
    for (const item of summary) {
      const offset = offsets.get(item.date) ?? 0;
      offsets.set(item.date, offset + 1);
      events.push({
        time: eventTime(item.date, `00:${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`),
        location: '',
        description: item.description,
      });
    }
    events.reverse();
  }
  const labels = $('.gray-out').map((_, element) => clean($(element).text())).get().filter(Boolean);
  const statusText = events[0]?.description ?? labels.at(-1) ?? 'Tracking information received';
  return {
    status: status(statusText, events.length > 0),
    last_status_text: statusText,
    last_update: events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

function durationSeconds(value: unknown, fallback: number): number {
  const match = /^(\d+)s?$/.exec(String(value ?? ''));
  return match ? Number(match[1]) : fallback;
}

export class DPDTracker {
  readonly timeoutMs: number;
  readonly flaresolverrUrl: string;
  readonly firebaseApiKey: string;
  #accessToken = '';
  #accessTokenExpiresAt = 0;
  #basicToken = '';
  #installationFid = '';
  #installationToken = '';
  #installationExpiresAt = 0;
  #tokenRequest: Promise<string> | null = null;

  constructor(options: {
    timeoutMs?: number;
    flaresolverrUrl?: string;
    firebaseApiKey?: string;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.flaresolverrUrl = (options.flaresolverrUrl ?? process.env.FLARESOLVERR_URL ?? '').trim();
    this.firebaseApiKey = (options.firebaseApiKey ?? process.env.DPD_FIREBASE_API_KEY ?? FIREBASE_API_KEY).trim();
  }

  async fetch(trackingNumber: string, postcode = ''): Promise<CarrierResult> {
    if (!/^\d{14}$/.test(trackingNumber)) {
      throw new TypeError('DPD tracking numbers must contain 14 digits');
    }
    const resolvedPostcode = postcode.trim();
    if (resolvedPostcode && !/^\d{4}$/.test(resolvedPostcode)) {
      throw new TypeError('DPD postcode must contain exactly 4 digits');
    }
    let apiError: unknown;
    let result: CarrierResult;
    try {
      result = await this.apiFetch(trackingNumber, resolvedPostcode);
    } catch (error) {
      if (!(error instanceof DPDAPIError || error instanceof RangeError)) throw error;
      apiError = error;
      result = await this.pageFetch(trackingNumber, Boolean(apiError));
    }
    result.tracking_url = dpdTrackingUrl(trackingNumber);
    return result;
  }

  private async apiFetch(trackingNumber: string, postcode: string): Promise<CarrierResult> {
    let postcodeVerified: boolean | undefined;
    let payload: JsonObject;
    try {
      payload = await this.detailsWithFreshToken(trackingNumber, postcode || undefined);
      if (postcode) postcodeVerified = true;
    } catch (error) {
      if (!(error instanceof DPDAPIHttpError) || !postcode || error.status !== 400) throw error;
      payload = await this.detailsWithFreshToken(trackingNumber);
      postcodeVerified = false;
    }
    return parseDPDTrackingApi(payload, trackingNumber, postcodeVerified);
  }

  private async detailsWithFreshToken(trackingNumber: string, postcode?: string): Promise<JsonObject> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken();
      try {
        return await this.parcelDetails(trackingNumber, postcode, token);
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError) || error.status !== 401 || attempt > 0) throw error;
        this.#accessToken = '';
        this.#accessTokenExpiresAt = 0;
      }
    }
    throw new DPDAPIError('DPD guest API authentication failed');
  }

  private async parcelDetails(
    trackingNumber: string,
    postcode: string | undefined,
    token: string,
  ): Promise<JsonObject> {
    const url = new URL(`${DETAILS_BASE}/${encodeURIComponent(trackingNumber)}`);
    url.searchParams.set('parcelType', 'INCOMING');
    url.searchParams.set('businessUnit', 'DPD-CH');
    url.searchParams.set('lang', 'en');
    url.searchParams.set('continueWithoutVerification', postcode ? 'false' : 'true');
    if (postcode) url.searchParams.set('dataForVerification', postcode);
    return await this.requestJson(url, '', {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `myDPD/${CLIENT_VERSION} (Android)`,
    });
  }

  private async accessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) return this.#accessToken;
    if (this.#tokenRequest) return await this.#tokenRequest;
    this.#tokenRequest = this.refreshAccessToken();
    try {
      return await this.#tokenRequest;
    } finally {
      this.#tokenRequest = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    let payload: JsonObject | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const basicToken = this.#basicToken || await this.fetchBasicToken();
      try {
        payload = await this.requestJson(OAUTH_URL, '', {
          Authorization: `Basic ${basicToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `myDPD/${CLIENT_VERSION} (Android)`,
        });
        break;
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError)
          || ![400, 401].includes(error.status)
          || attempt > 0) throw error;
        this.#basicToken = '';
      }
    }
    const token = clean(payload?.access_token);
    if (!token) throw new DPDAPIError('DPD guest API did not issue an access token');
    this.#accessToken = token;
    this.#accessTokenExpiresAt = Date.now()
      + Math.max(1, durationSeconds(payload?.expires_in, 3_600) - 60) * 1_000;
    return token;
  }

  private async fetchBasicToken(): Promise<string> {
    if (!this.firebaseApiKey) throw new DPDAPIError('DPD Firebase client configuration is missing');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [fid, installationToken] = await this.firebaseInstallation();
      try {
        const payload = await this.requestJson(REMOTE_CONFIG_URL, {
          appId: FIREBASE_APP_ID,
          appInstanceId: fid,
          appInstanceIdToken: installationToken,
          languageCode: 'en-US',
          countryCode: 'CH',
          platformVersion: '36',
          appVersion: CLIENT_VERSION,
          packageName: ANDROID_PACKAGE,
          sdkVersion: '22.1.2',
          analyticsUserProperties: {},
        }, this.firebaseHeaders({ 'X-Goog-Firebase-Installations-Auth': installationToken }));
        const entries = isRecord(payload.entries) ? payload.entries : {};
        const token = clean(entries.basic_dpd_token);
        if (!token) throw new DPDAPIError('myDPD Remote Config omitted its guest credential');
        this.#basicToken = token;
        return token;
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError)
          || ![401, 403].includes(error.status)
          || attempt > 0) throw error;
        this.#installationFid = '';
        this.#installationToken = '';
        this.#installationExpiresAt = 0;
      }
    }
    throw new DPDAPIError('myDPD Remote Config authentication failed');
  }

  private async firebaseInstallation(): Promise<[string, string]> {
    if (this.#installationFid
      && this.#installationToken
      && Date.now() < this.#installationExpiresAt) {
      return [this.#installationFid, this.#installationToken];
    }
    const bytes = randomBytes(17);
    bytes[0] = 0x70 | (bytes[0]! & 0x0f);
    const fid = bytes.toString('base64url').slice(0, 22);
    const payload = await this.requestJson(INSTALLATIONS_URL, {
      fid,
      appId: FIREBASE_APP_ID,
      authVersion: 'FIS_v2',
      sdkVersion: 'a:18.0.0',
    }, this.firebaseHeaders());
    const auth = isRecord(payload.authToken) ? payload.authToken : {};
    const token = clean(auth.token);
    if (!token) throw new DPDAPIError('Firebase did not issue a myDPD installation token');
    this.#installationFid = clean(payload.fid) || fid;
    this.#installationToken = token;
    this.#installationExpiresAt = Date.now()
      + Math.max(1, durationSeconds(auth.expiresIn, 604_800) - 300) * 1_000;
    return [this.#installationFid, token];
  }

  private firebaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': this.firebaseApiKey,
      'X-Android-Package': ANDROID_PACKAGE,
      'X-Android-Cert': ANDROID_CERT,
      ...extra,
    };
  }

  private async requestJson(
    url: string | URL,
    data: JsonObject | string,
    headers: Record<string, string>,
  ): Promise<JsonObject> {
    let result;
    try {
      result = await fetchBounded(url, {
        method: 'POST',
        headers,
        body: typeof data === 'string' ? data : JSON.stringify(data),
      }, {
        provider: 'DPD guest API',
        timeoutMs: this.timeoutMs,
        maxBytes: MAX_BYTES,
        allowHttpError: true,
      });
    } catch (error) {
      throw new DPDAPIError('DPD guest API is unreachable', { cause: error });
    }
    if (!result.response.ok) throw new DPDAPIHttpError(result.response.status);
    let payload: unknown;
    try {
      payload = parseJsonBytes(result.bytes, 'DPD guest API');
    } catch (error) {
      throw new DPDAPIError('DPD guest API returned invalid JSON', { cause: error });
    }
    if (!isRecord(payload)) throw new DPDAPIError('DPD guest API returned an invalid response');
    return payload;
  }

  private async pageFetch(trackingNumber: string, apiFailed: boolean): Promise<CarrierResult> {
    const url = new URL(FETCH_BASE);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('parcelNumber', trackingNumber);
    let html: string;
    if (this.flaresolverrUrl) {
      html = await this.flaresolverrGet(url);
    } else {
      try {
        html = await this.directGet(url);
      } catch (error) {
        if (!(error instanceof DPDChallengeError)) throw error;
        const prefix = apiFailed ? 'DPD guest API is unavailable and ' : 'DPD ';
        throw new RangeError(`${prefix}the web fallback requires a browser challenge solver; configure FLARESOLVERR_URL`, {
          cause: error,
        });
      }
    }
    return parseDPDTrackingHtml(html, trackingNumber);
  }

  private async directGet(url: URL): Promise<string> {
    const result = await fetchBounded(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-CH,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      },
    }, {
      provider: 'DPD',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_BYTES,
      redirect: 'follow',
      allowHttpError: true,
    });
    const html = decodeText(result.bytes);
    if (result.response.status === 403
      && (result.response.headers.get('cf-mitigated') === 'challenge'
        || /Just a moment|Enable JavaScript and cookies/i.test(html))) {
      throw new DPDChallengeError();
    }
    if (!result.response.ok) throw new Error(`DPD returned HTTP ${result.response.status}`);
    return html;
  }

  private async flaresolverrGet(url: URL): Promise<string> {
    let endpoint: URL;
    try {
      endpoint = new URL(this.flaresolverrUrl);
    } catch (error) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL', { cause: error });
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.host) {
      throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL');
    }
    if (!endpoint.pathname.endsWith('/v1')) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1`;
    const result = await fetchBounded(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: url.toString(), maxTimeout: this.timeoutMs }),
    }, {
      provider: 'The browser challenge solver',
      timeoutMs: this.timeoutMs + 10_000,
      maxBytes: MAX_BYTES,
    });
    const payload = parseJsonBytes(result.bytes, 'The browser challenge solver');
    const solution = isRecord(payload) && isRecord(payload.solution) ? payload.solution : {};
    if (payload && isRecord(payload)
      && payload.status === 'ok'
      && [200, 302].includes(Number(solution.status))
      && typeof solution.response === 'string') return solution.response;
    throw new Error('The browser challenge solver did not solve the DPD page');
  }
}
