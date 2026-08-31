import { describe, expect, it, vi } from 'vitest';
import { SupabaseServiceClient } from './supabase';

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
