import { type DisplayLine, demoSessions, type Session } from '@kage/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, linesById, projectsRoot, streamId } from './store.ts';

const line = (n: number): DisplayLine => ({ kind: 'out', text: `line ${n}` });
const snap = () =>
  applyEvent({ type: 'snapshot', host: 'h', streamId: 's1', projectsRoot: '/p', sessions: [] });

beforeEach(() => {
  linesById.value = new Map();
  streamId.value = null;
  snap();
});

describe('protocol v2 store', () => {
  it('a snapshot stores streamId and projectsRoot', () => {
    expect(streamId.value).toBe('s1');
    expect(projectsRoot.value).toBe('/p');
  });
  it('reset replaces the lines, otherwise they append', () => {
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(1), line(2)], reset: true });
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(3)], reset: false });
    expect(linesById.value.get('a')?.map((l) => l.text)).toEqual(['line 1', 'line 2', 'line 3']);
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(9)], reset: true });
    expect(linesById.value.get('a')?.map((l) => l.text)).toEqual(['line 9']);
  });
  it('keeps the newest 500 lines', () => {
    const many = Array.from({ length: 520 }, (_, i) => line(i));
    applyEvent({ type: 'session.lines', id: 'a', lines: many, reset: true });
    const got = linesById.value.get('a') ?? [];
    expect(got).toHaveLength(500);
    expect(got[0]?.text).toBe('line 20');
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(900)], reset: false });
    expect(linesById.value.get('a')).toHaveLength(500);
    expect(linesById.value.get('a')?.at(-1)?.text).toBe('line 900');
  });
  it('a snapshot of the same stream prunes lines of absent sessions', () => {
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(1)], reset: true });
    applyEvent({ type: 'session.lines', id: 'b', lines: [line(2)], reset: true });
    applyEvent({
      type: 'snapshot',
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [{ ...demoSessions(1)[0], id: 'a' } as Session],
    });
    expect([...linesById.value.keys()]).toEqual(['a']);
  });
  it('a snapshot of a new stream clears all lines', () => {
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(1)], reset: true });
    applyEvent({ type: 'snapshot', host: 'h', streamId: 's2', projectsRoot: '/p', sessions: [] });
    expect(linesById.value.size).toBe(0);
  });
  it('session.removed drops the lines of that id', () => {
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(1)], reset: true });
    applyEvent({ type: 'session.removed', id: 'a' });
    expect(linesById.value.has('a')).toBe(false);
  });
});
