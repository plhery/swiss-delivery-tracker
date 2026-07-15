self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Parcel update', body: 'A delivery has new tracking information.' };
  }

  const title = payload.title || 'Parcel update';
  const options = {
    body: payload.body || 'A delivery has new tracking information.',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-192.png',
    tag: payload.tag || 'parcel-update',
    renotify: true,
    data: payload.data || { url: '/' },
  };

  const tasks = [self.registration.showNotification(title, options)];
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    tasks.push(self.navigator.setAppBadge(1));
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
    void self.navigator.clearAppBadge();
  }

  let target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ('navigate' in client) await client.navigate(target.href);
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
