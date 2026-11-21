import type { ServerEvent } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { DemoSource } from './demo-source.ts';
import { NotFoundError } from './source.ts';

describe('DemoSource', () => {
  it('lists six sessions', () => {
    expect(new DemoSource(1_000_000).list()).toHaveLength(6);
  });
  it('remove emits session.removed and drops the session', async () => {
    const s = new DemoSource(1_000_000);
    const events: ServerEvent[] = [];
    s.subscribe((e) => events.push(e));
    await s.remove('docs');
    expect(events).toEqual([{ type: 'session.removed', id: 'docs' }]);
    expect(s.list()).toHaveLength(5);
    expect(s.get('docs')).toBeUndefined();
  });
  it('remove rejects NotFoundError for unknown id', async () => {
    await expect(new DemoSource(1).remove('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('unsubscribe stops events', async () => {
    const s = new DemoSource(1);
    const events: ServerEvent[] = [];
    const off = s.subscribe((e) => events.push(e));
    off();
    await s.remove('docs');
    expect(events).toEqual([]);
  });
  it('reset restores sessions and emits session.updated for each', async () => {
    const s = new DemoSource(1_000_000);
    await s.remove('docs');
    const events: ServerEvent[] = [];
    s.subscribe((e) => events.push(e));
    s.reset();
    expect(s.list()).toHaveLength(6);
    expect(events).toHaveLength(6);
    expect(events.some((e) => e.type === 'session.updated' && e.session.id === 'docs')).toBe(true);
  });
});
