// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowFailVerdict, CEILING } from './sizes.ts';

describe('allowFailVerdict (a budget known to fail today, ruling PF5, F5)', () => {
  const allow = { owner: 'Task 4', baseline: 100 };

  it('is fine while the budget fails within baseline × 1.25', () => {
    expect(CEILING).toBe(1.25);
    expect(allowFailVerdict('RSS', 100, 80, allow)).toBeNull();
    expect(allowFailVerdict('RSS', 125, 80, allow)).toBeNull();
  });

  it('fails when the budget passes: the marker must go', () => {
    expect(allowFailVerdict('RSS', 80, 80, allow)).toBe(
      'RSS passes now: remove its allowFail marker (Task 4)',
    );
  });

  it('fails past the regression ceiling', () => {
    expect(allowFailVerdict('RSS', 126, 80, allow)).toBe(
      'RSS regressed past its allowFail ceiling: 126 > 125 (baseline 100 × 1.25; Task 4)',
    );
  });
});

/** The files that may hold allowFail markers: the perf spec and the build test. */
const MARKED = ['../../e2e/perf.spec.ts', 'build.test.ts'];

// Task 11 removes this skip: by then Tasks 3 and 4 have removed every allowFail marker, and
// every §7 budget must pass outright.
describe.skip('no allowFail markers remain (Phase 5 end)', () => {
  it.each(MARKED)('%s has no allowFail marker', (file) => {
    const text = readFileSync(join(import.meta.dirname, file), 'utf8');
    // `allowFail: {` (perf spec) and `const allowFail = {` (build test).
    expect(text.match(/allowFail(: | = )\{/g) ?? []).toEqual([]);
  });
});
