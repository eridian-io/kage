import { defineConfig, devices } from '@playwright/test';
import { BASE, LIVE_BASE, PORT, SERVER_ENV } from './e2e/env.ts';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE,
    viewport: { width: 1320, height: 900 },
    deviceScaleFactor: 1,
    // The app's CSP (style-src 'self') would block the style tag that pauses the cursor.
    bypassCSP: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: 'live.spec.ts' },
    // Real tmux and `kage serve` in live mode; the spec skips itself where tmux is missing.
    {
      name: 'live',
      use: { browserName: 'chromium', baseURL: LIVE_BASE },
      testMatch: 'live.spec.ts',
    },
  ],
  webServer: {
    command: `node packages/server/src/main.ts serve --demo --port ${PORT}`,
    url: BASE,
    env: SERVER_ENV,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
