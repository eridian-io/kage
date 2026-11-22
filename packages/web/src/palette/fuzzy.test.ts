import { describe, expect, it } from 'vitest';
import { fuzzy, rank } from './fuzzy.ts';

describe('fuzzy', () => {
  it('matches a case-insensitive subsequence and reports the hits', () => {
    expect(fuzzy('dn', 'docs / Write notes')?.hits).toEqual([0, 13]);
    expect(fuzzy('DOCS', 'docs / Write notes')?.hits).toEqual([0, 1, 2, 3]);
  });

  it('is null when a query character is missing or out of order', () => {
    expect(fuzzy('xz', 'docs')).toBeNull();
    expect(fuzzy('sd', 'docs')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzy('', 'docs')).toEqual({ score: -0.04, hits: [] });
  });

  it('scores +1 a hit, +5 at a word start, +3 right after the previous hit, −0.01 a character', () => {
    // d at 0: 1 + 5; o right after: 1 + 3; minus 0.04 for the length.
    expect(fuzzy('do', 'docs')?.score).toBeCloseTo(10 - 0.04);
    // s after "/" counts as a word start.
    expect(fuzzy('s', 'a/sb')?.score).toBeCloseTo(6 - 0.04);
    // A scattered hit is +1 only.
    expect(fuzzy('c', 'docs')?.score).toBeCloseTo(1 - 0.04);
  });

  it('prefers word starts to the first occurrence', () => {
    expect(fuzzy('wn', 'Write notes')?.hits).toEqual([0, 6]);
    expect(fuzzy('n', 'an note')?.hits).toEqual([3]);
  });

  it('word starts outrank scattered hits', () => {
    const r = rank('wn', ['wonderland', 'Write notes'], (s) => s);
    expect(r.map((x) => x.item)).toEqual(['Write notes', 'wonderland']);
  });
});

describe('rank', () => {
  it('returns the items in order with an empty query', () => {
    expect(rank('', ['b', 'a', 'c'], (s) => s).map((x) => x.item)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the input order on ties, and drops what does not match', () => {
    const r = rank('ab', ['xab1', 'zz', 'xab2', 'yab3'], (s) => s);
    expect(r.map((x) => x.item)).toEqual(['xab1', 'xab2', 'yab3']);
  });

  it('caps at 50 by default, or at the given limit', () => {
    const items = Array.from({ length: 80 }, (_, i) => `item ${i}`);
    expect(rank('it', items, (s) => s)).toHaveLength(50);
    expect(rank('', items, (s) => s)).toHaveLength(50);
    expect(rank('it', items, (s) => s, 51)).toHaveLength(51);
  });

  it('ranks 1,000 items of 60 characters in under 10 ms (median of 20 runs)', () => {
    const words = ['web', 'shop-api', 'infra', 'docs', 'fix', 'login', 'notes', 'dark', 'mode'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    const items = Array.from({ length: 1000 }, () => {
      let s = '';
      while (s.length < 60) s += `${words[next() % words.length]} / `;
      return s.slice(0, 60);
    });
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      rank(i % 2 ? 'wn' : 'dkmd', items, (s) => s);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[10]).toBeLessThan(10);
  });
});
