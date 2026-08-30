import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'server-only': fileURLToPath(new URL('./src/test/serverOnly.ts', import.meta.url)) },
  },
  test: {
    include: ['src/server/**/*.live.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 60_000,
  },
});
