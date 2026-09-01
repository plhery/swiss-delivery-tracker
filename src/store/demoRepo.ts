import {
  detectCarrier,
  normalizeTrackingNumber,
  supportsSwissPostHandoff,
} from '../lib/carriers';
import { currentStage, isFinal, latestEvent } from '../lib/stages';
import { uid } from '../lib/uid';
import {
  ParcelAlreadyExistsError,
  type NewParcelInput,
  type ParcelCarrierInput,
  type ParcelRepo,
  type ParcelWithEvents,
  type Stage,
  type TrackingEvent,
} from '../types';

export const DEMO_STORAGE_KEY = 'sdt.demo.parcels.v1';

const HOUR = 3_600_000;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function defaultStorage(): Storage {
  if (typeof window !== 'undefined') {
    try {
      const storage = window.localStorage;
      const probeKey = 'sdt.storage.probe';
      const previous = storage.getItem(probeKey);
      storage.setItem(probeKey, '1');
      if (previous === null) storage.removeItem(probeKey);
      else storage.setItem(probeKey, previous);
      return storage;
    } catch {
      // Some privacy modes expose localStorage but deny access to it.
    }
  }
  return createMemoryStorage();
}

/** What the simulated carrier says at each stage. */
const SIMULATED_UPDATES: Record<Stage, { description: string; location?: string }> = {
  pending: {
    description: 'Tracking added; the carrier has not announced it yet',
  },
  registered: {
    description: 'The sender announced the parcel',
  },
  accepted: {
    description: 'Parcel accepted at the counter',
    location: 'Zürich-Mülligen',
  },
  in_transit: {
    description: 'Sorted at the parcel center',
    location: 'Härkingen',
  },
  customs: {
    description: 'Held for customs clearance',
    location: 'Basel',
  },
  out_for_delivery: {
    description: 'With the courier for delivery today',
    location: 'Your neighbourhood',
  },
  failed_attempt: {
    description: 'Nobody home — a notice was left',
  },
  ready_for_pickup: {
    description: 'Ready for pickup at your branch',
    location: 'Post branch',
  },
  delivered: {
    description: 'Delivered to your mailbox',
    location: 'Home',
  },
  returned: {
    description: 'Returned to the sender',
  },
};

/** Where the simulation goes next from a given stage. */
export function nextStage(stage: Stage): Stage | null {
  switch (stage) {
    case 'pending':
      return 'registered';
    case 'registered':
      return 'accepted';
    case 'accepted':
      return 'in_transit';
    case 'customs':
      return 'in_transit';
    case 'in_transit':
      return 'out_for_delivery';
    case 'out_for_delivery':
      return 'delivered';
    case 'failed_attempt':
      return 'ready_for_pickup';
    case 'ready_for_pickup':
      return 'delivered';
    case 'delivered':
    case 'returned':
      return null;
  }
}

function event(
  parcelId: string,
  stage: Stage,
  occurredAt: string,
): TrackingEvent {
  const sim = SIMULATED_UPDATES[stage];
  return {
    id: uid(),
    parcelId,
    stage,
    description: sim.description,
    location: sim.location,
    occurredAt,
  };
}

function seedParcels(now: number): ParcelWithEvents[] {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  const coffee: ParcelWithEvents = {
    id: uid(),
    trackingNumber: '993412345678901234',
    label: 'Coffee beans ☕',
    carrier: 'swiss-post',
    createdAt: iso(72 * HOUR),
    syncStatus: 'ok',
    events: [],
  };
  coffee.events = [
    event(coffee.id, 'registered', iso(72 * HOUR)),
    event(coffee.id, 'accepted', iso(60 * HOUR)),
    event(coffee.id, 'in_transit', iso(40 * HOUR)),
    event(coffee.id, 'out_for_delivery', iso(28 * HOUR)),
    event(coffee.id, 'delivered', iso(26 * HOUR)),
  ];

  const sneakers: ParcelWithEvents = {
    id: uid(),
    trackingNumber: '1234567899',
    label: 'New sneakers 👟',
    carrier: 'dhl',
    createdAt: iso(30 * HOUR),
    syncStatus: 'ok',
    events: [],
  };
  sneakers.events = [
    event(sneakers.id, 'registered', iso(30 * HOUR)),
    event(sneakers.id, 'accepted', iso(20 * HOUR)),
    event(sneakers.id, 'in_transit', iso(10 * HOUR)),
    event(sneakers.id, 'out_for_delivery', iso(2 * HOUR)),
  ];

  const gift: ParcelWithEvents = {
    id: uid(),
    trackingNumber: 'LX123456789DE',
    label: 'Birthday gift 🎁',
    carrier: 'intl-post',
    createdAt: iso(50 * HOUR),
    syncStatus: 'ok',
    events: [],
  };
  gift.events = [
    event(gift.id, 'registered', iso(50 * HOUR)),
    event(gift.id, 'accepted', iso(44 * HOUR)),
    event(gift.id, 'customs', iso(12 * HOUR)),
  ];

  return [coffee, sneakers, gift];
}

function load(storage: Storage): ParcelWithEvents[] | null {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParcelWithEvents[]) : null;
  } catch {
    return null;
  }
}

function save(storage: Storage, parcels: ParcelWithEvents[]): void {
  storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(parcels));
}

/**
 * A local, offline backend used when Supabase is not configured.
 * Parcels live in localStorage and "refresh" advances a small simulation,
 * so the app is fully usable (and demoable) with zero setup.
 */
export function createDemoRepo(
  storage: Storage = defaultStorage(),
  now: () => number = Date.now,
): ParcelRepo {
  function getAll(): ParcelWithEvents[] {
    let parcels = load(storage);
    if (!parcels) {
      parcels = seedParcels(now());
      save(storage, parcels);
    }
    return parcels;
  }

  const sortNewestFirst = (parcels: ParcelWithEvents[]) =>
    [...parcels].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const advance = (parcel: ParcelWithEvents): ParcelWithEvents => {
    if (parcel.archivedAt) return parcel;
    const stage = currentStage(parcel.events);
    if (stage === null || isFinal(stage)) return parcel;
    const next = nextStage(stage);
    if (!next) return parcel;
    // Keep timestamps strictly increasing so the newest event always wins,
    // even when refreshing several times in the same instant.
    const lastTs = Date.parse(latestEvent(parcel.events)!.occurredAt);
    const occurredAt = new Date(Math.max(now(), lastTs + 1000)).toISOString();
    const swissPostReady = supportsSwissPostHandoff(parcel.trackingNumber)
      && ['in_transit', 'customs', 'out_for_delivery', 'delivered'].includes(next);
    return {
      ...parcel,
      trackingSource: swissPostReady ? 'swiss-post' : parcel.trackingSource,
      swissPostReady: swissPostReady || parcel.swissPostReady,
      events: [...parcel.events, event(parcel.id, next, occurredAt)],
    };
  };

  return {
    mode: 'demo',

    async list() {
      return sortNewestFirst(getAll());
    },

    async add(input: NewParcelInput) {
      const parcels = getAll();
      const trackingNumber = normalizeTrackingNumber(input.trackingNumber);
      const existing = parcels.find((candidate) => candidate.trackingNumber === trackingNumber);
      if (existing) {
        throw new ParcelAlreadyExistsError(
          'This tracking number is already in your delivery box',
          existing.id,
        );
      }
      const createdAt = new Date(now()).toISOString();
      const parcel: ParcelWithEvents = {
        id: uid(),
        trackingNumber,
        label: input.label,
        carrier: input.carrier ?? detectCarrier(trackingNumber),
        trackingUrl: input.trackingUrl?.trim() || undefined,
        dpdPostcode: input.dpdPostcode?.trim() || undefined,
        createdAt,
        syncStatus: 'ok',
        events: [],
      };
      if (supportsSwissPostHandoff(trackingNumber)) {
        parcel.trackingSource = 'aliexpress';
        parcel.swissPostReady = false;
      }
      parcel.events = [event(parcel.id, 'pending', createdAt)];
      save(storage, [...parcels, parcel]);
      return parcel;
    },

    async rename(id: string, nextLabel: string) {
      const label = nextLabel.trim();
      if (label.length > 80) {
        throw new Error('Parcel names can be at most 80 characters');
      }
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      const renamed = { ...parcel, label };
      save(
        storage,
        parcels.map((candidate) => candidate.id === id ? renamed : candidate),
      );
      return renamed;
    },

    async changeCarrier(id: string, input: ParcelCarrierInput) {
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      const changedAt = new Date(now()).toISOString();
      const updated: ParcelWithEvents = {
        id: parcel.id,
        trackingNumber: parcel.trackingNumber,
        label: parcel.label,
        carrier: input.carrier,
        createdAt: parcel.createdAt,
        trackingUrl: input.trackingUrl?.trim() || undefined,
        dpdPostcode: input.dpdPostcode?.trim() || undefined,
        archivedAt: parcel.archivedAt,
        notificationsMuted: parcel.notificationsMuted,
        syncStatus: 'pending',
        events: [event(parcel.id, 'pending', changedAt)],
      };
      if (supportsSwissPostHandoff(parcel.trackingNumber)) {
        updated.trackingSource = 'aliexpress';
        updated.swissPostReady = false;
      }
      save(
        storage,
        parcels.map((candidate) => candidate.id === id ? updated : candidate),
      );
      return updated;
    },

    async setNotificationsMuted(id: string, muted: boolean) {
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      const updated = { ...parcel, notificationsMuted: muted };
      save(
        storage,
        parcels.map((candidate) => candidate.id === id ? updated : candidate),
      );
      return updated;
    },

    async remove(id: string) {
      const archivedAt = new Date(now()).toISOString();
      save(
        storage,
        getAll().map((parcel) => parcel.id === id ? { ...parcel, archivedAt } : parcel),
      );
    },

    async restore(id: string) {
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      const restored = { ...parcel };
      delete restored.archivedAt;
      save(
        storage,
        parcels.map((candidate) => candidate.id === id ? restored : candidate),
      );
      return restored;
    },

    async deletePermanently(id: string) {
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      save(storage, parcels.filter((candidate) => candidate.id !== id));
    },

    async refresh() {
      const advanced = getAll().map(advance);
      save(storage, advanced);
      return sortNewestFirst(advanced);
    },

    async refreshParcel(id: string) {
      const parcels = getAll();
      const parcel = parcels.find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found');
      const advanced = advance(parcel);
      save(
        storage,
        parcels.map((candidate) => candidate.id === id ? advanced : candidate),
      );
      return advanced;
    },
  };
}
