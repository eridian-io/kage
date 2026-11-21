import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, linesById, select, selectedId, sessions, streamId } from './store.ts';
import { installView } from './view.ts';

const posts = vi.hoisted(() => [] as [string, unknown][]);
vi.mock('./api.ts', () => ({
  apiPost: (path: string, body: unknown) => {
    posts.push([path, body]);
    return Promise.resolve(new Response(null, { status: 204 }));
  },
  apiDelete: () => Promise.resolve(new Response(null, { status: 204 })),
}));

const snap = (id: string, ids: string[]) =>
  applyEvent({
    type: 'snapshot',
    host: 'h',
    streamId: id,
    projectsRoot: '/p',
    sessions: ids.map((i) => ({
      id: i,
      project: i,
      task: 't',
      state: 'running',
      activity: '',
      updatedAt: 1,
      lines: [],
    })) as never,
  });

let stop: () => void;
beforeEach(() => {
  posts.length = 0;
  sessions.value = [];
  selectedId.value = null;
  streamId.value = null;
  linesById.value = new Map();
  stop = installView();
});
afterEach(() => stop());

describe('view posting', () => {
  it('posts the selected session after a snapshot', () => {
    snap('s1', ['a', 'b']);
    const last = posts.at(-1);
    expect(last?.[0]).toBe('/api/view');
    expect(last?.[1]).toEqual({ streamId: 's1', id: selectedId.value });
    expect(selectedId.value).not.toBeNull();
  });
  it('posts again on a selection change', () => {
    snap('s1', ['a', 'b']);
    const n = posts.length;
    const other = selectedId.value === 'a' ? 'b' : 'a';
    select(other);
    expect(posts).toHaveLength(n + 1);
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's1', id: other });
  });
  it('posts with the new stream id after a reconnect', () => {
    snap('s1', ['a']);
    snap('s2', ['a']);
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's2', id: 'a' });
  });
});
