import { authenticatedFetch, type ApiAuth } from './apiClient';
import type {
  ApiOkResponse,
  ApiNotificationPreferences,
  ApiNotificationStage,
  ApiPushConfigResponse,
  ApiPushSubscriptionResponse,
} from '../generated/apiContract';

export type NotificationPreferences = ApiNotificationPreferences;
export type NotificationStage = ApiNotificationStage;

export const ALL_NOTIFICATION_STAGES: NotificationStage[] = [
  'registered',
  'accepted',
  'in_transit',
  'customs',
  'out_for_delivery',
  'failed_attempt',
  'ready_for_pickup',
  'delivered',
  'returned',
];

export const IMPORTANT_NOTIFICATION_STAGES: NotificationStage[] = [
  'customs',
  'out_for_delivery',
  'failed_attempt',
  'ready_for_pickup',
  'delivered',
  'returned',
];

export const DELIVERY_DAY_NOTIFICATION_STAGES: NotificationStage[] = [
  'out_for_delivery',
  'delivered',
];

export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'prompt'; publicKey: string }
  | { kind: 'blocked' }
  | { kind: 'enabled'; publicKey: string };

type BadgeNavigator = { clearAppBadge?: () => Promise<void> };
type VisibilityDocument = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

/** Clear stale OS app badges on launch and whenever the PWA returns to the foreground. */
export function enableAppBadgeClearing(
  appNavigator: BadgeNavigator = navigator as BadgeNavigator,
  page: VisibilityDocument = document,
): () => void {
  const clearWhenVisible = () => {
    if (page.visibilityState !== 'visible') return;
    void appNavigator.clearAppBadge?.().catch(() => undefined);
  };

  clearWhenVisible();
  page.addEventListener('visibilitychange', clearWhenVisible);
  return () => page.removeEventListener('visibilitychange', clearWhenVisible);
}

async function request<T>(path: string, auth?: ApiAuth, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await authenticatedFetch(path, auth, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || 'Notification settings are unavailable');
  return body as T;
}

function supported(): boolean {
  return (
    'serviceWorker' in navigator &&
    typeof window.PushManager !== 'undefined' &&
    typeof window.Notification !== 'undefined'
  );
}

export async function inspectPushState(auth?: ApiAuth): Promise<PushState> {
  if (!supported()) return { kind: 'unsupported' };
  const config = await request<ApiPushConfigResponse>('/api/push/config', auth);
  if (!config.available || !config.publicKey) return { kind: 'unavailable' };
  if (Notification.permission === 'denied') return { kind: 'blocked' };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription
    ? { kind: 'enabled', publicKey: config.publicKey }
    : { kind: 'prompt', publicKey: config.publicKey };
}

export async function getNotificationPreferences(
  auth: ApiAuth,
): Promise<NotificationPreferences> {
  return request<ApiNotificationPreferences>('/api/push/preferences', auth);
}

export async function saveNotificationPreferences(
  preferences: NotificationPreferences,
  auth: ApiAuth,
): Promise<NotificationPreferences> {
  return request<ApiNotificationPreferences>('/api/push/preferences', auth, {
    method: 'PATCH',
    body: JSON.stringify(preferences),
  });
}

export async function enablePushNotifications(
  publicKey: string,
  auth?: ApiAuth,
): Promise<boolean> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed');
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const wasCreated = !subscription;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodePublicKey(publicKey),
    });
  }
  try {
    const result = await request<ApiPushSubscriptionResponse>('/api/push/subscriptions', auth, {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
    });
    return result.testSent;
  } catch (error) {
    if (wasCreated) await subscription.unsubscribe();
    throw error;
  }
}

export async function disablePushNotifications(auth?: ApiAuth): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await request<ApiOkResponse>('/api/push/subscriptions', auth, {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } finally {
    // Stop local delivery even if the server is temporarily unreachable. Its
    // next send will receive an expired-endpoint response and disable the row.
    await subscription.unsubscribe();
  }
}

export async function unsubscribePushNotificationsLocally(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

export function decodePublicKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer;
}
