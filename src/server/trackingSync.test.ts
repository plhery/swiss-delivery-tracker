import { afterEach, describe, expect, it, vi } from 'vitest';
import { secondsUntilNextSync, workerPollDelay } from './background';
import { normalizeCarrierResult, type CarrierResult } from './carrierResult';
import { ColisPriveTracker, ColisPriveTrackingError } from './colisPrive';
import { ColiswebTracker } from './colisweb';
import { CChezVousTracker } from './cChezVous';
import { CiblexTracker } from './ciblex';
import { DPDFranceTracker } from './dpdFrance';
import { GeodisTracker } from './geodis';
import { GLSFranceTracker } from './glsFrance';
import { GLSSwitzerlandTracker } from './glsSwitzerland';
import { HeppnerTracker } from './heppner';
import { LaPosteTracker } from './laPoste';
import { MondialRelayTracker } from './mondialRelay';
import { PaackTracker } from './paack';
import { RelaisColisTracker } from './relaisColis';
import { SwissPostCargoTracker } from './swissPostCargo';
import type { SupabaseServiceClient } from './supabase';
import {
  CarrierTrackingAdapter,
  buildEvents,
  detectSyncAnomalies,
  eventTimestamp,
  fairSyncPackages,
  inferStage,
  isUnannouncedTrackingError,
  providerEventId,
  resultHasUpdate,
  resultStage,
  TrackingSyncService,
  type TrackingAdapter,
} from './trackingSync';
import type { JsonObject } from './types';

afterEach(() => vi.restoreAllMocks());

describe('regional carrier dispatch', () => {
  it('routes every dedicated French and Swiss carrier to its isolated adapter', async () => {
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
    const swissPostCargo = vi.spyOn(SwissPostCargoTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const glsSwitzerland = vi.spyOn(GLSSwitzerlandTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const colisweb = vi.spyOn(ColiswebTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const cChezVous = vi.spyOn(CChezVousTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const heppner = vi.spyOn(HeppnerTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const ciblex = vi.spyOn(CiblexTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const paack = vi.spyOn(PaackTracker.prototype, 'fetch')
      .mockResolvedValue({ status: 'in_transit' });
    const adapter = new CarrierTrackingAdapter();

    await adapter.fetch('la-poste', '8G12345678901', null);
    await adapter.fetch('chronopost', 'PZ123456785JF', null);
    await adapter.fetch('gls-fr', '00AB12CD', null);
    await adapter.fetch('colis-prive', '99112233445575012', null);
    await adapter.fetch('geodis', '1G123GEODIS0', null);
    await adapter.fetch('dpd-fr', '250123456789012', null);
    await adapter.fetch('mondial-relay', '76434219', null, '59650');
    await adapter.fetch('relais-colis', 'CC200000000401', null);
    await adapter.fetch('swiss-post-cargo', '1234ABC789', null);
    await adapter.fetch('gls-ch', '993990103198', null, '8000');
    await adapter.fetch('colisweb', '12345678', null);
    await adapter.fetch('c-chez-vous', 'FGRC45BKLM', null);
    await adapter.fetch('heppner', '23456789', null, '75001');
    await adapter.fetch('ciblex', '12345678901234', null);
    await adapter.fetch('paack', 'ORDER1234', null, '75001');

    expect(laPoste).toHaveBeenNthCalledWith(1, '8G12345678901');
    expect(laPoste).toHaveBeenNthCalledWith(2, 'PZ123456785JF');
    expect(glsFrance).toHaveBeenCalledWith('00AB12CD');
    expect(colisPrive).toHaveBeenCalledWith('99112233445575012');
    expect(geodis).toHaveBeenCalledWith('1G123GEODIS0');
    expect(dpdFrance).toHaveBeenCalledWith('250123456789012');
    expect(mondialRelay).toHaveBeenCalledWith('76434219', '59650');
    expect(relaisColis).toHaveBeenCalledWith('CC200000000401');
    expect(swissPostCargo).toHaveBeenCalledWith('1234ABC789');
    expect(glsSwitzerland).toHaveBeenCalledWith('993990103198', '8000');
    expect(colisweb).toHaveBeenCalledWith('12345678');
    expect(cChezVous).toHaveBeenCalledWith('FGRC45BKLM');
    expect(heppner).toHaveBeenCalledWith('23456789', '75001');
    expect(ciblex).toHaveBeenCalledWith('12345678901234');
    expect(paack).toHaveBeenCalledWith('ORDER1234', '75001');
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

  it('records an observed event when a timestamp-less current state changes', () => {
    const observedAt = new Date('2026-08-30T13:00:00Z');
    const result: CarrierResult = {
      status: 'out_for_delivery',
      last_status_text: 'En cours de livraison',
      events: [{
        description: 'En cours de livraison',
        stage: 'out_for_delivery',
      }],
    };
    const changed = buildEvents({
      id: 'package-current',
      carrier: 'c-chez-vous',
      current_stage: 'in_transit',
    }, result, undefined, observedAt);
    expect(changed).toEqual([
      expect.objectContaining({
        stage: 'out_for_delivery',
        description: 'En cours de livraison',
        occurred_at: '2026-08-30T13:00:00.000Z',
        raw_data: { observed_without_provider_timestamp: true },
      }),
    ]);

    expect(buildEvents({
      id: 'package-current',
      carrier: 'c-chez-vous',
      current_stage: 'out_for_delivery',
    }, result, undefined, observedAt)).toEqual([]);

    expect(buildEvents({
      id: 'package-registered',
      carrier: 'c-chez-vous',
      current_stage: 'pending',
    }, {
      status: 'pending',
      last_status_text: 'Commande enregistrée',
      events: [{ description: 'Commande enregistrée', stage: 'registered' }],
    }, undefined, observedAt)).toEqual([
      expect.objectContaining({ stage: 'registered', occurred_at: observedAt.toISOString() }),
    ]);
  });

  it('recognizes usable event progress even when a carrier summary is pending', () => {
    expect(resultHasUpdate({
      status: 'pending',
      events: [{ description: 'Accepted at depot' }],
    })).toBe(true);
    expect(resultHasUpdate({ status: 'pending', events: [] })).toBe(false);
  });

  it('uses a validated adapter stage instead of reverse-translating display text', () => {
    expect(resultStage({
      status: 'exception',
      current_stage: 'returned',
      last_status_text: 'Livraison annulée',
    })).toBe('returned');
    expect(resultStage({
      status: 'in_transit',
      current_stage: 'accepted',
      last_status_text: 'Shipment collected',
    })).toBe('accepted');
    expect(() => normalizeCarrierResult({
      status: 'in_transit',
      current_stage: 'private_internal_state',
    })).toThrow('invalid current stage');
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
    startSyncAttempt: vi.fn().mockResolvedValue(undefined),
    completeSyncAttempt: vi.fn().mockResolvedValue(true),
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
    expect(client.startSyncAttempt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      package_id: 'package-1',
      trigger: 'scheduled',
      configured_carrier: 'dpd',
    }));
    expect(client.completeSyncAttempt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        outcome: 'updated',
        provider_status: 'delivered',
        selected_stage: 'delivered',
        events_received: 1,
        events_normalized: 1,
      }),
      expect.arrayContaining([
        expect.objectContaining({ step: 'fetch', status: 'succeeded' }),
        expect.objectContaining({ step: 'normalize', status: 'succeeded' }),
        expect.objectContaining({ step: 'persist_events', status: 'succeeded' }),
        expect.objectContaining({ step: 'persist_package', status: 'succeeded' }),
        expect.objectContaining({ step: 'complete', status: 'succeeded' }),
      ]),
    );
  });

  it('prefers an explicit current failure over an older timestamped milestone', async () => {
    const parcel = {
      id: 'package-current-failure',
      carrier: 'colisweb',
      tracking_number: '10000000',
      current_stage: 'in_transit',
    };
    const client = fakeClient();
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockResolvedValue({
        status: 'exception',
        last_status_text: 'Incident de livraison',
        last_update: '2026-08-28T11:30:00+02:00',
        events: [{
          description: 'Incident de livraison',
          stage: 'failed_attempt',
        }, {
          time: '2026-08-28T11:30:00+02:00',
          description: 'Colis pris en charge',
          stage: 'in_transit',
        }],
      }),
    };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
      null,
      () => new Date('2026-08-30T13:00:00Z'),
    );

    await expect(service.syncPackage(parcel)).resolves.toMatchObject({ updated: 1, errors: 0 });
    expect(client.insertEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ stage: 'in_transit' }),
      expect.objectContaining({
        stage: 'failed_attempt',
        occurred_at: '2026-08-30T13:00:00.000Z',
      }),
    ]));
    expect(client.updatePackage).toHaveBeenLastCalledWith(
      'package-current-failure',
      expect.objectContaining({
        current_stage: 'failed_attempt',
        last_status_text: 'Incident de livraison',
        sync_status: 'ok',
      }),
    );
  });

  it('keeps timed progress ahead of a pending provider summary', async () => {
    const parcel = {
      id: 'package-pending-summary',
      carrier: 'paack',
      tracking_number: 'PAACK12345',
      current_stage: 'pending',
    };
    const client = fakeClient();
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockResolvedValue({
        status: 'pending',
        last_status_text: 'Shipment registered',
        events: [{
          time: '2026-08-28T11:30:00+02:00',
          description: 'Received at hub',
          stage: 'in_transit',
        }],
      }),
    };
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
    );

    await expect(service.syncPackage(parcel)).resolves.toMatchObject({ updated: 1, errors: 0 });
    expect(client.updatePackage).toHaveBeenLastCalledWith(
      'package-pending-summary',
      expect.objectContaining({
        current_stage: 'in_transit',
        sync_status: 'ok',
      }),
    );
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
    expect(client.completeSyncAttempt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'waiting', error_type: null }),
      expect.arrayContaining([
        expect.objectContaining({
          step: 'fetch',
          status: 'succeeded',
          details: { disposition: 'unannounced' },
        }),
        expect.objectContaining({ step: 'normalize', status: 'skipped' }),
      ]),
    );
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
    expect(client.completeSyncAttempt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'error', error_type: 'ColisPriveTrackingError' }),
      expect.arrayContaining([
        expect.objectContaining({
          step: 'fetch',
          status: 'failed',
          error_type: 'ColisPriveTrackingError',
        }),
      ]),
    );
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

  it('keeps tracking operational when the private audit store is unavailable', async () => {
    const parcel = {
      id: 'package-audit-outage',
      carrier: 'dpd',
      tracking_number: '06086514587082',
      current_stage: 'pending',
    };
    const client = fakeClient();
    client.startSyncAttempt.mockRejectedValue(new Error('audit table unavailable'));
    client.completeSyncAttempt.mockRejectedValue(new Error('audit table unavailable'));
    const adapter: TrackingAdapter = {
      fetch: vi.fn().mockResolvedValue({ status: 'in_transit', current_stage: 'in_transit' }),
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = new TrackingSyncService(
      client as unknown as SupabaseServiceClient,
      adapter,
    );

    await expect(service.syncPackage(parcel)).resolves.toMatchObject({ updated: 1, errors: 0 });
    expect(client.updatePackage).toHaveBeenLastCalledWith(
      'package-audit-outage',
      expect.objectContaining({ sync_status: 'ok', current_stage: 'in_transit' }),
    );
  });
});

describe('tracking anomaly detection', () => {
  it('records malformed, future, synthetic, and contradictory carrier evidence', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    expect(detectSyncAnomalies(
      { current_stage: 'delivered' },
      {
        status: 'delivered',
        events: [{ time: 'not-a-time', description: 'Delivered' }],
      },
      [{
        occurred_at: '2026-09-03T12:00:00Z',
        raw_data: { observed_without_provider_timestamp: true },
      }],
      'dpd',
      'in_transit',
      now,
    )).toEqual(expect.arrayContaining([
      'invalid_event_timestamp',
      'future_event_timestamp',
      'observed_without_timestamp',
      'terminal_stage_regression',
      'delivered_status_conflict',
    ]));
  });

  it('flags a progressed parcel when a provider suddenly returns no evidence', () => {
    expect(detectSyncAnomalies(
      { current_stage: 'in_transit' },
      { status: 'unknown', events: [] },
      [],
      'colis-prive',
      null,
      new Date('2026-08-31T12:00:00Z'),
    )).toContain('progress_disappeared');
  });
});
