import 'server-only';

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { pushServices } from './push';
import { serviceClient } from './runtime';
import type { SupabaseServiceClient } from './supabase';
import { TrackingSyncService, type SyncSummary } from './trackingSync';
import type { JsonObject } from './types';

const AUTO_ARCHIVE_DAYS = 60;
const MAX_WORKER_BACKOFF_MS = 60_000;

export interface BackgroundState {
  lastScheduledSync: number | null;
  nextScheduledSync: number | null;
  lastSummary: JsonObject | null;
  lastError: string | null;
  lastAutoArchived: number;
  workerHeartbeat: number | null;
}

function initialState(): BackgroundState {
  return {
    lastScheduledSync: null,
    nextScheduledSync: null,
    lastSummary: null,
    lastError: null,
    lastAutoArchived: 0,
    workerHeartbeat: null,
  };
}

function log(event: string, fields: JsonObject = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }));
}

export function secondsUntilNextSync(now = new Date()): number {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Sync clock must be valid');
  const local = DateTime.fromJSDate(now, { zone: 'Europe/Zurich' });
  let candidate: DateTime;
  if (local.hour >= 8 && local.hour < 22) {
    const minutes = 10 - (local.minute % 10);
    candidate = local.startOf('minute').plus({ minutes });
  } else {
    candidate = local.startOf('hour').plus({ hours: 1 });
  }
  return Math.max(1, candidate.toUTC().diff(local.toUTC(), 'seconds').seconds);
}

export function workerPollDelay(pollIntervalMs: number, consecutiveFailures: number): number {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError('Worker poll interval must be positive');
  }
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new TypeError('Worker failure count must be a non-negative integer');
  }
  if (consecutiveFailures === 0) return pollIntervalMs;
  return Math.min(
    MAX_WORKER_BACKOFF_MS,
    pollIntervalMs * (2 ** Math.min(consecutiveFailures - 1, 6)),
  );
}

export class SyncJobWorker {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 12)}`;
  #stopped = false;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #consecutiveClaimFailures = 0;

  constructor(
    readonly service: TrackingSyncService,
    readonly state: BackgroundState,
    readonly pollIntervalMs = 1_000,
  ) {}

  start(): void {
    if (this.#stopped || this.#timer || this.#running) return;
    this.schedule(0);
  }

  wake(): void {
    if (this.#stopped || this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  private schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.run();
    }, delayMs);
    this.#timer.unref();
  }

  private async run(): Promise<void> {
    if (this.#stopped || this.#running) return;
    this.#running = true;
    this.state.workerHeartbeat = Date.now() / 1_000;
    let processed = false;
    try {
      processed = await this.processNext();
    } finally {
      this.#running = false;
      if (!this.#stopped) {
        this.schedule(processed ? 0 : workerPollDelay(
          this.pollIntervalMs,
          this.#consecutiveClaimFailures,
        ));
      }
    }
  }

  private async processNext(): Promise<boolean> {
    let job: JsonObject | null;
    try {
      job = await this.service.client.claimSyncJob(this.workerId);
    } catch (error) {
      this.#consecutiveClaimFailures += 1;
      this.state.lastError = error instanceof Error ? error.name : typeof error;
      log('sync_claim_failed', {
        error_type: this.state.lastError,
        retry_in_ms: workerPollDelay(this.pollIntervalMs, this.#consecutiveClaimFailures),
      });
      return false;
    }
    this.#consecutiveClaimFailures = 0;
    if (!job) return false;
    const jobId = String(job.id ?? '');
    const kind = String(job.kind ?? '');
    if (!jobId) {
      log('sync_job_invalid', { kind });
      return true;
    }
    try {
      let summary: SyncSummary;
      let archived = 0;
      if (kind === 'package') {
        const packageId = String(job.package_id ?? '');
        const parcel = packageId ? await this.service.client.getPackage(packageId) : null;
        if (!parcel) throw new Error('Package no longer exists');
        summary = await this.service.syncPackage(parcel);
      } else if (kind === 'scheduled') {
        summary = await this.service.sync();
        archived = await this.service.client.archiveDeliveredBefore(
          new Date(Date.now() - AUTO_ARCHIVE_DAYS * 86_400_000),
        );
        this.state.lastScheduledSync = Date.now() / 1_000;
        this.state.lastAutoArchived = archived;
      } else {
        throw new TypeError('Unknown synchronization job kind');
      }
      const result: JsonObject = { ...summary, auto_archived: archived };
      await this.service.client.finishSyncJob(jobId, this.workerId, { result });
      this.state.lastSummary = result;
      this.state.lastError = null;
      log('sync_job_completed', { job_id: jobId, kind });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      this.state.lastError = errorType;
      log('sync_job_failed', { job_id: jobId, kind, error_type: errorType });
      try {
        await this.service.client.finishSyncJob(jobId, this.workerId, {
          error: 'Tracking refresh failed. Try again.',
        });
      } catch (finishError) {
        log('sync_job_finish_failed', {
          job_id: jobId,
          error_type: finishError instanceof Error ? finishError.name : typeof finishError,
        });
      }
    }
    return true;
  }
}

class ScheduledSync {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(
    readonly client: SupabaseServiceClient,
    readonly worker: SyncJobWorker,
    readonly state: BackgroundState,
  ) {}

  start(): void {
    if (this.#stopped || this.#timer) return;
    this.schedule(8_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  private schedule(delayMs: number): void {
    this.state.nextScheduledSync = (Date.now() + delayMs) / 1_000;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.enqueueAndReschedule();
    }, delayMs);
    this.#timer.unref();
  }

  private async enqueueAndReschedule(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.client.enqueueSyncJob({ scheduled: true });
      this.state.lastError = null;
      this.worker.wake();
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      this.state.lastError = errorType;
      log('scheduled_sync_enqueue_failed', { error_type: errorType });
    }
    this.schedule(secondsUntilNextSync() * 1_000);
  }
}

interface BackgroundRuntime {
  client: SupabaseServiceClient;
  state: BackgroundState;
  worker: SyncJobWorker;
  scheduler: ScheduledSync;
}

const globalBackground = globalThis as typeof globalThis & {
  __deliveryBackgroundRuntime?: BackgroundRuntime;
};

export function startBackgroundServices(): BackgroundRuntime | null {
  const client = serviceClient();
  if (!client) return null;
  const current = globalBackground.__deliveryBackgroundRuntime;
  if (current?.client === client) {
    current.worker.start();
    current.scheduler.start();
    return current;
  }
  current?.worker.stop();
  current?.scheduler.stop();
  const state = initialState();
  const notifier = pushServices(client);
  const service = new TrackingSyncService(
    client,
    undefined,
    notifier.web || notifier.native || notifier.liveActivities ? notifier : null,
  );
  const worker = new SyncJobWorker(service, state);
  const scheduler = new ScheduledSync(client, worker, state);
  const runtime = { client, state, worker, scheduler };
  globalBackground.__deliveryBackgroundRuntime = runtime;
  worker.start();
  scheduler.start();
  log('background_services_started', {
    sync_enabled: true,
    web_push_enabled: Boolean(notifier.web),
    native_push_enabled: Boolean(notifier.native),
    live_activity_push_enabled: Boolean(notifier.liveActivities),
  });
  return runtime;
}

export function wakeSyncWorker(): void {
  globalBackground.__deliveryBackgroundRuntime?.worker.wake();
}

export function backgroundState(): BackgroundState | null {
  return globalBackground.__deliveryBackgroundRuntime?.state ?? null;
}
