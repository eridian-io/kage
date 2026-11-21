import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, linesById, select, selectedId, sessions, streamId } from './store.ts';
import { installView, sendView } from './view.ts';

const posts = vi.hoisted(() => [] as [string, unknown][]);
/** The signal each post was given. */
const signals = vi.hoisted(() => [] as (AbortSignal | undefined)[]);
/**
 * While `held`, posts stay pending until their resolver in `pending` is called (or their signal
 * aborts). `statuses` gives the status of the next unheld posts (default 204).
 */
const gate = vi.hoisted(() => ({
  held: false,
  pending: [] as ((ok: boolean) => void)[],
  statuses: [] as number[],
}));
vi.mock('./api.ts', () => ({
  apiPost: (path: string, body: unknown, init?: { signal?: AbortSignal }) => {
    posts.push([path, body]);
    signals.push(init?.signal);
    if (!gate.held) {
      return Promise.resolve(new Response(null, { status: gate.statuses.shift() ?? 204 }));
    }
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
      gate.pending.push((ok) =>
        ok ? resolve(new Response(null, { status: 204 })) : reject(new Error('offline')),
      );
    });
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

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let stop: () => void;
beforeEach(async () => {
  // Settle whatever the previous test left in flight, then start clean.
  gate.held = false;
  for (const r of gate.pending.splice(0)) r(true);
  await flush();
  posts.length = 0;
  signals.length = 0;
  gate.statuses = [];
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
  it('posts again on a selection change', async () => {
    snap('s1', ['a', 'b']);
    await flush();
    const n = posts.length;
    const other = selectedId.value === 'a' ? 'b' : 'a';
    select(other);
    await flush();
    expect(posts).toHaveLength(n + 1);
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's1', id: other });
  });
  it('posts with the new stream id after a reconnect', async () => {
    snap('s1', ['a']);
    await flush();
    snap('s2', ['a']);
    await flush();
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's2', id: 'a' });
  });

  it('latest wins: quick selection changes leave the server on the newest one', async () => {
    gate.held = true;
    snap('s1', ['a', 'b', 'c']);
    expect(posts).toHaveLength(1);
    select('b');
    select('c');
    select('a');
    select('c');
    // One view post at a time, so the server can't apply an older one after a newer one.
    expect(posts).toHaveLength(1);
    gate.pending.shift()?.(true);
    await flush();
    // The queued changes collapse into the newest.
    expect(posts).toHaveLength(2);
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's1', id: 'c' });
    gate.pending.shift()?.(true);
    await flush();
    expect(posts).toHaveLength(2);
  });

  it('latest wins after a failed post too', async () => {
    gate.held = true;
    snap('s1', ['a', 'b']);
    select('b');
    gate.pending.shift()?.(false);
    await flush();
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's1', id: 'b' });
    gate.pending.shift()?.(true);
    await flush();
    select('a');
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's1', id: 'a' });
  });

  it('a reconnect while a post is in flight sends the new stream next', async () => {
    gate.held = true;
    snap('s1', ['a']);
    snap('s2', ['a']);
    gate.pending.shift()?.(true);
    await flush();
    expect(posts.map((p) => p[1])).toEqual([
      { streamId: 's1', id: 'a' },
      { streamId: 's2', id: 'a' },
    ]);
  });
});

describe('view posts: timeout and retry', () => {
  it('every post carries a 5 s timeout signal', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    snap('s1', ['a']);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(signals.at(-1)).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('a post answered not ok is retried once, then left', async () => {
    gate.statuses = [503, 503];
    snap('s1', ['a']);
    await flush();
    expect(posts.map((p) => p[1])).toEqual([
      { streamId: 's1', id: 'a' },
      { streamId: 's1', id: 'a' },
    ]);
    await flush();
    expect(posts).toHaveLength(2);
  });

  it('a hung post times out and the newer view goes next, not the retry', async () => {
    const ac = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal);
    gate.held = true;
    snap('s1', ['a', 'b']);
    select('b');
    expect(posts).toHaveLength(1);
    ac.abort(); // the 5 s timeout
    await flush();
    expect(posts.map((p) => p[1])).toEqual([
      { streamId: 's1', id: 'a' },
      { streamId: 's1', id: 'b' },
    ]);
    timeout.mockRestore();
  });
});

describe('sendView', () => {
  it('posts the values it is given, not the signals', async () => {
    stop();
    await flush();
    posts.length = 0;
    streamId.value = 'other';
    selectedId.value = 'zzz';
    sendView('s9', 'q');
    await flush();
    expect(posts.at(-1)?.[1]).toEqual({ streamId: 's9', id: 'q' });
    stop = installView();
  });
});
