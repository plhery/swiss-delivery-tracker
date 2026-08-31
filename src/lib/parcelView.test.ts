import { describe, expect, it } from 'vitest';
import {
  parcelMatchesSearch,
  parcelMatchesStatus,
  sortArchivedParcels,
  viewParcels,
} from './parcelView';
import type { ParcelWithEvents, Stage } from '../types';

const NOW = new Date(2026, 7, 5, 12).getTime();

function parcel(
  id: string,
  stage: Stage,
  carrier: ParcelWithEvents['carrier'] = 'swiss-post',
): ParcelWithEvents {
  return {
    id,
    trackingNumber: `9934.${id}56-12345678`,
    label: `${id} coffee`,
    carrier,
    createdAt: `2026-08-0${id.length}T08:00:00Z`,
    syncStatus: 'ok',
    events: [{
      id: `event-${id}`,
      parcelId: id,
      stage,
      description: `${stage} at the parcel center`,
      location: 'Härkingen',
      occurredAt: `2026-08-0${Math.min(id.length + 1, 9)}T08:00:00Z`,
    }],
  };
}

describe('parcel view', () => {
  it('searches labels, compact tracking numbers, carriers, and event details', () => {
    const item = parcel('alpha', 'in_transit', 'swiss-post');
    expect(parcelMatchesSearch(item, 'alpha coffee')).toBe(true);
    expect(parcelMatchesSearch(item, '9934 alpha56')).toBe(true);
    expect(parcelMatchesSearch(item, 'swiss post')).toBe(true);
    expect(parcelMatchesSearch(item, 'härkingen')).toBe(true);
    expect(parcelMatchesSearch(item, 'shoes')).toBe(false);
  });

  it('filters active, actionable, today, delivered, and archived parcels', () => {
    const active = parcel('active', 'in_transit');
    active.expectedDelivery = '2026-08-05 13:00–15:00';
    const attention = parcel('attention', 'customs');
    const delivered = parcel('delivered', 'delivered');
    const archived = { ...parcel('archived', 'delivered'), archivedAt: '2026-08-05T09:00:00Z' };

    expect(parcelMatchesStatus(active, 'active', NOW)).toBe(true);
    expect(parcelMatchesStatus(active, 'today', NOW)).toBe(true);
    expect(parcelMatchesStatus(attention, 'attention', NOW)).toBe(true);
    expect(parcelMatchesStatus(delivered, 'delivered', NOW)).toBe(true);
    expect(parcelMatchesStatus(archived, 'archived', NOW)).toBe(true);
    expect(parcelMatchesStatus(archived, 'delivered', NOW)).toBe(false);
  });

  it('combines search, status, carrier, and stable sort choices', () => {
    const swiss = parcel('long-name', 'in_transit', 'swiss-post');
    swiss.expectedDelivery = '2026-08-08';
    const ups = parcel('ups', 'in_transit', 'ups');
    ups.expectedDelivery = '2026-08-06';
    const delivered = parcel('past', 'delivered', 'swiss-post');

    expect(viewParcels([swiss, ups, delivered], {
      query: '', status: 'active', sort: 'eta', now: NOW,
    }).map((item) => item.id)).toEqual(['ups', 'long-name']);

    expect(viewParcels([swiss, ups, delivered], {
      query: 'coffee', status: 'all', carrier: 'swiss-post', sort: 'newest', now: NOW,
    }).map((item) => item.id)).toEqual(['long-name', 'past']);
  });

  it('orders archived parcels by their latest completion, newest first', () => {
    const olderDelivery = {
      ...parcel('older', 'delivered'),
      archivedAt: '2026-08-31T12:00:00Z',
    };
    olderDelivery.events[0].occurredAt = '2026-08-20T08:00:00Z';
    const newerDelivery = {
      ...parcel('newer', 'delivered'),
      archivedAt: '2026-08-21T12:00:00Z',
    };
    newerDelivery.events[0].occurredAt = '2026-08-30T08:00:00Z';

    expect(sortArchivedParcels([olderDelivery, newerDelivery]).map(({ id }) => id))
      .toEqual(['newer', 'older']);
  });
});
