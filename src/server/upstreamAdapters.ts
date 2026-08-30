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

function comparableIdentifier(value: unknown): string {
  return text(value).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

export class UpstreamTrackingError extends Error {
  readonly status = 404;

  constructor(provider: string) {
    super(`${provider} could not locate the shipment`);
    this.name = 'UpstreamTrackingError';
  }
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
  const rawModules = Array.isArray(payload.module)
    ? payload.module
    : Array.isArray(payload.data) ? payload.data : null;
  if (!rawModules) throw new TypeError('Cainiao returned an invalid tracking response');
  const modules = recordArray(rawModules);
  if (modules.length !== rawModules.length) {
    throw new TypeError('Cainiao returned an invalid shipment entry');
  }
  if (modules.length === 0) throw new TypeError('Cainiao did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = modules.filter((module) => comparableIdentifier(module.mailNo));
  if (identified.length === 0) throw new TypeError('Cainiao did not return a shipment identifier');
  const trackingModule = identified.find(
    (module) => comparableIdentifier(module.mailNo) === requested,
  );
  if (!trackingModule) throw new RangeError('Cainiao returned a different shipment');
  const rawStatus = text(trackingModule.status);
  const latest = record(trackingModule.latestTrace ?? trackingModule.globalCombinedLogisticsTraceDTO);
  const rawDetails = trackingModule.detailList;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new TypeError('Cainiao returned invalid tracking history');
  }
  const details = recordArray(rawDetails);
  if (Array.isArray(rawDetails) && details.length !== rawDetails.length) {
    throw new TypeError('Cainiao returned an invalid tracking event');
  }
  if (Array.isArray(rawDetails)
    && !rawStatus
    && details.length === 0
    && Object.keys(latest).length === 0) {
    if (text(trackingModule.mailNoSource).toLocaleUpperCase('en-US') === 'EXTERNAL') {
      throw new UpstreamTrackingError('Cainiao');
    }
  }
  const status = CAINIAO_STATUS.get(rawStatus)
    ?? (rawStatus ? 'in_transit' : details.length === 0 ? 'pending' : 'unknown');
  const events = details.slice(0, 20).map((event): CarrierEvent => ({
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
  ['Shipment delivered', 'delivered'],
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
  if (!Array.isArray(payload.transportPositions)) {
    throw new TypeError('Planzer returned an invalid shipment response');
  }
  const positions = recordArray(payload.transportPositions);
  if (positions.length !== payload.transportPositions.length) {
    throw new TypeError('Planzer returned an invalid transport position');
  }
  const requested = comparableIdentifier(shipmentNumber);
  const identified = positions.filter((position) => comparableIdentifier(position.positionNumber));
  if (identified.length === 0) {
    throw new TypeError('Planzer did not return a shipment identifier');
  }
  const matchingPositions = identified.filter(
    (position) => comparableIdentifier(position.positionNumber) === requested,
  );
  if (matchingPositions.length === 0) {
    throw new RangeError('Planzer returned a different shipment');
  }
  const events: CarrierEvent[] = [];
  for (const position of matchingPositions) {
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
  if (payload.Data === null) throw new UpstreamTrackingError('PostLogistics');
  if (!Array.isArray(payload.Data)) {
    throw new TypeError('PostLogistics returned an invalid tracking response');
  }
  const items = recordArray(payload.Data);
  if (items.length !== payload.Data.length) {
    throw new TypeError('PostLogistics returned an invalid shipment entry');
  }
  if (items.length === 0) throw new TypeError('PostLogistics did not return a shipment entry');
  const responseType = Number(payload.Type);
  if (responseType !== 1 && responseType !== 2) {
    throw new TypeError('PostLogistics returned an invalid tracking response type');
  }
  const identified = items.filter((candidate) => comparableIdentifier(candidate.Identifier));
  if (identified.length === 0) {
    throw new TypeError('PostLogistics did not return a shipment identifier');
  }
  let shipments = identified;
  if (responseType === 1) {
    const requested = comparableIdentifier(trackingNumber);
    shipments = identified.filter(
      (candidate) => comparableIdentifier(candidate.Identifier) === requested,
    );
    if (shipments.length === 0) {
      throw new RangeError('PostLogistics returned a different shipment');
    }
  }
  const history = shipments.flatMap((shipment) => recordArray(shipment.History));
  const orderedHistory = history.map((event, index) => {
    const rawTimestamp = text(event.TimeStamp);
    const parsedTimestamp = Date.parse(rawTimestamp);
    return {
      event,
      index,
      timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.NEGATIVE_INFINITY,
    };
  }).sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = orderedHistory.map(({ event }): CarrierEvent => ({
    time: text(event.TimeStamp),
    location: text(event.City),
    description: text(event.Description),
  }));
  const latest = orderedHistory[0]?.event ?? {};
  const latestStatus = text(latest.Status);
  let status: CarrierStatus = 'in_transit';
  if (['DEL', 'DLV', 'POD', 'SIG'].includes(latestStatus)) status = 'delivered';
  else if (latestStatus === 'NTF') status = 'pending';
  const eta = shipments.map((shipment) => record(shipment.DriveAndArrive))
    .map((drive) => text(drive.PlannedDeliveryDate) || text(drive.EstimatedArrival))
    .find(Boolean) ?? '';
  return {
    status,
    last_status_text: text(latest.Description) || latestStatus,
    last_update: text(latest.TimeStamp) || null,
    expected_delivery: eta ? eta.slice(0, 10) : null,
    events,
  };
}

const SPRING_STATUS = new Map<string, { status: CarrierStatus; stage: string }>([
  ['pre-advised', { status: 'pending', stage: 'registered' }],
  ['preparing', { status: 'pending', stage: 'registered' }],
  ['processing', { status: 'in_transit', stage: 'accepted' }],
  ['departed', { status: 'in_transit', stage: 'in_transit' }],
  ['arrived', { status: 'in_transit', stage: 'in_transit' }],
  ['in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['transit', { status: 'in_transit', stage: 'in_transit' }],
  ['customs', { status: 'in_transit', stage: 'customs' }],
  ['out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['pick-up point', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['delivered', { status: 'delivered', stage: 'delivered' }],
  ['unsuccesfull', { status: 'exception', stage: 'failed_attempt' }],
  ['unsuccessful', { status: 'exception', stage: 'failed_attempt' }],
  ['undelivered', { status: 'exception', stage: 'failed_attempt' }],
  ['returned', { status: 'exception', stage: 'returned' }],
  ['exception', { status: 'exception', stage: 'failed_attempt' }],
]);

function springStatus(category: unknown): { status: CarrierStatus; stage: string } | undefined {
  return SPRING_STATUS.get(text(category).trim().toLocaleLowerCase('en-US'));
}

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
  const rawItems = record(payload.data).items;
  if (!Array.isArray(rawItems)) {
    throw new TypeError('Spring GDS returned an invalid tracking response');
  }
  const items = recordArray(rawItems);
  if (items.length !== rawItems.length) {
    throw new TypeError('Spring GDS returned an invalid shipment entry');
  }
  if (items.length === 0) throw new TypeError('Spring GDS did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = items.filter((candidate) => comparableIdentifier(candidate.item));
  if (identified.length === 0) {
    throw new TypeError('Spring GDS did not return a shipment identifier');
  }
  const item = identified.find((candidate) => comparableIdentifier(candidate.item) === requested);
  if (!item) throw new RangeError('Spring GDS returned a different shipment');
  if (!Array.isArray(item.events)) {
    throw new TypeError('Spring GDS returned invalid tracking history');
  }
  const rawEvents = recordArray(item.events);
  if (rawEvents.length !== item.events.length) {
    throw new TypeError('Spring GDS returned an invalid tracking event');
  }
  if (rawEvents.length === 0 && /barcode was not found/i.test(text(item.message))) {
    throw new UpstreamTrackingError('Spring GDS');
  }
  const events = rawEvents.map((event): CarrierEvent => {
    const classified = springStatus(event.category);
    return {
      time: text(event.datetime_local),
      location: text(event.country_name) || text(event.country_code),
      description: text(event.status_description) || text(event.category),
      ...(classified ? { stage: classified.stage } : {}),
    };
  });
  const latest = rawEvents[0] ?? {};
  const category = text(latest.category);
  const classified = springStatus(category);
  return {
    status: classified?.status ?? (category ? 'in_transit' : 'unknown'),
    ...(classified ? { current_stage: classified.stage } : {}),
    last_status_text: text(latest.status_description) || category,
    last_update: events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

const SUNYOU_STATUS = new Map<string, { status: CarrierStatus; stage: string }>([
  ['1', { status: 'in_transit', stage: 'in_transit' }],
  ['2', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['3', { status: 'exception', stage: 'failed_attempt' }],
  ['4', { status: 'delivered', stage: 'delivered' }],
  ['5', { status: 'exception', stage: 'failed_attempt' }],
  ['6', { status: 'exception', stage: 'failed_attempt' }],
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
    throw new TypeError('SunYou returned an invalid tracking response');
  }
  let payload: JsonObject;
  try {
    payload = record(JSON.parse(match[1]!));
  } catch (error) {
    throw new TypeError('SunYou returned an invalid tracking response', { cause: error });
  }
  if (!Array.isArray(payload.data)) {
    throw new TypeError('SunYou returned an invalid tracking response');
  }
  const items = recordArray(payload.data);
  if (items.length !== payload.data.length) {
    throw new TypeError('SunYou returned an invalid shipment entry');
  }
  if (items.length === 0) throw new TypeError('SunYou did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = items.filter((candidate) => comparableIdentifier(candidate.orderNo));
  if (identified.length === 0) throw new TypeError('SunYou did not return a shipment identifier');
  const item = identified.find((candidate) => comparableIdentifier(candidate.orderNo) === requested);
  if (!item) throw new RangeError('SunYou returned a different shipment');
  const displayStatus = String(item.displayStatus ?? '');
  if (displayStatus === '0') throw new UpstreamTrackingError('SunYou');
  if (item.has !== true) throw new UpstreamTrackingError('SunYou');
  const result = record(item.result);
  const allEvents = [
    ...recordArray(record(result.origin).items),
    ...recordArray(record(result.destination).items),
  ].sort((left, right) => text(right.createTime).localeCompare(text(left.createTime)));
  const classified = SUNYOU_STATUS.get(displayStatus);
  const events = allEvents.slice(0, 20).map((event, index): CarrierEvent => ({
    time: text(event.createTime),
    location: '',
    description: text(event.content),
    ...(index === 0 && classified ? { stage: classified.stage } : {}),
  }));
  return {
    status: classified?.status ?? 'in_transit',
    ...(classified ? { current_stage: classified.stage } : {}),
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
