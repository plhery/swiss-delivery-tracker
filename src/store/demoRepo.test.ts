import { beforeEach, describe, expect, it } from 'vitest';
import { currentStage, isDelivered } from '../lib/stages';
import { createDemoRepo, DEMO_STORAGE_KEY, nextStage } from './demoRepo';

beforeEach(() => {
  window.localStorage.clear();
});

describe('nextStage', () => {
  it('walks the happy path in order', () => {
    expect(nextStage('pending')).toBe('registered');
    expect(nextStage('registered')).toBe('accepted');
    expect(nextStage('accepted')).toBe('in_transit');
    expect(nextStage('in_transit')).toBe('out_for_delivery');
    expect(nextStage('out_for_delivery')).toBe('delivered');
  });

  it('resolves exceptions back towards delivery', () => {
    expect(nextStage('customs')).toBe('in_transit');
    expect(nextStage('failed_attempt')).toBe('ready_for_pickup');
    expect(nextStage('ready_for_pickup')).toBe('delivered');
  });

  it('stops at final stages', () => {
    expect(nextStage('delivered')).toBeNull();
    expect(nextStage('returned')).toBeNull();
  });
});

describe('createDemoRepo', () => {
  it('seeds example parcels on first use and persists them', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcels = await repo.list();
    expect(parcels.length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(DEMO_STORAGE_KEY)).not.toBeNull();

    // A second repo instance sees the same data (no re-seeding).
    const again = await createDemoRepo(window.localStorage).list();
    expect(again.map((p) => p.id).sort()).toEqual(
      parcels.map((p) => p.id).sort(),
    );
  });

  it('adds a parcel as pending until the carrier announces it', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({
      trackingNumber: '99.34.123456.12345678',
      label: 'Chocolate 🍫',
    });

    expect(parcel.trackingNumber).toBe('993412345612345678');
    expect(parcel.carrier).toBe('swiss-post');
    expect(parcel.events).toHaveLength(1);
    expect(parcel.events[0].stage).toBe('pending');

    const listed = await repo.list();
    expect(listed.some((p) => p.id === parcel.id)).toBe(true);
  });

  it('lists newest parcels first', async () => {
    let t = new Date('2026-07-01T10:00:00.000Z').getTime();
    const repo = createDemoRepo(window.localStorage, () => (t += 60_000));
    const first = await repo.add({ trackingNumber: '1234567890', label: 'First' });
    const second = await repo.add({ trackingNumber: '123456789012', label: 'Second' });

    const listed = await repo.list();
    expect(listed.findIndex((p) => p.id === second.id)).toBeLessThan(
      listed.findIndex((p) => p.id === first.id),
    );
  });

  it('keeps a manually selected carrier when the number is ambiguous', async () => {
    const parcel = await createDemoRepo(window.localStorage).add({
      trackingNumber: 'ABC123456',
      label: 'Quickpac parcel',
      carrier: 'quickpac',
    });

    expect(parcel.carrier).toBe('quickpac');
  });

  it('automatically selects Quickpac for parcel numbers starting with 44', async () => {
    const parcel = await createDemoRepo(window.localStorage).add({
      trackingNumber: '44.00.123456.12345678',
      label: 'Quickpac parcel',
    });

    expect(parcel.trackingNumber).toBe('440012345612345678');
    expect(parcel.carrier).toBe('quickpac');
  });

  it('keeps a Planzer shared tracking URL', async () => {
    const trackingUrl =
      'https://trackandtrace.planzergroup.com/shared/sendungen/999.90.03316119?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH';
    const parcel = await createDemoRepo(window.localStorage).add({
      trackingNumber: '999.90.03316119',
      label: 'Plants',
      trackingUrl,
    });

    expect(parcel.carrier).toBe('planzer');
    expect(parcel.trackingUrl).toBe(trackingUrl);
  });

  it('stores the postcode with a DPD parcel', async () => {
    const parcel = await createDemoRepo(window.localStorage).add({
      trackingNumber: '06086514587082',
      label: 'DPD parcel',
      carrier: 'dpd',
      dpdPostcode: '8004',
    });

    expect(parcel.dpdPostcode).toBe('8004');
    const reloaded = await createDemoRepo(window.localStorage).list();
    expect(reloaded.find((candidate) => candidate.id === parcel.id)?.dpdPostcode)
      .toBe('8004');
  });

  it('archives and restores a parcel without deleting it', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Bye' });
    await repo.remove(parcel.id);
    let listed = await repo.list();
    expect(listed.find((candidate) => candidate.id === parcel.id)?.archivedAt).toBeTruthy();

    await repo.restore!(parcel.id);
    listed = await repo.list();
    expect(listed.find((candidate) => candidate.id === parcel.id)?.archivedAt).toBeUndefined();
  });

  it('persists per-parcel notification mutes', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = (await repo.list())[0];

    const muted = await repo.setNotificationsMuted!(parcel.id, true);

    expect(muted.notificationsMuted).toBe(true);
    expect((await repo.list()).find((candidate) => candidate.id === parcel.id))
      .toMatchObject({ notificationsMuted: true });
  });

  it('renames and persists a parcel', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Old title' });

    const renamed = await repo.rename(parcel.id, ' New title ');

    expect(renamed.label).toBe('New title');
    const reloaded = await createDemoRepo(window.localStorage).list();
    expect(reloaded.find((candidate) => candidate.id === parcel.id)?.label).toBe('New title');
  });

  it('applies the title length limit when renaming', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Old title' });

    await expect(repo.rename(parcel.id, 'x'.repeat(81))).rejects.toThrow('at most 80');
  });

  it('refresh advances non-final parcels by exactly one stage', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Socks' });
    expect(currentStage(parcel.events)).toBe('pending');

    const afterOne = await repo.refresh();
    const mine = afterOne.find((p) => p.id === parcel.id)!;
    expect(currentStage(mine.events)).toBe('registered');
    expect(mine.events).toHaveLength(2);
  });

  it('refreshes only the selected parcel', async () => {
    const repo = createDemoRepo(window.localStorage);
    const first = await repo.add({ trackingNumber: '1234567890', label: 'Socks' });
    const second = await repo.add({ trackingNumber: '1234567891', label: 'Hat' });

    const refreshed = await repo.refreshParcel!(first.id);
    const parcels = await repo.list();

    expect(currentStage(refreshed.events)).toBe('registered');
    expect(currentStage(parcels.find((parcel) => parcel.id === second.id)!.events)).toBe('pending');
  });

  it('refresh leaves delivered parcels alone and eventually delivers everything', async () => {
    const repo = createDemoRepo(window.localStorage);
    await repo.add({ trackingNumber: '1234567890', label: 'Socks' });

    let parcels = await repo.list();
    for (let i = 0; i < 10; i++) {
      parcels = await repo.refresh();
    }
    for (const parcel of parcels) {
      expect(isDelivered(parcel.events)).toBe(true);
    }

    const counts = parcels.map((p) => p.events.length);
    await repo.refresh();
    const after = await repo.list();
    expect(after.map((p) => p.events.length)).toEqual(counts);
  });

  it('survives corrupted storage by re-seeding', async () => {
    window.localStorage.setItem(DEMO_STORAGE_KEY, '{not json');
    const repo = createDemoRepo(window.localStorage);
    const parcels = await repo.list();
    expect(parcels.length).toBeGreaterThan(0);
  });
});
