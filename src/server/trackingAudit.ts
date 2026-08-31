import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  captureOperationalError,
  captureSyncAnomaly,
  errorType,
  logOperationalEvent,
} from './observability';
import type { SupabaseServiceClient } from './supabase';
import type { JsonObject } from './types';

export type SyncTrigger = 'package' | 'scheduled';
export type SyncStep =
  | 'selected'
  | 'fetch'
  | 'normalize'
  | 'persist_events'
  | 'persist_package'
  | 'complete';
export type SyncAuditOutcome = 'updated' | 'waiting' | 'error' | 'unsupported';
export type SyncAnomalyCode =
  | 'delivered_status_conflict'
  | 'future_event_timestamp'
  | 'invalid_event_timestamp'
  | 'observed_without_timestamp'
  | 'progress_disappeared'
  | 'terminal_stage_regression';

export interface SyncRunContext {
  jobId?: string | null;
  trigger: SyncTrigger;
}

export interface SyncAuditCompletion {
  outcome: SyncAuditOutcome;
  sourceCarrier?: string | null;
  providerStatus?: string | null;
  reportedStage?: string | null;
  selectedStage?: string | null;
  statusText?: string | null;
  eventsReceived?: number;
  eventsNormalized?: number;
  anomalyCodes?: SyncAnomalyCode[];
  error?: unknown;
}

type StepStatus = 'succeeded' | 'failed' | 'skipped';

interface StoredStep extends JsonObject {
  sequence: number;
  step: SyncStep;
  status: StepStatus;
  occurred_at: string;
  duration_ms: number | null;
  details: JsonObject;
  error_type: string | null;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

function boundedCount(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 0 ? Math.min(value!, 10_000) : 0;
}

function safeDetails(details: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => (
      value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    )),
  );
}

export class TrackingSyncAudit {
  readonly attemptId = randomUUID();
  readonly #startedAt = performance.now();
  readonly #startedAtIso: string;
  readonly #steps: StoredStep[] = [];
  #reportedWriteFailure = false;

  constructor(
    readonly client: SupabaseServiceClient,
    readonly packageId: string,
    readonly configuredCarrier: string,
    readonly previousStage: string,
    readonly context: SyncRunContext,
    now = new Date(),
  ) {
    this.#startedAtIso = now.toISOString();
  }

  async start(): Promise<void> {
    await this.writeAudit('start_attempt', async () => {
      await this.client.startSyncAttempt(this.attemptId, {
        job_id: this.context.jobId ?? null,
        package_id: this.packageId,
        trigger: this.context.trigger,
        configured_carrier: this.configuredCarrier,
        previous_stage: this.previousStage,
        started_at: this.#startedAtIso,
      });
    });
    logOperationalEvent('tracking_sync_started', this.logContext());
  }

  record(
    step: SyncStep,
    status: StepStatus,
    durationMs: number | null,
    details: JsonObject = {},
    error?: unknown,
  ): void {
    const stored: StoredStep = {
      sequence: this.#steps.length + 1,
      step,
      status,
      occurred_at: new Date().toISOString(),
      duration_ms: durationMs == null ? null : Math.max(0, Math.round(durationMs)),
      details: safeDetails(details),
      error_type: error === undefined ? null : errorType(error),
    };
    this.#steps.push(stored);
    logOperationalEvent('tracking_sync_step', {
      ...this.logContext(),
      step,
      step_status: status,
      duration_ms: stored.duration_ms,
      error_type: stored.error_type,
      ...stored.details,
    }, status === 'failed' ? 'error' : 'info');
  }

  async step<T>(
    step: SyncStep,
    operation: () => Promise<T> | T,
    details: (value: T) => JsonObject = () => ({}),
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const value = await operation();
      this.record(step, 'succeeded', elapsedMilliseconds(startedAt), details(value));
      return value;
    } catch (error) {
      this.record(step, 'failed', elapsedMilliseconds(startedAt), {}, error);
      throw error;
    }
  }

  skip(step: SyncStep, reason: string): void {
    this.record(step, 'skipped', null, { reason: reason.slice(0, 100) });
  }

  reportError(error: unknown, operation: SyncStep | string): void {
    captureOperationalError(error, {
      component: 'tracking-sync',
      operation,
      carrier: this.configuredCarrier,
      attemptId: this.attemptId,
      jobId: this.context.jobId,
      trigger: this.context.trigger,
      previousStage: this.previousStage,
    });
  }

  reportAnomalies(
    anomalies: SyncAnomalyCode[],
    completion: Omit<SyncAuditCompletion, 'outcome' | 'anomalyCodes' | 'error'>,
  ): void {
    const alertable = anomalies.filter((code) => code !== 'observed_without_timestamp');
    for (const anomalyCode of alertable) {
      captureSyncAnomaly(anomalyCode, {
        component: 'tracking-sync',
        operation: 'classify',
        carrier: this.configuredCarrier,
        attemptId: this.attemptId,
        jobId: this.context.jobId,
        trigger: this.context.trigger,
        previousStage: this.previousStage,
        providerStatus: completion.providerStatus,
        reportedStage: completion.reportedStage,
        selectedStage: completion.selectedStage,
        eventsReceived: completion.eventsReceived,
        eventsNormalized: completion.eventsNormalized,
      });
    }
  }

  async finish(completion: SyncAuditCompletion): Promise<void> {
    if (!this.#steps.some((step) => step.step === 'complete')) {
      this.record('complete', 'succeeded', elapsedMilliseconds(this.#startedAt), {
        outcome: completion.outcome,
      });
    }
    const completedAt = new Date();
    const values: JsonObject = {
      outcome: completion.outcome,
      source_carrier: completion.sourceCarrier ?? null,
      provider_status: completion.providerStatus ?? null,
      reported_stage: completion.reportedStage ?? null,
      selected_stage: completion.selectedStage ?? null,
      status_text: completion.statusText?.slice(0, 500) || null,
      events_received: boundedCount(completion.eventsReceived),
      events_normalized: boundedCount(completion.eventsNormalized),
      anomaly_codes: [...new Set(completion.anomalyCodes ?? [])].slice(0, 16),
      error_type: completion.error === undefined ? null : errorType(completion.error),
      completed_at: completedAt.toISOString(),
      duration_ms: Math.round(elapsedMilliseconds(this.#startedAt)),
    };
    await this.writeAudit('complete_attempt', async () => {
      const completed = await this.client.completeSyncAttempt(
        this.attemptId,
        values,
        this.#steps,
      );
      if (!completed) throw new Error('The tracking sync attempt was not running');
    });
    logOperationalEvent('tracking_sync_completed', {
      ...this.logContext(),
      outcome: completion.outcome,
      duration_ms: values.duration_ms,
      source_carrier: completion.sourceCarrier ?? null,
      provider_status: completion.providerStatus ?? null,
      reported_stage: completion.reportedStage ?? null,
      selected_stage: completion.selectedStage ?? null,
      events_received: values.events_received,
      events_normalized: values.events_normalized,
      anomaly_count: (completion.anomalyCodes ?? []).length,
      error_type: values.error_type,
    }, completion.outcome === 'error' ? 'error' : 'info');
  }

  private logContext(): JsonObject {
    return {
      attempt_id: this.attemptId,
      job_id: this.context.jobId ?? null,
      trigger: this.context.trigger,
      carrier: this.configuredCarrier,
    };
  }

  private async writeAudit(operation: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      logOperationalEvent('tracking_sync_audit_write_failed', {
        ...this.logContext(),
        operation,
        error_type: errorType(error),
      }, 'error');
      if (!this.#reportedWriteFailure) {
        this.#reportedWriteFailure = true;
        captureOperationalError(error, {
          component: 'tracking-sync-audit',
          operation,
          carrier: this.configuredCarrier,
          attemptId: this.attemptId,
          jobId: this.context.jobId,
          trigger: this.context.trigger,
        });
      }
    }
  }
}
