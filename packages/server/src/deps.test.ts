import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Spec §3: no native modules. `ws` would load `bufferutil` and `utf-8-validate` when present;
 * they are optional peers and must never be installed (Task 12).
 */
describe('the server has no native helpers', () => {
  const require = createRequire(import.meta.url);
  it.each(['bufferutil', 'utf-8-validate'])('%s does not resolve', (name) => {
    expect(() => import.meta.resolve(name)).toThrow();
    expect(() => require.resolve(name)).toThrow();
  });
  it('ws itself resolves (the one runtime dependency the terminal adds)', () => {
    expect(import.meta.resolve('ws')).toMatch(/ws/);
  });
});
