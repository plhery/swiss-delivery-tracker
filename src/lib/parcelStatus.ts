import type { ParcelWithEvents } from '../types';
import type { MessageKey } from '../i18n';
import { currentEvent, stageMeta } from './stages';

export interface ParcelDisplayStatus {
  label: string;
  tone: 'ok' | 'warn' | 'done';
  syncing: boolean;
}

export function parcelHasCarrierUpdate(parcel: ParcelWithEvents): boolean {
  const current = currentEvent(parcel.events);
  return Boolean(current && current.stage !== 'pending');
}

export function parcelIsUnannounced(parcel: ParcelWithEvents): boolean {
  return !parcelHasCarrierUpdate(parcel) && parcel.syncStatus === 'waiting';
}

/** Keep the app's sync lifecycle separate from the carrier's delivery stage. */
export function parcelDisplayStatus(parcel: ParcelWithEvents): ParcelDisplayStatus {
  const current = currentEvent(parcel.events);
  const hasCarrierUpdate = parcelHasCarrierUpdate(parcel);

  if (!hasCarrierUpdate && (parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing')) {
    return { label: 'Sync in progress', tone: 'ok', syncing: true };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'error') {
    return { label: 'Sync failed', tone: 'warn', syncing: false };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'unsupported') {
    return {
      label: 'Automatic sync unavailable',
      tone: 'warn',
      syncing: false,
    };
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'waiting') {
    return { label: 'Not announced yet', tone: 'ok', syncing: false };
  }

  const meta = current ? stageMeta(current.stage) : null;
  return {
    label: meta?.label ?? 'Not announced yet',
    tone: meta?.tone ?? 'ok',
    syncing: false,
  };
}

export function parcelDisplayStatusKey(parcel: ParcelWithEvents): MessageKey {
  const current = currentEvent(parcel.events);
  const hasCarrierUpdate = parcelHasCarrierUpdate(parcel);
  if (!hasCarrierUpdate && (parcel.syncStatus === 'pending' || parcel.syncStatus === 'syncing')) {
    return 'status.syncing';
  }
  if (!hasCarrierUpdate && parcel.syncStatus === 'error') return 'status.failed';
  if (!hasCarrierUpdate && parcel.syncStatus === 'unsupported') return 'status.unsupported';
  if (!hasCarrierUpdate && parcel.syncStatus === 'waiting') return 'status.unannounced';
  return current ? (`stage.${current.stage}` as MessageKey) : 'status.unannounced';
}

/** The actual completion date shown beside a final-state status tag. */
export function localizedParcelCompletionDate(
  parcel: ParcelWithEvents,
  languageTag: string,
): string | null {
  const current = currentEvent(parcel.events);
  if (current?.stage === 'delivered' || current?.stage === 'returned') {
    const occurredAt = new Date(current.occurredAt);
    if (!Number.isNaN(occurredAt.getTime())) {
      return new Intl.DateTimeFormat(languageTag, {
        day: 'numeric',
        month: 'numeric',
        year: '2-digit',
      }).format(occurredAt);
    }
  }
  return null;
}
