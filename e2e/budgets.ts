import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type AllowFail, allowFailVerdict } from '../packages/web/sizes.ts';

/** One measured budget (spec §7). */
export interface Budget {
  name: string;
  value: number;
  limit: number;
  unit: 'B' | 'ms' | '%' | 'MB' | '/s' | 'nodes' | 'frames';
}

/** A budget row as test-results/budgets.json holds it. */
export interface BudgetRow extends Budget {
  pass: boolean;
  /** The test that measured it: a retry replaces its rows instead of adding to them. */
  testId: string;
  /** The owning task and baseline while the budget is known to fail (PF5, F5); else absent. */
  allowFail?: AllowFail;
}

/** Playwright's outputDir; it is emptied at the start of every run. */
export const BUDGETS_FILE = join(import.meta.dirname, '..', 'test-results', 'budgets.json');

/** Every row recorded so far in this run. */
export function readBudgets(): BudgetRow[] {
  if (!existsSync(BUDGETS_FILE)) return [];
  return JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) as BudgetRow[];
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Writes the budget's row to test-results/budgets.json (one row per test and name: a retry
 * replaces it) and asserts value <= limit. The row and a log line come before the (soft)
 * assertion, so a failing budget is in the table too (the Docker run keeps only the log).
 *
 * `allowFail: { owner, baseline }` marks a budget that fails today (ruling PF5, F5): it may stay
 * over its limit up to baseline × CEILING. It fails once it passes (the owner must remove the
 * marker) and past the ceiling (a regression). packages/web/perf-markers.test.ts fails while any
 * marker remains, from Task 11 on.
 */
export function recordBudget(b: Budget, opts: { allowFail?: AllowFail } = {}): void {
  const pass = b.value <= b.limit;
  const testId = test.info().testId;
  const row: BudgetRow = {
    ...b,
    pass,
    testId,
    ...(opts.allowFail ? { allowFail: opts.allowFail } : {}),
  };
  const rows = readBudgets().filter((r) => !(r.testId === testId && r.name === b.name));
  mkdirSync(join(BUDGETS_FILE, '..'), { recursive: true });
  writeFileSync(
    BUDGETS_FILE,
    `${JSON.stringify([...rows, row], null, 2)}
`,
  );
  const allow = opts.allowFail;
  const verdict = pass ? 'pass' : allow ? `FAIL (allowed: ${allow.owner})` : 'FAIL';
  console.log(`budget: ${b.name}: ${fmt(b.value)} ${b.unit} (limit ${fmt(b.limit)}) ${verdict}`);
  // Soft: a test that measures two budgets records both before it fails.
  if (allow) {
    expect.soft(allowFailVerdict(b.name, b.value, b.limit, allow), b.name).toBeNull();
    test.info().annotations.push({
      type: 'budget',
      description: `${b.name} fails (${fmt(b.value)} > ${fmt(b.limit)} ${b.unit}); ${allow.owner} owns it.`,
    });
    return;
  }
  expect.soft(b.value, `${b.name} (${b.unit})`).toBeLessThanOrEqual(b.limit);
}

/** The median of `xs` (the mean of the middle two for an even count). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** The nearest-rank percentile: p95 of 40 samples is the 38th smallest (ruling PF5, F8). */
export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] as number;
}
