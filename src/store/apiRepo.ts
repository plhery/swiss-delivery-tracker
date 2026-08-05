import { detectCarrier, normalizeTrackingNumber } from '../lib/carriers';
import {
  cloudflareAccessRequest,
  throwIfCloudflareAccessRequiresLogin,
} from '../lib/cloudflareAccess';
import type {
  ApiCreatePackageRequest,
  ApiOkResponse,
  ApiPackageListResponse,
  ApiPackageRow,
  ApiQueueResponse,
  ApiRenamePackageRequest,
  ApiTrackingEventRow,
} from '../generated/apiContract';
import type {
  NewParcelInput,
  ParcelRepo,
  ParcelWithEvents,
  TrackingEvent,
} from '../types';

export const API_CACHE_KEY = 'parcel-post.api-cache.v1';

function cachedParcels(storage: Storage | null): ParcelWithEvents[] | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(API_CACHE_KEY) ?? 'null');
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

function saveCachedParcels(storage: Storage | null, parcels: ParcelWithEvents[]) {
  if (!storage) return;
  try {
    storage.setItem(API_CACHE_KEY, JSON.stringify(parcels));
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
    archivedAt: row.archived_at ?? undefined,
    events: (row.tracking_events ?? []).map(toEvent),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, cloudflareAccessRequest({ ...init, headers }));
  throwIfCloudflareAccessRequiresLogin(response);
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Delivery service failed (${response.status})`);
  }
  if (payload === null) throw new Error('The delivery service returned an empty response');
  return payload;
}

export function createApiRepo(
  pollIntervalMs = 30_000,
  activePollIntervalMs = 1_000,
  storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage,
): ParcelRepo {
  let hasActiveSync = false;
  let pollingModeChanged: (() => void) | null = null;

  function setHasActiveSync(next: boolean) {
    if (hasActiveSync === next) return;
    hasActiveSync = next;
    pollingModeChanged?.();
  }

  async function list(): Promise<ParcelWithEvents[]> {
    const payload = await request<ApiPackageListResponse>(
      '/api/packages?includeArchived=true',
    );
    const parcels = payload.packages.map(toParcel);
    setHasActiveSync(parcels.some(
      (parcel) => parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing',
    ));
    saveCachedParcels(storage, parcels);
    return parcels;
  }

  return {
    mode: 'api',
    list,
    cachedList: () => cachedParcels(storage),

    async add(input: NewParcelInput): Promise<ParcelWithEvents> {
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const carrier = input.carrier ?? detectCarrier(trackingNumber);
      const body: ApiCreatePackageRequest = {
        trackingNumber,
        label: input.label,
        carrier,
        trackingUrl: input.trackingUrl?.trim() || undefined,
      };
      const row = await request<ApiPackageRow>('/api/packages', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const parcel = toParcel(row);
      setHasActiveSync(parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing');
      return parcel;
    },

    async rename(id: string, label: string): Promise<ParcelWithEvents> {
      const body: ApiRenamePackageRequest = { label: label.trim() };
      const row = await request<ApiPackageRow>(
        `/api/packages/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      );
      return toParcel(row);
    },

    async remove(id: string): Promise<void> {
      await request<ApiOkResponse>(`/api/packages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    async restore(id: string): Promise<ParcelWithEvents> {
      const row = await request<ApiPackageRow>(
        `/api/packages/${encodeURIComponent(id)}/restore`,
        { method: 'POST' },
      );
      return toParcel(row);
    },

    async refresh(): Promise<ParcelWithEvents[]> {
      await request<ApiQueueResponse>('/api/sync', { method: 'POST' });
      setHasActiveSync(true);
      return list().then((parcels) => {
        setHasActiveSync(true);
        return parcels;
      });
    },

    async refreshParcel(id: string): Promise<ParcelWithEvents> {
      await request<ApiQueueResponse>(`/api/packages/${encodeURIComponent(id)}/sync`, {
        method: 'POST',
      });
      const parcels = await list();
      setHasActiveSync(true);
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
        const delay = hasActiveSync ? activePollIntervalMs : pollIntervalMs;
        timer = window.setTimeout(() => {
          timer = null;
          if (document.visibilityState !== 'visible') {
            schedule();
            return;
          }
          void trigger();
        }, delay);
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
      pollingModeChanged = () => {
        if (!pollInFlight) schedule();
      };
      document.addEventListener('visibilitychange', onVisible);
      schedule();
      return () => {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        if (pollingModeChanged) pollingModeChanged = null;
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}
