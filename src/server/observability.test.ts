import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import {
  errorType,
  logOperationalEvent,
  parseSampleRate,
  resolveSentryRelease,
  scrubSentryEvent,
  shouldReportRepeatedFailure,
} from './observability';

afterEach(() => vi.restoreAllMocks());

describe('Sentry privacy boundary', () => {
  it('removes request, user, breadcrumb, local-variable, and arbitrary context data', () => {
    const event = {
      message: 'secret carrier response',
      transaction: '/api/packages/11111111-1111-1111-1111-111111111111?token=secret',
      user: { id: 'private-user' },
      request: {
        url: 'https://delivery.example/api/packages/private?token=secret',
        headers: { authorization: 'Bearer secret' },
      },
      breadcrumbs: [{ message: 'tracking number 123' }],
      contexts: {
        runtime: { name: 'node' },
        request: { tracking_number: 'private' },
      },
      tags: {
        carrier: 'dpd-fr',
        tracking_number: 'private',
      },
      extra: {
        attempt_id: 'opaque-attempt',
        carrier_payload: { private: true },
      },
      server_name: 'private-host',
      exception: {
        values: [{
          type: 'CarrierError',
          value: 'private tracking number',
          stacktrace: {
            frames: [{
              filename: '/app/tracker.ts',
              vars: { trackingNumber: 'private' },
              context_line: 'throw new Error(trackingNumber)',
              pre_context: ['private'],
              post_context: ['private'],
            }],
          },
        }],
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.breadcrumbs).toEqual([]);
    expect(scrubbed.contexts).toEqual({ runtime: { name: 'node' } });
    expect(scrubbed.tags).toEqual({ carrier: 'dpd-fr' });
    expect(scrubbed.extra).toEqual({ attempt_id: 'opaque-attempt' });
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.message).toBe('Operational failure');
    expect(scrubbed.exception?.values?.[0]?.value).toBe('Operational failure');
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('private');
    expect(JSON.stringify(scrubbed)).not.toContain('secret');
  });

  it('drops private fields from structured operational logs', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logOperationalEvent('tracking_sync_step', {
      attempt_id: 'opaque-attempt',
      carrier: 'dpd-fr',
      tracking_number: '250123456789012',
      package_id: 'private-package',
      status_text: 'private status',
    });

    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      event: 'tracking_sync_step',
      attempt_id: 'opaque-attempt',
      carrier: 'dpd-fr',
    });
    expect(payload).not.toHaveProperty('tracking_number');
    expect(payload).not.toHaveProperty('package_id');
    expect(payload).not.toHaveProperty('status_text');
  });
});

describe('observability configuration', () => {
  it('accepts only bounded trace sample rates', () => {
    expect(parseSampleRate(undefined)).toBe(0);
    expect(parseSampleRate('0.25')).toBe(0.25);
    expect(parseSampleRate('-1', 0.1)).toBe(0.1);
    expect(parseSampleRate('2', 0.1)).toBe(0.1);
    expect(parseSampleRate('invalid', 0.1)).toBe(0.1);
  });

  it('prefers immutable image commits and rejects placeholder releases', () => {
    expect(resolveSentryRelease({
      IMAGE_COMMIT: 'a'.repeat(40),
      SENTRY_RELEASE: 'delivery@fallback',
    })).toBe('a'.repeat(40));
    expect(resolveSentryRelease({ SENTRY_RELEASE: 'delivery@2026.08.31' }))
      .toBe('delivery@2026.08.31');
    expect(resolveSentryRelease({ SENTRY_RELEASE: 'HEAD' })).toBeUndefined();
  });

  it('reports early repeats and then powers of two to prevent alert floods', () => {
    expect([1, 2, 3, 4, 5, 8, 16].filter(shouldReportRepeatedFailure))
      .toEqual([1, 2, 3, 4, 8, 16]);
  });

  it('does not treat an arbitrary exception name as telemetry metadata', () => {
    const error = new Error('private');
    error.name = 'TRACKING123';
    expect(errorType(error)).toBe('Error');
    error.name = 'CarrierTimeoutError';
    expect(errorType(error)).toBe('CarrierTimeoutError');
  });
});
