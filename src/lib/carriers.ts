import type { CarrierId } from '../types';

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Accent used for the carrier chip in the UI. */
  color: string;
  trackingUrl?: (trackingNumber: string) => string;
}

export const CARRIERS: Record<CarrierId, CarrierInfo> = {
  'swiss-post': {
    id: 'swiss-post',
    name: 'Swiss Post',
    color: '#ffcc00',
    trackingUrl: (n) =>
      `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(n)}`,
  },
  dhl: {
    id: 'dhl',
    name: 'DHL',
    color: '#ffcc00',
    trackingUrl: (n) =>
      `https://www.dhl.com/ch-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  },
  ups: {
    id: 'ups',
    name: 'UPS',
    color: '#351c15',
    trackingUrl: (n) =>
      `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  },
  fedex: {
    id: 'fedex',
    name: 'FedEx',
    color: '#4d148c',
    trackingUrl: (n) =>
      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  dpd: {
    id: 'dpd',
    name: 'DPD',
    color: '#dc0032',
    trackingUrl: (n) =>
      `https://tracking.dpd.de/status/en_CH/parcel/${encodeURIComponent(n)}`,
  },
  'intl-post': {
    id: 'intl-post',
    name: 'International Post',
    color: '#2c6fb5',
    trackingUrl: (n) =>
      `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(n)}`,
  },
  unknown: {
    id: 'unknown',
    name: 'Carrier',
    color: '#8e8e93',
  },
};

/** Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…). */
export function normalizeTrackingNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-]/g, '');
}

/**
 * Guess the carrier from the shape of a tracking number.
 * Swiss-focused: Swiss Post barcodes and UPU S10 codes ending in CH
 * are recognised first, then the big international carriers.
 */
export function detectCarrier(raw: string): CarrierId {
  const n = normalizeTrackingNumber(raw);
  if (!n) return 'unknown';

  // UPS: 1Z + 16 alphanumeric characters.
  if (/^1Z[A-Z0-9]{16}$/.test(n)) return 'ups';

  // UPU S10 (registered mail): two letters + 9 digits + ISO country.
  if (/^[A-Z]{2}\d{9}CH$/.test(n)) return 'swiss-post';
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return 'intl-post';

  // DHL parcel codes.
  if (/^(JJD|JVGL)[A-Z0-9]{8,}$/.test(n)) return 'dhl';

  // Numeric barcodes, longest first to avoid ambiguity.
  if (/^\d{18}$/.test(n)) return 'swiss-post'; // 99.xx.xxxxxx.xxxxxxxx
  if (/^\d{15}$/.test(n)) return 'fedex';
  if (/^\d{14}$/.test(n)) return 'dpd';
  if (/^\d{12}$/.test(n)) return 'fedex';
  if (/^\d{10}$/.test(n)) return 'dhl'; // DHL Express waybill

  return 'unknown';
}

/** Swiss Post shows 18-digit barcodes as 99.34.123456.12345678. */
export function formatTrackingNumber(raw: string): string {
  const n = normalizeTrackingNumber(raw);
  if (/^\d{18}$/.test(n)) {
    return `${n.slice(0, 2)}.${n.slice(2, 4)}.${n.slice(4, 10)}.${n.slice(10)}`;
  }
  return n;
}

export function carrierInfo(id: CarrierId): CarrierInfo {
  return CARRIERS[id] ?? CARRIERS.unknown;
}
