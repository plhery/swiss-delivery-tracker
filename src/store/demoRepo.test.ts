import { beforeEach, describe, expect, it } from 'vitest';
import { currentStage, isDelivered } from '../lib/stages';
import { createDemoRepo, DEMO_STORAGE_KEY, nextStage } from './demoRepo';

beforeEach(() => {
  window.localStorage.clear();
});

describe('nextStage', () => {
  it('walks the happy path in order', () => {
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

  it('adds a parcel with a registered event and a detected carrier', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({
      trackingNumber: '99.34.123456.12345678',
      label: 'Chocolate 🍫',
    });

    expect(parcel.trackingNumber).toBe('993412345612345678');
    expect(parcel.carrier).toBe('swiss-post');
    expect(parcel.events).toHaveLength(1);
    expect(parcel.events[0].stage).toBe('registered');

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

  it('removes a parcel', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Bye' });
    await repo.remove(parcel.id);
    const listed = await repo.list();
    expect(listed.some((p) => p.id === parcel.id)).toBe(false);
  });

  it('refresh advances non-final parcels by exactly one stage', async () => {
    const repo = createDemoRepo(window.localStorage);
    const parcel = await repo.add({ trackingNumber: '1234567890', label: 'Socks' });
    expect(currentStage(parcel.events)).toBe('registered');

    const afterOne = await repo.refresh();
    const mine = afterOne.find((p) => p.id === parcel.id)!;
    expect(currentStage(mine.events)).toBe('accepted');
    expect(mine.events).toHaveLength(2);
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
