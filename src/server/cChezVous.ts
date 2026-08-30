import 'server-only';

import { load } from 'cheerio';
import { decodeText, fetchBounded, UpstreamHttpError } from './boundedFetch';
import type { CarrierResult, CarrierStatus } from './carrierResult';
import { isRecord } from './types';

const TRACKING_BASE = 'https://www.cchezvous.fr/suivi-colis';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const FRENCH_POSTCODE = /^(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/;

interface StepDetails {
  status: CarrierStatus;
  stage: string;
  description: string;
}

const STEP_DETAILS: Record<number, StepDetails> = {
  1: { status: 'pending', stage: 'registered', description: 'Commande enregistrée' },
  2: { status: 'pending', stage: 'registered', description: 'Prise de rendez-vous' },
  3: { status: 'in_transit', stage: 'in_transit', description: 'Commande en préparation' },
  4: { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Commande en livraison' },
  5: { status: 'delivered', stage: 'delivered', description: 'Commande livrée' },
};

export class CChezVousTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('C Chez Vous could not locate the shipment');
    this.name = 'CChezVousTrackingError';
  }
}

function cleanText(value: string, maxLength = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizedIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(candidate);
  if (!match || Number.isNaN(Date.parse(candidate))) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeResponseCredential(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('C Chez Vous returned an invalid shipment number');
  }
  try {
    return normalizeCChezVousCredential(value);
  } catch (error) {
    throw new TypeError('C Chez Vous returned an invalid shipment number', { cause: error });
  }
}

export function normalizeCChezVousCredential(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US').replace(/\s/g, '');
  const composite = /^([A-Z0-9]{11})--(\d{5})$/.exec(value);
  if (composite) {
    if (!FRENCH_POSTCODE.test(composite[2])) {
      throw new TypeError('C Chez Vous tracking contains an invalid French postcode');
    }
    return `${composite[1]}--${composite[2]}`;
  }

  // Shared package normalization removes punctuation. The only documented compact
  // composite form has an 11-character order followed by its 5-digit postcode.
  const compactComposite = /^([A-Z0-9]{11})(\d{5})$/.exec(value);
  if (compactComposite) {
    if (!FRENCH_POSTCODE.test(compactComposite[2])) {
      throw new TypeError('C Chez Vous tracking contains an invalid French postcode');
    }
    return `${compactComposite[1]}--${compactComposite[2]}`;
  }

  if (!/^(?=.*\d)[A-Z0-9]{8,15}$/.test(value)) {
    throw new TypeError(
      'C Chez Vous tracking requires an 8- to 15-character order number, or an 11-character order followed by -- and a French postcode',
    );
  }
  return value;
}

export function cChezVousTrackingUrl(rawCredential: string): string {
  const credential = normalizeCChezVousCredential(rawCredential);
  return `${TRACKING_BASE}/${encodeURIComponent(credential)}`;
}

export function parseCChezVousTrackingHtml(
  html: string,
  rawCredential: string,
): CarrierResult {
  const credential = normalizeCChezVousCredential(rawCredential);
  if (!html.trim()) throw new TypeError('C Chez Vous returned an empty tracking response');
  if (/commande est introuvable|commande introuvable/i.test(html)) {
    throw new CChezVousTrackingError();
  }

  const $ = load(html);
  const tracking = $('tracking').first();
  const encodedResult = tracking.attr(':tracking-results')
    ?? tracking.attr('v-bind:tracking-results');
  if (!encodedResult) throw new TypeError('C Chez Vous did not return tracking details');

  let payload: unknown;
  try {
    payload = JSON.parse(encodedResult);
  } catch (error) {
    throw new TypeError('C Chez Vous returned an invalid tracking response', { cause: error });
  }
  if (!isRecord(payload)) throw new TypeError('C Chez Vous returned an invalid tracking response');

  const responseCredential = normalizeResponseCredential(payload.package_number);
  if (responseCredential !== credential) {
    throw new RangeError('C Chez Vous returned a different shipment');
  }
  const displayedCredential = cleanText($('.title--tertiary').first().text(), 64);
  if (displayedCredential
    && normalizeResponseCredential(displayedCredential) !== credential) {
    throw new RangeError('C Chez Vous returned a different shipment');
  }

  const parcels = Array.isArray(payload.parcels) ? payload.parcels.filter(isRecord) : [];
  if (parcels.length === 0) {
    throw new TypeError('C Chez Vous returned incomplete tracking details');
  }
  const steps = parcels.map((parcel) => {
    const rawStep = parcel.parcelStep;
    return typeof rawStep === 'number' && Number.isInteger(rawStep) && rawStep >= 1 && rawStep <= 5
      ? rawStep
      : 1;
  });
  // A multi-parcel order is complete only when its least-advanced parcel is complete.
  const currentStep = Math.min(...steps);
  const current = STEP_DETAILS[currentStep] ?? STEP_DETAILS[1];
  const deliveryDates = parcels
    .map((parcel) => normalizedIsoDate(parcel.date))
    .filter((date): date is string => date !== null)
    .sort();
  const expectedDelivery = deliveryDates.at(-1) ?? null;

  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: current.description,
    last_update: null,
    expected_delivery: current.status === 'delivered' ? null : expectedDelivery,
    timezone: 'Europe/Paris',
    events: [{
      description: current.description,
      stage: current.stage,
    }],
  };
}

export class CChezVousTracker {
  constructor(readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('C Chez Vous timeout must be positive');
    }
  }

  async fetch(rawCredential: string): Promise<CarrierResult> {
    const credential = normalizeCChezVousCredential(rawCredential);
    const { response, bytes } = await fetchBounded(cChezVousTrackingUrl(credential), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryTracker/1.0)',
      },
    }, {
      provider: 'C Chez Vous tracking',
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      allowHttpError: true,
    });

    if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
      throw new CChezVousTrackingError();
    }
    if (!response.ok) throw new UpstreamHttpError('C Chez Vous tracking', response.status);
    return parseCChezVousTrackingHtml(decodeText(bytes), credential);
  }
}
