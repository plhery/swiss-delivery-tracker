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

export interface TrackingInputMatch {
  trackingNumber: string;
  carrier: CarrierId;
  trackingUrl?: string;
  source: 'number' | 'link' | 'text' | 'none';
}

export const CARRIERS: Record<CarrierId, CarrierInfo> = {
  'swiss-post': {
    id: 'swiss-post',
    name: 'Swiss Post',
    color: '#ffcc00',
    trackingUrl: (n) =>
      `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(n)}`,
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
    automatic: true,
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
      `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(n)}`,
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

interface TrackingLinkRule {
  carrier: CarrierId;
  domains: string[];
  params?: string[];
  path?: RegExp;
  keepsCapabilityUrl?: boolean;
}

const TRACKING_LINK_RULES: TrackingLinkRule[] = [
  {
    carrier: 'swiss-post',
    domains: ['service.post.ch'],
    path: /\/entry\/search\/([^/?#]+)/i,
  },
  {
    carrier: 'quickpac',
    domains: ['quickpac.ch'],
    params: ['parcel'],
  },
  {
    carrier: 'planzer',
    domains: ['trackandtrace.planzergroup.com'],
    path: /\/shared\/sendungen\/([^/?#]+)/i,
    keepsCapabilityUrl: true,
  },
  {
    carrier: 'planzer',
    domains: ['tracking.app.planzer.ch'],
    params: ['deliveryNumber'],
  },
  {
    carrier: 'aliexpress',
    domains: ['global.cainiao.com'],
    params: ['mailNoList'],
  },
  {
    carrier: 'sunyou',
    domains: ['sypost.net'],
    params: ['trackNumber'],
  },
  {
    carrier: 'spring-gds',
    domains: ['postnl.post'],
    path: /\/details\/([^/?#]+)/i,
  },
  {
    carrier: 'dhl',
    domains: ['dhl.com'],
    params: ['tracking-id', 'trackingId', 'piececode'],
  },
  {
    carrier: 'ups',
    domains: ['ups.com'],
    params: ['tracknum', 'trackNums'],
  },
  {
    carrier: 'fedex',
    domains: ['fedex.com'],
    params: ['trknbr', 'tracknumbers'],
  },
  {
    carrier: 'dpd',
    domains: ['dpdgroup.com', 'dpd.com'],
    params: ['parcelNumber', 'parcelnumber'],
  },
];

const TRACKING_CANDIDATE_PATTERNS = [
  /\b1Z[A-Z0-9]{16}\b/gi,
  /\b[A-Z]{2}\s*\d(?:[\s.\-]?\d){8}\s*[A-Z]{2}\b/gi,
  /\b(?:JJD|JVGL)[A-Z0-9]{8,}\b/gi,
  /\b\d(?:[\s.\-]?\d){9,19}\b/g,
];

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function trimPastedUrl(raw: string): string {
  return raw.replace(/^[\s<'"(\[]+/, '').replace(/[\s>'")\],;.!?]+$/, '');
}

function cleanLinkTrackingNumber(raw: string): string {
  return raw.split(/[,|]/, 1)[0].trim();
}

function validTrackingNumber(raw: string): boolean {
  const normalized = normalizeTrackingNumber(raw);
  return normalized.length >= 4
    && normalized.length <= 40
    && /^[A-Z0-9]+$/.test(normalized)
    && /\d/.test(normalized);
}

function queryParam(url: URL, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [name, value] of url.searchParams) {
    if (wanted.has(name.toLowerCase()) && value.trim()) return value;
  }
  return undefined;
}

function numberFromRule(url: URL, rule: TrackingLinkRule): string | undefined {
  const fromQuery = rule.params ? queryParam(url, rule.params) : undefined;
  const fromPath = rule.path?.exec(url.pathname)?.[1];
  const candidate = cleanLinkTrackingNumber(fromQuery ?? fromPath ?? '');
  return validTrackingNumber(candidate) ? candidate : undefined;
}

function recognizedNumberInText(raw: string): string | undefined {
  for (const pattern of TRACKING_CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const candidate = match[0].trim();
      if (detectCarrier(candidate) !== 'unknown') return candidate;
    }
  }
  return undefined;
}

function keywordNumberInText(raw: string): string | undefined {
  const match = raw.match(
    /(?:(?:tracking|track(?:ing)?\s*(?:number|no\.?|id)?)|(?:parcel|shipment)(?:\s+(?:tracking|number|no\.?|id))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9.\-]{3,39})/i,
  );
  const candidate = match?.[1]?.trim();
  return candidate && validTrackingNumber(candidate) ? candidate : undefined;
}

/**
 * Pull a tracking number and carrier out of a number, carrier URL, or pasted
 * shipping message. Known carrier links win over number-shape heuristics.
 */
export function parseTrackingInput(raw: string): TrackingInputMatch {
  const input = raw.trim();
  if (!input) return { trackingNumber: '', carrier: 'unknown', source: 'none' };

  const pastedUrls = input.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const pastedUrl of pastedUrls) {
    const trackingUrl = trimPastedUrl(pastedUrl);
    try {
      const url = new URL(trackingUrl);
      const rule = TRACKING_LINK_RULES.find((candidate) =>
        candidate.domains.some((domain) => matchesDomain(url.hostname.toLowerCase(), domain)),
      );
      if (rule) {
        const trackingNumber = numberFromRule(url, rule);
        if (trackingNumber) {
          return {
            trackingNumber,
            carrier: rule.carrier,
            trackingUrl: rule.keepsCapabilityUrl ? trackingUrl : undefined,
            source: 'link',
          };
        }
      }

      const trackingNumber = recognizedNumberInText(decodeURIComponent(url.href));
      if (trackingNumber) {
        return {
          trackingNumber,
          carrier: detectCarrier(trackingNumber),
          source: 'link',
        };
      }
    } catch {
      // Keep looking: pasted prose can contain a truncated or malformed URL.
    }
  }

  const recognized = recognizedNumberInText(input);
  if (recognized) {
    return {
      trackingNumber: recognized,
      carrier: detectCarrier(recognized),
      source: input === recognized ? 'number' : 'text',
    };
  }

  const keywordNumber = keywordNumberInText(input);
  if (keywordNumber) {
    return {
      trackingNumber: keywordNumber,
      carrier: detectCarrier(keywordNumber),
      source: 'text',
    };
  }

  if (!input.includes('://') && validTrackingNumber(input)) {
    return {
      trackingNumber: input,
      carrier: detectCarrier(input),
      source: 'number',
    };
  }

  return { trackingNumber: '', carrier: 'unknown', source: 'none' };
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
