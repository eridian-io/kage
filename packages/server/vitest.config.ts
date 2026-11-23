import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // Load timeouts kept recurring at vitest's 5 s default under the full suite (R136). The
    // describes that set their own 30 s keep it.
    testTimeout: 15_000,
    // Loopback-only fetch in every test (N0, R85).
    setupFiles: ['test/setup-fetch.ts'],
    // Ends test tmux servers a killed worker left behind (kage-test-<pid>-… only).
    globalSetup: ['test/tmux-global.ts'],
  },
});
