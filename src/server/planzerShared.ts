import { load } from 'cheerio';
import { decodeText, fetchBounded } from './boundedFetch';
import type { CarrierResult } from './carrierResult';

const PLANZER_SHARED_HOST = 'trackandtrace.planzergroup.com';
const PLANZER_SHARED_PATH = /^\/shared\/sendungen\/([^/]+)\/?$/;
const PLANZER_ACCESS_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const CORE_STAGES = [
  'registered',
  'accepted',
  'in_transit',
  'out_for_delivery',
  'delivered',
] as const;
const EVENT_DESCRIPTIONS: Record<(typeof CORE_STAGES)[number], string> = {
  registered: 'Shipment registered by Planzer',
  accepted: 'Shipment accepted from the sender',
  in_transit: 'Shipment at the transfer depot',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};
const NOT_FOUND_MESSAGES = new Set([
  'keine sendungen gefunden.',
  'aucun envoi trouve.',
  'nessuna spedizione trovata.',
  'no shipments found.',
]);

export class PlanzerTrackingError extends Error {
  readonly status = 404;

  constructor() {
    super('Planzer could not locate the shipment');
    this.name = 'PlanzerTrackingError';
  }
}

interface RouteStep {
  label: string;
  reached: boolean;
  timestamp: string;
}

export function normalizeTrackingNumber(raw: string): string {
  return raw.replace(/[\s.-]/g, '').toUpperCase();
}

export function isPlanzerSharedTrackingNumber(raw: string): boolean {
  return /^99990\d{8}$/.test(normalizeTrackingNumber(raw));
}

export function validatePlanzerSharedUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Planzer tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== PLANZER_SHARED_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) {
    throw new TypeError(`Planzer shared links must use https://${PLANZER_SHARED_HOST}`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  const match = PLANZER_SHARED_PATH.exec(pathname);
  if (!match) throw new TypeError('Paste a Planzer shared shipment URL');
  if (normalizeTrackingNumber(match[1]!) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Planzer URL belongs to a different tracking number');
  }
  const accessKeys = url.searchParams.getAll('accessKey');
  if (accessKeys.length !== 1 || !PLANZER_ACCESS_KEY.test(accessKeys[0]!)) {
    throw new TypeError('The Planzer URL must include its accessKey');
  }
  return url.toString();
}

function labelStage(label: string): (typeof CORE_STAGES)[number] | null {
  const value = label.toLocaleLowerCase();
  const rules: Array<[(typeof CORE_STAGES)[number], string[]]> = [
    ['delivered', ['ausgeliefert', 'delivered', 'livré', 'livrée', 'consegnat']],
    ['out_for_delivery', ['in auslieferung', 'out for delivery', 'en livraison', 'in consegna']],
    ['in_transit', ['umschlaglager', 'transfer depot', 'transshipment', 'plateforme', 'trasbordo']],
    ['accepted', ['abholung', 'collection', 'collecte', 'ritiro']],
    ['registered', ['erfasst', 'recorded', 'enregistr', 'registrat']],
  ];
  return rules.find(([, needles]) => needles.some((needle) => value.includes(needle)))?.[0] ?? null;
}

export function parsePlanzerTrackingHtml(html: string, trackingNumber: string): CarrierResult {
  const $ = load(html);
  const notice = $('p.lead').first().text().trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const timestamps = $('time[datetime]').toArray()
    .map((element) => ($(element).attr('datetime') ?? '').trim())
    .filter(Boolean);
  const steps: RouteStep[] = [];
  $('div.text-center').each((_, element) => {
    const container = $(element);
    const target = container.find('span.tooltip-target').first();
    if (target.length === 0) return;
    const label = (target.attr('data-original-title') ?? target.attr('title') ?? '').trim();
    if (!label) return;
    steps.push({
      label,
      reached: target.hasClass('text-primary'),
      timestamp: (container.find('time[datetime]').first().attr('datetime') ?? '').trim(),
    });
  });

  const seen = new Set<string>();
  const uniqueSteps = steps.filter((step) => {
    const key = step.label.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueSteps.length < CORE_STAGES.length) {
    if (NOT_FOUND_MESSAGES.has(notice)) throw new PlanzerTrackingError();
    throw new TypeError('Planzer returned an invalid tracking page');
  }

  const events: Array<{ time: string; location: string; description: string }> = [];
  let currentStage: (typeof CORE_STAGES)[number] | null = null;
  let currentLabel = '';
  uniqueSteps.slice(0, CORE_STAGES.length).forEach((step, index) => {
    const stage = labelStage(step.label) ?? CORE_STAGES[index]!;
    if (!step.reached) return;
    currentStage = stage;
    currentLabel = step.label || EVENT_DESCRIPTIONS[stage];
    events.push({
      time: step.timestamp,
      location: '',
      description: EVENT_DESCRIPTIONS[stage],
    });
  });
  if (!currentStage) {
    throw new TypeError('Planzer returned a shipment without a current stage');
  }
  const status = {
    registered: 'pending',
    accepted: 'in_transit',
    in_transit: 'in_transit',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
  } as const;
  const dates = [...new Set(
    timestamps.filter((timestamp) => /^\d{4}-\d{2}-\d{2}/.test(timestamp))
      .map((timestamp) => timestamp.slice(0, 10)),
  )].sort();
  return {
    status: status[currentStage],
    last_status_text: currentLabel,
    last_update: events.at(-1)?.time || null,
    expected_delivery: dates.at(-1) ?? null,
    events: events.reverse(),
    tracking_number: normalizeTrackingNumber(trackingNumber),
  };
}

export class PlanzerSharedTracker {
  constructor(readonly timeoutMs = 15_000) {}

  async fetch(trackingNumber: string, trackingUrl: string): Promise<CarrierResult> {
    const url = validatePlanzerSharedUrl(trackingUrl, trackingNumber);
    const { bytes } = await fetchBounded(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
        'User-Agent': 'SwissDeliveryTracker/1.0',
      },
    }, {
      provider: 'Planzer shared tracking',
      timeoutMs: this.timeoutMs,
    });
    return parsePlanzerTrackingHtml(decodeText(bytes), trackingNumber);
  }
}
