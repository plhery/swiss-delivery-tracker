import 'server-only';

import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { Cookie, CookieJar } from 'tough-cookie';
import { decodeText, fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const TRACKING_BASE = 'https://www.ups.com/track';
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const MAX_BYTES = 10_000_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0';

function clean(value: unknown): string {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
}

export function upsTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('loc', 'en_US');
  url.searchParams.set('tracknum', trackingNumber);
  url.searchParams.set('requester', 'ST/trackdetails');
  return url.toString();
}

export class UPSSessionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UPSSessionRejected';
  }
}

class UPSHttpSession {
  readonly jar = new CookieJar();
  #fetcher: typeof fetch;
  #userAgent = USER_AGENT;

  constructor(readonly timeoutMs: number) {
    this.#fetcher = makeFetchCookie(fetch, this.jar);
  }

  async fetchPage(url: string): Promise<string> {
    const result = await this.request(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-GPC': '1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': this.#userAgent,
      },
    }, 'UPS tracking page');
    return decodeText(result);
  }

  async fetchStatus(trackingNumber: string): Promise<JsonObject> {
    const token = await this.xsrfToken();
    if (!token) throw new UPSSessionRejected('The UPS session has no XSRF token');
    const clientUrl = upsTrackingUrl(trackingNumber);
    const bytes = await this.request(STATUS_API, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        DNT: '1',
        Origin: 'https://www.ups.com',
        Referer: clientUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Sec-GPC': '1',
        'User-Agent': this.#userAgent,
        'X-XSRF-TOKEN': token,
      },
      body: JSON.stringify({
        Locale: 'en_US',
        TrackingNumber: [trackingNumber.toLocaleLowerCase('en-US')],
        isBarcodeScanned: false,
        Requester: 'st/trackdetails',
        ClientUrl: clientUrl,
        returnToValue: '',
        AssociatedBcdnNumber: null,
      }),
    }, 'UPS status API');
    const payload = parseJsonBytes(bytes, 'UPS');
    if (!isRecord(payload)) throw new UPSSessionRejected('UPS returned an invalid tracking response');
    return payload;
  }

  async seedBrowserCookies(cookies: unknown[], userAgent: unknown): Promise<void> {
    const browserUserAgent = clean(userAgent);
    if (browserUserAgent) this.#userAgent = browserUserAgent.slice(0, 1_024);
    await this.jar.removeAllCookies();
    for (const value of cookies) {
      if (!isRecord(value)) continue;
      const name = clean(value.name);
      const cookieValue = String(value.value ?? '');
      const domain = clean(value.domain).toLocaleLowerCase('en-US');
      if (!name || !validCookieDomain(domain)) continue;
      const path = clean(value.path).startsWith('/') ? clean(value.path) : '/';
      const rawExpires = Number(value.expires);
      const expires = Number.isFinite(rawExpires) && rawExpires > 0
        ? new Date(rawExpires * 1_000)
        : 'Infinity';
      const cookie = new Cookie({
        key: name,
        value: cookieValue,
        domain,
        path,
        secure: Boolean(value.secure),
        httpOnly: Boolean(value.httpOnly),
        expires,
      });
      await this.jar.setCookie(cookie, `https://${domain.replace(/^\./, '')}${path}`);
    }
  }

  async xsrfToken(): Promise<string> {
    const cookies = await this.jar.getCookies(STATUS_API);
    const value = cookies.find((cookie) => cookie.key === 'X-XSRF-TOKEN-ST')?.value ?? '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    description: string,
  ): Promise<Uint8Array> {
    const result = await fetchBounded(url, init, {
      provider: description,
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_BYTES,
      redirect: 'follow',
      fetcher: this.#fetcher,
      allowHttpError: true,
    });
    if ([401, 403, 419, 429].includes(result.response.status)) {
      throw new UPSSessionRejected(`${description} returned HTTP ${result.response.status}`);
    }
    if (!result.response.ok) throw new Error(`${description} returned HTTP ${result.response.status}`);
    return result.bytes;
  }
}

function validCookieDomain(domain: string): boolean {
  const bare = domain.replace(/^\./, '');
  return bare === 'ups.com' || bare.endsWith('.ups.com');
}

function upsStatus(text: string, hasEvents = false): CarrierStatus {
  const value = text.toLocaleLowerCase('en-US');
  if (['return to sender', 'returned', 'delivery attempted', 'we missed you', 'not delivered', 'exception', 'action required']
    .some((term) => value.includes(term))) return 'exception';
  if (['delivered', 'left at'].some((term) => value.includes(term))) return 'delivered';
  if (value.includes('out for delivery')) return 'out_for_delivery';
  if (hasEvents || ['on the way', 'in transit', 'we have your package', 'first ups possession', 'departed', 'arrived', 'processing at ups facility']
    .some((term) => value.includes(term))) return 'in_transit';
  if (['label created', 'manifest upload', 'shipment ready for ups']
    .some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

function withoutIcons(value: string): string {
  return clean(value.replace(/\b(?:check_circle|content_copy|expand_more|check)\b/g, ' '));
}

export function parseUPSTrackingHtml(page: string, trackingNumber: string): CarrierResult {
  const $ = load(page);
  $('script, style, noscript').remove();
  const expected = trackingNumber.toUpperCase();
  const visible = clean($('body').text()).toUpperCase();
  const metaNumbers = $('meta[name]').map((_, element) => {
    const name = clean($(element).attr('name')).toLocaleLowerCase('en-US');
    return ['stapp-tracknum', 'appvars.trk_tracknum'].includes(name)
      ? clean($(element).attr('content')).toUpperCase()
      : '';
  }).get();
  if (!visible.includes(expected) && !metaNumbers.includes(expected)) {
    throw new RangeError('UPS did not return the requested parcel');
  }
  if (/could not locate|invalid tracking|not valid tracking/i.test(visible)) {
    return {
      status: 'unknown',
      last_status_text: 'UPS could not locate the shipment',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  let statusText = withoutIcons(clean($('#stApp_nameKey').last().text()));
  const progress = withoutIcons(clean($('#stApp_shpmtProgress').last().text()));
  const currentStatus = upsStatus(`${statusText} ${progress}`);
  if (!statusText) statusText = progress || 'Tracking information received';
  let location = clean($('#stApp_deliveredToAddress').last().text());
  if (!location) {
    location = clean(`${$('#stApp_txtAddress').last().text()} ${$('#stApp_txtCountry').last().text()}`);
  }
  const events: CarrierEvent[] = currentStatus === 'unknown'
    ? []
    : [{ time: '', location, description: statusText }];
  return {
    status: currentStatus,
    last_status_text: statusText,
    last_update: null,
    expected_delivery: null,
    events,
  };
}

function activityTime(activity: JsonObject): string {
  const gmtDate = clean(activity.gmtDate);
  const gmtTime = clean(activity.gmtTime);
  if (/^\d{8}$/.test(gmtDate) && /^\d{2}:\d{2}:\d{2}$/.test(gmtTime)) {
    return `${gmtDate.slice(0, 4)}-${gmtDate.slice(4, 6)}-${gmtDate.slice(6, 8)}T${gmtTime}+00:00`;
  }
  const localDate = clean(activity.date);
  const localTime = clean(activity.time).replace(/\.M\./gi, 'M');
  const offset = clean(activity.gmtOffset);
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(localDate);
  const timeMatch = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(localTime);
  if (dateMatch && timeMatch && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    let hour = Number(timeMatch[1]);
    if (timeMatch[3]!.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (timeMatch[3]!.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}T${String(hour).padStart(2, '0')}:${timeMatch[2]}:00${offset}`;
  }
  return clean(`${localDate} ${localTime}`);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function expectedDelivery(detail: JsonObject, today: Date): string | null {
  if (!isRecord(detail.scheduledDeliveryDateDetail)) return null;
  const value = detail.scheduledDeliveryDateDetail;
  const month = MONTHS[clean(value.monthCMSKey).split('.').at(-1)?.toLocaleLowerCase('en-US') ?? ''];
  const day = Number(clean(value.dayNum));
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const utcToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let year = utcToday.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  if (candidate.getTime() < utcToday.getTime() - 7 * 86_400_000) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate.toISOString().slice(0, 10);
}

export function parseUPSTrackingResponse(
  payload: unknown,
  trackingNumber: string,
  today = new Date(),
): CarrierResult {
  if (!isRecord(payload)) throw new TypeError('UPS returned an invalid tracking response');
  if (String(payload.statusCode ?? '') !== '200') {
    throw new Error(clean(payload.statusText) || 'UPS tracking is unavailable');
  }
  if (!Array.isArray(payload.trackDetails) || payload.trackDetails.length === 0) {
    return {
      status: 'unknown',
      last_status_text: 'UPS could not locate the shipment',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const expected = trackingNumber.toUpperCase();
  const detail = payload.trackDetails.find((item) => isRecord(item)
    && clean(item.trackingNumber ?? item.requestedTrackingNumber).toUpperCase() === expected)
    ?? payload.trackDetails[0];
  if (!isRecord(detail)) throw new TypeError('UPS returned an invalid tracking response');
  const returned = clean(detail.trackingNumber ?? detail.requestedTrackingNumber);
  if (returned && returned.toUpperCase() !== expected) {
    throw new RangeError('UPS did not return the requested parcel');
  }
  const errorText = clean(detail.errorText);
  if (detail.errorCode || errorText) {
    return {
      status: 'unknown',
      last_status_text: errorText || 'UPS could not locate the shipment',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const events: CarrierEvent[] = [];
  if (Array.isArray(detail.shipmentProgressActivities)) {
    for (const raw of detail.shipmentProgressActivities) {
      if (!isRecord(raw)) continue;
      const milestone = isRecord(raw.milestoneName) ? clean(raw.milestoneName.name) : '';
      let description = clean(raw.activityScan) || milestone;
      const additional = clean(raw.activityAdditionalDescription);
      if (additional && !description.toLocaleLowerCase('en-US').includes(additional.toLocaleLowerCase('en-US'))) {
        description = clean(`${description} — ${additional}`);
      }
      if (!description) continue;
      events.push({
        time: activityTime(raw),
        location: clean(raw.location),
        description,
      });
    }
  }
  const currentName = isRecord(detail.currentMilestone) ? clean(detail.currentMilestone.name) : '';
  const statusText = events[0]?.description
    || clean(detail.packageStatus ?? detail.simplifiedText)
    || currentName
    || 'Tracking information received';
  const progress = clean(detail.progressBarType).toLocaleLowerCase('en-US');
  const progressStatus: Record<string, CarrierStatus> = {
    manifestupload: 'pending',
    firstupspossession: 'in_transit',
    intransit: 'in_transit',
    outfordelivery: 'out_for_delivery',
    delivered: 'delivered',
    exception: 'exception',
  };
  return {
    status: progressStatus[progress] ?? upsStatus(
      [detail.packageStatus, detail.simplifiedText, currentName, statusText].map(clean).join(' '),
      events.length > 0,
    ),
    last_status_text: statusText,
    last_update: events[0]?.time || null,
    expected_delivery: expectedDelivery(detail, today),
    events,
  };
}

interface TrawlResponse extends JsonObject {
  html: string;
  cookies: unknown[];
}

export class UPSTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly trawlUrl: string;
  #session: UPSHttpSession | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { timeoutMs?: number; directTimeoutMs?: number; trawlUrl?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? 20_000,
    ));
    this.trawlUrl = (options.trawlUrl ?? process.env.FLARESOLVERR_URL ?? '').trim();
  }

  async fetch(trackingNumber: string): Promise<CarrierResult> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const number = trackingNumber.toUpperCase();
      if (!/^1Z[A-Z0-9]{16}$/.test(number)) {
        throw new TypeError('UPS tracking numbers must start with 1Z and contain 18 characters');
      }
      return await this.fetchLocked(number);
    } finally {
      release();
    }
  }

  private async fetchLocked(number: string): Promise<CarrierResult> {
    if (this.#session) {
      try {
        return await this.apiResult(number, this.#session);
      } catch (error) {
        if (!(error instanceof UPSSessionRejected)) throw error;
        try {
          await this.#session.fetchPage(upsTrackingUrl(number));
          return await this.apiResult(number, this.#session);
        } catch (refreshError) {
          if (!(refreshError instanceof UPSSessionRejected)) throw refreshError;
          this.#session = null;
        }
      }
    }

    const direct = new UPSHttpSession(this.directTimeoutMs);
    let directPage: string | null = null;
    let directError: unknown;
    try {
      directPage = await direct.fetchPage(upsTrackingUrl(number));
      if (!await direct.xsrfToken()) throw new Error('UPS challenged the direct tracking session');
      const result = await this.apiResult(number, direct);
      this.#session = direct;
      return result;
    } catch (error) {
      directError = error;
    }

    if (!this.trawlUrl) {
      if (directPage) {
        try {
          return this.renderedResult(directPage, number);
        } catch {
          // The direct page was itself a challenge; surface the actionable setup error.
        }
      }
      throw new RangeError('UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback', {
        cause: directError,
      });
    }

    const bootstrap = await this.trawlRequest({
      url: upsTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: this.timeoutMs,
    });
    const browser = new UPSHttpSession(this.directTimeoutMs);
    await browser.seedBrowserCookies(bootstrap.cookies, bootstrap.userAgent);
    let browserError: unknown;
    if (await browser.xsrfToken()) {
      try {
        const result = await this.apiResult(number, browser);
        this.#session = browser;
        return result;
      } catch (error) {
        browserError = error;
        if (!(error instanceof UPSSessionRejected)) this.#session = browser;
      }
    }
    try {
      return this.renderedResult(bootstrap.html, number);
    } catch (error) {
      if (browserError) throw new Error('UPS rejected the browser-established session', { cause: browserError });
      throw new Error('TRAWL did not establish a usable UPS session', { cause: error });
    }
  }

  private async apiResult(number: string, session: UPSHttpSession): Promise<CarrierResult> {
    const result = parseUPSTrackingResponse(await session.fetchStatus(number), number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }

  private renderedResult(page: string, number: string): CarrierResult {
    const result = parseUPSTrackingHtml(page, number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'rendered-page';
    return result;
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
      provider: 'TRAWL while fetching UPS',
      timeoutMs: this.timeoutMs + 15_000,
      maxBytes: MAX_BYTES,
    });
    const value = parseJsonBytes(result.bytes, 'TRAWL');
    if (!isRecord(value) || value.error) {
      throw new Error(clean(isRecord(value) ? value.error : '') || 'TRAWL could not fetch UPS');
    }
    if (![2, 3].includes(Number(value.tier)) || Number(value.statusCode) !== 200) {
      throw new Error('TRAWL did not solve the UPS page');
    }
    if (typeof value.html !== 'string') throw new TypeError('TRAWL returned an invalid UPS page');
    return {
      ...value,
      html: value.html,
      cookies: Array.isArray(value.cookies) ? value.cookies : [],
    };
  }
}
