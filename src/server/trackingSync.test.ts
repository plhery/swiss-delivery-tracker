import { afterEach, describe, expect, it, vi } from 'vitest';
import { secondsUntilNextSync, workerPollDelay } from './background';
import type { CarrierResult } from './carrierResult';
import { ColisPriveTracker, ColisPriveTrackingError } from './colisPrive';
import { DPDFranceTracker } from './dpdFrance';
import { GeodisTracker } from './geodis';
import { GLSFranceTracker } from './glsFrance';
import { LaPosteTracker } from './laPoste';
import { MondialRelayTracker } from './mondialRelay';
import { RelaisColisTracker } from './relaisColis';
import type { SupabaseServiceClient } from './supabase';
import {
  CarrierTrackingAdapter,
  buildEvents,
  eventTimestamp,
  fairSyncPackages,
  inferStage,
  isUnannouncedTrackingError,
  providerEventId,
  resultHasUpdate,
  TrackingSyncService,
  type TrackingAdapter,
} from './trackingSync';
import type { JsonObject } from './types';

afterEach(() => vi.restoreAllMocks());

describe('French carrier dispatch', () => {
  it('routes every hidden carrier to its isolated adapter', async () => {
    const laPoste = vi.spyOn(LaPosteTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const glsFrance = vi.spyOn(GLSFranceTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const colisPrive = vi.spyOn(ColisPriveTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const geodis = vi.spyOn(GeodisTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const dpdFrance = vi.spyOn(DPDFranceTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const mondialRelay = vi.spyOn(MondialRelayTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const relaisColis = vi.spyOn(RelaisColisTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const adapter = new CarrierTrackingAdapter();

    await adapter.fetch('la-poste', '8G12345678901', null);
    await adapter.fetch('chronopost', 'PZ123456785JF', null);
    await adapter.fetch('gls-fr', '00AB12CD', null);
    await adapter.fetch('colis-prive', '99112233445575012', null);
    await adapter.fetch('geodis', '1G123GEODIS0', null);
    await adapter.fetch('dpd-fr', '250803383035673', null);
    await adapter.fetch('mondial-relay', '76434219', null, '59650');
    await adapter.fetch('relais-colis', 'CC200000000401', null);

    expect(laPoste).toHaveBeenNthCalledWith(1, '8G12345678901');
    expect(laPoste).toHaveBeenNthCalledWith(2, 'PZ123456785JF');
    expect(glsFrance).toHaveBeenCalledWith('00AB12CD');
    expect(colisPrive).toHaveBeenCalledWith('99112233445575012');
    expect(geodis).toHaveBeenCalledWith('1G123GEODIS0');
    expect(dpdFrance).toHaveBeenCalledWith('250803383035673');
    expect(mondialRelay).toHaveBeenCalledWith('76434219', '59650');
    expect(relaisColis).toHaveBeenCalledWith('CC200000000401');
  });
});

describe('tracking event normalization', () => {
  it('prioritizes exception and final-stage phrases before broad delivery words', () => {
    expect(inferStage('Delivery attempt failed')).toBe('failed_attempt');
    expect(inferStage('Return to sender')).toBe('returned');
    expect(inferStage('Parcel handed to DPD')).toBe('accepted');
    expect(inferStage('To be delivered')).toBe('in_transit');
  });

  it('normalizes zoneless carrier timestamps into UTC', () => {
    expect(eventTimestamp('15.07.2026 10:00', 'Europe/Zurich'))
      .toBe('2026-07-15T08:00:00Z');
    expect(eventTimestamp('not-a-date', 'Europe/Zurich')).toBeNull();
  });

  it('creates stable provider ids and drops events without usable timestamps', () => {
    const result: CarrierResult = {
      status: 'in_transit',
      events: [
        { time: '2026-07-15T08:00:00Z', description: 'Sorted', location: 'Härkingen' },
        { time: '', description: 'No time' },
      ],
    };
    const rows = buildEvents({ id: 'package-1', carrier: 'dpd' }, result);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      package_id: 'package-1',
      stage: 'in_transit',
      location: 'Härkingen',
      occurred_at: '2026-07-15T08:00:00Z',
    });
    expect(rows[0]?.provider_event_id).toBe(
      providerEventId('dpd', '2026-07-15T08:00:00Z', 'Härkingen', 'Sorted'),
    );
  });

  it('recognizes usable event progress even when a carrier summary is pending', () => {
    expect(resultHasUpdate({
      status: 'pending',
      events: [{ description: 'Accepted at depot' }],
    })).toBe(true);
    expect(resultHasUpdate({ status: 'pending', events: [] })).toBe(false);
  });

  it('recognizes 404s through an error cause chain', () => {
    const cause = Object.assign(new Error('provider response'), { status: 404 });
    expect(isUnannouncedTrackingError(new Error('lookup failed', { cause }))).toBe(true);
    expect(isUnannouncedTrackingError(new Error('network down'))).toBe(false);
  });
});

describe('fair scheduling', () => {
  it('round-robins owners and caps each account', () => {
    const packages = [
      { id: 'a1', user_id: 'a' },
      { id: 'a2', user_id: 'a' },
      { id: 'a3', user_id: 'a' },
      { id: 'b1', user_id: 'b' },
      { id: 'b2', user_id: 'b' },
    ];
    expect(fairSyncPackages(packages, 2).map((parcel) => parcel.id))
      .toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(() => fairSyncPackages(packages, 0)).toThrow('positive');
  });

  it('aligns daytime checks to ten minutes and overnight checks to the hour', () => {
    expect(secondsUntilNextSync(new Date('2026-07-15T07:03:30Z'))).toBe(390);
    expect(secondsUntilNextSync(new Date('2026-07-15T20:15:00Z'))).toBe(2_700);
    expect(() => secondsUntilNextSync(new Date('invalid'))).toThrow('valid');
  });

  it('backs off boundedly when the job store is unavailable', () => {
    expect(workerPollDelay(1_000, 0)).toBe(1_000);
    expect(workerPollDelay(1_000, 1)).toBe(1_000);
    expect(workerPollDelay(1_000, 4)).toBe(8_000);
    expect(workerPollDelay(1_000, 20)).toBe(60_000);
    expect(() => workerPollDelay(0, 1)).toThrow('positive');
    expect(() => workerPollDelay(1_000, -1)).toThrow('non-negative');
  });
});

function fakeClient(packages: JsonObject[] = []) {
  return {
    listActivePackages: vi.fn().mockResolvedValue(packages),
    updatePackage: vi.fn().mockResolvedValue(undefined),
    insertEvents: vi.fn().mockResolvedValue(undefined),
    deleteEventsByDescriptions: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TrackingSyncService', () => {
  it('stores normalized events and advances the package stage', async () => {
    const parcel = {
      id: 'package-1',
      user_id: 'user-1',
      carrier: 'dpd',
      tracking_number: '06086514587082',
      current_stage: 'pending',
    };
    const client = fakeClient([parcel]);
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockResolvedValue({
        status: 'delivered',
        last_status_text: 'Delivered',
        last_update: '2026-08-04T12:38:28Z',
        events: [{
          time: '2026-08-04T12:38:28Z',
          location: 'Zürich',
          description: 'Delivered',
        }],
      }),
    };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
      null,
      () => new Date('2026-08-04T13:00:00Z'),
    );

    await expect(service.sync()).resolves.toMatchObject({ checked: 1, updated: 1, errors: 0 });
    expect(client.insertEvents).toHaveBeenCalledWith([
      expect.objectContaining({ stage: 'delivered', package_id: 'package-1' }),
    ]);
    expect(client.updatePackage).toHaveBeenLastCalledWith('package-1', expect.objectContaining({
      current_stage: 'delivered',
      sync_status: 'ok',
      sync_error: null,
    }));
  });

  it('keeps a newly unannounced shipment waiting without showing an error', async () => {
    const parcel = {
      id: 'package-2',
      carrier: 'dpd',
      tracking_number: '06086514587082',
      current_stage: 'pending',
    };
    const client = fakeClient();
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockRejectedValue(Object.assign(new Error('not live'), { status: 404 })),
    };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
      null,
      () => new Date('2026-08-04T13:00:00Z'),
    );

    await expect(service.syncPackage(parcel)).resolves.toMatchObject({ waiting: 1, errors: 0 });
    expect(client.updatePackage).toHaveBeenLastCalledWith('package-2', {
      last_synced_at: '2026-08-04T13:00:00.000Z',
      sync_status: 'waiting',
      sync_error: null,
    });
  });

  it('preserves progressed shipment data when a carrier later reports not found', async () => {
    const parcel = {
      id: 'package-progressed',
      carrier: 'colis-prive',
      tracking_number: '99112233445575012',
      current_stage: 'in_transit',
      last_status_text: 'En cours d’acheminement',
    };
    const client = fakeClient();
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockRejectedValue(new ColisPriveTrackingError()),
    };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
      null,
      () => new Date('2026-08-04T13:00:00Z'),
    );

    await expect(service.syncPackage(parcel)).resolves.toMatchObject({ errors: 1, waiting: 0 });
    expect(client.updatePackage).toHaveBeenLastCalledWith('package-progressed', {
      last_synced_at: '2026-08-04T13:00:00.000Z',
      sync_status: 'error',
      sync_error: 'Colis Privé could not locate the shipment',
    });
  });

  it('marks link-only carriers unsupported without pretending they were checked', async () => {
    const client = fakeClient();
    const adapter: TrackingAdapter = { fetch: vi.fn() };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
    );

    await expect(service.syncPackage({ id: 'package-3', carrier: 'dhl' }))
      .resolves.toMatchObject({ unsupported: 1, checked: 1 });
    expect(adapter.fetch).not.toHaveBeenCalled();
    expect(client.updatePackage).toHaveBeenCalledWith('package-3', expect.objectContaining({
      sync_status: 'unsupported',
      last_synced_at: null,
    }));
  });
});
