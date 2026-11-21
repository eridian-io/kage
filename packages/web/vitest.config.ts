import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'build.test.ts'],
  },
});
