import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord, type JsonObject } from './types';

const HERMES_API = 'https://myhes.de/api/request/auftragsdaten';
const HERMES_STATUS = new Map<number, CarrierStatus>([
  [40, 'pending'],
  [100, 'in_transit'],
  [190, 'in_transit'],
  [300, 'in_transit'],
  [307, 'in_transit'],
  [318, 'exception'],
  [319, 'exception'],
  [320, 'exception'],
  [321, 'exception'],
  [314, 'in_transit'],
  [315, 'in_transit'],
  [500, 'in_transit'],
  [701, 'delivered'],
  [702, 'delivered'],
  [700, 'delivered'],
  [720, 'delivered'],
  [721, 'delivered'],
  [722, 'delivered'],
  [728, 'delivered'],
  [731, 'delivered'],
  [740, 'delivered'],
  [742, 'delivered'],
  [430, 'out_for_delivery'],
]);

export class HermesTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Hermes could not locate the shipment');
    this.name = 'HermesTrackingError';
  }
}

function normalizedText(raw: unknown): string {
  return String(raw ?? '').toLocaleLowerCase('de-DE').normalize('NFKD').replace(/\p{M}/gu, '');
}

export function hermesStatus(rawStatusId: unknown, rawDescription: unknown = ''): CarrierStatus {
  if (!['string', 'number'].includes(typeof rawStatusId)) return 'pending';
  const statusId = Number(rawStatusId);
  if (!Number.isFinite(statusId)) return 'pending';
  const known = HERMES_STATUS.get(statusId);
  if (known) return known;
  const description = normalizedText(rawDescription);
  if (/(nicht zugestellt|fehlgeschlagen|storniert|retour|zuruck)/.test(description)) {
    return 'exception';
  }
  if (/(erfolgreich zugestellt|ware geliefert|wurde .* zugestellt|delivered)/.test(description)) {
    return 'delivered';
  }
  if (/(befindet sich auf tour|fahrzeugbeladung|ankunft bei kundenadresse|out for delivery)/
    .test(description)) return 'out_for_delivery';
  if (description) return statusId === 40 ? 'pending' : 'in_transit';
  return 'pending';
}

function eventStage(rawStatusId: unknown, rawDescription: unknown): string {
  const status = hermesStatus(rawStatusId, rawDescription);
  if (status === 'exception') return 'failed_attempt';
  if (status === 'pending') return 'registered';
  return status;
}

function normalizeHermesTrackingNumber(raw: unknown): string {
  return String(raw ?? '').replace(/[\s.-]/g, '').toUpperCase();
}

export function parseHermesTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  if (!isRecord(payload)) throw new TypeError('Hermes returned an invalid tracking response');
  const body = isRecord(payload.body) ? payload.body : payload;
  if (!isRecord(body.auftragsdaten)) {
    throw new TypeError('Hermes returned an invalid tracking response');
  }
  const order = body.auftragsdaten;
  if (
    !order.lieferscheinnummer
    || normalizeHermesTrackingNumber(order.lieferscheinnummer)
      !== normalizeHermesTrackingNumber(trackingNumber)
  ) throw new TypeError('Hermes returned a different shipment');
  const journey = isRecord(order.statusjourneyDto) ? order.statusjourneyDto : {};
  if (journey.auftragstatusdaten !== undefined && !Array.isArray(journey.auftragstatusdaten)) {
    throw new TypeError('Hermes returned invalid tracking history');
  }
  // Hermes's own public UI treats auftragstatusdaten as the customer-facing
  // timeline. statusdaten contains a second, internal operational stream with
  // duplicate scans and different identifiers, so it is intentionally ignored.
  const rawEvents: JsonObject[] = Array.isArray(journey.auftragstatusdaten)
    ? journey.auftragstatusdaten.filter(isRecord)
    : [];
  // The public API answers a valid, unknown 8- or 9-digit consignment with a
  // synthetic order whose identifying/status fields are all null. Do not turn
  // that placeholder into a real-looking pending parcel.
  if (
    rawEvents.length === 0
    && order.auftragId == null
    && order.auftragsart == null
    && order.statusjourneyDto == null
  ) throw new HermesTrackingError();
  const meaningfulEvents = rawEvents.filter((event) => (
    String(event.sendungsstatus ?? '').trim()
    && String(event.sendungsstatusBuchungszeitpunkt ?? '').trim()
  ));
  meaningfulEvents.sort((left, right) => String(right.sendungsstatusBuchungszeitpunkt ?? '')
    .localeCompare(String(left.sendungsstatusBuchungszeitpunkt ?? '')));
  const events = meaningfulEvents.map((event) => ({
    time: String(event.sendungsstatusBuchungszeitpunkt ?? ''),
    location: '',
    description: String(event.sendungsstatus),
    stage: eventStage(event.sendungsstatusId, event.sendungsstatus),
  }));
  return {
    status: meaningfulEvents[0]
      ? hermesStatus(meaningfulEvents[0].sendungsstatusId, meaningfulEvents[0].sendungsstatus)
      : 'pending',
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
    return parseHermesTrackingResponse(parseJsonBytes(bytes, 'Hermes'), trackingNumber);
  }
}
