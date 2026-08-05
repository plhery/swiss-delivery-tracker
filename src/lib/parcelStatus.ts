import type { ParcelWithEvents } from '../types';
import { currentEvent, stageMeta } from './stages';

export interface ParcelDisplayStatus {
  label: string;
  tone: 'ok' | 'warn' | 'done';
  syncing: boolean;
}

/** Keep the app's sync lifecycle separate from the carrier's delivery stage. */
export function parcelDisplayStatus(parcel: ParcelWithEvents): ParcelDisplayStatus {
  const current = currentEvent(parcel.events);
  const hasCarrierUpdate = Boolean(current && current.stage !== 'pending');

  if (!hasCarrierUpdate && (parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing')) {
    return { label: 'Sync in progress', tone: 'ok', syncing: true };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'error') {
    return { label: 'Sync failed', tone: 'warn', syncing: false };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'unsupported') {
    return { label: 'Automatic sync unavailable', tone: 'warn', syncing: false };
  }

  const meta = current ? stageMeta(current.stage) : null;
  return {
    label: meta?.label ?? 'Not announced yet',
    tone: meta?.tone ?? 'ok',
    syncing: false,
  };
}
