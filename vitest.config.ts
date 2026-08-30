import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Next.js replaces this marker at build time. Tests intentionally exercise
    // the server modules directly, so map the marker to an inert module here.
    alias: { 'server-only': fileURLToPath(new URL('./src/test/serverOnly.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.live.test.ts'],
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    setupFiles: ['src/test/setup.ts'],
    css: false,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/generated/**',
        'src/server/**',
        'src/ClientApplication.tsx',
        'src/types.ts',
      ],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
