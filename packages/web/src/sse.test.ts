import { demoSessions } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from './sse.ts';
import {
  archivedCount,
  authRequired,
  connection,
  hadSnapshot,
  host,
  selectedId,
  sessions,
} from './store.ts';

type Listener = (e: MessageEvent) => void;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    const e = new MessageEvent(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  fail(): void {
    const e = new Event('error');
    this.onerror?.(e);
    for (const fn of this.listeners.get('error') ?? []) fn(e as MessageEvent);
  }
}

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const latest = () => FakeEventSource.all.at(-1) as FakeEventSource;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  host.value = '';
  hadSnapshot.value = false;
  sessions.value = [];
  selectedId.value = null;
  connection.value = 'connecting';
  authRequired.value = false;
  authStatus = 204;
  authCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      authCalls.push(url);
      return new Response(null, { status: authStatus });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  authRequired.value = false;
});

/** What GET /api/auth answers, and the URLs fetched. */
let authStatus = 204;
let authCalls: string[] = [];

describe('connect: sign-in (B13)', () => {
  it('on a stream error asks GET /api/auth; a 401 sets authRequired and stops retrying', async () => {
    authStatus = 401;
    const stop = connect('/api/events', { retryMs: 100 });
    latest().fail();
    expect(authCalls).toEqual(['/api/auth']);
    await vi.advanceTimersByTimeAsync(0);
    expect(authRequired.value).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(authCalls).toEqual(['/api/auth']);
    stop();
  });

  it('a 401 that arrives after the stream was stopped changes nothing', async () => {
    authStatus = 401;
    const stop = connect('/api/events', { retryMs: 100 });
    latest().fail();
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(authRequired.value).toBe(false);
    // Likewise for a stream replaced by a new connect (signing in calls connect again).
    connect('/api/events', { retryMs: 100 });
    latest().fail();
    const again = connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(authRequired.value).toBe(false);
    again();
  });

  it('a 204 retries as before', async () => {
    const stop = connect('/api/events', { retryMs: 100 });
    latest().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(authCalls).toEqual(['/api/auth']);
    expect(authRequired.value).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.all).toHaveLength(2);
    stop();
  });

  it('a failed auth check retries as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    const stop = connect('/api/events', { retryMs: 100 });
    latest().fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(authRequired.value).toBe(false);
    expect(FakeEventSource.all).toHaveLength(2);
    stop();
  });

  it('a new connect replaces the old stream: one stream at a time', () => {
    connect();
    const first = latest();
    const stop = connect();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(latest().closed).toBe(false);
    stop();
  });
});

describe('connect', () => {
  it('opens /api/events and goes live on the first snapshot', () => {
    const stop = connect();
    expect(FakeEventSource.all).toHaveLength(1);
    expect(latest().url).toBe('/api/events');
    expect(connection.value).toBe('connecting');
    latest().emit('snapshot', {
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      sessions: demoSessions(NOW),
    });
    expect(connection.value).toBe('live');
    expect(host.value).toBe('my-pc');
    expect(sessions.value).toHaveLength(6);
    latest().emit('session.removed', { type: 'session.removed', id: 'docs' });
    expect(sessions.value.map((s) => s.id)).not.toContain('docs');
    stop();
  });

  it('listens for session.ports and session.files', () => {
    const stop = connect();
    latest().emit('snapshot', {
      type: 'snapshot',
      host: 'h',
      streamId: 's',
      projectsRoot: '/p',
      sessions: demoSessions(NOW),
    });
    const ports = [{ port: 8080, process: 'node', localOnly: true }];
    latest().emit('session.ports', { type: 'session.ports', id: 'docs', ports });
    latest().emit('session.files', {
      type: 'session.files',
      id: 'docs',
      files: [],
      filesTotal: 7,
    });
    const docs = sessions.value.find((s) => s.id === 'docs');
    expect(docs?.ports).toEqual(ports);
    expect(docs).toMatchObject({ files: [], filesTotal: 7 });
    stop();
  });

  it('review focus 4: reconnects after an error and replaces the sessions on the next snapshot', () => {
    const stop = connect('/api/events', { retryMs: 250 });
    const first = latest();
    first.emit('snapshot', {
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      sessions: demoSessions(NOW),
    });
    expect(connection.value).toBe('live');

    first.fail();
    expect(connection.value).toBe('reconnecting');
    expect(first.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(connection.value).toBe('reconnecting');

    // A second failure before any snapshot keeps retrying, after twice the wait.
    latest().fail();
    vi.advanceTimersByTime(499);
    expect(FakeEventSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(3);

    const fresh = demoSessions(NOW).slice(0, 2);
    latest().emit('snapshot', {
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      sessions: fresh,
    });
    expect(connection.value).toBe('live');
    expect(sessions.value.map((s) => s.id)).toEqual(['web', 'shop']);
    stop();
  });

  it('defaults to a one-second retry', () => {
    const stop = connect();
    latest().fail();
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);
    stop();
  });

  it('backs off 1 s, doubling to a 10 s cap, and resets to 1 s after a snapshot', () => {
    const stop = connect();
    const waitFor = (ms: number) => {
      const n = FakeEventSource.all.length;
      latest().fail();
      vi.advanceTimersByTime(ms - 1);
      expect(FakeEventSource.all).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.all).toHaveLength(n + 1);
    };
    for (const ms of [1000, 2000, 4000, 8000, 10_000, 10_000]) waitFor(ms);
    latest().emit('snapshot', {
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      sessions: demoSessions(NOW),
    });
    expect(connection.value).toBe('live');
    waitFor(1000);
    waitFor(2000);
    stop();
  });

  it('stops: closes the stream and cancels a pending retry', () => {
    const stop = connect('/api/events', { retryMs: 100 });
    latest().fail();
    stop();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.all).toHaveLength(1);
    const again = connect();
    stop();
    again();
    expect(latest().closed).toBe(true);
  });

  it('ignores a malformed frame', () => {
    const stop = connect();
    latest().emit('snapshot', '{not json');
    expect(connection.value).toBe('connecting');
    expect(sessions.value).toEqual([]);
    stop();
  });
});

describe('the archive event', () => {
  it('is listened for and sets archivedCount', () => {
    archivedCount.value = 0;
    connect();
    latest().emit('archive', { type: 'archive', count: 7 });
    expect(archivedCount.value).toBe(7);
  });
});

describe('the kage:board mark (spec §7, time to a usable board)', () => {
  const snapshot = {
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    sessions: demoSessions(NOW),
  };

  it('marks kage:board once, in the frame after the first snapshot; never after a reconnect snapshot', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const mark = vi.spyOn(performance, 'mark');
    const stop = connect('/api/events', { retryMs: 100 });
    latest().emit('snapshot', snapshot);
    // Not before the frame: the board has been applied, not yet painted.
    expect(mark).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    for (const cb of frames.splice(0)) cb(0);
    expect(mark.mock.calls).toEqual([['kage:board']]);

    // A reconnect's snapshot is not a first board.
    latest().fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.all).toHaveLength(2);
    latest().emit('snapshot', snapshot);
    expect(frames).toHaveLength(0);
    expect(mark).toHaveBeenCalledTimes(1);
    stop();
    mark.mockRestore();
  });
});
