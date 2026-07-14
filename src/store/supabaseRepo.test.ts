import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseRepo } from './supabaseRepo';

const packageRow = {
  id: 'pkg-1',
  tracking_number: '993412345612345678',
  label: 'Coffee beans',
  carrier: 'swiss-post',
  created_at: '2026-06-28T10:00:00.000Z',
  tracking_events: [
    {
      id: 'ev-1',
      package_id: 'pkg-1',
      stage: 'in_transit',
      description: 'Sorted at the parcel center',
      location: 'Härkingen',
      occurred_at: '2026-06-29T08:00:00.000Z',
    },
  ],
};

/** Minimal stand-in for the parts of supabase-js the repo touches. */
function fakeClient(overrides: { session?: object | null } = {}) {
  const signInAnonymously = vi
    .fn()
    .mockResolvedValue({ data: { session: {} }, error: null });
  const order = vi.fn().mockResolvedValue({ data: [packageRow], error: null });
  const single = vi.fn().mockResolvedValue({ data: packageRow, error: null });
  const insert = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({ single }),
  });
  const eq = vi.fn().mockResolvedValue({ error: null });

  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: overrides.session === undefined ? {} : overrides.session },
      }),
      signInAnonymously,
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ order }),
      insert,
      delete: vi.fn().mockReturnValue({ eq }),
    }),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  };
  return { client: client as unknown as SupabaseClient, spies: { signInAnonymously, insert, eq } };
}

describe('createSupabaseRepo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps package and event rows to the app model', async () => {
    const { client } = fakeClient();
    const repo = createSupabaseRepo(client);
    const parcels = await repo.list();

    expect(parcels).toHaveLength(1);
    const parcel = parcels[0];
    expect(parcel.trackingNumber).toBe('993412345612345678');
    expect(parcel.carrier).toBe('swiss-post');
    expect(parcel.events).toHaveLength(1);
    expect(parcel.events[0]).toMatchObject({
      parcelId: 'pkg-1',
      stage: 'in_transit',
      location: 'Härkingen',
      occurredAt: '2026-06-29T08:00:00.000Z',
    });
  });

  it('reuses an existing session without signing in again', async () => {
    const { client, spies } = fakeClient({ session: {} });
    await createSupabaseRepo(client).list();
    expect(spies.signInAnonymously).not.toHaveBeenCalled();
  });

  it('requires an explicit session instead of silently creating an anonymous identity', async () => {
    const { client, spies } = fakeClient({ session: null });
    await expect(createSupabaseRepo(client).list()).rejects.toThrow(/sign in/i);
    expect(spies.signInAnonymously).not.toHaveBeenCalled();
  });

  it('normalises the tracking number and detects the carrier on insert', async () => {
    const { client, spies } = fakeClient();
    await createSupabaseRepo(client).add({
      trackingNumber: '99.34.123456.12345678',
      label: 'Coffee beans',
    });
    expect(spies.insert).toHaveBeenCalledWith({
      tracking_number: '993412345612345678',
      label: 'Coffee beans',
      carrier: 'swiss-post',
    });
  });

  it('deletes by id', async () => {
    const { client, spies } = fakeClient();
    await createSupabaseRepo(client).remove('pkg-1');
    expect(spies.eq).toHaveBeenCalledWith('id', 'pkg-1');
  });

  it('requests an authenticated server-side sync before reloading', async () => {
    const { client } = fakeClient({ session: { access_token: 'session-token' } });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);

    const parcels = await createSupabaseRepo(client).refresh();

    expect(fetch).toHaveBeenCalledWith('/api/sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    });
    expect(parcels).toHaveLength(1);
  });
});
