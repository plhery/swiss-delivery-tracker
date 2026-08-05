import { detectCarrier, normalizeTrackingNumber } from '../lib/carriers';
import {
  cloudflareAccessRequest,
  throwIfCloudflareAccessRequiresLogin,
} from '../lib/cloudflareAccess';
import type {
  CarrierId,
  NewParcelInput,
  ParcelRepo,
  ParcelWithEvents,
  Stage,
  TrackingEvent,
} from '../types';

interface PackageRow {
  id: string;
  tracking_number: string;
  label: string;
  carrier: string;
  created_at: string;
  expected_delivery: string | null;
  last_status_text: string | null;
  last_synced_at: string | null;
  sync_status: string | null;
  sync_error: string | null;
  tracking_url: string | null;
  archived_at: string | null;
  tracking_events: EventRow[] | null;
}

interface EventRow {
  id: string;
  package_id: string;
  stage: string;
  description: string;
  location: string | null;
  occurred_at: string;
}

function toEvent(row: EventRow): TrackingEvent {
  return {
    id: row.id,
    parcelId: row.package_id,
    stage: row.stage as Stage,
    description: row.description,
    location: row.location ?? undefined,
    occurredAt: row.occurred_at,
  };
}

function toParcel(row: PackageRow): ParcelWithEvents {
  return {
    id: row.id,
    trackingNumber: row.tracking_number,
    label: row.label,
    carrier: (row.carrier || detectCarrier(row.tracking_number)) as CarrierId,
    createdAt: row.created_at,
    expectedDelivery: row.expected_delivery ?? undefined,
    lastStatusText: row.last_status_text ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: (row.sync_status ?? 'pending') as ParcelWithEvents['syncStatus'],
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
): ParcelRepo {
  let hasActiveSync = false;

  async function list(): Promise<ParcelWithEvents[]> {
    const payload = await request<{ packages: PackageRow[] }>(
      '/api/packages?includeArchived=true',
    );
    const parcels = payload.packages.map(toParcel);
    hasActiveSync = parcels.some(
      (parcel) => parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing',
    );
    return parcels;
  }

  return {
    mode: 'api',
    list,

    async add(input: NewParcelInput): Promise<ParcelWithEvents> {
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const carrier = input.carrier ?? detectCarrier(trackingNumber);
      const row = await request<PackageRow>('/api/packages', {
        method: 'POST',
        body: JSON.stringify({
          trackingNumber,
          label: input.label,
          carrier,
          trackingUrl: input.trackingUrl?.trim() || undefined,
        }),
      });
      const parcel = toParcel(row);
      hasActiveSync = parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing';
      return parcel;
    },

    async rename(id: string, label: string): Promise<ParcelWithEvents> {
      const row = await request<PackageRow>(
        `/api/packages/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ label: label.trim() }),
        },
      );
      return toParcel(row);
    },

    async remove(id: string): Promise<void> {
      await request<{ ok: boolean }>(`/api/packages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    async restore(id: string): Promise<ParcelWithEvents> {
      const row = await request<PackageRow>(
        `/api/packages/${encodeURIComponent(id)}/restore`,
        { method: 'POST' },
      );
      return toParcel(row);
    },

    async refresh(): Promise<ParcelWithEvents[]> {
      await request('/api/sync', { method: 'POST' });
      hasActiveSync = true;
      return list().then((parcels) => {
        hasActiveSync = true;
        return parcels;
      });
    },

    async refreshParcel(id: string): Promise<ParcelWithEvents> {
      await request(`/api/packages/${encodeURIComponent(id)}/sync`, { method: 'POST' });
      const parcels = await list();
      hasActiveSync = true;
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Package not found after queueing its tracking check');
      return parcel;
    },

    subscribe(onChange: () => void | Promise<void>): () => void {
      let lastPollAt = Date.now();
      let pollInFlight = false;
      const timerResolution = Math.min(pollIntervalMs, activePollIntervalMs);

      const trigger = () => {
        if (pollInFlight) return;
        lastPollAt = Date.now();
        pollInFlight = true;
        const result = onChange();
        if (result) {
          void result.finally(() => {
            pollInFlight = false;
          });
        } else {
          pollInFlight = false;
        }
      };
      const interval = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const desiredInterval = hasActiveSync ? activePollIntervalMs : pollIntervalMs;
        if (Date.now() - lastPollAt >= desiredInterval) trigger();
      }, timerResolution);
      const onVisible = () => {
        if (document.visibilityState === 'visible') trigger();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}
