import { DateTime } from 'luxon';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import type { CarrierResult } from './carrierResult';
import { isRecord } from './types';

const DACHSER_HOST = 'customeriberia.dachser.com';
const DACHSER_PAGE_PATH = '/customerarea/utilidades/seguimiento-publico/detalle';
const DACHSER_API_PATH = '/api/utilidades/seguimiento-publico/detalle';
const ALLOWED_QUERY_KEYS = new Set([
  'hash',
  'cliente',
  'numeroUnico',
  'referencia',
  'fecha',
  'clave',
  'user',
  'idioma',
  'expedicion',
  'tipoMail',
  'error',
  'origen',
  'usuario',
]);
const CAPABILITY_VALUE = /^[A-Za-z0-9_-]{4,256}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DATE_FORMATS = [
  'dd/MM/yyyy HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy',
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm',
  'yyyy-MM-dd',
];

function normalizeTrackingNumber(raw: unknown): string {
  return String(raw ?? '').replace(/[\s.-]/g, '').toUpperCase();
}

export function validateDachserTrackingUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Dachser tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== DACHSER_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) throw new TypeError(`Dachser links must use https://${DACHSER_HOST}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (pathname !== DACHSER_PAGE_PATH && pathname !== `${DACHSER_PAGE_PATH}/`) {
    throw new TypeError('Paste a Dachser public shipment detail URL');
  }

  const values = new Map<string, string>();
  for (const [name, parameter] of url.searchParams) {
    if (!ALLOWED_QUERY_KEYS.has(name)) {
      throw new TypeError('The Dachser URL contains an unsupported parameter');
    }
    if (values.has(name)) throw new TypeError('The Dachser URL contains a duplicate parameter');
    if (!parameter || parameter.length > 256 || CONTROL_CHARACTER.test(parameter)) {
      throw new TypeError('The Dachser URL contains an invalid parameter');
    }
    values.set(name, parameter);
  }
  const uniqueNumber = values.get('numeroUnico');
  if (!uniqueNumber) throw new TypeError('The Dachser URL must include its shipment number');
  if (normalizeTrackingNumber(uniqueNumber) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Dachser URL belongs to a different tracking number');
  }
  const capabilityHash = values.get('hash');
  const capabilityKey = values.get('clave');
  const capabilityDate = values.get('fecha');
  const hasHash = Boolean(capabilityHash && CAPABILITY_VALUE.test(capabilityHash));
  const hasKey = Boolean(
    capabilityKey
    && capabilityDate
    && CAPABILITY_VALUE.test(capabilityKey)
    && /^\d{8}$/.test(capabilityDate),
  );
  if (!hasHash && !hasKey) {
    throw new TypeError('The Dachser URL must include its access parameters');
  }
  url.protocol = 'https:';
  url.hostname = DACHSER_HOST;
  url.port = '';
  return url.toString();
}

export function dachserApiUrl(trackingUrl: string, trackingNumber: string): string {
  const url = new URL(validateDachserTrackingUrl(trackingUrl, trackingNumber));
  url.pathname = DACHSER_API_PATH;
  return url.toString();
}

function plainText(raw: unknown): string {
  return String(raw ?? '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

function parseDateTime(raw: unknown): DateTime | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed = DateTime.fromISO(value, { zone: 'Europe/Madrid', setZone: true });
  if (!parsed.isValid) {
    for (const format of DATE_FORMATS) {
      parsed = DateTime.fromFormat(value, format, { zone: 'Europe/Madrid' });
      if (parsed.isValid) break;
    }
  }
  return parsed.isValid ? parsed : null;
}

function eventLabel(rawDescription: unknown): { stage: string; description: string } {
  const value = plainText(rawDescription);
  const rules: Array<{ stage: string; description: string; needles: string[] }> = [
    { stage: 'failed_attempt', description: 'Delivery attempt was unsuccessful', needles: ['no entreg', 'entrega fallida', 'failed delivery', 'unsuccessful'] },
    { stage: 'returned', description: 'Shipment returned', needles: ['devol', 'retorn', 'return', 'retour'] },
    { stage: 'in_transit', description: 'Delivery appointment updated', needles: ['fecha de entrega', 'cita', 'appointment', 'avis de livraison'] },
    { stage: 'delivered', description: 'Delivered', needles: ['entregado', 'entregada', 'delivered', 'zugestellt', 'consegnat'] },
    { stage: 'out_for_delivery', description: 'Out for delivery', needles: ['reparto', 'proceso de entrega', 'out for delivery', 'in zustellung'] },
    { stage: 'ready_for_pickup', description: 'Ready for pickup', needles: ['recogida', 'ready for pickup', 'ready for collection', 'abholbereit'] },
    { stage: 'customs', description: 'Customs processing', needles: ['aduana', 'customs', 'clearance', 'zoll'] },
    { stage: 'in_transit', description: 'Shipment departed a Dachser facility', needles: ['salida', 'departed', 'outbound'] },
    { stage: 'in_transit', description: 'Shipment arrived at a Dachser facility', needles: ['llegada', 'arrived', 'inbound'] },
    { stage: 'accepted', description: 'Shipment accepted by Dachser', needles: ['recogido', 'aceptado', 'picked up', 'accepted'] },
    { stage: 'registered', description: 'Shipment registered by Dachser', needles: ['registrado', 'creado', 'announced', 'registered', 'information received'] },
  ];
  return rules.find((rule) => rule.needles.some((needle) => value.includes(needle)))
    ?? { stage: 'in_transit', description: 'Dachser tracking update' };
}

function shipmentStatus(rawStatus: unknown, hasEvents: boolean): {
  status: CarrierResult['status'];
  text: string;
} {
  const value = plainText(rawStatus);
  if (['no entreg', 'incidencia', 'averia', 'failed', 'problem', 'devol', 'return', 'retour']
    .some((needle) => value.includes(needle))) return { status: 'exception', text: 'Shipment exception' };
  if (['entregado', 'entregada', 'delivered', 'zugestellt', 'consegnat']
    .some((needle) => value.includes(needle))) return { status: 'delivered', text: 'Delivered' };
  if (['reparto', 'proceso de entrega', 'out for delivery', 'in zustellung']
    .some((needle) => value.includes(needle))) return { status: 'out_for_delivery', text: 'Out for delivery' };
  if (['registrado', 'creado', 'announced', 'registered', 'information received']
    .some((needle) => value.includes(needle))) return { status: 'pending', text: 'Shipment registered by Dachser' };
  if (value || hasEvents) return { status: 'in_transit', text: 'In transit' };
  return { status: 'unknown', text: 'Tracking update unavailable' };
}

export function parseDachserTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  if (!isRecord(payload)) throw new TypeError('Dachser returned an invalid tracking response');
  if (!payload.numUnico) throw new TypeError('Dachser did not return a shipment number');
  if (normalizeTrackingNumber(payload.numUnico) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('Dachser returned a different shipment');
  }

  const sourceEvents = Array.isArray(payload.incidenciaExpedicionData)
    ? payload.incidenciaExpedicionData
    : [];
  const events: Array<{ time: string; location: string; stage: string; description: string }> = [];
  const seen = new Set<string>();
  for (const sourceEvent of sourceEvents.slice(0, 200)) {
    if (!isRecord(sourceEvent)) continue;
    const occurred = parseDateTime(sourceEvent.fechaIncidencia);
    if (!occurred) continue;
    const label = eventLabel(sourceEvent.descripcionIncidencia);
    const timestamp = occurred.toISO({ suppressMilliseconds: true })!;
    const identity = JSON.stringify([timestamp, label.stage, label.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push({ time: timestamp, location: '', ...label });
  }
  events.sort((left, right) => right.time.localeCompare(left.time));

  const status = shipmentStatus(payload.estadoExpedicion, events.length > 0);
  const lastUpdate = parseDateTime(payload.fechaEstado) ?? parseDateTime(events[0]?.time);
  let expectedDelivery: string | null = null;
  if (status.status !== 'delivered') {
    for (const field of ['fechaEntregaAplazada', 'fCompromiso', 'fechaPrimeraEntrega']) {
      const value = parseDateTime(payload[field]);
      if (value) {
        expectedDelivery = value.toISODate();
        break;
      }
    }
  }
  return {
    status: status.status,
    last_status_text: status.text,
    last_update: lastUpdate?.toISO({ suppressMilliseconds: true }) ?? null,
    expected_delivery: expectedDelivery,
    timezone: 'Europe/Madrid',
    events,
  };
}

export class DachserTracker {
  constructor(readonly timeoutMs = 15_000) {}

  async fetch(trackingNumber: string, trackingUrl: string): Promise<CarrierResult> {
    const { bytes } = await fetchBounded(dachserApiUrl(trackingUrl, trackingNumber), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        Referer: `https://${DACHSER_HOST}${DACHSER_PAGE_PATH}`,
        'User-Agent': 'SwissDeliveryTracker/1.0',
      },
    }, {
      provider: 'Dachser tracking',
      timeoutMs: this.timeoutMs,
    });
    return parseDachserTrackingResponse(parseJsonBytes(bytes, 'Dachser'), trackingNumber);
  }
}
