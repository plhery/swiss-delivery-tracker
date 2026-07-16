export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'prompt'; publicKey: string }
  | { kind: 'blocked' }
  | { kind: 'enabled'; publicKey: string };

type PushConfig = { available: boolean; publicKey: string | null };
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
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

export async function inspectPushState(): Promise<PushState> {
  if (!supported()) return { kind: 'unsupported' };
  const config = await request<PushConfig>('/api/push/config');
  if (!config.available || !config.publicKey) return { kind: 'unavailable' };
  if (Notification.permission === 'denied') return { kind: 'blocked' };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription
    ? { kind: 'enabled', publicKey: config.publicKey }
    : { kind: 'prompt', publicKey: config.publicKey };
}

export async function enablePushNotifications(publicKey: string): Promise<boolean> {
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
    const result = await request<{ testSent: boolean }>('/api/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
    });
    return result.testSent;
  } catch (error) {
    if (wasCreated) await subscription.unsubscribe();
    throw error;
  }
}

export async function disablePushNotifications(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await request('/api/push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

export function decodePublicKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return bytes.buffer;
}
