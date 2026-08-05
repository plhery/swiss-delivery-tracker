import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodePublicKey,
  disablePushNotifications,
  enableAppBadgeClearing,
  enablePushNotifications,
  inspectPushState,
  unsubscribePushNotificationsLocally,
} from './pushNotifications';

const getSubscription = vi.fn();
const subscribe = vi.fn();
const registration = { pushManager: { getSubscription, subscribe } };

function response(body: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  getSubscription.mockReset().mockResolvedValue(null);
  subscribe.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ available: true, publicKey: 'AQID' })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inspectPushState', () => {
  it('explains unsupported and server-unavailable installations', async () => {
    vi.stubGlobal('PushManager', undefined);
    await expect(inspectPushState()).resolves.toEqual({ kind: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();

    vi.stubGlobal('PushManager', function PushManager() {});
    vi.mocked(fetch).mockResolvedValueOnce(response({ available: false, publicKey: null }));
    await expect(inspectPushState()).resolves.toEqual({ kind: 'unavailable' });
  });

  it('distinguishes blocked, ready, and subscribed devices', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    await expect(inspectPushState()).resolves.toEqual({ kind: 'blocked' });

    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
    await expect(inspectPushState()).resolves.toEqual({ kind: 'prompt', publicKey: 'AQID' });

    getSubscription.mockResolvedValueOnce({ endpoint: 'https://push.example/token' });
    await expect(inspectPushState()).resolves.toEqual({ kind: 'enabled', publicKey: 'AQID' });
  });
});

describe('app badge lifecycle', () => {
  it('clears the badge on launch and each return to the foreground', () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    let onVisibilityChange: EventListener | undefined;
    const page = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        onVisibilityChange = listener as EventListener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);

    const cleanupBadgeClearing = enableAppBadgeClearing({ clearAppBadge }, page);
    expect(clearAppBadge).toHaveBeenCalledOnce();

    visibilityState = 'hidden';
    onVisibilityChange?.(new Event('visibilitychange'));
    expect(clearAppBadge).toHaveBeenCalledOnce();

    visibilityState = 'visible';
    onVisibilityChange?.(new Event('visibilitychange'));
    expect(clearAppBadge).toHaveBeenCalledTimes(2);

    cleanupBadgeClearing();
    expect(page.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      onVisibilityChange,
    );
  });

  it('is inert when the Badging API is unsupported', () => {
    const addEventListener = vi.fn();
    const page = {
      visibilityState: 'visible',
      addEventListener,
      removeEventListener: vi.fn(),
    } as unknown as Document;

    expect(() => enableAppBadgeClearing({}, page)).not.toThrow();
    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('push subscription lifecycle', () => {
  it('decodes VAPID keys and registers a new subscription', async () => {
    expect([...new Uint8Array(decodePublicKey('AQID'))]).toEqual([1, 2, 3]);
    const subscription = {
      endpoint: 'https://push.example/token',
      toJSON: () => ({ endpoint: 'https://push.example/token', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(),
    };
    subscribe.mockResolvedValue(subscription);
    vi.mocked(fetch).mockResolvedValueOnce(response({ testSent: true }));

    await expect(enablePushNotifications('AQID')).resolves.toBe(true);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(ArrayBuffer),
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/subscriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rolls back a new browser subscription when the server rejects it', async () => {
    const subscription = {
      endpoint: 'https://push.example/token',
      toJSON: () => ({ endpoint: 'https://push.example/token' }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    subscribe.mockResolvedValue(subscription);
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'database offline' }, false));
    await expect(enablePushNotifications('AQID')).rejects.toThrow('database offline');
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it('removes an existing subscription from server and browser', async () => {
    const subscription = {
      endpoint: 'https://push.example/token',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    getSubscription.mockResolvedValue(subscription);
    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: true }));
    await disablePushNotifications();
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/subscriptions',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it('unsubscribes locally when server cleanup is unavailable', async () => {
    const subscription = {
      endpoint: 'https://push.example/token',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    getSubscription.mockResolvedValue(subscription);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));

    await expect(disablePushNotifications()).rejects.toThrow('offline');
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('can remove only the local subscription after account deletion', async () => {
    const subscription = { unsubscribe: vi.fn().mockResolvedValue(true) };
    getSubscription.mockResolvedValue(subscription);

    await unsubscribePushNotificationsLocally();

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
