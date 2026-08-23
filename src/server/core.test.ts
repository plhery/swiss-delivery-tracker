import { NextRequest } from 'next/server';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  readJsonObject,
} from './api';
import { SupabaseAuthError, SupabaseAuthenticator } from './auth';
import { fetchBounded, parseJsonBytes } from './boundedFetch';
import { RateLimiter } from './rateLimit';
import { NativePushNotificationService, notificationText, pushServices } from './push';
import { SupabaseClient } from './supabase';
import {
  nativePushDevice,
  newPackageValues,
  notificationPreferences,
  packageLabel,
  pushEndpoint,
  pushSubscription,
} from './validation';

const originalEnvironment = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  APNS_TEAM_ID: process.env.APNS_TEAM_ID,
  APNS_KEY_ID: process.env.APNS_KEY_ID,
  APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
  APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('API request boundaries', () => {
  it('adds request tracing and privacy headers to public handlers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const route = apiRoute(async () => json({ ok: true }), {
      authenticated: false,
      loadService: false,
    });
    const response = await route(
      new NextRequest('https://delivery.example/health'),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('returns a service error for malformed authentication configuration', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.SUPABASE_URL = 'not-a-url';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'public-key';
    delete process.env.SUPABASE_ANON_KEY;
    const route = apiRoute(async () => json({ unreachable: true }), { loadService: false });
    const response = await route(
      new NextRequest('https://delivery.example/api/packages', {
        headers: { Authorization: 'Bearer token' },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Supabase authentication is not configured',
    });
  });

  it('accepts only bounded JSON objects', async () => {
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      body: '{"ok":true}',
    }))).resolves.toEqual({ ok: true });
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      body: '[]',
    }))).rejects.toThrow('JSON object');
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      headers: { 'Content-Length': '16385' },
      body: '{}',
    }))).rejects.toThrow('request size');
  });

  it('normalizes UUIDs and rejects route-shaped junk', () => {
    expect(parseUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'package id'))
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(() => parseUuid('../package', 'package id')).toThrow(HttpError);
  });
});

describe('authentication validation', () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function token(payload: Record<string, unknown>): string {
    return [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'signature',
    ].join('.');
  }

  it('validates a non-anonymous Supabase user and current-session claims', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: userId,
      email: 'owner@example.com',
      is_anonymous: false,
    }), { status: 200 }));
    const auth = new SupabaseAuthenticator('https://supabase.example', 'public-key');
    const accessToken = token({
      sub: userId,
      session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      amr: [{ method: 'otp', timestamp: 1_787_000_000 }],
    });
    const user = await auth.validate(accessToken);

    expect(user).toMatchObject({
      id: userId,
      email: 'owner@example.com',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(user.authenticatedAt?.toISOString()).toBe('2026-08-17T20:53:20.000Z');
    await expect(auth.validate(accessToken)).resolves.toEqual(user);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects anonymous, malformed, and oversized tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: userId,
      is_anonymous: true,
    }), { status: 200 }));
    const auth = new SupabaseAuthenticator('https://supabase.example', 'public-key');
    await expect(auth.validate('token')).rejects.toBeInstanceOf(SupabaseAuthError);
    await expect(auth.validate('x'.repeat(16_385))).rejects.toBeInstanceOf(SupabaseAuthError);
  });
});

describe('input validation', () => {
  it('normalizes package input and enforces carrier-specific fields', () => {
    expect(newPackageValues({
      trackingNumber: '44.00 123456-12345678',
      label: '  Shoes  ',
      carrier: 'unknown',
      trackingUrl: '',
      dpdPostcode: '',
    })).toMatchObject({
      trackingNumber: '440012345612345678',
      label: 'Shoes',
      carrier: 'quickpac',
    });
    expect(() => newPackageValues({
      trackingNumber: '06086514587082',
      label: 'Parcel',
      carrier: 'dpd',
      trackingUrl: '',
      dpdPostcode: '',
    })).toThrow('four-digit');
    expect(() => newPackageValues({
      trackingNumber: 'letters',
      label: 'Parcel',
      carrier: 'unknown',
      trackingUrl: '',
      dpdPostcode: '',
    })).toThrow('include a digit');
  });

  it('counts user-visible characters and trims package labels', () => {
    expect(packageLabel({ label: '  Coffee  ' })).toBe('Coffee');
    expect(() => packageLabel({ label: '😀'.repeat(81) })).toThrow('80 characters');
    expect(() => packageLabel({ label: 42 })).toThrow('text');
  });

  it('allowlists browser push services without accepting lookalike hosts', () => {
    expect(pushEndpoint('https://fcm.googleapis.com/fcm/send/id'))
      .toBe('https://fcm.googleapis.com/fcm/send/id');
    expect(pushEndpoint('https://region.notify.windows.com/push/id'))
      .toBe('https://region.notify.windows.com/push/id');
    for (const endpoint of [
      'http://fcm.googleapis.com/push',
      'https://fcm.googleapis.com.evil.example/push',
      'https://user:password@fcm.googleapis.com/push',
      'https://fcm.googleapis.com:444/push',
    ]) expect(() => pushEndpoint(endpoint)).toThrow('valid push endpoint');
  });

  it('validates Web Push key material and APNs registrations', () => {
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
    const auth = Buffer.alloc(16).toString('base64url');
    expect(pushSubscription({
      endpoint: 'https://web.push.apple.com/Q123',
      keys: { p256dh: publicKey, auth },
    })).toMatchObject({ p256dh: publicKey, auth });
    expect(() => pushSubscription({
      endpoint: 'https://web.push.apple.com/Q123',
      keys: { p256dh: Buffer.alloc(65).toString('base64url'), auth },
    })).toThrow('encryption keys');

    expect(nativePushDevice({
      token: 'AB'.repeat(32),
      environment: 'development',
      locale: 'de',
      deviceName: '  iPhone  ',
      sendTest: true,
    })).toMatchObject({ token: 'ab'.repeat(32), locale: 'de', deviceName: 'iPhone' });
    expect(() => nativePushDevice({ token: 'xyz' }, false)).toThrow('APNs');
  });

  it('rejects incomplete quiet hours, duplicates, and invalid timezones', () => {
    expect(notificationPreferences({
      enabledStages: ['delivered'],
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'Europe/Zurich',
    })).toMatchObject({ enabledStages: ['delivered'], timezone: 'Europe/Zurich' });
    expect(() => notificationPreferences({
      enabledStages: ['delivered', 'delivered'],
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Europe/Zurich',
    })).toThrow('valid notification');
    expect(() => notificationPreferences({
      enabledStages: ['delivered'],
      quietHoursStart: '22:00',
      quietHoursEnd: null,
      timezone: 'Europe/Zurich',
    })).toThrow('both quiet-hour');
    expect(() => notificationPreferences({
      enabledStages: ['delivered'],
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'Moon/Base',
    })).toThrow('timezone');
  });
});

describe('native notification boundaries', () => {
  function privateKey(curve: 'prime256v1' | 'secp384r1'): string {
    return generateKeyPairSync('ec', { namedCurve: curve }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }).toString();
  }

  it('requires a valid P-256 APNs key and reuses short-lived provider tokens', async () => {
    expect(() => new NativePushNotificationService(
      {} as never,
      'TEAM',
      'KEY',
      'not-a-key',
      'com.example.delivery',
    )).toThrow('P-256');
    expect(() => new NativePushNotificationService(
      {} as never,
      'TEAM',
      'KEY',
      privateKey('secp384r1'),
      'com.example.delivery',
    )).toThrow('P-256');

    const service = new NativePushNotificationService(
      {} as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
      () => 1_787_500_000,
    );
    const first = await service.providerToken();
    expect(await service.providerToken()).toBe(first);
    expect(JSON.parse(Buffer.from(first.split('.')[0]!, 'base64url').toString('utf8')))
      .toEqual({ alg: 'ES256', kid: 'KEY' });
  });

  it('bounds notification text by Unicode characters', () => {
    expect(notificationText(`  ${'😀'.repeat(5)}  `, 4)).toBe('😀😀😀…');
  });

  it('rejects incomplete Web Push credentials during service startup', () => {
    process.env.VAPID_PUBLIC_KEY = 'public-key-without-private-key';
    delete process.env.VAPID_PRIVATE_KEY;
    expect(() => pushServices({} as never)).toThrow('configured together');
  });
});

describe('outbound request boundaries', () => {
  it('enforces declared and streamed carrier response limits', async () => {
    await expect(fetchBounded('https://carrier.example', {}, {
      provider: 'Carrier',
      maxBytes: 4,
      fetcher: vi.fn().mockResolvedValue(new Response('12345')),
    })).rejects.toThrow('unexpectedly large');
    await expect(fetchBounded('https://carrier.example', {}, {
      provider: 'Carrier',
      maxBytes: 4,
      fetcher: vi.fn().mockResolvedValue(new Response('12345', {
        headers: { 'Content-Length': '5' },
      })),
    })).rejects.toThrow('unexpectedly large');
    expect(parseJsonBytes(Buffer.from('{"ok":true}'), 'Carrier')).toEqual({ ok: true });
    expect(() => parseJsonBytes(Buffer.from('<html>'), 'Carrier')).toThrow('invalid tracking');
  });

  it('cancels rejected carrier response bodies', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    await expect(fetchBounded('https://carrier.example', {}, {
      provider: 'Carrier',
      fetcher: vi.fn().mockResolvedValue(new Response(body, { status: 503 })),
    })).rejects.toMatchObject({ status: 503 });
    expect(cancelled).toBe(true);
  });

  it('maps database transport, status, and payload failures', async () => {
    const client = new SupabaseClient('https://supabase.example', 'service-key');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'one' }]), { status: 200 }));
    await expect(client.request('/rest/v1/packages')).resolves.toEqual([{ id: 'one' }]);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer service-key');

    fetcher.mockResolvedValueOnce(new Response('{broken', { status: 200 }));
    await expect(client.request('/rest/v1/packages')).rejects.toThrow('invalid JSON');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: '23505' }), { status: 409 }));
    await expect(client.request('/rest/v1/packages')).rejects.toMatchObject({
      status: 409,
      code: '23505',
    });
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(client.request('/rest/v1/packages')).rejects.toThrow('unreachable');
  });
});

describe('rate limiting', () => {
  it('uses a sliding window and validates policies', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    expect(limiter.retryAfter('account', { limit: 2, window: 10 })).toBe(0);
    expect(limiter.retryAfter('account', { limit: 2, window: 10 })).toBe(0);
    expect(limiter.retryAfter('account', { limit: 2, window: 10 })).toBe(10);
    now = 10;
    expect(limiter.retryAfter('account', { limit: 2, window: 10 })).toBe(0);
    expect(() => limiter.retryAfter('account', { limit: 0, window: 10 })).toThrow('positive');
  });
});
