import type { Stage, TrackingEvent } from '../types';

/** The happy path, in order. Progress is measured against these. */
export const CORE_STAGES: readonly Stage[] = [
  'pending',
  'registered',
  'accepted',
  'in_transit',
  'out_for_delivery',
  'delivered',
];

export interface StageMeta {
  label: string;
  emoji: string;
  /** Visual tone: ok = normal progress, warn = needs attention, done = final. */
  tone: 'ok' | 'warn' | 'done';
  /** Where this stage sits on the happy path (index into CORE_STAGES). */
  progress: number;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  pending: { label: 'Not announced yet', emoji: '🔎', tone: 'ok', progress: 0 },
  registered: { label: 'Announced', emoji: '📝', tone: 'ok', progress: 1 },
  accepted: { label: 'Posted', emoji: '📮', tone: 'ok', progress: 2 },
  in_transit: { label: 'In transit', emoji: '🚚', tone: 'ok', progress: 3 },
  customs: { label: 'At customs', emoji: '🛃', tone: 'warn', progress: 3 },
  out_for_delivery: {
    label: 'Out for delivery',
    emoji: '🛵',
    tone: 'ok',
    progress: 4,
  },
  failed_attempt: {
    label: 'Delivery attempted',
    emoji: '📪',
    tone: 'warn',
    progress: 4,
  },
  ready_for_pickup: {
    label: 'Ready for pickup',
    emoji: '🏤',
    tone: 'warn',
    progress: 4,
  },
  delivered: { label: 'Delivered', emoji: '✅', tone: 'done', progress: 5 },
  returned: { label: 'Returned to sender', emoji: '↩️', tone: 'warn', progress: 5 },
};

export function stageMeta(stage: Stage): StageMeta {
  return STAGE_META[stage];
}

/** Newest first; ties broken by id so ordering is stable. */
export function sortEventsDesc(events: TrackingEvent[]): TrackingEvent[] {
  return [...events].sort((a, b) => {
    const cmp = b.occurredAt.localeCompare(a.occurredAt);
    return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
  });
}

export function latestEvent(events: TrackingEvent[]): TrackingEvent | null {
  return sortEventsDesc(events)[0] ?? null;
}

export function currentStage(events: TrackingEvent[]): Stage | null {
  return latestEvent(events)?.stage ?? null;
}

/** 0..5 position on the happy path; -1 when there are no events yet. */
export function progressIndex(events: TrackingEvent[]): number {
  const stage = currentStage(events);
  return stage === null ? -1 : STAGE_META[stage].progress;
}

export function isDelivered(events: TrackingEvent[]): boolean {
  return currentStage(events) === 'delivered';
}

export function isFinal(stage: Stage): boolean {
  return stage === 'delivered' || stage === 'returned';
}
