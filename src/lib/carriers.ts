import type { CarrierId } from '../types';

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Accent used for the carrier chip in the UI. */
  color: string;
  trackingUrl?: (trackingNumber: string) => string;
  /** Whether the deployed worker can fetch this carrier without private credentials. */
  automatic: boolean;
}

export const CARRIERS: Record<CarrierId, CarrierInfo> = {
  'swiss-post': {
    id: 'swiss-post',
    name: 'Swiss Post',
    color: '#ffcc00',
    trackingUrl: (n) =>
      `https://www.post.ch/en/receiving-mail/track-consignments?formattedParcelCodes=${encodeURIComponent(n)}`,
    automatic: true,
  },
  quickpac: {
    id: 'quickpac',
    name: 'Quickpac',
    color: '#ed1c24',
    trackingUrl: (n) => `https://quickpac.ch/en/tracking?parcel=${encodeURIComponent(n)}`,
    automatic: true,
  },
  planzer: {
    id: 'planzer',
    name: 'Planzer',
    color: '#e30613',
    trackingUrl: (n) =>
      `https://tracking.app.planzer.ch/delivery/info?deliveryNumber=${encodeURIComponent(n)}`,
    automatic: true,
  },
  aliexpress: {
    id: 'aliexpress',
    name: 'AliExpress / Cainiao',
    color: '#ff4747',
    trackingUrl: (n) => `https://global.cainiao.com/detail.htm?mailNoList=${encodeURIComponent(n)}`,
    automatic: true,
  },
  sunyou: {
    id: 'sunyou',
    name: 'SunYou',
    color: '#f39800',
    trackingUrl: (n) => `https://sypost.net/search?trackNumber=${encodeURIComponent(n)}`,
    automatic: true,
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    color: '#0091cd',
    automatic: true,
  },
  'spring-gds': {
    id: 'spring-gds',
    name: 'Spring GDS',
    color: '#ef7d00',
    trackingUrl: (n) => `https://postnl.post/details/${encodeURIComponent(n)}`,
    automatic: true,
  },
  postlogistics: {
    id: 'postlogistics',
    name: 'PostLogistics',
    color: '#ffcc00',
    automatic: true,
  },
  dachser: {
    id: 'dachser',
    name: 'Dachser',
    color: '#005ca9',
    automatic: false,
  },
  dhl: {
    id: 'dhl',
    name: 'DHL',
    color: '#ffcc00',
    trackingUrl: (n) =>
      `https://www.dhl.com/ch-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
    automatic: false,
  },
  ups: {
    id: 'ups',
    name: 'UPS',
    color: '#351c15',
    trackingUrl: (n) =>
      `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
    automatic: false,
  },
  fedex: {
    id: 'fedex',
    name: 'FedEx',
    color: '#4d148c',
    trackingUrl: (n) =>
      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
    automatic: false,
  },
  dpd: {
    id: 'dpd',
    name: 'DPD',
    color: '#dc0032',
    trackingUrl: (n) =>
      `https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming?parcelNumber=${encodeURIComponent(n)}`,
    automatic: true,
  },
  shipup: {
    id: 'shipup',
    name: 'ShipUp',
    color: '#5c4ee5',
    automatic: false,
  },
  'intl-post': {
    id: 'intl-post',
    name: 'International Post',
    color: '#2c6fb5',
    trackingUrl: (n) =>
      `https://www.post.ch/en/receiving-mail/track-consignments?formattedParcelCodes=${encodeURIComponent(n)}`,
    automatic: false,
  },
  unknown: {
    id: 'unknown',
    name: 'Carrier',
    color: '#8e8e93',
    automatic: false,
  },
};

/** Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…). */
export function normalizeTrackingNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-]/g, '');
}

/** Capability-link shipment numbers look like 999.90.########. */
export function isPlanzerSharedTrackingNumber(raw: string): boolean {
  return /^99990\d{8}$/.test(normalizeTrackingNumber(raw));
}

/**
 * Guess the carrier from the shape of a tracking number.
 * Swiss-focused: Quickpac and Swiss Post barcodes, plus UPU S10 codes
 * ending in CH, are recognised first, then the big international carriers.
 */
export function detectCarrier(raw: string): CarrierId {
  const n = normalizeTrackingNumber(raw);
  if (!n) return 'unknown';

  if (isPlanzerSharedTrackingNumber(n)) return 'planzer';

  // UPS: 1Z + 16 alphanumeric characters.
  if (/^1Z[A-Z0-9]{16}$/.test(n)) return 'ups';

  // UPU S10 (registered mail): two letters + 9 digits + ISO country.
  if (/^[A-Z]{2}\d{9}CH$/.test(n)) return 'swiss-post';
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return 'intl-post';

  // DHL parcel codes.
  if (/^(JJD|JVGL)[A-Z0-9]{8,}$/.test(n)) return 'dhl';

  // Numeric barcodes, longest first to avoid ambiguity.
  if (/^\d{20}$/.test(n)) return 'planzer';
  if (/^44\d{16}$/.test(n)) return 'quickpac'; // 44.xx.xxxxxx.xxxxxxxx
  if (/^\d{18}$/.test(n)) return 'swiss-post'; // Usually 99.xx.xxxxxx.xxxxxxxx
  if (/^\d{15}$/.test(n)) return 'fedex';
  if (/^\d{14}$/.test(n)) return 'dpd';
  if (/^\d{12}$/.test(n)) return 'fedex';
  if (/^\d{10}$/.test(n)) return 'dhl'; // DHL Express waybill

  return 'unknown';
}

/** Swiss carriers show 18-digit barcodes as 99.34.123456.12345678. */
export function formatTrackingNumber(raw: string): string {
  const n = normalizeTrackingNumber(raw);
  if (isPlanzerSharedTrackingNumber(n)) {
    return `${n.slice(0, 3)}.${n.slice(3, 5)}.${n.slice(5)}`;
  }
  if (/^\d{18}$/.test(n)) {
    return `${n.slice(0, 2)}.${n.slice(2, 4)}.${n.slice(4, 10)}.${n.slice(10)}`;
  }
  return n;
}

export function carrierInfo(id: CarrierId): CarrierInfo {
  return CARRIERS[id] ?? CARRIERS.unknown;
}

export const SELECTABLE_CARRIERS = Object.values(CARRIERS).filter(
  (carrier) => carrier.id !== 'unknown' && carrier.id !== 'intl-post',
);
