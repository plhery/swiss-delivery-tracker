import {
  CARRIER_CAPABILITIES,
  type ApiCarrierId as CarrierId,
} from '../generated/apiContract';

export type CarrierTrackingMode = 'automatic' | 'link-only';
export type CarrierInputField = 'trackingUrl' | 'dpdPostcode';
export type DetectionConfidence = 'high' | 'low' | 'none';

export interface CarrierInputRequirement {
  field: CarrierInputField;
  whenTrackingNumber?: string;
  label: string;
  type: 'text' | 'url';
  placeholder?: string;
  help?: string;
  pattern?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'text' | 'url';
  autoComplete?: string;
}

export interface CarrierCapabilities {
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    requirements: CarrierInputRequirement[];
  };
  selectable: boolean;
  timezone: string;
}

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Accent used for the carrier chip in the UI. */
  color: string;
  trackingUrl?: (trackingNumber: string) => string;
  capabilities: CarrierCapabilities;
}

export interface CarrierDetection {
  carrier: CarrierId;
  confidence: DetectionConfidence;
  candidates: CarrierId[];
}

export interface TrackingInputMatch extends CarrierDetection {
  trackingNumber: string;
  trackingUrl?: string;
  source: 'number' | 'link' | 'text' | 'none';
}

interface DetectionRule {
  pattern: string;
  confidence: Exclude<DetectionConfidence, 'none'>;
  checksum?: 's10';
}

interface TrackingLinkRule {
  carrier: CarrierId;
  domains: string[];
  params?: string[];
  path?: RegExp;
  keepsCapabilityUrl?: boolean;
}

interface RawCarrierCapability {
  displayName: string;
  color: string;
  selectable: boolean;
  timezone: string;
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    requirements?: readonly CarrierInputRequirement[];
  };
  trackingUrlTemplate?: string;
  linkRules: readonly {
    domains: readonly string[];
    params?: readonly string[];
    path?: string;
    keepsCapabilityUrl?: boolean;
  }[];
  detectionRules: readonly DetectionRule[];
}

const RAW_CARRIERS = CARRIER_CAPABILITIES as unknown as Record<
  CarrierId,
  RawCarrierCapability
>;

function trackingLink(template: string | undefined) {
  if (!template) return undefined;
  return (trackingNumber: string) =>
    template.replace('{trackingNumber}', encodeURIComponent(trackingNumber));
}

export const CARRIERS = Object.fromEntries(
  Object.entries(RAW_CARRIERS).map(([id, carrier]) => [
    id,
    {
      id: id as CarrierId,
      name: carrier.displayName,
      color: carrier.color,
      trackingUrl: trackingLink(carrier.trackingUrlTemplate),
      capabilities: {
        tracking: {
          mode: carrier.tracking.mode,
          adapter: carrier.tracking.adapter,
          requirements: [...(carrier.tracking.requirements ?? [])],
        },
        selectable: carrier.selectable,
        timezone: carrier.timezone,
      },
    },
  ]),
) as Record<CarrierId, CarrierInfo>;

const TRACKING_LINK_RULES: TrackingLinkRule[] = Object.entries(RAW_CARRIERS)
  .flatMap(([carrier, definition]) => definition.linkRules.map((rule) => ({
    carrier: carrier as CarrierId,
    domains: [...rule.domains],
    params: rule.params ? [...rule.params] : undefined,
    path: rule.path ? new RegExp(rule.path, 'i') : undefined,
    keepsCapabilityUrl: rule.keepsCapabilityUrl,
  })));

/** Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…). */
export function normalizeTrackingNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, '');
}

/** Capability-link shipment numbers look like 999.90.########. */
export function isPlanzerSharedTrackingNumber(raw: string): boolean {
  return /^99990\d{8}$/.test(normalizeTrackingNumber(raw));
}

/** Validate the UPU S10 check digit, not only its broad A2-N9-A2 shape. */
export function isValidS10TrackingNumber(raw: string): boolean {
  const value = normalizeTrackingNumber(raw);
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(value)) return false;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce(
    (total, weight, index) => total + Number(value[index + 2]) * weight,
    0,
  );
  const rawCheckDigit = 11 - (sum % 11);
  const expected = rawCheckDigit === 10 ? 0 : rawCheckDigit === 11 ? 5 : rawCheckDigit;
  return Number(value[10]) === expected;
}

export function carrierRequirements(
  carrierId: CarrierId,
  trackingNumber: string,
): CarrierInputRequirement[] {
  const normalized = normalizeTrackingNumber(trackingNumber);
  return CARRIERS[carrierId].capabilities.tracking.requirements.filter(
    (requirement) =>
      !requirement.whenTrackingNumber
      || new RegExp(requirement.whenTrackingNumber).test(normalized),
  );
}

export function tracksAutomatically(carrierId: CarrierId): boolean {
  return CARRIERS[carrierId].capabilities.tracking.mode === 'automatic';
}

/** Return only a high-confidence carrier; preserve ambiguous candidates for the UI. */
export function detectCarrierMatch(raw: string): CarrierDetection {
  const trackingNumber = normalizeTrackingNumber(raw);
  if (!trackingNumber) {
    return { carrier: 'unknown', confidence: 'none', candidates: [] };
  }

  const matches: { carrier: CarrierId; confidence: 'high' | 'low' }[] = [];
  for (const [carrier, definition] of Object.entries(RAW_CARRIERS)) {
    for (const rule of definition.detectionRules) {
      if (!new RegExp(rule.pattern).test(trackingNumber)) continue;
      if (rule.checksum === 's10' && !isValidS10TrackingNumber(trackingNumber)) continue;
      matches.push({ carrier: carrier as CarrierId, confidence: rule.confidence });
      break;
    }
  }

  const highConfidence = matches.filter((match) => match.confidence === 'high');
  const ranked = highConfidence.length > 0 ? highConfidence : matches;
  const candidates = ranked.map((match) => match.carrier);
  if (highConfidence.length === 1) {
    return { carrier: highConfidence[0].carrier, confidence: 'high', candidates };
  }
  return {
    carrier: 'unknown',
    confidence: matches.length > 0 ? 'low' : 'none',
    candidates,
  };
}

/** Guess only when the tracking-number shape identifies one carrier confidently. */
export function detectCarrier(raw: string): CarrierId {
  return detectCarrierMatch(raw).carrier;
}

const TRACKING_CANDIDATE_PATTERNS = [
  /\b1Z[A-Z0-9]{16}\b/gi,
  /\b[A-Z]{2}\s*\d(?:[\s.-]?\d){8}\s*[A-Z]{2}\b/gi,
  /\b(?:JJD|JVGL)[A-Z0-9]{8,}\b/gi,
  /\b\d(?:[\s.-]?\d){9,19}\b/g,
];

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function trimPastedUrl(raw: string): string {
  return raw.replace(/^[\s<'"(\x5b]+/, '').replace(/[\s>'")\],;.!?]+$/, '');
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
      if (detectCarrierMatch(candidate).confidence === 'high') return candidate;
    }
  }
  return undefined;
}

function keywordNumberInText(raw: string): string | undefined {
  const match = raw.match(
    /(?:(?:tracking|track(?:ing)?\s*(?:number|no\.?|id)?)|(?:parcel|shipment)(?:\s+(?:tracking|number|no\.?|id))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9.-]{3,39})/i,
  );
  const candidate = match?.[1]?.trim();
  return candidate && validTrackingNumber(candidate) ? candidate : undefined;
}

function trackingMatch(
  trackingNumber: string,
  source: TrackingInputMatch['source'],
): TrackingInputMatch {
  return { trackingNumber, source, ...detectCarrierMatch(trackingNumber) };
}

/**
 * Pull a tracking number and carrier out of a number, carrier URL, or pasted
 * shipping message. Known carrier links win over number-shape heuristics.
 */
export function parseTrackingInput(raw: string): TrackingInputMatch {
  const input = raw.trim();
  if (!input) {
    return {
      trackingNumber: '',
      carrier: 'unknown',
      confidence: 'none',
      candidates: [],
      source: 'none',
    };
  }

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
            confidence: 'high',
            candidates: [rule.carrier],
            trackingUrl: rule.keepsCapabilityUrl ? trackingUrl : undefined,
            source: 'link',
          };
        }
      }

      const trackingNumber = recognizedNumberInText(decodeURIComponent(url.href));
      if (trackingNumber) return trackingMatch(trackingNumber, 'link');
    } catch {
      // Keep looking: pasted prose can contain a truncated or malformed URL.
    }
  }

  const recognized = recognizedNumberInText(input);
  if (recognized) {
    return trackingMatch(recognized, input === recognized ? 'number' : 'text');
  }

  const keywordNumber = keywordNumberInText(input);
  if (keywordNumber) return trackingMatch(keywordNumber, 'text');

  if (!input.includes('://') && validTrackingNumber(input)) {
    return trackingMatch(input, 'number');
  }

  return {
    trackingNumber: '',
    carrier: 'unknown',
    confidence: 'none',
    candidates: [],
    source: 'none',
  };
}

/** Swiss carriers show 18-digit barcodes as 99.34.123456.12345678. */
export function formatTrackingNumber(raw: string): string {
  const value = normalizeTrackingNumber(raw);
  if (isPlanzerSharedTrackingNumber(value)) {
    return `${value.slice(0, 3)}.${value.slice(3, 5)}.${value.slice(5)}`;
  }
  if (/^\d{18}$/.test(value)) {
    return `${value.slice(0, 2)}.${value.slice(2, 4)}.${value.slice(4, 10)}.${value.slice(10)}`;
  }
  return value;
}

export function carrierInfo(id: CarrierId): CarrierInfo {
  return CARRIERS[id] ?? CARRIERS.unknown;
}

export const SELECTABLE_CARRIERS = Object.values(CARRIERS).filter(
  (carrier) => carrier.capabilities.selectable,
);
