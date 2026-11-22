import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // Loopback-only fetch in every test (N0, R85).
    setupFiles: ['test/setup-fetch.ts'],
  },
});
