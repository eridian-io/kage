import { demoSessions } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { DemoSource } from './demo-source.ts';
import { NotFoundError, type SourceEvent } from './source.ts';

describe('DemoSource', () => {
  it('a view brings the viewed session its files, as in live mode (the board then knows its counts)', () => {
    const s = new DemoSource(1_000_000);
    const events: SourceEvent[] = [];
    s.subscribe((e) => events.push(e));
    const docs = s.get('docs');
    s.setViewed(new Set(['docs']));
    expect(events).toEqual([
      { type: 'session.files', id: 'docs', files: docs?.files, filesTotal: docs?.filesTotal },
    ]);
    // Still viewed: nothing new until another stream views it too (refreshView).
    s.setViewed(new Set(['docs', 'nope']));
    expect(events).toHaveLength(1);
    s.refreshView('docs');
    expect(events).toHaveLength(2);
    s.setViewed(new Set());
    s.setViewed(new Set(['docs']));
    expect(events).toHaveLength(3);
  });
  it('lists six sessions', () => {
    expect(new DemoSource(1_000_000).list()).toHaveLength(6);
  });
  it('remove emits session.removed and drops the session', async () => {
    const s = new DemoSource(1_000_000);
    const events: SourceEvent[] = [];
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
    const events: SourceEvent[] = [];
    const off = s.subscribe((e) => events.push(e));
    off();
    await s.remove('docs');
    expect(events).toEqual([]);
  });
  it('reset restores sessions and emits session.updated for each', async () => {
    const s = new DemoSource(1_000_000);
    await s.remove('docs');
    const events: SourceEvent[] = [];
    s.subscribe((e) => events.push(e));
    s.reset();
    expect(s.list()).toHaveLength(6);
    expect(events).toHaveLength(6);
    expect(events.some((e) => e.type === 'session.updated' && e.session.id === 'docs')).toBe(true);
  });
});

describe('DemoSource lines', () => {
  it('list and get carry no lines', () => {
    const s = new DemoSource(1_000_000);
    expect(s.list().every((x) => x.lines.length === 0)).toBe(true);
    expect(s.get('shop')?.lines).toEqual([]);
  });
  it('lines(id) returns the demo transcript', () => {
    const s = new DemoSource(1_000_000);
    const shop = demoSessions(1_000_000).find((x) => x.id === 'shop');
    expect(s.lines('shop')).toHaveLength(9);
    expect(s.lines('shop')).toEqual(shop?.lines);
    expect(s.lines('nope')).toEqual([]);
  });
  it('reset still restores the transcripts', async () => {
    const s = new DemoSource(1_000_000);
    await s.remove('shop');
    expect(s.lines('shop')).toEqual([]);
    s.reset();
    expect(s.lines('shop')).toHaveLength(9);
  });
});
