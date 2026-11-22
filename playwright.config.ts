import { defineConfig, devices } from '@playwright/test';
import { BASE, LIVE_BASE, PERF_BASE, PORT, SERVER_ENV } from './e2e/env.ts';

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
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      testIgnore: ['live.spec.ts', 'finish.spec.ts', 'notify.spec.ts', 'perf.spec.ts'],
    },
    // Real tmux and `kage serve` in live mode (notify.spec.ts with the fake ntfy); the specs skip
    // themselves where tmux is missing.
    {
      name: 'live',
      use: { browserName: 'chromium', baseURL: LIVE_BASE },
      testMatch: ['live.spec.ts', 'finish.spec.ts', 'notify.spec.ts'],
    },
    // The budgets of spec §7 (e2e/budgets.ts writes test-results/budgets.json). Live mode on its
    // own port; the live parts skip themselves without tmux, the idle server without /proc.
    {
      name: 'perf',
      use: { browserName: 'chromium', baseURL: PERF_BASE },
      testMatch: 'perf.spec.ts',
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
