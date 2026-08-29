import 'server-only';

import { createHash } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { STAGES } from '../generated/apiContract';
import type { CarrierResult } from './carrierResult';
import { normalizeCarrierResult } from './carrierResult';
import {
  AUTOMATIC_CARRIER_IDS,
  carrierAdapter,
  carrierTimezone,
  supportsSwissPostHandoff,
} from './carriers';
import { ColisPriveTracker } from './colisPrive';
import { DachserTracker } from './dachser';
import { DPDTracker } from './dpd';
import { GeodisTracker } from './geodis';
import { GLSFranceTracker } from './glsFrance';
import { HermesTracker } from './hermes';
import { LaPosteTracker } from './laPoste';
import { PlanzerSharedTracker } from './planzerShared';
import type { CompositePushNotificationService } from './push';
import type { SupabaseServiceClient } from './supabase';
import { SwissPostTracker } from './swissPost';
import { isRecord, type JsonObject } from './types';
import { fetchUpstreamCarrier } from './upstreamAdapters';
import { UPSTracker } from './ups';

const MAX_PACKAGES_PER_OWNER_PER_SYNC = 5;
const VALID_STAGES = new Set<string>(STAGES);

export interface TrackingAdapter {
  fetch(
    carrierId: string,
    trackingNumber: string,
    trackingUrl: string | null,
    dpdPostcode?: string | null,
  ): Promise<CarrierResult>;
}

export class CarrierTrackingAdapter implements TrackingAdapter {
  constructor(
    readonly dpd = new DPDTracker(),
    readonly dachser = new DachserTracker(),
    readonly hermes = new HermesTracker(),
    readonly planzerShared = new PlanzerSharedTracker(),
    readonly swissPost = new SwissPostTracker(),
    readonly ups = new UPSTracker(),
    readonly laPoste = new LaPosteTracker(),
    readonly glsFrance = new GLSFranceTracker(),
    readonly colisPrive = new ColisPriveTracker(),
    readonly geodis = new GeodisTracker(),
  ) {}

  async fetch(
    carrierId: string,
    trackingNumber: string,
    trackingUrl: string | null,
    dpdPostcode?: string | null,
  ): Promise<CarrierResult> {
    const adapter = carrierAdapter(carrierId);
    let result: CarrierResult;
    if (carrierId === 'swiss-post') {
      result = await this.swissPost.fetch(trackingNumber);
    } else if (adapter === 'dpd') {
      result = await this.dpd.fetch(trackingNumber, dpdPostcode ?? '');
    } else if (adapter === 'dachser') {
      if (!trackingUrl) throw new TypeError('Dachser tracking requires its complete tracking URL');
      result = await this.dachser.fetch(trackingNumber, trackingUrl);
    } else if (adapter === 'hermes') {
      result = await this.hermes.fetch(trackingNumber);
    } else if (adapter === 'ups') {
      result = await this.ups.fetch(trackingNumber);
    } else if (adapter === 'la-poste') {
      result = await this.laPoste.fetch(trackingNumber);
    } else if (adapter === 'gls-france') {
      result = await this.glsFrance.fetch(trackingNumber);
    } else if (adapter === 'colis-prive') {
      result = await this.colisPrive.fetch(trackingNumber);
    } else if (adapter === 'geodis') {
      result = await this.geodis.fetch(trackingNumber);
    } else if (adapter === 'planzer' && trackingUrl) {
      result = await this.planzerShared.fetch(trackingNumber, trackingUrl);
    } else {
      result = await fetchUpstreamCarrier(carrierId, trackingNumber);
    }
    return normalizeCarrierResult(result);
  }
}

export interface SyncSummary extends JsonObject {
  checked: number;
  updated: number;
  waiting: number;
  errors: number;
  unsupported: number;
  notifications_sent: number;
  notification_errors: number;
  subscriptions_expired: number;
}

export function emptySyncSummary(): SyncSummary {
  return {
    checked: 0,
    updated: 0,
    waiting: 0,
    errors: 0,
    unsupported: 0,
    notifications_sent: 0,
    notification_errors: 0,
    subscriptions_expired: 0,
  };
}

export function inferStage(text: string, fallback = 'in_transit'): string {
  const value = text.toLocaleLowerCase('en-US').replaceAll('_', ' ').trim().split(/\s+/).join(' ');
  if (value.includes('to be delivered')) return 'in_transit';
  if (['will shortly be handed over', 'shipment information received', 'electronic shipment information']
    .some((term) => value.includes(term))) return 'registered';
  if (['return to sender', 'returned', 'retour'].some((term) => value.includes(term))) {
    return 'returned';
  }
  if (['not delivered', 'could not be delivered', 'unable to deliver', 'delivery attempt',
    'failed', 'unsuccessful', 'missed delivery', 'nicht zugestellt',
    'zustellung nicht möglich', 'non livré', 'livraison impossible',
    'échec de livraison', 'mancata consegna'].some((term) => value.includes(term))) {
    return 'failed_attempt';
  }
  if (['delivered', 'deposited', 'zugestellt', 'confirmation of receipt']
    .some((term) => value.includes(term))) return 'delivered';
  if (['ready for pickup', 'ready for collection', 'abholbereit']
    .some((term) => value.includes(term))) return 'ready_for_pickup';
  if (['out for delivery', 'in delivery', 'loading into delivery vehicle',
    'loaded into delivery vehicle', 'zustellung'].some((term) => value.includes(term))) {
    return 'out_for_delivery';
  }
  if (['customs', 'custom clearance', 'zoll'].some((term) => value.includes(term))) return 'customs';
  if (['accepted', 'received at', 'handed over', 'handed to dpd', 'parcel handed', 'posted']
    .some((term) => value.includes(term))) return 'accepted';
  if (['announced', 'registered', 'label created', 'information received']
    .some((term) => value.includes(term))) return 'registered';
  if (['transit', 'sorted', 'departed', 'arrived', 'transport', 'delivery centre', 'depot']
    .some((term) => value.includes(term))) return 'in_transit';
  return fallback;
}

export function resultStage(result: CarrierResult): string | null {
  const status = String(result.status ?? 'unknown');
  const text = String(result.last_status_text ?? '');
  switch (status) {
    case 'pending': return inferStage(text, 'pending');
    case 'in_transit': return inferStage(text, 'in_transit');
    case 'out_for_delivery': return inferStage(text, 'out_for_delivery');
    case 'delivered': return inferStage(text, 'delivered');
    case 'exception': return inferStage(text, 'failed_attempt');
    default: return null;
  }
}

export function resultHasUpdate(result: CarrierResult): boolean {
  const stage = resultStage(result);
  if (stage && stage !== 'pending') return true;
  return (result.events ?? []).some((event) => {
    const declared = String(event.stage ?? '');
    if (VALID_STAGES.has(declared) && declared !== 'pending') return true;
    const description = String(event.description ?? '');
    return Boolean(description) && inferStage(description, 'pending') !== 'pending';
  });
}

const UNANNOUNCED_PHRASES = [
  'did not return the requested parcel',
  'no parcel found',
  'not announced',
  'not found yet',
  'not registered',
  'shipment not found',
  'tracking number not found',
  'unknown tracking number',
];

export function isUnannouncedTrackingError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object' && current !== null) {
      const status = 'status' in current ? Number(current.status)
        : 'statusCode' in current ? Number(current.statusCode)
          : 0;
      if (status === 404) return true;
    }
    const message = String(current).toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ');
    if (UNANNOUNCED_PHRASES.some((phrase) => message.includes(phrase))) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

function resultTimezone(carrierId: string, result: CarrierResult): string {
  const declared = typeof result.timezone === 'string' ? result.timezone : '';
  if (declared.length >= 1 && declared.length <= 64 && IANAZone.isValidZone(declared)) return declared;
  try {
    const configured = carrierTimezone(carrierId);
    return IANAZone.isValidZone(configured) ? configured : 'UTC';
  } catch {
    return 'UTC';
  }
}

const EVENT_FORMATS = [
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm',
  'dd.MM.yyyy HH:mm:ss',
  'dd.MM.yyyy HH:mm',
  'dd/MM/yyyy HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'yyyy-MM-dd',
  'dd.MM.yyyy',
  'dd/MM/yyyy',
];

export function eventTimestamp(raw: unknown, assumedTimezone = 'UTC'): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  let parsed = DateTime.fromISO(value, { setZone: true });
  if (parsed.isValid) {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      parsed = DateTime.fromISO(value, { zone: assumedTimezone });
    }
    return parsed.toUTC().toISO({ suppressMilliseconds: true }) ?? null;
  }
  for (const format of EVENT_FORMATS) {
    parsed = DateTime.fromFormat(value, format, { zone: assumedTimezone });
    if (parsed.isValid) return parsed.toUTC().toISO({ suppressMilliseconds: true }) ?? null;
  }
  return null;
}

export function providerEventId(
  carrierId: string,
  rawTime: unknown,
  location: string,
  description: string,
): string {
  const material = JSON.stringify([
    carrierId,
    String(rawTime ?? ''),
    location.trim(),
    description.trim(),
  ]);
  return `${carrierId}:${createHash('sha256').update(material).digest('hex')}`;
}

export function buildEvents(
  parcel: JsonObject,
  result: CarrierResult,
  sourceCarrierId?: string,
): JsonObject[] {
  const current = resultStage(result) ?? 'in_transit';
  const carrierId = sourceCarrierId ?? String(parcel.carrier ?? '');
  const timezone = resultTimezone(carrierId, result);
  const rows: JsonObject[] = [];
  for (const raw of result.events ?? []) {
    const description = String(raw.description ?? 'Tracking update').trim();
    const location = String(raw.location ?? '').trim();
    const occurredAt = eventTimestamp(raw.time, timezone);
    if (!occurredAt) continue;
    const declaredStage = String(raw.stage ?? '');
    rows.push({
      package_id: parcel.id,
      stage: VALID_STAGES.has(declaredStage) ? declaredStage : inferStage(description, current),
      description,
      location: location || null,
      occurred_at: occurredAt,
      provider_event_id: providerEventId(carrierId, raw.time, location, description),
      raw_data: raw,
    });
  }
  if (rows.length === 0 && current && result.last_status_text) {
    const description = String(result.last_status_text);
    const occurredAt = eventTimestamp(result.last_update, timezone);
    if (occurredAt) {
      rows.push({
        package_id: parcel.id,
        stage: current,
        description,
        location: null,
        occurred_at: occurredAt,
        provider_event_id: providerEventId(carrierId, result.last_update, '', description),
        raw_data: {},
      });
    }
  }
  return rows;
}

type SyncOutcome = 'updated' | 'waiting' | 'errors' | 'unsupported';

export class TrackingSyncService {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly client: SupabaseServiceClient,
    readonly adapter: TrackingAdapter = new CarrierTrackingAdapter(),
    readonly notifier: CompositePushNotificationService | null = null,
    readonly now: () => Date = () => new Date(),
  ) {}

  async sync(): Promise<SyncSummary> {
    return await this.exclusive(async () => {
      const summary = emptySyncSummary();
      for (const parcel of fairSyncPackages(await this.client.listActivePackages())) {
        summary.checked += 1;
        summary[await this.syncOne(parcel)] += 1;
      }
      await this.dispatchNotifications(summary);
      return summary;
    });
  }

  async syncPackage(parcel: JsonObject): Promise<SyncSummary> {
    return await this.exclusive(async () => {
      const summary = emptySyncSummary();
      summary.checked = 1;
      summary[await this.syncOne(parcel)] += 1;
      await this.dispatchNotifications(summary);
      return summary;
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async dispatchNotifications(summary: SyncSummary): Promise<void> {
    if (!this.notifier) return;
    try {
      const push = await this.notifier.dispatch();
      summary.notifications_sent = push.sent;
      summary.notification_errors = push.failed;
      summary.subscriptions_expired = push.expired;
    } catch {
      summary.notification_errors += 1;
    }
  }

  private async syncOne(parcel: JsonObject): Promise<SyncOutcome> {
    const id = String(parcel.id ?? '');
    const carrierId = String(parcel.carrier ?? '');
    if (!id) throw new TypeError('A package id is required for synchronization');
    if (!AUTOMATIC_CARRIER_IDS.has(carrierId)) {
      await this.client.updatePackage(id, {
        sync_status: 'unsupported',
        sync_error: 'Choose a carrier with an automatic adapter or use the carrier link.',
        last_synced_at: null,
      });
      return 'unsupported';
    }

    await this.client.updatePackage(id, { sync_status: 'syncing', sync_error: null });
    const now = this.now();
    try {
      let fetched: { result: CarrierResult; sourceCarrierId: string; swissPostReady: boolean | null };
      try {
        fetched = await this.fetchResult(parcel, carrierId);
      } catch (error) {
        const hasProgress = String(parcel.current_stage ?? 'pending') !== 'pending';
        if (!hasProgress && isUnannouncedTrackingError(error)) {
          await this.client.updatePackage(id, {
            last_synced_at: now.toISOString(),
            sync_status: 'waiting',
            sync_error: null,
          });
          return 'waiting';
        }
        throw error;
      }

      const { result, sourceCarrierId, swissPostReady } = fetched;
      const events = buildEvents(parcel, result, sourceCarrierId);
      await this.client.insertEvents(events);
      if (sourceCarrierId === 'swiss-post' && (result.events?.length ?? 0) > 0) {
        await this.client.deleteEventsByDescriptions(id, new Set([
          'TO_BE_DELIVERED', 'REPORTED', 'IN_DELIVERY', 'DELIVERED',
          'MISSED_DELIVERY', 'NOT_DELIVERED', 'RETURNED', 'CUSTOMS', 'REGISTERED',
        ]));
      }
      const reportedStage = resultStage(result);
      const latestEvent = [...events].sort(
        (left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)),
      )[0];
      const stage = latestEvent ? String(latestEvent.stage) : reportedStage;
      const hasUpdate = Boolean(
        (stage && stage !== 'pending')
        || events.some((event) => event.stage !== 'pending'),
      );
      const handoff = supportsSwissPostHandoff(String(parcel.tracking_number ?? ''));
      const knownUpdate = hasUpdate || Boolean(handoff && swissPostReady);
      const carrierData: JsonObject = Object.fromEntries(
        Object.entries(result).filter(([key, value]) => key !== 'events' && value != null),
      );
      if (handoff) {
        carrierData.active_tracking_carrier = sourceCarrierId;
        carrierData.swiss_post_ready = swissPostReady;
      }
      const values: JsonObject = {
        last_synced_at: now.toISOString(),
        sync_status: knownUpdate ? 'ok' : 'waiting',
        sync_error: null,
        last_status_text: result.last_status_text || null,
        expected_delivery: result.expected_delivery ? String(result.expected_delivery) : null,
        carrier_data: carrierData,
      };
      if (stage && (hasUpdate || !swissPostReady)) values.current_stage = stage;
      await this.client.updatePackage(id, values);
      return knownUpdate ? 'updated' : 'waiting';
    } catch (error) {
      let message = error instanceof Error ? error.message.trim() || error.name : String(error);
      if (error instanceof SyntaxError) {
        message = 'The carrier returned a maintenance page instead of tracking data.';
      }
      await this.client.updatePackage(id, {
        last_synced_at: now.toISOString(),
        sync_status: 'error',
        sync_error: message.slice(0, 500),
      });
      return 'errors';
    }
  }

  private async fetchResult(
    parcel: JsonObject,
    carrierId: string,
  ): Promise<{ result: CarrierResult; sourceCarrierId: string; swissPostReady: boolean | null }> {
    const trackingNumber = String(parcel.tracking_number ?? '');
    if (!supportsSwissPostHandoff(trackingNumber)) {
      const result = await this.adapter.fetch(
        carrierId,
        trackingNumber,
        typeof parcel.tracking_url === 'string' ? parcel.tracking_url : null,
        typeof parcel.dpd_postcode === 'string' ? parcel.dpd_postcode : null,
      );
      return { result: normalizeCarrierResult(result), sourceCarrierId: carrierId, swissPostReady: null };
    }
    const wasReady = isRecord(parcel.carrier_data) && parcel.carrier_data.swiss_post_ready === true;
    if (wasReady) {
      const result = await this.adapter.fetch('swiss-post', trackingNumber, null, null);
      return { result: normalizeCarrierResult(result), sourceCarrierId: 'swiss-post', swissPostReady: true };
    }
    try {
      const swiss = normalizeCarrierResult(
        await this.adapter.fetch('swiss-post', trackingNumber, null, null),
      );
      if (resultHasUpdate(swiss)) {
        return { result: swiss, sourceCarrierId: 'swiss-post', swissPostReady: true };
      }
    } catch {
      // Cainiao still covers the international leg if Swiss Post is not ready.
    }
    const cainiao = await this.adapter.fetch('aliexpress', trackingNumber, null, null);
    return {
      result: normalizeCarrierResult(cainiao),
      sourceCarrierId: 'aliexpress',
      swissPostReady: false,
    };
  }
}

export function fairSyncPackages(
  packages: JsonObject[],
  perOwnerLimit = MAX_PACKAGES_PER_OWNER_PER_SYNC,
): JsonObject[] {
  if (!Number.isInteger(perOwnerLimit) || perOwnerLimit < 1) {
    throw new TypeError('Per-owner synchronization limits must be positive');
  }
  const grouped = new Map<string, JsonObject[]>();
  for (const parcel of packages) {
    const owner = String(parcel.user_id ?? `legacy:${parcel.id}`);
    grouped.set(owner, [...(grouped.get(owner) ?? []), parcel]);
  }
  const served = new Map<string, number>();
  const active = [...grouped.keys()];
  const ordered: JsonObject[] = [];
  while (active.length > 0) {
    const owner = active.shift()!;
    const rows = grouped.get(owner)!;
    const count = served.get(owner) ?? 0;
    if (rows.length === 0 || count >= perOwnerLimit) continue;
    ordered.push(rows.shift()!);
    served.set(owner, count + 1);
    if (rows.length > 0 && count + 1 < perOwnerLimit) active.push(owner);
  }
  return ordered;
}
