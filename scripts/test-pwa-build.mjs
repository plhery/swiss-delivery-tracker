import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const [index, registration, worker, pushWorker, manifestText, privacy] = await Promise.all([
  readFile(resolve(dist, 'index.html'), 'utf8'),
  readFile(resolve(dist, 'registerSW.js'), 'utf8'),
  readFile(resolve(dist, 'sw.js'), 'utf8'),
  readFile(resolve(dist, 'push-sw.js'), 'utf8'),
  readFile(resolve(dist, 'manifest.webmanifest'), 'utf8'),
  readFile(resolve(dist, 'privacy.html'), 'utf8'),
]);

const asset = index.match(/\/assets\/index-[^" ]+\.js/)?.[0];
assert.ok(asset, 'index.html must reference a hashed JavaScript bundle');
await stat(resolve(dist, asset.slice(1)));
const bundle = await readFile(resolve(dist, asset.slice(1)), 'utf8');
assert.ok(worker.includes(asset.slice(1)), 'the service worker must precache the current bundle');
assert.match(bundle, /controllerchange/, 'the app must observe service worker upgrades');
assert.match(bundle, /location\.reload/, 'an activated upgrade must reload the open app');
assert.match(registration, /serviceWorker\.register\(['"]\/sw\.js['"]/);
assert.match(worker, /\.skipWaiting\(\)/, 'new workers must activate without waiting');
assert.match(worker, /\.clientsClaim\(\)/, 'new workers must take control of open clients');
assert.match(worker, /\.cleanupOutdatedCaches\(\)/, 'old precaches must be removed');
assert.match(worker, /importScripts\(["']push-sw\.js["']\)/, 'push handler must be loaded');
assert.match(
  worker,
  /privacy\.html/,
  'the privacy notice must be available from the offline application shell',
);
assert.match(pushWorker, /addEventListener\(['"]push['"]/, 'push events must be handled');
assert.match(pushWorker, /showNotification\(/, 'push events must display a notification');
assert.match(pushWorker, /addEventListener\(['"]notificationclick['"]/, 'notification clicks must be handled');

const manifest = JSON.parse(manifestText);
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.id, '/');
assert.deepEqual(manifest.share_target, {
  action: '/?share-target=1',
  method: 'GET',
  params: { title: 'title', text: 'text', url: 'url' },
});
assert.match(privacy, /Download my data/, 'the public build must include the privacy notice');

console.log(`PWA build contract passed for ${asset}`);
