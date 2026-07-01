import type { SupabaseClient } from '@supabase/supabase-js';
import { detectCarrier, normalizeTrackingNumber } from '../lib/carriers';
import type {
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
    carrier: detectCarrier(row.tracking_number),
    createdAt: row.created_at,
    events: (row.tracking_events ?? []).map(toEvent),
  };
}

/** Signs in anonymously on first use so RLS has a user to scope rows to. */
async function ensureSession(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(`Supabase sign-in failed: ${error.message}`);
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
      const { data, error } = await supabase
        .from('packages')
        .insert({
          tracking_number: trackingNumber,
          label: input.label,
          carrier: detectCarrier(trackingNumber),
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

    refresh: list,

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
