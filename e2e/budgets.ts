import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** One measured budget (spec §7). */
export interface Budget {
  name: string;
  value: number;
  limit: number;
  unit: 'B' | 'ms' | '%' | 'MB' | '/s' | 'nodes';
}

/** A budget row as test-results/budgets.json holds it. */
export interface BudgetRow extends Budget {
  pass: boolean;
  /** The owning task while the budget is known to fail (ruling PF5, F5); absent otherwise. */
  allowFail?: string;
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
 * Appends to test-results/budgets.json and asserts value <= limit.
 *
 * `allowFail: '<owning task>'` is the baseline's marker for a budget that fails today (ruling PF5,
 * F5): the row is still written, with its value, and the test passes with an annotation. The
 * owning task removes the marker. The row and a log line are written before the (soft) assertion,
 * so a failing budget is in the table too (the Docker run keeps only the log).
 */
export function recordBudget(b: Budget, opts: { allowFail?: string } = {}): void {
  const pass = b.value <= b.limit;
  const row: BudgetRow = { ...b, pass, ...(opts.allowFail ? { allowFail: opts.allowFail } : {}) };
  mkdirSync(join(BUDGETS_FILE, '..'), { recursive: true });
  writeFileSync(BUDGETS_FILE, `${JSON.stringify([...readBudgets(), row], null, 2)}\n`);
  const verdict = pass ? 'pass' : opts.allowFail ? `FAIL (allowed: ${opts.allowFail})` : 'FAIL';
  console.log(`budget: ${b.name}: ${fmt(b.value)} ${b.unit} (limit ${fmt(b.limit)}) ${verdict}`);
  if (opts.allowFail) {
    test.info().annotations.push({
      type: 'budget',
      description: pass
        ? `${b.name} is within budget now; ${opts.allowFail} can remove its allowFail marker.`
        : `${b.name} fails (${fmt(b.value)} > ${fmt(b.limit)} ${b.unit}); ${opts.allowFail} owns it.`,
    });
    return;
  }
  // Soft: a test that measures two budgets records both before it fails.
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
