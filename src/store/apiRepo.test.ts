import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRepo } from './apiRepo';

const packageRow = {
  id: '40000000-0000-0000-0000-000000000004',
  tracking_number: '993412345612345678',
  label: 'Coffee beans',
  carrier: 'swiss-post',
  created_at: '2026-07-15T00:00:00Z',
  expected_delivery: '2026-07-16',
  last_status_text: 'Sorted',
  last_synced_at: '2026-07-15T01:00:00Z',
  sync_status: 'ok',
  sync_error: null,
  tracking_events: [
    {
      id: 'event-1',
      package_id: '40000000-0000-0000-0000-000000000004',
      stage: 'in_transit',
      description: 'Sorted at the parcel center',
      location: 'Härkingen',
      occurred_at: '2026-07-15T01:00:00Z',
    },
  ],
};

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) };
}

describe('createApiRepo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads and maps the shared package collection', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ packages: [packageRow] }));
    vi.stubGlobal('fetch', fetch);

    const parcels = await createApiRepo().list();

    expect(fetch).toHaveBeenCalledWith('/api/packages', { headers: undefined });
    expect(parcels[0]).toMatchObject({
      trackingNumber: '993412345612345678',
      label: 'Coffee beans',
      carrier: 'swiss-post',
      expectedDelivery: '2026-07-16',
      lastStatusText: 'Sorted',
      syncStatus: 'ok',
    });
    expect(parcels[0].events[0]).toMatchObject({
      parcelId: packageRow.id,
      stage: 'in_transit',
      location: 'Härkingen',
    });
  });

  it('normalises additions and keeps explicit carrier choices', async () => {
    const fetch = vi.fn().mockResolvedValue(response(packageRow));
    vi.stubGlobal('fetch', fetch);

    await createApiRepo().add({
      trackingNumber: '99.34.123456.12345678',
      label: 'Coffee beans',
    });
    expect(fetch).toHaveBeenCalledWith('/api/packages', {
      method: 'POST',
      body: JSON.stringify({
        trackingNumber: '993412345612345678',
        label: 'Coffee beans',
        carrier: 'swiss-post',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await createApiRepo().add({
      trackingNumber: 'ambiguous-123',
      label: '',
      carrier: 'planzer',
    });
    expect(fetch).toHaveBeenLastCalledWith('/api/packages', expect.objectContaining({
      body: JSON.stringify({
        trackingNumber: 'AMBIGUOUS123',
        label: '',
        carrier: 'planzer',
      }),
    }));
  });

  it('deletes, syncs and reloads through the same-origin API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ checked: 1 }))
      .mockResolvedValueOnce(response({ packages: [packageRow] }));
    vi.stubGlobal('fetch', fetch);
    const repo = createApiRepo();

    await repo.remove(packageRow.id);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `/api/packages/${packageRow.id}`,
      { method: 'DELETE', headers: undefined },
    );

    const parcels = await repo.refresh();
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/sync', {
      method: 'POST',
      headers: undefined,
    });
    expect(parcels).toHaveLength(1);
  });

  it('surfaces API errors and malformed success responses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'Database offline' }, false, 502))
      .mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn().mockRejectedValue(new Error()) })
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal('fetch', fetch);
    const repo = createApiRepo();

    await expect(repo.list()).rejects.toThrow('Database offline');
    await expect(repo.list()).rejects.toThrow('Delivery service failed (503)');
    await expect(repo.list()).rejects.toThrow('empty response');
  });

  it('polls while visible, refreshes on visibility changes, and unsubscribes', () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const onChange = vi.fn();
    const unsubscribe = createApiRepo(1_000).subscribe?.(onChange);

    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledOnce();

    visibility = 'hidden';
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledOnce();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe?.();
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
