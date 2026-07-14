import type { SupabaseClient } from '@supabase/supabase-js';
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

/** Data access always requires an explicit permanent or legacy anonymous session. */
async function ensureSession(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  throw new Error('Sign in to access your deliveries.');
}

export function createSupabaseRepo(supabase: SupabaseClient): ParcelRepo {
  async function list(): Promise<ParcelWithEvents[]> {
    await ensureSession(supabase);
    const { data, error } = await supabase
      .from('packages')
      .select('*, tracking_events(*)')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data as PackageRow[]).map(toParcel);
  }

  return {
    mode: 'supabase',
    list,

    async add(input: NewParcelInput): Promise<ParcelWithEvents> {
      await ensureSession(supabase);
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const carrier = input.carrier ?? detectCarrier(trackingNumber);
      const { data, error } = await supabase
        .from('packages')
        .insert({
          tracking_number: trackingNumber,
          label: input.label,
          carrier,
        })
        .select('*, tracking_events(*)')
        .single();
      if (error) throw new Error(error.message);
      return toParcel(data as PackageRow);
    },

    async remove(id: string): Promise<void> {
      const { error } = await supabase.from('packages').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async refresh(): Promise<ParcelWithEvents[]> {
      await ensureSession(supabase);
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return list();

      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Tracking sync failed (${response.status})`);
      }
      return list();
    },

    subscribe(onChange: () => void): () => void {
      const channel = supabase
        .channel('parcel-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tracking_events' },
          onChange,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'packages' },
          onChange,
        )
        .subscribe();
      return () => {
        void supabase.removeChannel(channel);
      };
    },
  };
}
