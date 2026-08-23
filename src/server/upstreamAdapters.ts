import { randomInt } from 'node:crypto';
import { decodeText, fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierEvent, CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
};

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function fetchJson(
  url: string,
  init: RequestInit,
  provider: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  const { bytes } = await fetchBounded(url, init, { provider, timeoutMs });
  return parseJsonBytes(bytes, provider);
}

const CAINIAO_STATUS = new Map<string, CarrierStatus>([
  ['WAIT_SELLER_SEND_GOODS', 'pending'],
  ['SELLER_SEND_GOODS', 'pending'],
  ['WAIT_BUYER_ACCEPT_GOODS', 'in_transit'],
  ['DELIVERING', 'in_transit'],
  ['SIGN', 'delivered'],
  ['FAILED', 'exception'],
  ['RETURNED', 'exception'],
]);

export async function fetchCainiao(trackingNumber: string): Promise<CarrierResult> {
  const payload = record(await fetchJson(
    `https://global.cainiao.com/global/detail.json?${new URLSearchParams({
      mailNos: trackingNumber,
      lang: 'en-US',
    })}`,
    { headers: { ...BASE_HEADERS, Referer: 'https://www.aliexpress.com/' } },
    'Cainiao tracking',
    10_000,
  ));
  const modules = recordArray(Array.isArray(payload.module) ? payload.module : payload.data);
  const trackingModule = modules[0] ?? {};
  const rawStatus = text(trackingModule.status);
  const status = CAINIAO_STATUS.get(rawStatus) ?? (rawStatus ? 'in_transit' : 'unknown');
  const latest = record(trackingModule.latestTrace ?? trackingModule.globalCombinedLogisticsTraceDTO);
  const events = recordArray(trackingModule.detailList).slice(0, 20).map((event): CarrierEvent => ({
    time: text(event.timeStr),
    location: '',
    description: text(event.standerdDesc) || text(event.desc),
  }));
  const eta = record(trackingModule.globalEtaInfo);
  const deliveryMaxTime = typeof eta.deliveryMaxTime === 'number' ? eta.deliveryMaxTime : NaN;
  const expected = Number.isFinite(deliveryMaxTime)
    ? new Date(deliveryMaxTime).toISOString().slice(0, 10)
    : null;
  return {
    status,
    last_status_text: text(latest.standerdDesc) || text(latest.desc) || rawStatus,
    last_update: text(latest.timeStr) || null,
    expected_delivery: expected,
    events,
  };
}

const PLANZER_STATUS = new Map<string, CarrierStatus>([
  ['Recorded', 'pending'],
  ['Transferred', 'in_transit'],
  ['Shipment on the way', 'in_transit'],
  ['In delivery', 'out_for_delivery'],
  ['Shipment out for delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Not delivered', 'exception'],
]);

export function planzerShipmentNumber(trackingNumber: string): string {
  if (!trackingNumber.includes('.')) return trackingNumber;
  const raw = trackingNumber.split('.', 2)[1] ?? '';
  return raw.replace(/^0+/, '') || raw;
}

export async function fetchPlanzer(trackingNumber: string): Promise<CarrierResult> {
  const shipmentNumber = planzerShipmentNumber(trackingNumber);
  const payload = record(await fetchJson(
    `https://api.tracking.app.planzer.ch/api/v1/shipments/${encodeURIComponent(shipmentNumber)}/Pak`,
    { headers: BASE_HEADERS },
    'Planzer tracking',
    10_000,
  ));
  const overall = record(payload.overallStatus);
  const statusText = text(record(overall.text).english);
  const events: CarrierEvent[] = [];
  for (const position of recordArray(payload.transportPositions)) {
    for (const event of recordArray(position.positionEvents)) {
      events.push({
        time: text(event.createdAt),
        location: '',
        description: text(record(event.text).english),
      });
    }
  }
  events.sort((left, right) => text(right.time).localeCompare(text(left.time)));
  return {
    status: PLANZER_STATUS.get(statusText) ?? (statusText ? 'in_transit' : 'unknown'),
    last_status_text: statusText,
    last_update: events[0]?.time || null,
    expected_delivery: text(record(payload.deliveryDay).date) || null,
    events,
  };
}

export async function fetchPostlogistics(trackingNumber: string): Promise<CarrierResult> {
  const payload = record(await fetchJson(
    'https://eosapi.postlogistics.ch/api/trackandtrace/public?culture=fr-FR',
    {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/json',
        Origin: 'https://tracking.postlogistics.ch',
        Referer: 'https://tracking.postlogistics.ch/',
      },
      body: JSON.stringify({ Identifier: trackingNumber }),
    },
    'PostLogistics tracking',
  ));
  const item = recordArray(payload.Data)[0];
  if (!item) {
    return {
      status: 'unknown',
      last_status_text: 'No data',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const history = recordArray(item.History);
  const events = history.map((event): CarrierEvent => ({
    time: text(event.TimeStamp),
    location: text(event.City),
    description: text(event.Description),
  })).sort((left, right) => text(right.time).localeCompare(text(left.time)));
  const latest = history.at(-1) ?? {};
  const latestStatus = text(latest.Status);
  let status: CarrierStatus = 'in_transit';
  if (['DEL', 'DLV', 'POD', 'SIG'].includes(latestStatus)) status = 'delivered';
  else if (latestStatus === 'NTF') status = 'pending';
  const drive = record(item.DriveAndArrive);
  const eta = text(drive.PlannedDeliveryDate) || text(drive.EstimatedArrival);
  return {
    status,
    last_status_text: text(latest.Description) || latestStatus,
    last_update: text(latest.TimeStamp) || null,
    expected_delivery: eta ? eta.slice(0, 10) : null,
    events,
  };
}

const SPRING_STATUS = new Map<string, CarrierStatus>([
  ['Preparing', 'pending'],
  ['In transit', 'in_transit'],
  ['Transit', 'in_transit'],
  ['Out for delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Returned', 'exception'],
  ['Exception', 'exception'],
]);

export async function fetchSpringGds(trackingNumber: string): Promise<CarrierResult> {
  const tokenPayload = record(await fetchJson(
    'https://postnl.post/api/v1/auth/token',
    {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/json',
        Origin: 'https://postnl.post',
        Referer: 'https://postnl.post/',
      },
      body: '{}',
    },
    'Spring GDS authentication',
    10_000,
  ));
  const accessToken = text(tokenPayload.access_token);
  if (!accessToken || accessToken.length > 16_384) {
    throw new TypeError('Spring GDS returned an invalid visitor token');
  }
  const payload = record(await fetchJson(
    'https://postnl.post/api/v1/tracking-items',
    {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        Origin: 'https://postnl.post',
        Referer: 'https://postnl.post/',
      },
      body: JSON.stringify({ items: [trackingNumber], language_code: 'en' }),
    },
    'Spring GDS tracking',
  ));
  const item = recordArray(record(payload.data).items)[0];
  if (!item) {
    return {
      status: 'unknown',
      last_status_text: '',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const rawEvents = recordArray(item.events);
  const events = rawEvents.map((event): CarrierEvent => ({
    time: text(event.datetime_local),
    location: text(event.country_name) || text(event.country_code),
    description: text(event.status_description) || text(event.category),
  }));
  const latest = rawEvents[0] ?? {};
  const category = text(latest.category);
  return {
    status: SPRING_STATUS.get(category) ?? (category ? 'in_transit' : 'unknown'),
    last_status_text: text(latest.status_description) || category,
    last_update: events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

const SUNYOU_STATUS = new Map<string, CarrierStatus>([
  ['1', 'in_transit'],
  ['2', 'in_transit'],
  ['3', 'out_for_delivery'],
  ['4', 'exception'],
  ['5', 'delivered'],
  ['6', 'exception'],
  ['7', 'exception'],
]);

export async function fetchSunYou(trackingNumber: string): Promise<CarrierResult> {
  const queryTime = `${Date.now()}-${randomInt(10_000, 100_000)}`;
  const { bytes } = await fetchBounded(
    `https://sypost.net/queryTrack?${new URLSearchParams({
      queryTime,
      toLanguage: 'en_US',
      trackNumber: trackingNumber,
    })}`,
    { headers: { ...BASE_HEADERS, Referer: 'https://sypost.net/search' } },
    { provider: 'SunYou tracking' },
  );
  const raw = decodeText(bytes);
  const match = /^\s*\w+\(([\s\S]*)\)\s*;?\s*$/.exec(raw);
  if (!match) {
    return {
      status: 'unknown',
      last_status_text: 'Invalid JSONP response',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  let payload: JsonObject;
  try {
    payload = record(JSON.parse(match[1]!));
  } catch (error) {
    throw new TypeError('SunYou returned an invalid tracking response', { cause: error });
  }
  const item = recordArray(payload.data)[0];
  if (!item || item.has !== true) {
    return {
      status: 'unknown',
      last_status_text: 'Not yet in system',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const result = record(item.result);
  const allEvents = [
    ...recordArray(record(result.origin).items),
    ...recordArray(record(result.destination).items),
  ].sort((left, right) => text(right.createTime).localeCompare(text(left.createTime)));
  const events = allEvents.slice(0, 20).map((event): CarrierEvent => ({
    time: text(event.createTime),
    location: '',
    description: text(event.content),
  }));
  const displayStatus = String(item.displayStatus ?? '');
  return {
    status: SUNYOU_STATUS.get(displayStatus) ?? 'in_transit',
    last_status_text: text(item.lastContent) || events[0]?.description || '',
    last_update: text(item.lastUpdate) || events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

export async function fetchUpstreamCarrier(
  carrierId: string,
  trackingNumber: string,
): Promise<CarrierResult> {
  switch (carrierId) {
    case 'aliexpress':
      return fetchCainiao(trackingNumber);
    case 'quickpac':
    case 'planzer':
      return fetchPlanzer(trackingNumber);
    case 'postlogistics':
      return fetchPostlogistics(trackingNumber);
    case 'spring-gds':
      return fetchSpringGds(trackingNumber);
    case 'sunyou':
      return fetchSunYou(trackingNumber);
    default:
      throw new RangeError(`Automatic tracking is not available for ${carrierId}`);
  }
}
