self.addEventListener('activate', (event) => {
  // Remove cache names used by Serwist defaults before private API traffic was
  // explicitly made network-only.
  event.waitUntil(Promise.all([
    caches.delete('apis'),
    caches.delete('cross-origin'),
  ]));
});

self.addEventListener('push', (event) => {
  let decoded = {};
  try {
    decoded = event.data ? event.data.json() : {};
  } catch {
    decoded = {};
  }

  const payload = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {};
  const text = (value, fallback, limit) => (
    typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback
  );
  const title = text(payload.title, 'Parcel update', 120);
  const options = {
    body: text(payload.body, 'A delivery has new tracking information.', 500),
    icon: text(payload.icon, '/icons/icon-192.png', 2_048),
    badge: text(payload.badge, '/icons/icon-192.png', 2_048),
    tag: text(payload.tag, 'parcel-update', 120),
    renotify: true,
    data: payload.data && typeof payload.data === 'object' ? payload.data : { url: '/' },
  };

  const tasks = [self.registration.showNotification(title, options)];
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    tasks.push(Promise.resolve(self.navigator.setAppBadge(1)).catch(() => undefined));
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
    void self.navigator.clearAppBadge();
  }

  let target;
  try {
    const requested = typeof event.notification.data?.url === 'string'
      ? event.notification.data.url
      : '/';
    target = new URL(requested, self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        try {
          if ('navigate' in client) await client.navigate(target.href);
          if ('focus' in client) return await client.focus();
        } catch {
          // A stale or closing client should not prevent opening a usable one.
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
