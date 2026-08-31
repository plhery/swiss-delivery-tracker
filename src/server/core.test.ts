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
import {
  DeliveryLiveActivityNotificationService,
  NativePushNotificationService,
  notificationExpectedDelivery,
  notificationText,
  pushServices,
  WebPushNotificationService,
} from './push';
import {
  authConfiguration,
  deliveryServiceConfigured,
  publicSupabaseOrigin,
  serviceClient,
} from './runtime';
import { SupabaseClient } from './supabase';
import {
  deleteLiveActivityDevice,
  deleteLiveActivityUpdateToken,
  liveActivityDevice,
  liveActivityUpdateToken,
  nativePushDevice,
  newPackageValues,
  notificationPreferences,
  packageLabel,
  pushEndpoint,
  pushSubscription,
} from './validation';

const originalEnvironment = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLIC_URL: process.env.SUPABASE_PUBLIC_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
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

describe('server runtime configuration', () => {
  it('distinguishes an intentionally absent service from malformed configuration', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLIC_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(publicSupabaseOrigin()).toBeNull();
    expect(authConfiguration()).toBeNull();
    expect(serviceClient()).toBeNull();
    expect(deliveryServiceConfigured()).toBe(false);

    process.env.SUPABASE_URL = 'not-a-url';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(publicSupabaseOrigin()).toBeNull();
    expect(() => authConfiguration()).toThrow('required');
    expect(() => serviceClient()).toThrow('required');
    expect(deliveryServiceConfigured()).toBe(false);
  });

  it('normalizes valid origins, prefers the public URL, and reuses the service client', () => {
    process.env.SUPABASE_URL = 'http://supabase.internal:8000/';
    process.env.SUPABASE_PUBLIC_URL = 'https://supabase.example.com/';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'public-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    expect(publicSupabaseOrigin()).toBe('https://supabase.example.com');
    expect(authConfiguration()).toEqual({
      url: 'http://supabase.internal:8000',
      publishableKey: 'public-key',
    });
    const first = serviceClient();
    expect(first).not.toBeNull();
    expect(serviceClient()).toBe(first);
    expect(deliveryServiceConfigured()).toBe(true);
  });
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
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      headers: { 'Content-Length': '1e1' },
      body: '{}',
    }))).rejects.toThrow('request size');
  });

  it('stream-limits chunked JSON bodies and cancels oversized input', async () => {
    const encoder = new TextEncoder();
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"ok":'));
        controller.enqueue(encoder.encode('true}'));
        controller.close();
      },
    });
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      body: streamed,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }))).resolves.toEqual({ ok: true });

    let cancelled = false;
    let chunk = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(chunk === 0 ? 'x'.repeat(16_384) : 'x'));
        chunk += 1;
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      body: oversized,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }))).rejects.toThrow('request size');
    expect(cancelled).toBe(true);
  });

  it('rejects invalid UTF-8 before parsing streamed JSON', async () => {
    let cancelled = false;
    const invalidUtf8 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0xff]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readJsonObject(new Request('https://delivery.example/api', {
      method: 'POST',
      body: invalidUtf8,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }))).rejects.toThrow('valid JSON object');
    expect(cancelled).toBe(true);
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
    expect(newPackageValues({
      trackingNumber: '76434219',
      label: 'Relay parcel',
      carrier: 'mondial-relay',
      trackingUrl: '',
      dpdPostcode: '59650',
    })).toMatchObject({
      trackingNumber: '76434219',
      carrier: 'mondial-relay',
      dpdPostcode: '59650',
    });
    expect(() => newPackageValues({
      trackingNumber: '76434219',
      label: 'Relay parcel',
      carrier: 'mondial-relay',
      trackingUrl: '',
      dpdPostcode: '5965',
    })).toThrow('five-digit');
    expect(newPackageValues({
      trackingNumber: '993990103198',
      label: 'GLS parcel',
      carrier: 'gls-ch',
      trackingUrl: '',
      dpdPostcode: '8000',
    })).toMatchObject({
      carrier: 'gls-ch',
      dpdPostcode: '8000',
    });
    expect(newPackageValues({
      trackingNumber: '23456789',
      label: 'Heppner shipment',
      carrier: 'heppner',
      trackingUrl: '',
      dpdPostcode: '1201',
    })).toMatchObject({
      carrier: 'heppner',
      dpdPostcode: '1201',
    });
    expect(newPackageValues({
      trackingNumber: 'PAACK12345',
      label: 'Paack parcel',
      carrier: 'paack',
      trackingUrl: '',
      dpdPostcode: '1234 567',
    })).toMatchObject({
      carrier: 'paack',
      dpdPostcode: '1234567',
    });
    expect(() => newPackageValues({
      trackingNumber: 'PAACK12345',
      label: 'Paack parcel',
      carrier: 'paack',
      trackingUrl: '',
      dpdPostcode: '12--345',
    })).toThrow('valid delivery postcode');
    expect(() => newPackageValues({
      trackingNumber: 'PAACK12345',
      label: 'Paack parcel',
      carrier: 'paack',
      trackingUrl: '',
      dpdPostcode: '12 - 345',
    })).toThrow('valid delivery postcode');
    expect(() => newPackageValues({
      trackingNumber: 'PAACK12345',
      label: 'Paack parcel',
      carrier: 'paack',
      trackingUrl: '',
      dpdPostcode: 'ABC',
    })).toThrow('valid delivery postcode');
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
      installationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      environment: 'development',
      locale: 'de',
      deviceName: '  iPhone  ',
      sendTest: true,
    })).toMatchObject({
      token: 'ab'.repeat(32),
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      locale: 'de',
      deviceName: 'iPhone',
    });
    expect(() => nativePushDevice({ token: 'xyz' }, false)).toThrow('APNs');

    expect(liveActivityDevice({
      installationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      token: 'CD'.repeat(32),
      environment: 'production',
      locale: 'fr',
    })).toEqual({
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      token: 'cd'.repeat(32),
      environment: 'production',
      locale: 'fr',
    });
    expect(liveActivityUpdateToken({
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      activityId: 'activity-123',
      parcelId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      token: 'EF'.repeat(32),
      environment: 'development',
      locale: 'it',
    })).toMatchObject({
      activityId: 'activity-123',
      parcelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      token: 'ef'.repeat(32),
    });
    expect(deleteLiveActivityDevice({
      installationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    })).toEqual({ installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(deleteLiveActivityUpdateToken({
      installationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      activityId: 'activity-123',
    })).toMatchObject({ activityId: 'activity-123' });
    expect(() => liveActivityUpdateToken({
      installationId: 'nope',
      activityId: '../activity',
      parcelId: 'nope',
      token: '00',
      environment: 'development',
      locale: 'en',
    })).toThrow(HttpError);
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

  it('always keeps the current ETA in tracking notifications and marks changes', () => {
    const now = Date.UTC(2026, 7, 25, 12);
    const web = new WebPushNotificationService(
      {} as never,
      'public-key',
      'private-key',
      'https://delivery.example',
      () => now,
    );
    const row = {
      label: 'Coffee grinder',
      package_id: 'package-1',
      stage: 'in_transit',
      location: 'Zürich',
      expected_delivery: '2026-08-26',
      expected_delivery_changed: true,
      timezone: 'Europe/Zurich',
    };

    expect(web.payload(row)).toMatchObject({
      body: 'Parcel in transit · Zürich · New ETA: tomorrow',
    });
    expect(web.payload({ ...row, expected_delivery_changed: false })).toMatchObject({
      body: 'Parcel in transit · Zürich · ETA tomorrow',
    });
    expect(notificationExpectedDelivery(
      '2026-08-26 09:00–12:00',
      'fr',
      'Europe/Zurich',
      now,
    )).toBe('demain, 09:00–12:00');
  });

  it('localizes native ETA copy and preserves it after a long location', () => {
    const now = Date.UTC(2026, 7, 25, 12);
    const native = new NativePushNotificationService(
      {} as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
      () => now / 1_000,
    );
    const payload = native.eventPayload({
      locale: 'de',
      label: 'Paket',
      package_id: 'package-1',
      stage: 'in_transit',
      location: 'Z'.repeat(300),
      expected_delivery: '2026-08-26',
      expected_delivery_changed: true,
      timezone: 'Europe/Zurich',
    });
    const alert = (payload.aps as Record<string, unknown>).alert as Record<string, unknown>;
    const body = String(alert.body);

    expect(body).toMatch(/^Paket unterwegs · Z+… · Neue Lieferprognose: morgen$/);
    expect([...body].length).toBeLessThanOrEqual(220);
  });

  it('builds parcel-stable ActivityKit start, update, and graceful end payloads', () => {
    const now = Date.UTC(2026, 7, 25, 12) / 1_000;
    const native = new NativePushNotificationService(
      {} as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
      () => now,
    );
    const live = new DeliveryLiveActivityNotificationService({} as never, native);
    const row = {
      locale: 'de',
      label: 'Laufschuhe',
      package_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      carrier: 'swiss-post',
      stage: 'out_for_delivery',
      location: 'Zürich',
      expected_delivery: '2026-08-25 14:00–16:00',
      timezone: 'Europe/Zurich',
    };

    expect(live.deliveryKind({ ...row, update_token: '' })).toBe('start');
    expect(live.deliveryKind({ ...row, update_token: 'ab'.repeat(32) })).toBe('update');
    expect(live.deliveryKind({ ...row, stage: 'delivered', update_token: 'ab'.repeat(32) }))
      .toBe('end');

    const start = live.payload(row, 'start');
    expect(start).toMatchObject({
      aps: {
        timestamp: now,
        event: 'start',
        'relevance-score': 0.8,
        'attributes-type': 'DeliveryActivityAttributes',
        attributes: { parcelID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        'input-push-token': 1,
        'stale-date': now + 1_800,
        'content-state': {
          languageCode: 'de',
          parcel: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            label: 'Laufschuhe',
            carrier: 'Swiss Post',
            status: 'In Zustellung',
            detail: 'heute, 14:00–16:00',
            phase: 'out_for_delivery',
          },
        },
      },
    });
    expect(JSON.stringify(start)).not.toContain('trackingNumber');

    const delivered = live.payload({ ...row, stage: 'delivered' }, 'end');
    expect(delivered).toMatchObject({
      aps: {
        event: 'end',
        'relevance-score': 1,
        'dismissal-date': now + 1_800,
        alert: { title: 'Laufschuhe', body: 'Zugestellt · Zürich' },
        'content-state': {
          parcel: { status: 'Zugestellt', detail: 'Zugestellt', phase: 'delivered' },
        },
      },
    });
  });

  it('collapses superseded ActivityKit events into the newest state and acknowledges all', async () => {
    const rows = [
      {
        device_id: 'device-1',
        package_id: 'package-1',
        event_id: 'event-1',
        event_created_at: '2026-08-25T12:00:00.000Z',
        update_token_id: 'token-1',
        update_token: 'ab'.repeat(32),
        stage: 'out_for_delivery',
      },
      {
        device_id: 'device-1',
        package_id: 'package-1',
        event_id: 'event-2',
        event_created_at: '2026-08-25T12:05:00.000Z',
        update_token_id: 'token-1',
        update_token: 'ab'.repeat(32),
        stage: 'out_for_delivery',
      },
    ];
    const client = {
      listPendingLiveActivityEvents: vi.fn().mockResolvedValue(rows),
      recordLiveActivityDeliveries: vi.fn().mockResolvedValue(undefined),
      updateLiveActivityToken: vi.fn().mockResolvedValue(undefined),
    };
    const native = new NativePushNotificationService(
      client as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
    );
    const live = new DeliveryLiveActivityNotificationService(client as never, native);
    const send = vi.spyOn(live, 'send').mockResolvedValue(undefined);

    await expect(live.dispatch()).resolves.toEqual({
      attempted: 1,
      sent: 1,
      failed: 0,
      expired: 0,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(rows[1], 'update');
    expect(client.recordLiveActivityDeliveries).toHaveBeenCalledWith([
      {
        deviceId: 'device-1',
        eventId: 'event-1',
        packageId: 'package-1',
        deliveryKind: 'update',
        eventCreatedAt: '2026-08-25T12:00:00.000Z',
      },
      {
        deviceId: 'device-1',
        eventId: 'event-2',
        packageId: 'package-1',
        deliveryKind: 'update',
        eventCreatedAt: '2026-08-25T12:05:00.000Z',
      },
    ]);
  });

  it('suppresses only the native alert that a Live Activity successfully replaced', async () => {
    const liveRow = {
      device_id: 'device-1',
      package_id: 'package-1',
      event_id: 'event-1',
      event_created_at: '2026-08-25T12:00:00.000Z',
      stage: 'out_for_delivery',
      live_activity_delivered: true,
    };
    const suppressedClient = {
      listPendingNativePushNotifications: vi.fn().mockResolvedValue([liveRow]),
      recordNativePushDeliveries: vi.fn().mockResolvedValue(undefined),
    };
    const suppressed = new NativePushNotificationService(
      suppressedClient as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
    );
    const suppressedSend = vi.spyOn(suppressed, 'send').mockResolvedValue(undefined);

    await expect(suppressed.dispatch()).resolves.toEqual({
      attempted: 0,
      sent: 0,
      failed: 0,
      expired: 0,
    });
    expect(suppressedSend).not.toHaveBeenCalled();
    expect(suppressedClient.recordNativePushDeliveries)
      .toHaveBeenCalledWith('device-1', ['event-1']);

    const fallbackClient = {
      listPendingNativePushNotifications: vi.fn().mockResolvedValue([{
        ...liveRow,
        live_activity_delivered: false,
      }]),
      recordNativePushDeliveries: vi.fn().mockResolvedValue(undefined),
      updateNativePushDevice: vi.fn().mockResolvedValue(undefined),
    };
    const fallback = new NativePushNotificationService(
      fallbackClient as never,
      'TEAM',
      'KEY',
      privateKey('prime256v1'),
      'com.example.delivery',
    );
    const fallbackSend = vi.spyOn(fallback, 'send').mockResolvedValue(undefined);

    await expect(fallback.dispatch()).resolves.toMatchObject({ attempted: 1, sent: 1 });
    expect(fallbackSend).toHaveBeenCalledOnce();
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
