export type CarrierId =
  | 'swiss-post'
  | 'dhl'
  | 'ups'
  | 'fedex'
  | 'dpd'
  | 'intl-post'
  | 'unknown';

/**
 * The lifecycle of a parcel. The first five are the "happy path" in order;
 * the rest are exceptions that can happen along the way.
 */
export type Stage =
  | 'registered'
  | 'accepted'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'customs'
  | 'failed_attempt'
  | 'ready_for_pickup'
  | 'returned';

export interface Parcel {
  id: string;
  trackingNumber: string;
  label: string;
  carrier: CarrierId;
  createdAt: string; // ISO timestamp
}

export interface TrackingEvent {
  id: string;
  parcelId: string;
  stage: Stage;
  description: string;
  location?: string;
  occurredAt: string; // ISO timestamp
}

export interface ParcelWithEvents extends Parcel {
  events: TrackingEvent[];
}

export interface NewParcelInput {
  trackingNumber: string;
  label: string;
}

/** Storage backends: Supabase when configured, local demo otherwise. */
export interface ParcelRepo {
  readonly mode: 'supabase' | 'demo';
  list(): Promise<ParcelWithEvents[]>;
  add(input: NewParcelInput): Promise<ParcelWithEvents>;
  remove(id: string): Promise<void>;
  /** Re-sync tracking; in demo mode this advances the simulation. */
  refresh(): Promise<ParcelWithEvents[]>;
  /** Optional live updates (Supabase realtime). Returns unsubscribe. */
  subscribe?(onChange: () => void): () => void;
}
