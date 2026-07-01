// Renders public/icons/icon.svg to the PNG sizes the PWA manifest needs.
// Run with: npm run icons
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');
const svg = readFileSync(join(iconsDir, 'icon.svg'), 'utf8');

const outputs = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
];

for (const { file, size } of outputs) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
  }).render();
  writeFileSync(join(iconsDir, file), png.asPng());
  console.log(`wrote public/icons/${file} (${size}x${size})`);
}
