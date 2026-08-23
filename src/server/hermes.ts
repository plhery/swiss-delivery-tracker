import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const HERMES_API = 'https://myhes.de/api/request/auftragsdaten';

export function hermesStatus(rawStatusId: unknown): CarrierStatus {
  if (!['string', 'number'].includes(typeof rawStatusId)) return 'pending';
  const statusId = Number(rawStatusId);
  if (!Number.isFinite(statusId)) return 'pending';
  if (statusId >= 50_000) return 'exception';
  if (statusId >= 40_000) return 'delivered';
  if (statusId >= 30_000) return 'out_for_delivery';
  if (statusId >= 20_000) return 'in_transit';
  return 'pending';
}

function eventStage(rawStatusId: unknown): string {
  const status = hermesStatus(rawStatusId);
  return status === 'exception' ? 'failed_attempt' : status;
}

export function parseHermesTrackingResponse(payload: unknown): CarrierResult {
  if (!isRecord(payload)) throw new TypeError('Hermes returned an invalid tracking response');
  const body = isRecord(payload.body) ? payload.body : payload;
  const order = isRecord(body.auftragsdaten) ? body.auftragsdaten : {};
  const journey = isRecord(order.statusjourneyDto) ? order.statusjourneyDto : {};
  const rawEvents: JsonObject[] = [];
  for (const key of ['auftragstatusdaten', 'statusdaten']) {
    const values = journey[key];
    if (Array.isArray(values)) rawEvents.push(...values.filter(isRecord));
  }
  rawEvents.sort((left, right) => String(right.sendungsstatusBuchungszeitpunkt ?? '')
    .localeCompare(String(left.sendungsstatusBuchungszeitpunkt ?? '')));
  const events = rawEvents.map((event) => ({
    time: String(event.sendungsstatusBuchungszeitpunkt ?? ''),
    location: '',
    description: String(event.sendungsstatus ?? 'Tracking update'),
    stage: eventStage(event.sendungsstatusId),
  }));
  return {
    status: rawEvents[0] ? hermesStatus(rawEvents[0].sendungsstatusId) : 'pending',
    last_status_text: events[0]?.description ?? '',
    last_update: events[0]?.time || null,
    expected_delivery: typeof order.lieferdatum === 'string'
      ? order.lieferdatum
      : typeof order.hesBasicLieferterminZeit === 'string'
        ? order.hesBasicLieferterminZeit
        : null,
    timezone: 'Europe/Zurich',
    events,
  };
}

export class HermesTracker {
  constructor(readonly timeoutMs = 15_000) {}

  async fetch(trackingNumber: string): Promise<CarrierResult> {
    const url = new URL(HERMES_API);
    url.searchParams.set('parcelNumber', trackingNumber);
    const { bytes } = await fetchBounded(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)',
      },
    }, {
      provider: 'Hermes tracking',
      timeoutMs: this.timeoutMs,
    });
    return parseHermesTrackingResponse(parseJsonBytes(bytes, 'Hermes'));
  }
}
