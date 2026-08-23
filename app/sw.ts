import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

importScripts('/push-sw.js');

const SHARE_TARGET_CACHE = 'sdt-private-share-target-v1';
const SHARE_TARGET_DRAFT = '/share-target/draft';
const SHARE_TARGET_MAX_AGE_MS = 10 * 60 * 1_000;
let shareTargetTail: Promise<void> = Promise.resolve();

async function serializeShareTarget<T>(operation: () => Promise<T>): Promise<T> {
  const prior = shareTargetTail;
  let release!: () => void;
  shareTargetTail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    return await operation();
  } finally {
    release();
  }
}

function missingShareTarget(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function captureShareTarget(request: Request): Promise<Response> {
  const declaredHeader = request.headers.get('content-length');
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
      return new Response('Shared content has an invalid size.', { status: 400 });
    }
    if (declaredLength > 65_536) {
      return new Response('Shared content is too large.', { status: 413 });
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Shared content is invalid.', { status: 400 });
  }
  const asText = (value: FormDataEntryValue | null) => (
    typeof value === 'string' ? value.trim() : ''
  );
  const title = asText(form.get('title')).slice(0, 80);
  const parts = [form.get('url'), form.get('text')]
    .map(asText)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const trackingInput = parts.join('\n').slice(0, 10_000);
  await serializeShareTarget(async () => {
    const cache = await caches.open(SHARE_TARGET_CACHE);
    await cache.delete(SHARE_TARGET_DRAFT);
    if (trackingInput) {
      await cache.put(SHARE_TARGET_DRAFT, new Response(
        JSON.stringify({ label: title, trackingInput }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-SDT-Created-At': String(Date.now()),
          },
        },
      ));
    }
  });
  return Response.redirect(new URL('/?share-target=1', self.location.origin), 303);
}

async function consumeShareTarget(): Promise<Response> {
  return await serializeShareTarget(async () => {
    const cache = await caches.open(SHARE_TARGET_CACHE);
    const draft = await cache.match(SHARE_TARGET_DRAFT);
    await cache.delete(SHARE_TARGET_DRAFT);
    if (!draft) return missingShareTarget();
    const createdAtHeader = draft.headers.get('X-SDT-Created-At');
    const createdAt = Number(createdAtHeader);
    const age = Date.now() - createdAt;
    if (
      createdAtHeader === null
      || !Number.isFinite(createdAt)
      || age < -60_000
      || age > SHARE_TARGET_MAX_AGE_MS
    ) return missingShareTarget();
    return draft;
  });
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname === '/share-target',
      method: 'POST',
      handler: async ({ request }) => captureShareTarget(request),
    },
    {
      matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname === SHARE_TARGET_DRAFT,
      handler: async () => consumeShareTarget(),
    },
    {
      // Account data and authentication traffic must never enter CacheStorage.
      // Keep this route ahead of Serwist's defaults, which cache GET APIs and
      // cross-origin responses for applications with public data.
      matcher: ({ sameOrigin, url }) => (
        !sameOrigin || url.pathname.startsWith('/api/') || url.pathname === '/health'
      ),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: '/~offline',
        matcher({ request }) {
          return request.destination === 'document';
        },
      },
    ],
  },
});

serwist.addEventListeners();
