self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const title = String(form.get('title') || '').trim().slice(0, 80);
      const parts = [form.get('url'), form.get('text')]
        .map((value) => String(value || '').trim())
        .filter((value, index, values) => value && values.indexOf(value) === index);
      const trackingInput = parts.join('\n').slice(0, 10_000);
      if (trackingInput) {
        const cache = await caches.open('sdt-private-share-target-v1');
        await cache.put('/share-target/draft', new Response(
          JSON.stringify({ label: title, trackingInput }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
        ));
      }
      return Response.redirect(new URL('/?share-target=1', self.location.origin), 303);
    })());
    return;
  }

  if (event.request.method === 'GET' && url.pathname === '/share-target/draft') {
    event.respondWith((async () => {
      const cache = await caches.open('sdt-private-share-target-v1');
      const draft = await cache.match('/share-target/draft');
      await cache.delete('/share-target/draft');
      return draft || new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    })());
  }
});

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
