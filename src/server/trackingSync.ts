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
import { AmazonLogisticsTracker } from './amazonLogistics';
import { ColisPriveTracker } from './colisPrive';
import { ColiswebTracker } from './colisweb';
import { CChezVousTracker } from './cChezVous';
import { CiblexTracker } from './ciblex';
import { DachserTracker } from './dachser';
import { DPDFranceTracker } from './dpdFrance';
import { DPDTracker } from './dpd';
import { GeodisTracker } from './geodis';
import { GLSFranceTracker } from './glsFrance';
import { GLSSwitzerlandTracker } from './glsSwitzerland';
import { HeppnerTracker } from './heppner';
import { HermesTracker } from './hermes';
import { LaPosteTracker } from './laPoste';
import { MondialRelayTracker } from './mondialRelay';
import { captureOperationalError, errorType } from './observability';
import { PaackTracker } from './paack';
import { PlanzerSharedTracker } from './planzerShared';
import type { CompositePushNotificationService } from './push';
import { RelaisColisTracker } from './relaisColis';
import type { SupabaseServiceClient } from './supabase';
import { SwissPostTracker } from './swissPost';
import { SwissPostCargoTracker } from './swissPostCargo';
import {
  TrackingSyncAudit,
  type SyncAnomalyCode,
  type SyncRunContext,
} from './trackingAudit';
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
    readonly dpdFrance = new DPDFranceTracker(),
    readonly mondialRelay = new MondialRelayTracker(),
    readonly relaisColis = new RelaisColisTracker(),
    readonly swissPostCargo = new SwissPostCargoTracker(),
    readonly glsSwitzerland = new GLSSwitzerlandTracker(),
    readonly colisweb = new ColiswebTracker(),
    readonly cChezVous = new CChezVousTracker(),
    readonly heppner = new HeppnerTracker(),
    readonly ciblex = new CiblexTracker(),
    readonly paack = new PaackTracker(),
    readonly amazonLogistics = new AmazonLogisticsTracker(),
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
    } else if (adapter === 'swiss-post-cargo') {
      result = await this.swissPostCargo.fetch(trackingNumber);
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
    } else if (adapter === 'gls-switzerland') {
      result = await this.glsSwitzerland.fetch(trackingNumber, dpdPostcode ?? '');
    } else if (adapter === 'colis-prive') {
      result = await this.colisPrive.fetch(trackingNumber);
    } else if (adapter === 'geodis') {
      result = await this.geodis.fetch(trackingNumber);
    } else if (adapter === 'dpd-france') {
      result = await this.dpdFrance.fetch(trackingNumber);
    } else if (adapter === 'mondial-relay') {
      result = await this.mondialRelay.fetch(trackingNumber, dpdPostcode ?? '');
    } else if (adapter === 'relais-colis') {
      result = await this.relaisColis.fetch(trackingNumber);
    } else if (adapter === 'colisweb') {
      result = await this.colisweb.fetch(trackingNumber);
    } else if (adapter === 'c-chez-vous') {
      result = await this.cChezVous.fetch(trackingNumber);
    } else if (adapter === 'heppner') {
      result = await this.heppner.fetch(trackingNumber, dpdPostcode ?? '');
    } else if (adapter === 'ciblex') {
      result = await this.ciblex.fetch(trackingNumber);
    } else if (adapter === 'paack') {
      result = await this.paack.fetch(trackingNumber, dpdPostcode ?? '');
    } else if (adapter === 'amazon-logistics') {
      result = await this.amazonLogistics.fetch(trackingNumber);
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
  const declaredCurrent = String(result.current_stage ?? '');
  if (VALID_STAGES.has(declaredCurrent)) return declaredCurrent;
  const status = String(result.status ?? 'unknown');
  const text = String(result.last_status_text ?? '');
  switch (status) {
    case 'pending': {
      const inferred = inferStage(text, 'pending');
      if (inferred !== 'pending') return inferred;
      const declared = String(result.events?.[0]?.stage ?? '');
      return VALID_STAGES.has(declared) ? declared : 'pending';
    }
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
  observedAt?: Date,
): JsonObject[] {
  const reportedCurrent = resultStage(result);
  const current = reportedCurrent ?? 'in_transit';
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
  const previousStage = String(parcel.current_stage ?? 'pending');
  const currentAlreadyTimed = rows.some((row) => row.stage === current);
  if (
    observedAt
    && !Number.isNaN(observedAt.getTime())
    && reportedCurrent !== null
    && (result.status !== 'pending' || rows.length === 0)
    && current !== 'pending'
    && current !== previousStage
    && !currentAlreadyTimed
  ) {
    const matchingEvent = (result.events ?? []).find((raw) => {
      const declaredStage = String(raw.stage ?? '');
      const description = String(raw.description ?? '');
      return (VALID_STAGES.has(declaredStage) ? declaredStage : inferStage(description, current))
        === current;
    });
    const description = String(
      matchingEvent?.description ?? result.last_status_text ?? 'Tracking update',
    ).trim() || 'Tracking update';
    const location = String(matchingEvent?.location ?? '').trim();
    const occurredAt = observedAt.toISOString();
    rows.push({
      package_id: parcel.id,
      stage: current,
      description,
      location: location || null,
      occurred_at: occurredAt,
      provider_event_id: providerEventId(
        carrierId,
        `observed:${previousStage}->${current}`,
        location,
        description,
      ),
      raw_data: { observed_without_provider_timestamp: true },
    });
  }
  return rows;
}

export function detectSyncAnomalies(
  parcel: JsonObject,
  result: CarrierResult,
  events: JsonObject[],
  sourceCarrierId: string,
  selectedStage: string | null,
  now: Date,
): SyncAnomalyCode[] {
  const anomalies = new Set<SyncAnomalyCode>();
  const timezone = resultTimezone(sourceCarrierId, result);
  if ((result.events ?? []).some((event) => (
    typeof event.time === 'string'
    && event.time.trim() !== ''
    && eventTimestamp(event.time, timezone) === null
  ))) {
    anomalies.add('invalid_event_timestamp');
  }
  const futureBoundary = now.getTime() + 24 * 60 * 60 * 1_000;
  if (events.some((event) => {
    const occurredAt = Date.parse(String(event.occurred_at ?? ''));
    return Number.isFinite(occurredAt) && occurredAt > futureBoundary;
  })) {
    anomalies.add('future_event_timestamp');
  }
  if (events.some((event) => (
    isRecord(event.raw_data)
    && event.raw_data.observed_without_provider_timestamp === true
  ))) {
    anomalies.add('observed_without_timestamp');
  }
  const previousStage = String(parcel.current_stage ?? 'pending');
  if (
    (previousStage === 'delivered' || previousStage === 'returned')
    && selectedStage !== null
    && selectedStage !== previousStage
  ) {
    anomalies.add('terminal_stage_regression');
  }
  if (result.status === 'delivered' && selectedStage !== 'delivered') {
    anomalies.add('delivered_status_conflict');
  }
  if (previousStage !== 'pending' && !resultHasUpdate(result)) {
    anomalies.add('progress_disappeared');
  }
  return [...anomalies];
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

  async sync(context: SyncRunContext = { trigger: 'scheduled' }): Promise<SyncSummary> {
    return await this.exclusive(async () => {
      const summary = emptySyncSummary();
      for (const parcel of fairSyncPackages(await this.client.listActivePackages())) {
        summary.checked += 1;
        summary[await this.syncOne(parcel, context)] += 1;
      }
      await this.dispatchNotifications(summary);
      return summary;
    });
  }

  async syncPackage(
    parcel: JsonObject,
    context: SyncRunContext = { trigger: 'package' },
  ): Promise<SyncSummary> {
    return await this.exclusive(async () => {
      const summary = emptySyncSummary();
      summary.checked = 1;
      summary[await this.syncOne(parcel, context)] += 1;
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
      if (push.failed > 0) {
        captureOperationalError(new Error('Push dispatch returned failed deliveries'), {
          component: 'push',
          operation: 'dispatch',
          failureCount: push.failed,
        });
      }
    } catch (error) {
      summary.notification_errors += 1;
      captureOperationalError(error, { component: 'push', operation: 'dispatch' });
    }
  }

  private async syncOne(parcel: JsonObject, context: SyncRunContext): Promise<SyncOutcome> {
    const id = String(parcel.id ?? '');
    const carrierId = String(parcel.carrier ?? '');
    if (!id) throw new TypeError('A package id is required for synchronization');
    const previousStage = String(parcel.current_stage ?? 'pending');
    const now = this.now();
    const audit = new TrackingSyncAudit(
      this.client,
      id,
      carrierId || 'unknown',
      previousStage,
      context,
      now,
    );
    await audit.start();

    if (!AUTOMATIC_CARRIER_IDS.has(carrierId)) {
      audit.record('selected', 'succeeded', 0, { automatic: false });
      audit.skip('fetch', 'unsupported_carrier');
      audit.skip('normalize', 'unsupported_carrier');
      audit.skip('persist_events', 'unsupported_carrier');
      try {
        await audit.step('persist_package', async () => {
          await this.client.updatePackage(id, {
            sync_status: 'unsupported',
            sync_error: 'Choose a carrier with an automatic adapter or use the carrier link.',
            last_synced_at: null,
          });
        });
        await audit.finish({ outcome: 'unsupported' });
        return 'unsupported';
      } catch (error) {
        audit.reportError(error, 'persist_package');
        await audit.finish({ outcome: 'error', error });
        throw error;
      }
    }

    let operation: 'selected' | 'fetch' | 'normalize' | 'persist_events' | 'persist_package'
      = 'selected';
    let result: CarrierResult | null = null;
    let sourceCarrierId: string | null = null;
    let reportedStage: string | null = null;
    let selectedStage: string | null = null;
    let events: JsonObject[] = [];
    let anomalies: SyncAnomalyCode[] = [];
    try {
      await audit.step('selected', async () => {
        await this.client.updatePackage(id, { sync_status: 'syncing', sync_error: null });
      }, () => ({ automatic: true }));

      operation = 'fetch';
      let fetched: {
        result: CarrierResult;
        sourceCarrierId: string;
        swissPostReady: boolean | null;
        handoffFallbackErrorType: string | null;
      };
      const fetchStartedAt = performance.now();
      try {
        fetched = await this.fetchResult(parcel, carrierId);
      } catch (error) {
        const hasProgress = previousStage !== 'pending';
        if (!hasProgress && isUnannouncedTrackingError(error)) {
          audit.record('fetch', 'succeeded', performance.now() - fetchStartedAt, {
            disposition: 'unannounced',
          });
          audit.skip('normalize', 'unannounced');
          audit.skip('persist_events', 'unannounced');
          operation = 'persist_package';
          await audit.step('persist_package', async () => {
            await this.client.updatePackage(id, {
              last_synced_at: now.toISOString(),
              sync_status: 'waiting',
              sync_error: null,
            });
          });
          await audit.finish({
            outcome: 'waiting',
            sourceCarrier: carrierId,
            eventsReceived: 0,
            eventsNormalized: 0,
          });
          return 'waiting';
        }
        audit.record('fetch', 'failed', performance.now() - fetchStartedAt, {}, error);
        throw error;
      }

      ({ result, sourceCarrierId } = fetched);
      const { swissPostReady, handoffFallbackErrorType } = fetched;
      audit.record('fetch', 'succeeded', performance.now() - fetchStartedAt, {
        source_carrier: sourceCarrierId,
        swiss_post_ready: swissPostReady,
        handoff_fallback_error_type: handoffFallbackErrorType,
      });

      operation = 'normalize';
      const normalized = await audit.step('normalize', () => {
        const normalizedEvents = buildEvents(parcel, result!, sourceCarrierId!, now);
        const normalizedReportedStage = resultStage(result!);
        const latestEvent = [...normalizedEvents].sort(
          (left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)),
        )[0];
        const latestEventStage = latestEvent ? String(latestEvent.stage) : null;
        // A provider's explicit non-pending summary can be newer than its last
        // timestamped milestone. Timed progress remains authoritative only
        // while the provider's summary is still pending.
        const normalizedSelectedStage = normalizedReportedStage && result!.status !== 'pending'
          ? normalizedReportedStage
          : latestEventStage ?? normalizedReportedStage;
        return {
          events: normalizedEvents,
          reportedStage: normalizedReportedStage,
          selectedStage: normalizedSelectedStage,
        };
      }, (value) => ({
        events_received: result?.events?.length ?? 0,
        events_normalized: value.events.length,
        provider_status: result?.status ?? 'unknown',
        reported_stage: value.reportedStage,
        selected_stage: value.selectedStage,
      }));
      events = normalized.events;
      reportedStage = normalized.reportedStage;
      selectedStage = normalized.selectedStage;
      anomalies = detectSyncAnomalies(
        parcel,
        result,
        events,
        sourceCarrierId,
        selectedStage,
        now,
      );

      operation = 'persist_events';
      await audit.step('persist_events', async () => {
        await this.client.insertEvents(events);
        if (sourceCarrierId === 'swiss-post' && (result!.events?.length ?? 0) > 0) {
          await this.client.deleteEventsByDescriptions(id, new Set([
            'TO_BE_DELIVERED', 'REPORTED', 'IN_DELIVERY', 'DELIVERED',
            'MISSED_DELIVERY', 'NOT_DELIVERED', 'RETURNED', 'CUSTOMS', 'REGISTERED',
          ]));
        }
      }, () => ({ events_persisted: events.length }));
      const hasUpdate = Boolean(
        (selectedStage && selectedStage !== 'pending')
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
      if (selectedStage && (hasUpdate || !swissPostReady)) values.current_stage = selectedStage;
      operation = 'persist_package';
      await audit.step('persist_package', async () => {
        await this.client.updatePackage(id, values);
      }, () => ({
        outcome: knownUpdate ? 'updated' : 'waiting',
        selected_stage: selectedStage,
      }));
      const outcome = knownUpdate ? 'updated' : 'waiting';
      const completion = {
        outcome,
        sourceCarrier: sourceCarrierId,
        providerStatus: result.status ?? 'unknown',
        reportedStage,
        selectedStage,
        statusText: result.last_status_text,
        eventsReceived: result.events?.length ?? 0,
        eventsNormalized: events.length,
        anomalyCodes: anomalies,
      } as const;
      await audit.finish(completion);
      audit.reportAnomalies(anomalies, completion);
      return outcome;
    } catch (error) {
      audit.reportError(error, operation);
      let message = error instanceof Error ? error.message.trim() || error.name : String(error);
      if (error instanceof SyntaxError) {
        message = 'The carrier returned a maintenance page instead of tracking data.';
      }
      try {
        await audit.step('persist_package', async () => {
          await this.client.updatePackage(id, {
            last_synced_at: now.toISOString(),
            sync_status: 'error',
            sync_error: message.slice(0, 500),
          });
        }, () => ({ purpose: 'record_error' }));
      } catch (persistenceError) {
        audit.reportError(persistenceError, 'persist_error_state');
        await audit.finish({
          outcome: 'error',
          sourceCarrier: sourceCarrierId,
          providerStatus: result?.status ?? null,
          reportedStage,
          selectedStage,
          statusText: result?.last_status_text,
          eventsReceived: result?.events?.length ?? 0,
          eventsNormalized: events.length,
          anomalyCodes: anomalies,
          error,
        });
        throw persistenceError;
      }
      await audit.finish({
        outcome: 'error',
        sourceCarrier: sourceCarrierId,
        providerStatus: result?.status ?? null,
        reportedStage,
        selectedStage,
        statusText: result?.last_status_text,
        eventsReceived: result?.events?.length ?? 0,
        eventsNormalized: events.length,
        anomalyCodes: anomalies,
        error,
      });
      return 'errors';
    }
  }

  private async fetchResult(
    parcel: JsonObject,
    carrierId: string,
  ): Promise<{
    result: CarrierResult;
    sourceCarrierId: string;
    swissPostReady: boolean | null;
    handoffFallbackErrorType: string | null;
  }> {
    const trackingNumber = String(parcel.tracking_number ?? '');
    if (!supportsSwissPostHandoff(trackingNumber)) {
      const result = await this.adapter.fetch(
        carrierId,
        trackingNumber,
        typeof parcel.tracking_url === 'string' ? parcel.tracking_url : null,
        typeof parcel.dpd_postcode === 'string' ? parcel.dpd_postcode : null,
      );
      return {
        result: normalizeCarrierResult(result),
        sourceCarrierId: carrierId,
        swissPostReady: null,
        handoffFallbackErrorType: null,
      };
    }
    const wasReady = isRecord(parcel.carrier_data) && parcel.carrier_data.swiss_post_ready === true;
    if (wasReady) {
      const result = await this.adapter.fetch('swiss-post', trackingNumber, null, null);
      return {
        result: normalizeCarrierResult(result),
        sourceCarrierId: 'swiss-post',
        swissPostReady: true,
        handoffFallbackErrorType: null,
      };
    }
    let handoffFallbackErrorType: string | null = null;
    try {
      const swiss = normalizeCarrierResult(
        await this.adapter.fetch('swiss-post', trackingNumber, null, null),
      );
      if (resultHasUpdate(swiss)) {
        return {
          result: swiss,
          sourceCarrierId: 'swiss-post',
          swissPostReady: true,
          handoffFallbackErrorType: null,
        };
      }
    } catch (error) {
      handoffFallbackErrorType = errorType(error);
      // Cainiao still covers the international leg if Swiss Post is not ready.
    }
    const cainiao = await this.adapter.fetch('aliexpress', trackingNumber, null, null);
    return {
      result: normalizeCarrierResult(cainiao),
      sourceCarrierId: 'aliexpress',
      swissPostReady: false,
      handoffFallbackErrorType,
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
