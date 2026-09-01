import { describe, expect, it, vi } from 'vitest';
import { SupabaseServiceClient, SupabaseUserClient } from './supabase';

describe('tracking audit PostgREST client', () => {
  it('starts and transactionally completes a private sync attempt', async () => {
    const client = new SupabaseServiceClient('https://database.example', 'service-key');
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(true);

    await client.startSyncAttempt('attempt-1', {
      package_id: 'package-1',
      trigger: 'package',
      configured_carrier: 'dpd-fr',
    });
    await expect(client.completeSyncAttempt(
      'attempt-1',
      { outcome: 'waiting', completed_at: '2026-08-31T12:00:00Z', duration_ms: 10 },
      [{ sequence: 1, step: 'fetch', status: 'succeeded' }],
    )).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(1, '/rest/v1/tracking_sync_attempts', {
      method: 'POST',
      body: {
        id: 'attempt-1',
        package_id: 'package-1',
        trigger: 'package',
        configured_carrier: 'dpd-fr',
      },
      prefer: 'return=minimal',
    });
    expect(request).toHaveBeenNthCalledWith(2, '/rest/v1/rpc/complete_tracking_sync_attempt', {
      method: 'POST',
      body: {
        p_attempt_id: 'attempt-1',
        p_values: {
          outcome: 'waiting',
          completed_at: '2026-08-31T12:00:00Z',
          duration_ms: 10,
        },
        p_steps: [{ sequence: 1, step: 'fetch', status: 'succeeded' }],
      },
    });
  });

  it('returns audit maintenance counts', async () => {
    const client = new SupabaseServiceClient('https://database.example', 'service-key');
    vi.spyOn(client, 'request').mockResolvedValue([{ abandoned: 2, purged: 7 }]);

    await expect(client.maintainSyncAudit()).resolves.toEqual({ abandoned: 2, purged: 7 });
  });
});

describe('owner package PostgREST client', () => {
  it('looks up duplicates by normalized tracking number', async () => {
    const client = new SupabaseUserClient('https://database.example', 'public-key', 'token');
    const request = vi.spyOn(client, 'request').mockResolvedValue([{ id: 'package-1' }]);

    await expect(client.getPackageByTrackingNumber('FR3182317025'))
      .resolves.toEqual({ id: 'package-1' });

    expect(request).toHaveBeenCalledWith(expect.stringMatching(
      /^\/rest\/v1\/packages\?select=.*&tracking_number=eq\.FR3182317025&limit=1$/,
    ));
  });

  it('changes carriers through the owner-scoped reset RPC', async () => {
    const client = new SupabaseUserClient('https://database.example', 'public-key', 'token');
    const request = vi.spyOn(client, 'request').mockResolvedValue(true);

    await expect(client.changePackageCarrier(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'mondial-relay',
      null,
      '59650',
    )).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith('/rest/v1/rpc/change_owned_package_carrier', {
      method: 'POST',
      body: {
        p_package_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        p_carrier: 'mondial-relay',
        p_tracking_url: null,
        p_dpd_postcode: '59650',
      },
    });
  });
});
