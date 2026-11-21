import { describe, expect, it } from 'vitest';
import { slugify, uniqueSlug } from './slug.ts';

describe('slugify', () => {
  it('lowercases words and joins them with "-"', () => {
    expect(slugify('Fix the login bug!')).toBe('fix-the-login-bug');
  });

  it('strips accents', () => {
    expect(slugify('Ünïcödé café')).toBe('unicode-cafe');
  });

  it('falls back to "task" when nothing is left', () => {
    expect(slugify('日本語')).toBe('task');
    expect(slugify('')).toBe('task');
    expect(slugify('---')).toBe('task');
  });

  it('keeps a long task at most 40 characters, with no trailing "-"', () => {
    const task =
      'Refactor the payment module so that every provider shares one retry policy and logs';
    const long = `${task} ${task}`.slice(0, 120);
    expect(long).toHaveLength(120);
    const s = slugify(long);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).not.toMatch(/-$/);
    expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // It cut at a word boundary in the last 10 characters.
    expect(s).toBe('refactor-the-payment-module-so-that');
  });

  it('cuts mid-word when no "-" is in the last 10 characters', () => {
    expect(slugify('a'.repeat(120))).toBe('a'.repeat(40));
  });

  it('never starts with "-" (no option-looking branch names)', () => {
    expect(slugify('--dangerously-skip-permissions')).toBe('dangerously-skip-permissions');
    expect(slugify('-p x')).toBe('p-x');
  });

  it('leaves no path or shell characters', () => {
    expect(slugify('../../etc')).toBe('etc');
    expect(slugify('a/../../b')).toBe('a-b');
    expect(slugify('$(rm -rf ~)')).toBe('rm-rf');
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', async () => {
    expect(await uniqueSlug('x', async () => false)).toBe('x');
  });

  it('adds -2, -3 … until one is free', async () => {
    const taken = new Set(['x', 'x-2']);
    expect(await uniqueSlug('x', async (s) => taken.has(s))).toBe('x-3');
  });

  it('trims the base so the suffix keeps it at most 40 characters', async () => {
    const base = `${'a'.repeat(35)}-bbbb`;
    expect(base).toHaveLength(40);
    const got = await uniqueSlug(base, async (s) => s === base);
    expect(got.length).toBeLessThanOrEqual(40);
    expect(got).toBe(`${'a'.repeat(35)}-bb-2`);
    // A trim that ends on "-" drops it.
    const dashed = `${'a'.repeat(37)}-bb`;
    expect(await uniqueSlug(dashed, async (s) => s === dashed)).toBe(`${'a'.repeat(37)}-2`);
  });

  it('throws after base-99', async () => {
    await expect(uniqueSlug('x', async () => true)).rejects.toThrow();
  });
});
