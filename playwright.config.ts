import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // Next's development compiler can leave chunk responses pending when every
  // desktop CPU is used for a cold, fully parallel browser run. Two workers
  // keep the test server responsive while still exercising concurrent pages.
  workers: 2,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    // CI exercises the self-contained production server. This also avoids a
    // Next dev bug that unnecessarily compiles Node-only instrumentation for
    // the Edge runtime when CI=true.
    command: process.env.CI
      ? 'npm run build && npm start'
      : 'npm run dev -- --hostname 127.0.0.1 --port 4173',
    env: {
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_USE_API: 'false',
      PORT: '4173',
    },
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 120_000 : 30_000,
    url: 'http://127.0.0.1:4173',
  },
});
