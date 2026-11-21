import { describe, expect, it } from 'vitest';
import { demoSessions } from './demo.ts';
import { groupOf, sortSessions } from './order.ts';

const s = demoSessions(Date.UTC(2026, 10, 21, 14, 32));

describe('order', () => {
  it('sorts by group, pinned first within done, then oldest status first', () => {
    expect(sortSessions(s).map((x) => x.id)).toEqual([
      'web',
      'shop',
      'infra',
      'rate',
      'footer',
      'docs',
    ]);
    expect(sortSessions([...s].reverse()).map((x) => x.id)).toEqual(
      sortSessions(s).map((x) => x.id),
    );
    expect(sortSessions(s.filter((x) => !x.archived)).length).toBe(6);
  });

  it('does not mutate its input', () => {
    const copy = [...s].reverse();
    const before = copy.map((x) => x.id);
    sortSessions(copy);
    expect(copy.map((x) => x.id)).toEqual(before);
  });

  it('groups ended with done', () => {
    const first = s[0];
    if (!first) throw new Error('no demo session');
    expect(groupOf({ ...first, status: 'ended' })).toBe('done');
    expect(groupOf(first)).toBe('needs you');
    expect(groupOf({ ...first, status: 'running' })).toBe('running');
  });
});
