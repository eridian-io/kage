import { type DisplayLine, demoSessions, type Session } from '@kage/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEvent,
  archivedCount,
  archiveOpen,
  beginRemoval,
  demo,
  endRemoval,
  lineKeyBase,
  linesById,
  onApplied,
  projectsRoot,
  select,
  selectedId,
  selectStarted,
  selectWhenSeen,
  sessions,
  streamId,
  toast,
} from './store.ts';

const line = (n: number): DisplayLine => ({ kind: 'out', text: `line ${n}` });
const snap = () =>
  applyEvent({
    type: 'snapshot',
    auth: false,
    demo: false,
    host: 'h',
    streamId: 's1',
    projectsRoot: '/p',
    sessions: [],
    archived: 0,
  });

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
  it('a snapshot sets demo, false outside the demo (usability U6)', () => {
    expect(demo.value).toBe(false);
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: true,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [],
      archived: 0,
    });
    expect(demo.value).toBe(true);
    snap();
    expect(demo.value).toBe(false);
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
      auth: false,
      demo: false,
      archived: 0,
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
      auth: false,
      demo: false,
      archived: 0,
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
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      host: 'h',
      streamId: 's2',
      projectsRoot: '/p',
      sessions: [],
      archived: 0,
    });
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
      auth: false,
      demo: false,
      archived: 0,
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
  it('session.files carries a note (M4); a value without one clears it, and session.updated keeps it', () => {
    seed();
    applyEvent({ type: 'session.files', id: 'a', files: [], filesTotal: 0, note: 'Refused.' });
    expect(sessions.value[0]?.filesNote).toBe('Refused.');
    const { filesNote: _held, ...bare } = sessions.value[0] as Session;
    applyEvent({ type: 'session.updated', session: bare });
    expect(sessions.value[0]?.filesNote).toBe('Refused.');
    applyEvent({ type: 'session.files', id: 'a', files: [], filesTotal: 0 });
    expect(sessions.value[0]?.filesNote).toBeUndefined();
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
      auth: false,
      demo: false,
      archived: 0,
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

describe('selecting a started session (Task 9, F5)', () => {
  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
  const fresh = (id: string): Session => ({ ...(demoSessions(NOW)[1] as Session), id });
  beforeEach(() => {
    selectWhenSeen.value = null;
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      archived: 0,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: demoSessions(NOW),
    });
    select('web');
  });

  it('selects at once when the id is already in the store (adopt emits before the 201)', () => {
    applyEvent({ type: 'session.updated', session: fresh('new') });
    expect(selectedId.value).toBe('web');
    selectStarted('new');
    expect(selectedId.value).toBe('new');
    expect(selectWhenSeen.value).toBeNull();
  });

  it('otherwise waits for its session.updated, across keepSelection on other events', () => {
    selectStarted('new');
    expect(selectWhenSeen.value).toBe('new');
    expect(selectedId.value).toBe('web');
    applyEvent({ type: 'session.updated', session: fresh('other') });
    applyEvent({ type: 'session.removed', id: 'web' });
    expect(selectWhenSeen.value).toBe('new');
    applyEvent({ type: 'session.updated', session: fresh('new') });
    expect(selectedId.value).toBe('new');
    expect(selectWhenSeen.value).toBeNull();
  });

  it('a snapshot that brings it selects it too', () => {
    selectStarted('new');
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      archived: 0,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [...demoSessions(NOW), fresh('new')],
    });
    expect(selectedId.value).toBe('new');
  });

  it("the user's own selection meanwhile wins", () => {
    selectStarted('new');
    select('shop');
    applyEvent({ type: 'session.updated', session: fresh('new') });
    expect(selectedId.value).toBe('shop');
  });
});

describe('the archive count', () => {
  it('a snapshot sets it and an archive event changes it', () => {
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: [],
      archived: 5,
    });
    expect(archivedCount.value).toBe(5);
    applyEvent({ type: 'archive', count: 6 });
    expect(archivedCount.value).toBe(6);
  });
});

describe('the heartbeat (reliability I3)', () => {
  it('applyEvent ignores hb', () => {
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: demoSessions(1),
      archived: 2,
    });
    select('shop');
    const before = { s: sessions.value, l: linesById.value, sel: selectedId.value };
    const heard: string[] = [];
    const off = onApplied((e) => heard.push(e.type));
    try {
      applyEvent({ type: 'hb' });
    } finally {
      off();
    }
    expect(sessions.value).toBe(before.s);
    expect(linesById.value).toBe(before.l);
    expect(selectedId.value).toBe(before.sel);
    expect(archivedCount.value).toBe(2);
    expect(heard).toEqual([]);
  });
});

describe('the archived list and the removal toasts (Task 9, F12)', () => {
  const withDemo = () =>
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      host: 'h',
      streamId: 's1',
      projectsRoot: '/p',
      sessions: demoSessions(0),
      archived: 0,
    });
  const docs = () => sessions.value.find((s) => s.id === 'docs') as Session;

  beforeEach(() => {
    toast.value = null;
    archiveOpen.value = false;
    withDemo();
  });

  it('closes the archived list when the count drops to 0', () => {
    applyEvent({ type: 'archive', count: 2 });
    archiveOpen.value = true;
    applyEvent({ type: 'archive', count: 1 });
    expect(archiveOpen.value).toBe(true);
    applyEvent({ type: 'archive', count: 0 });
    expect(archiveOpen.value).toBe(false);
  });

  it('an archive this page asked for toasts as archived, a delete as deleted', () => {
    beginRemoval(docs(), 'archived');
    endRemoval('docs', true);
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(toast.value).toEqual({ kind: 'archived', name: 'docs · update README' });
    const footer = sessions.value.find((s) => s.id === 'footer') as Session;
    beginRemoval(footer, 'deleted');
    applyEvent({ type: 'session.removed', id: 'footer' });
    expect(toast.value).toEqual({ kind: 'deleted', name: 'web · fix footer links' });
  });

  it('a removal nobody here asked for (auto-archive, another tab) shows no toast', () => {
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(toast.value).toBeNull();
  });

  it('a failed request forgets its removal, unless an earlier one succeeded', () => {
    beginRemoval(docs(), 'archived');
    endRemoval('docs', false);
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(toast.value).toBeNull();
    withDemo();
    beginRemoval(docs(), 'deleted');
    endRemoval('docs', true);
    // A second attempt before the removal event arrives fails (the session is going away).
    beginRemoval(docs(), 'deleted');
    endRemoval('docs', false);
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(toast.value).toEqual({ kind: 'deleted', name: 'docs · update README' });
  });
});
