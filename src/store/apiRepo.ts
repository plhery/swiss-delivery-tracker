import { detectCarrier, normalizeTrackingNumber } from '../lib/carriers';
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
    events: (row.tracking_events ?? []).map(toEvent),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Delivery service failed (${response.status})`);
  }
  if (payload === null) throw new Error('The delivery service returned an empty response');
  return payload;
}

export function createApiRepo(pollIntervalMs = 30_000): ParcelRepo {
  async function list(): Promise<ParcelWithEvents[]> {
    const payload = await request<{ packages: PackageRow[] }>('/api/packages');
    return payload.packages.map(toParcel);
  }

  return {
    mode: 'api',
    list,

    async add(input: NewParcelInput): Promise<ParcelWithEvents> {
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const carrier = input.carrier ?? detectCarrier(trackingNumber);
      const row = await request<PackageRow>('/api/packages', {
        method: 'POST',
        body: JSON.stringify({ trackingNumber, label: input.label, carrier }),
      });
      return toParcel(row);
    },

    async remove(id: string): Promise<void> {
      await request<{ ok: boolean }>(`/api/packages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    async refresh(): Promise<ParcelWithEvents[]> {
      await request('/api/sync', { method: 'POST' });
      return list();
    },

    subscribe(onChange: () => void): () => void {
      const interval = window.setInterval(() => {
        if (document.visibilityState === 'visible') onChange();
      }, pollIntervalMs);
      const onVisible = () => {
        if (document.visibilityState === 'visible') onChange();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}
