import { carrierInfo } from './carriers';
import {
  compareParcelPriority,
  expectedDeliveryDay,
  isActiveParcel,
  parcelAttention,
} from './parcelPriority';
import { currentEvent, currentStage, isFinal } from './stages';
import type { CarrierId, ParcelWithEvents } from '../types';

export type ParcelStatusFilter =
  | 'all'
  | 'active'
  | 'attention'
  | 'today'
  | 'delivered'
  | 'archived';

export type ParcelSort = 'priority' | 'updated' | 'newest' | 'eta' | 'carrier';

export interface ParcelViewOptions {
  query: string;
  status: ParcelStatusFilter;
  carrier?: CarrierId;
  sort: ParcelSort;
  now?: number;
}

function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function searchText(parcel: ParcelWithEvents): string {
  const events = parcel.events.flatMap((event) => [event.description, event.location ?? '']);
  return [
    parcel.label,
    parcel.trackingNumber,
    carrierInfo(parcel.carrier).name,
    parcel.lastStatusText ?? '',
    ...events,
  ].join(' ').toLocaleLowerCase();
}

export function parcelMatchesSearch(parcel: ParcelWithEvents, query: string): boolean {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) return true;
  if (searchText(parcel).includes(trimmed)) return true;
  const compactQuery = trimmed.replace(/[\s.-]/g, '');
  const compactTracking = parcel.trackingNumber.toLocaleLowerCase().replace(/[\s.-]/g, '');
  return compactQuery.length > 0
    && compactTracking.includes(compactQuery);
}

export function parcelMatchesStatus(
  parcel: ParcelWithEvents,
  status: ParcelStatusFilter,
  now: number = Date.now(),
): boolean {
  switch (status) {
    case 'all': return true;
    case 'active': return isActiveParcel(parcel);
    case 'attention': return isActiveParcel(parcel) && parcelAttention(parcel, now) !== null;
    case 'today':
      return isActiveParcel(parcel)
        && expectedDeliveryDay(parcel.expectedDelivery) === dateKey(new Date(now));
    case 'delivered': return !parcel.archivedAt && currentStage(parcel.events) === 'delivered';
    case 'archived': return Boolean(parcel.archivedAt);
  }
}

function updatedAt(parcel: ParcelWithEvents): string {
  return currentEvent(parcel.events)?.occurredAt ?? parcel.createdAt;
}

/**
 * The date that best represents a parcel in its archive. A delivered or returned
 * scan is more meaningful than the moment the user happened to archive it.
 */
export function archivedDisplayDate(parcel: ParcelWithEvents): string {
  const completion = [...parcel.events]
    .filter((event) => isFinal(event.stage))
    .sort((first, second) => second.occurredAt.localeCompare(first.occurredAt))[0];
  return completion?.occurredAt
    ?? parcel.archivedAt
    ?? currentEvent(parcel.events)?.occurredAt
    ?? parcel.createdAt;
}

export function sortArchivedParcels(
  parcels: ParcelWithEvents[],
): ParcelWithEvents[] {
  return [...parcels].sort((first, second) => {
    const byDate = archivedDisplayDate(second).localeCompare(archivedDisplayDate(first));
    return byDate !== 0 ? byDate : first.id.localeCompare(second.id);
  });
}

export function parcelComparator(
  sort: ParcelSort,
): (first: ParcelWithEvents, second: ParcelWithEvents) => number {
  return (first, second) => {
    let compared = 0;
    switch (sort) {
      case 'priority':
        compared = compareParcelPriority(first, second);
        break;
      case 'updated':
        compared = updatedAt(second).localeCompare(updatedAt(first));
        break;
      case 'newest':
        compared = second.createdAt.localeCompare(first.createdAt);
        break;
      case 'eta': {
        const firstEta = expectedDeliveryDay(first.expectedDelivery) ?? '9999-99-99';
        const secondEta = expectedDeliveryDay(second.expectedDelivery) ?? '9999-99-99';
        compared = firstEta.localeCompare(secondEta);
        break;
      }
      case 'carrier':
        compared = carrierInfo(first.carrier).name.localeCompare(
          carrierInfo(second.carrier).name,
        );
        break;
    }
    if (compared !== 0) return compared;
    const label = first.label.localeCompare(second.label);
    return label !== 0 ? label : first.id.localeCompare(second.id);
  };
}

export function viewParcels(
  parcels: ParcelWithEvents[],
  options: ParcelViewOptions,
): ParcelWithEvents[] {
  const now = options.now ?? Date.now();
  return parcels
    .filter((parcel) => parcelMatchesSearch(parcel, options.query))
    .filter((parcel) => parcelMatchesStatus(parcel, options.status, now))
    .filter((parcel) => !options.carrier || parcel.carrier === options.carrier)
    .sort(parcelComparator(options.sort));
}
