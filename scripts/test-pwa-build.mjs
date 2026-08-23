import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const next = resolve(root, '.next');
const staticDirectory = resolve(next, 'static');
const [worker, workerSource, pushWorker, manifestText, privacy, offline, ogImage, staticEntries] = await Promise.all([
  readFile(resolve(root, 'public/sw.js'), 'utf8'),
  readFile(resolve(root, 'app/sw.ts'), 'utf8'),
  readFile(resolve(root, 'public/push-sw.js'), 'utf8'),
  readFile(resolve(next, 'server/app/manifest.webmanifest.body'), 'utf8'),
  readFile(resolve(root, 'public/privacy.html'), 'utf8'),
  readFile(resolve(next, 'server/app/~offline.html'), 'utf8'),
  readFile(resolve(root, 'public/og.png')),
  readdir(staticDirectory, { recursive: true, withFileTypes: true }),
]);

await stat(resolve(next, 'standalone/server.js'));
const javascriptFiles = staticEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => resolve(entry.parentPath, entry.name));
const applicationBundle = (await Promise.all(javascriptFiles.map(async (file) => ({
  file,
  source: await readFile(file, 'utf8'),
})))).find(({ source }) => (
  source.includes('controllerchange') && source.includes('updateViaCache')
));

assert.ok(applicationBundle, 'the production client bundle must observe service worker upgrades');
const applicationAsset = `/_next/${relative(next, applicationBundle.file).replaceAll('\\', '/')}`;
assert.ok(worker.includes(applicationAsset), 'the service worker must precache the current app bundle');
assert.match(
  applicationBundle.source,
  /\.register\(["']\/sw\.js["'],\{[^}]*updateViaCache:["']none["']/,
  'the app must register its worker without caching the worker script',
);
assert.match(applicationBundle.source, /location\.reload/, 'an activated upgrade must reload the open app');
assert.match(worker, /skipWaiting/, 'new workers must activate without waiting');
assert.match(worker, /clientsClaim/, 'new workers must take control of open clients');
assert.match(worker, /cleanupOutdatedCaches/, 'old precaches must be removed');
assert.match(worker, /push-sw\.js/, 'the push handler must be loaded');
assert.match(worker, /privacy\.html/, 'the privacy notice must be cached for offline access');
assert.match(worker, /~offline/, 'offline navigations must use the dedicated Next.js fallback');
assert.match(offline, /You’re offline/, 'the offline fallback must be rendered during the build');
assert.match(pushWorker, /addEventListener\(['"]push['"]/, 'push events must be handled');
assert.match(pushWorker, /showNotification\(/, 'push events must display a notification');
assert.match(pushWorker, /addEventListener\(['"]notificationclick['"]/, 'notification clicks must be handled');
assert.match(workerSource, /method: 'POST'/, 'private POST share targets must use the worker router');
assert.match(workerSource, /formData\(\)/, 'shared content must be read from a POST body');
assert.match(workerSource, /X-SDT-Created-At/, 'abandoned private share drafts must expire');
assert.doesNotMatch(
  pushWorker,
  /addEventListener\(['"]fetch['"]/,
  'only the Serwist router may own fetch responses',
);
assert.match(workerSource, /new NetworkOnly\(\)/, 'private requests must use a network-only strategy');
assert.match(workerSource, /pathname\.startsWith\('\/api\/'\)/, 'authenticated APIs must never be cached');
assert.match(pushWorker, /caches\.delete\('apis'\)/, 'legacy private API caches must be removed');

assert.equal(ogImage.subarray(1, 4).toString('ascii'), 'PNG', 'the social card must be a PNG');
assert.ok(ogImage.readUInt32BE(16) >= 1_200, 'the social card must be wide enough for link previews');
assert.ok(ogImage.readUInt32BE(20) >= 630, 'the social card must be tall enough for link previews');

const manifest = JSON.parse(manifestText);
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.id, '/');
assert.deepEqual(manifest.share_target, {
  action: '/share-target',
  method: 'POST',
  enctype: 'multipart/form-data',
  params: { title: 'title', text: 'text', url: 'url' },
});
assert.match(privacy, /Download my data/, 'the public build must include the privacy notice');

console.log(`PWA build contract passed for ${applicationAsset}`);
