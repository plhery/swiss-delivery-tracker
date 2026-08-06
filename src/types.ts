import type {
  ApiCarrierId,
  ApiStage,
  ApiSyncStatus,
} from './generated/apiContract';

export type CarrierId = ApiCarrierId;

export type SyncStatus = ApiSyncStatus;

/**
 * The lifecycle of a parcel. The first six are the "happy path" in order;
 * the rest are exceptions that can happen along the way.
 */
export type Stage = ApiStage;

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
  dpdPostcode?: string;
  /** Carrier currently supplying automatic updates for a multi-carrier journey. */
  trackingSource?: CarrierId;
  /** Whether Swiss Post has announced a Swiss-issued inbound shipment. */
  swissPostReady?: boolean;
  archivedAt?: string;
  notificationsMuted?: boolean;
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
  dpdPostcode?: string;
}

/** Storage backends: the shared server API in production, local demo in development. */
export interface ParcelRepo {
  readonly mode: 'api' | 'demo';
  list(): Promise<ParcelWithEvents[]>;
  add(input: NewParcelInput): Promise<ParcelWithEvents>;
  rename(id: string, label: string): Promise<ParcelWithEvents>;
  setNotificationsMuted?(id: string, muted: boolean): Promise<ParcelWithEvents>;
  /** Soft-delete an active parcel so it can still be restored. */
  remove(id: string): Promise<void>;
  restore?(id: string): Promise<ParcelWithEvents>;
  /** Permanently delete a parcel that has already been archived. */
  deleteArchived?(id: string): Promise<void>;
  /** Re-sync tracking; in demo mode this advances the simulation. */
  refresh(): Promise<ParcelWithEvents[]>;
  /** Re-sync one parcel without waiting for every active carrier. */
  refreshParcel?(id: string): Promise<ParcelWithEvents>;
  /** Optional shared-data polling. Returns unsubscribe. */
  subscribe?(onChange: () => void | Promise<void>): () => void;
  /** Last successfully loaded API snapshot for read-only offline fallback. */
  cachedList?(): ParcelWithEvents[] | null;
}
