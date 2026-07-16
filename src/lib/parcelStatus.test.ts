import { describe, expect, it } from 'vitest';
import type { ParcelWithEvents, SyncStatus } from '../types';
import { parcelDisplayStatus } from './parcelStatus';

function parcel(syncStatus: SyncStatus, stage: 'pending' | 'in_transit' = 'pending'): ParcelWithEvents {
  return {
    id: 'package-1',
    trackingNumber: '993412345612345678',
    label: 'Coffee',
    carrier: 'swiss-post',
    createdAt: '2026-07-16T10:00:00Z',
    syncStatus,
    events: [
      {
        id: 'event-1',
        parcelId: 'package-1',
        stage,
        description: 'Tracking added',
        occurredAt: '2026-07-16T10:00:00Z',
      },
    ],
  };
}

describe('parcelDisplayStatus', () => {
  it('shows the initial lookup separately from carrier announcement', () => {
    expect(parcelDisplayStatus(parcel('pending'))).toEqual({
      label: 'Sync in progress',
      tone: 'ok',
      syncing: true,
    });
    expect(parcelDisplayStatus(parcel('syncing')).label).toBe('Sync in progress');
    expect(parcelDisplayStatus(parcel('waiting')).label).toBe('Not announced yet');
  });

  it('makes first-sync failures and unsupported carriers explicit', () => {
    expect(parcelDisplayStatus(parcel('error')).label).toBe('Sync failed');
    expect(parcelDisplayStatus(parcel('unsupported')).label).toBe('Automatic sync unavailable');
  });

  it('keeps a real carrier stage visible during later sync attempts or errors', () => {
    expect(parcelDisplayStatus(parcel('syncing', 'in_transit')).label).toBe('In transit');
    expect(parcelDisplayStatus(parcel('error', 'in_transit')).label).toBe('In transit');
  });
});
