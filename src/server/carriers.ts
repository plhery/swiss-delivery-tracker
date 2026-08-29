import { CARRIER_CAPABILITIES } from '../generated/apiContract';
import { validateDachserTrackingUrl } from './dachser';
import { validatePlanzerSharedUrl } from './planzerShared';

interface CarrierRequirement {
  field: 'trackingUrl' | 'dpdPostcode';
  validator: 'planzerSharedUrl' | 'dachserCapabilityUrl' | 'swissPostcode' | 'francePostcode';
  whenTrackingNumber?: string;
}

interface CarrierDefinition {
  displayName: string;
  timezone?: string;
  tracking: {
    mode: 'automatic' | 'link-only';
    adapter: string | null;
    upstreamName?: string;
    requirements?: CarrierRequirement[];
  };
}

const DEFINITIONS = CARRIER_CAPABILITIES as unknown as Record<string, CarrierDefinition>;

export const AUTOMATIC_CARRIER_IDS = new Set(
  Object.entries(DEFINITIONS)
    .filter(([, definition]) => definition.tracking.mode === 'automatic')
    .map(([carrierId]) => carrierId),
);

export const CARRIER_NAMES = new Map(
  Object.entries(DEFINITIONS)
    .filter(([carrierId]) => AUTOMATIC_CARRIER_IDS.has(carrierId))
    .map(([carrierId, definition]) => [
      carrierId,
      definition.tracking.upstreamName ?? definition.displayName,
    ]),
);

export function isValidS10TrackingNumber(trackingNumber: string): boolean {
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(trackingNumber)) return false;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const total = weights.reduce(
    (sum, weight, index) => sum + Number(trackingNumber[index + 2]) * weight,
    0,
  );
  const rawCheckDigit = 11 - (total % 11);
  const expected = rawCheckDigit === 10 ? 0 : rawCheckDigit === 11 ? 5 : rawCheckDigit;
  return Number(trackingNumber[10]) === expected;
}

export function supportsSwissPostHandoff(trackingNumber: string): boolean {
  return /^L[A-Z]\d{9}CH$/.test(trackingNumber)
    && isValidS10TrackingNumber(trackingNumber);
}

export function carrierDefinition(carrierId: string): CarrierDefinition {
  const definition = DEFINITIONS[carrierId];
  if (!definition) throw new RangeError(`Unknown carrier ${carrierId}`);
  return definition;
}

export function carrierTimezone(carrierId: string): string {
  return carrierDefinition(carrierId).timezone ?? 'UTC';
}

export function carrierAdapter(carrierId: string): string | null {
  return carrierDefinition(carrierId).tracking.adapter;
}

export function activeRequirements(
  carrierId: string,
  trackingNumber: string,
): CarrierRequirement[] {
  return (carrierDefinition(carrierId).tracking.requirements ?? []).filter(
    (requirement) => !requirement.whenTrackingNumber
      || new RegExp(`^(?:${requirement.whenTrackingNumber})$`).test(trackingNumber),
  );
}

export function normalizeCarrierInputs(
  carrierId: string,
  trackingNumber: string,
  trackingUrl: string,
  dpdPostcode: string,
): { trackingUrl: string | null; dpdPostcode: string | null } {
  const supplied: Record<'trackingUrl' | 'dpdPostcode', string | null> = {
    trackingUrl: trackingUrl.trim() || null,
    dpdPostcode: dpdPostcode.trim() || null,
  };
  const requirements = new Map(
    activeRequirements(carrierId, trackingNumber).map((item) => [item.field, item]),
  );
  for (const [field, value] of Object.entries(supplied) as Array<[
    'trackingUrl' | 'dpdPostcode',
    string | null,
  ]>) {
    if (value !== null && !requirements.has(field)) {
      if (field === 'trackingUrl') {
        throw new TypeError('A tracking URL is not used for this carrier or tracking number');
      }
      throw new TypeError('A delivery postcode is not used for this carrier');
    }
  }
  for (const [field, requirement] of requirements) {
    const value = supplied[field];
    if (!value) {
      if (field === 'trackingUrl') {
        throw new TypeError(`${carrierDefinition(carrierId).displayName} requires its complete tracking URL`);
      }
      if (requirement.validator === 'swissPostcode') {
        throw new TypeError('DPD parcels require the four-digit delivery postcode');
      }
      if (requirement.validator === 'francePostcode') {
        throw new TypeError('Mondial Relay parcels require the five-digit delivery postcode');
      }
      throw new TypeError(`${carrierDefinition(carrierId).displayName} requires the delivery postcode`);
    }
    switch (requirement.validator) {
      case 'planzerSharedUrl':
        supplied[field] = validatePlanzerSharedUrl(value, trackingNumber);
        break;
      case 'dachserCapabilityUrl':
        supplied[field] = validateDachserTrackingUrl(value, trackingNumber);
        break;
      case 'swissPostcode':
        if (!/^\d{4}$/.test(value)) {
          throw new TypeError('DPD parcels require the four-digit delivery postcode');
        }
        break;
      case 'francePostcode':
        if (!/^\d{5}$/.test(value)) {
          throw new TypeError('Mondial Relay parcels require the five-digit delivery postcode');
        }
        break;
      default:
        requirement.validator satisfies never;
    }
  }
  return supplied;
}
