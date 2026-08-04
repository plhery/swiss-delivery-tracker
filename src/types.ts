export type CarrierId =
  | 'swiss-post'
  | 'quickpac'
  | 'planzer'
  | 'aliexpress'
  | 'sunyou'
  | 'hermes'
  | 'spring-gds'
  | 'postlogistics'
  | 'dachser'
  | 'dhl'
  | 'ups'
  | 'fedex'
  | 'dpd'
  | 'shipup'
  | 'intl-post'
  | 'unknown';

export type SyncStatus = 'pending' | 'syncing' | 'ok' | 'waiting' | 'error' | 'unsupported';

/**
 * The lifecycle of a parcel. The first six are the "happy path" in order;
 * the rest are exceptions that can happen along the way.
 */
export type Stage =
  | 'pending'
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
  expectedDelivery?: string;
  lastStatusText?: string;
  lastSyncedAt?: string;
  syncStatus: SyncStatus;
  syncError?: string;
  trackingUrl?: string;
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
  carrier?: CarrierId;
  trackingUrl?: string;
}

/** Storage backends: the shared server API in production, local demo in development. */
export interface ParcelRepo {
  readonly mode: 'api' | 'demo';
  list(): Promise<ParcelWithEvents[]>;
  add(input: NewParcelInput): Promise<ParcelWithEvents>;
  rename(id: string, label: string): Promise<ParcelWithEvents>;
  remove(id: string): Promise<void>;
  /** Re-sync tracking; in demo mode this advances the simulation. */
  refresh(): Promise<ParcelWithEvents[]>;
  /** Optional shared-data polling. Returns unsubscribe. */
  subscribe?(onChange: () => void | Promise<void>): () => void;
}
