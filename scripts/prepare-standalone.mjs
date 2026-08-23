import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const standalone = resolve(root, '.next/standalone');
const standaloneNext = resolve(standalone, '.next');

await mkdir(standaloneNext, { recursive: true });
for (const [source, destination] of [
  [resolve(root, 'public'), resolve(standalone, 'public')],
  [resolve(root, '.next/static'), resolve(standaloneNext, 'static')],
]) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

console.log('Prepared the self-contained Next.js server.');
