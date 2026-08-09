import { detectCarrier, normalizeTrackingNumber } from '../lib/carriers';
import { authenticatedFetch, type ApiAuth } from '../lib/apiClient';
import type {
  ApiCreatePackageResponse,
  ApiCreatePackageRequest,
  ApiOkResponse,
  ApiPackageListResponse,
  ApiPackageRow,
  ApiQueueResponse,
  ApiRenamePackageRequest,
  ApiPackageNotificationRequest,
  ApiTrackingEventRow,
  ApiSyncJobResponse,
} from '../generated/apiContract';
import type {
  NewParcelInput,
  ParcelRepo,
  ParcelWithEvents,
  TrackingEvent,
} from '../types';

export const API_CACHE_KEY = 'parcel-post.api-cache.v1';

export function clearApiCache(storage: Storage | null, userId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(API_CACHE_KEY);
    storage.removeItem(`${API_CACHE_KEY}.${userId}`);
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

function cachedParcels(storage: Storage | null, cacheKey: string): ParcelWithEvents[] | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(cacheKey) ?? 'null');
    if (!Array.isArray(value)) return null;
    const valid = value.every((parcel) => {
      if (!parcel || typeof parcel !== 'object') return false;
      const candidate = parcel as Partial<ParcelWithEvents>;
      return typeof candidate.id === 'string'
        && typeof candidate.trackingNumber === 'string'
        && typeof candidate.label === 'string'
        && typeof candidate.carrier === 'string'
        && typeof candidate.createdAt === 'string'
        && typeof candidate.syncStatus === 'string'
        && Array.isArray(candidate.events);
    });
    return valid ? value as ParcelWithEvents[] : null;
  } catch {
    return null;
  }
}

function saveCachedParcels(
  storage: Storage | null,
  cacheKey: string,
  parcels: ParcelWithEvents[],
) {
  if (!storage) return;
  try {
    storage.setItem(cacheKey, JSON.stringify(parcels));
  } catch {
    // Storage can be unavailable in private browsing or on a full device.
  }
}

function toEvent(row: ApiTrackingEventRow): TrackingEvent {
  return {
    id: row.id,
    parcelId: row.package_id,
    stage: row.stage,
    description: row.description,
    location: row.location ?? undefined,
    occurredAt: row.occurred_at,
  };
}

function toParcel(row: ApiPackageRow): ParcelWithEvents {
  return {
    id: row.id,
    trackingNumber: row.tracking_number,
    label: row.label,
    carrier: row.carrier,
    createdAt: row.created_at,
    expectedDelivery: row.expected_delivery ?? undefined,
    lastStatusText: row.last_status_text ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status,
    syncError: row.sync_error ?? undefined,
    trackingUrl: row.tracking_url ?? undefined,
    dpdPostcode: row.dpd_postcode ?? undefined,
    trackingSource: row.carrier_data?.active_tracking_carrier ?? undefined,
    swissPostReady: row.carrier_data?.swiss_post_ready ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    notificationsMuted: row.notifications_muted,
    events: (row.tracking_events ?? []).map(toEvent),
  };
}

async function request<T>(path: string, auth: ApiAuth | undefined, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, auth, init);
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Delivery service failed (${response.status})`);
  }
  if (payload === null) throw new Error('The delivery service returned an empty response');
  return payload;
}

export function createApiRepo(
  pollIntervalMs = 30_000,
  jobPollIntervalMs = 1_000,
  storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage,
  auth?: ApiAuth,
): ParcelRepo {
  let notifySubscriber: (() => void) | null = null;
  const monitoredJobIds = new Set<string>();
  let monitorTask: Promise<void> | null = null;
  const cacheKey = auth ? `${API_CACHE_KEY}.${auth.userId}` : API_CACHE_KEY;

  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

  async function waitForJobs(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const jobs = await Promise.all(jobIds.map((jobId) => request<ApiSyncJobResponse>(
        `/api/sync/jobs/${encodeURIComponent(jobId)}`,
        auth,
      )));
      const failed = jobs.find((job) => job.status === 'failed');
      if (failed) throw new Error(failed.error ?? 'Tracking refresh failed. Try again.');
      if (jobs.every((job) => job.status === 'succeeded')) return;
      await wait(jobPollIntervalMs);
    }
    throw new Error('The tracking refresh is taking longer than expected.');
  }

  function monitorJobs(jobIds: string[]) {
    jobIds.forEach((jobId) => monitoredJobIds.add(jobId));
    if (monitorTask || monitoredJobIds.size === 0) return;
    monitorTask = (async () => {
      try {
        while (monitoredJobIds.size > 0) {
          const ids = [...monitoredJobIds];
          try {
            await waitForJobs(ids);
          } finally {
            ids.forEach((jobId) => monitoredJobIds.delete(jobId));
          }
        }
        notifySubscriber?.();
      } catch {
        // The normal collection poll remains the recovery path for a transient
        // status request failure or a job that outlives the foreground page.
      } finally {
        monitorTask = null;
        if (monitoredJobIds.size > 0) monitorJobs([]);
      }
    })();
  }

  async function list(): Promise<ParcelWithEvents[]> {
    const payload = await request<ApiPackageListResponse>(
      '/api/packages?includeArchived=true',
      auth,
    );
    const parcels = payload.packages.map(toParcel);
    saveCachedParcels(storage, cacheKey, parcels);
    return parcels;
  }

  return {
    mode: 'api',
    list,
    cachedList: () => cachedParcels(storage, cacheKey),

    async add(input: NewParcelInput): Promise<ParcelWithEvents> {
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const carrier = input.carrier ?? detectCarrier(trackingNumber);
      const body: ApiCreatePackageRequest = {
        trackingNumber,
        label: input.label,
        carrier,
        trackingUrl: input.trackingUrl?.trim() || undefined,
        dpdPostcode: input.dpdPostcode?.trim() || undefined,
      };
      const payload = await request<ApiCreatePackageResponse>('/api/packages', auth, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const parcel = toParcel(payload.package);
      monitorJobs(payload.jobIds);
      return parcel;
    },

    async rename(id: string, label: string): Promise<ParcelWithEvents> {
      const body: ApiRenamePackageRequest = { label: label.trim() };
      const row = await request<ApiPackageRow>(
        `/api/packages/${encodeURIComponent(id)}`,
        auth,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      );
      return toParcel(row);
    },

    async setNotificationsMuted(id: string, muted: boolean): Promise<ParcelWithEvents> {
      const body: ApiPackageNotificationRequest = { muted };
      const row = await request<ApiPackageRow>(
        `/api/packages/${encodeURIComponent(id)}/notifications`,
        auth,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      );
      return toParcel(row);
    },

    async remove(id: string): Promise<void> {
      await request<ApiOkResponse>(`/api/packages/${encodeURIComponent(id)}`, auth, {
        method: 'DELETE',
      });
    },

    async restore(id: string): Promise<ParcelWithEvents> {
      const row = await request<ApiPackageRow>(
        `/api/packages/${encodeURIComponent(id)}/restore`,
        auth,
        { method: 'POST' },
      );
      return toParcel(row);
    },

    async deleteArchived(id: string): Promise<void> {
      await request<ApiOkResponse>(
        `/api/packages/${encodeURIComponent(id)}/permanent`,
        auth,
        { method: 'DELETE' },
      );
      const cached = cachedParcels(storage, cacheKey);
      if (cached) {
        saveCachedParcels(
          storage,
          cacheKey,
          cached.filter((parcel) => parcel.id !== id),
        );
      }
    },

    async refresh(): Promise<ParcelWithEvents[]> {
      const queued = await request<ApiQueueResponse>('/api/sync', auth, { method: 'POST' });
      await waitForJobs(queued.jobIds);
      return list();
    },

    async refreshParcel(id: string): Promise<ParcelWithEvents> {
      const queued = await request<ApiQueueResponse>(
        `/api/packages/${encodeURIComponent(id)}/sync`,
        auth,
        { method: 'POST' },
      );
      await waitForJobs(queued.jobIds);
      const parcels = await list();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Package not found after queueing its tracking check');
      return parcel;
    },

    subscribe(onChange: () => void | Promise<void>): () => void {
      let pollInFlight = false;
      let stopped = false;
      let timer: number | null = null;

      const schedule = () => {
        if (timer !== null) window.clearTimeout(timer);
        if (stopped) return;
        timer = window.setTimeout(() => {
          timer = null;
          if (document.visibilityState !== 'visible') {
            schedule();
            return;
          }
          void trigger();
        }, pollIntervalMs);
      };

      const trigger = async () => {
        if (pollInFlight || stopped) return;
        pollInFlight = true;
        try {
          await onChange();
        } finally {
          pollInFlight = false;
          schedule();
        }
      };

      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        void trigger();
      };
      notifySubscriber = () => { void trigger(); };
      document.addEventListener('visibilitychange', onVisible);
      schedule();
      return () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        notifySubscriber = null;
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}
