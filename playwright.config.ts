import { defineConfig, devices } from '@playwright/test';
import { BASE, PORT, SERVER_ENV } from './e2e/env.ts';

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
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node packages/server/src/main.ts serve --demo --port ${PORT}`,
    url: BASE,
    env: SERVER_ENV,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
