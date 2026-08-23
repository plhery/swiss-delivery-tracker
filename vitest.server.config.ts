import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'server-only': fileURLToPath(new URL('./src/test/serverOnly.ts', import.meta.url)) },
  },
  test: {
    include: ['src/server/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/server',
      include: ['src/server/**/*.ts'],
      exclude: [
        'src/server/**/*.test.ts',
        'src/server/types.ts',
      ],
      // This separately gates the newly ported backend at its measured
      // baseline. Raise these floors as adapter and route coverage expands.
      thresholds: {
        statements: 39,
        branches: 34,
        functions: 39,
        lines: 42,
        'src/server/{api,auth,boundedFetch,carrierResult,rateLimit,runtime,trackingSync,validation}.ts': {
          statements: 71,
          branches: 61,
          functions: 79,
          lines: 74,
        },
      },
    },
  },
});
