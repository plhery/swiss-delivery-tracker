import type { ParcelWithEvents } from '../types';
import { latestEvent, stageMeta } from './stages';

export interface ParcelDisplayStatus {
  label: string;
  tone: 'ok' | 'warn' | 'done';
  syncing: boolean;
}

/** Keep the app's sync lifecycle separate from the carrier's delivery stage. */
export function parcelDisplayStatus(parcel: ParcelWithEvents): ParcelDisplayStatus {
  const last = latestEvent(parcel.events);
  const hasCarrierUpdate = Boolean(last && last.stage !== 'pending');

  if (!hasCarrierUpdate && (parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing')) {
    return { label: 'Sync in progress', tone: 'ok', syncing: true };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'error') {
    return { label: 'Sync failed', tone: 'warn', syncing: false };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'unsupported') {
    return { label: 'Automatic sync unavailable', tone: 'warn', syncing: false };
  }

  const meta = last ? stageMeta(last.stage) : null;
  return {
    label: meta?.label ?? 'Not announced yet',
    tone: meta?.tone ?? 'ok',
    syncing: false,
  };
}
