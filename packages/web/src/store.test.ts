import { type DisplayLine, demoSessions, type Session } from '@kage/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, lineKeyBase, linesById, projectsRoot, sessions, streamId } from './store.ts';

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
  it('a snapshot also forgets the line counts of absent sessions, and keeps the others', () => {
    applyEvent({ type: 'session.lines', id: 'a', lines: [line(1), line(2)], reset: true });
    applyEvent({ type: 'session.lines', id: 'b', lines: [line(3)], reset: true });
    const a = lineKeyBase('a', 0);
    expect(lineKeyBase('b', 0)).toBeGreaterThan(0);
    applyEvent({
      type: 'snapshot',
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [{ ...demoSessions(1)[0], id: 'a' } as Session],
    });
    expect(lineKeyBase('a', 0)).toBe(a);
    expect(lineKeyBase('b', 0)).toBe(0);
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

describe('protocol v3 store', () => {
  const seed = () =>
    applyEvent({
      type: 'snapshot',
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [{ ...(demoSessions(1)[0] as Session), id: 'a', filesTotal: 1 }],
    });
  it('session.ports replaces that session’s ports only', () => {
    seed();
    const ports = [{ port: 5173, process: 'vite', localOnly: false }];
    applyEvent({ type: 'session.ports', id: 'a', ports });
    expect(sessions.value[0]?.ports).toEqual(ports);
  });
  it('session.files replaces files and filesTotal', () => {
    seed();
    const files = [{ path: 'x.ts', added: 2, removed: 1 }];
    applyEvent({ type: 'session.files', id: 'a', files, filesTotal: 250 });
    expect(sessions.value[0]).toMatchObject({ files, filesTotal: 250 });
  });
  it('both are ignored for an unknown id', () => {
    seed();
    const before = sessions.value;
    applyEvent({ type: 'session.ports', id: 'zzz', ports: [] });
    applyEvent({ type: 'session.files', id: 'zzz', files: [], filesTotal: 0 });
    expect(sessions.value).toBe(before);
  });
  it('session.updated and a snapshot keep ports, files and filesTotal from their own events', () => {
    seed();
    const ports = [{ port: 5173, process: 'vite', localOnly: false }];
    const files = [{ path: 'x.ts', added: 2, removed: 1 }];
    applyEvent({ type: 'session.ports', id: 'a', ports });
    applyEvent({ type: 'session.files', id: 'a', files, filesTotal: 250 });
    const bare = { ...(sessions.value[0] as Session), ports: [], files: [], filesTotal: 0 };
    applyEvent({ type: 'session.updated', session: { ...bare, status: 'done' } });
    expect(sessions.value[0]).toMatchObject({ status: 'done', ports, files, filesTotal: 250 });
    applyEvent({
      type: 'snapshot',
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [bare],
    });
    expect(sessions.value[0]).toMatchObject({ ports, files, filesTotal: 250 });
  });
  it('session.removed drops ports and files with the session', () => {
    seed();
    applyEvent({ type: 'session.ports', id: 'a', ports: [] });
    applyEvent({ type: 'session.removed', id: 'a' });
    applyEvent({ type: 'session.files', id: 'a', files: [], filesTotal: 5 });
    expect(sessions.value).toEqual([]);
  });
});
