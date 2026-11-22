import type { Session, SessionStatus } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceEvent } from '../source.ts';
import { boardLink, NOTIFY_DEFAULTS, Notifier, type NotifierOptions, pingFor } from './notifier.ts';
import type { Ping } from './ntfy.ts';

/** RIGHT-TO-LEFT OVERRIDE, kept out of the source as a literal. */
const RLO = String.fromCodePoint(0x202e);
const LINK_HOST = 'box.tail1.ts.net';

function session(id: string, status: SessionStatus, over: Partial<Session> = {}): Session {
  return {
    id,
    status,
    project: 'demo',
    task: 'Fix the login form',
    branch: 'kage/fix-login',
    worktree: '~/projects/demo/.worktrees/fix-login',
    startedAt: 0,
    statusSince: 0,
    pinned: false,
    archived: false,
    external: false,
    unpushed: 0,
    uncommitted: 0,
    ignored: 0,
    lines: [],
    ports: [],
    files: [],
    filesTotal: 0,
    ...over,
  };
}

/** A source with `list()` and `subscribe()`; `emit` plays an event to the subscriber. */
class FakeSource {
  sessions: Session[] = [];
  listener: ((e: SourceEvent) => void) | null = null;
  list(): Session[] {
    return this.sessions;
  }
  subscribe(fn: (e: SourceEvent) => void): () => void {
    this.listener = fn;
    return () => {
      this.listener = null;
    };
  }
  set(id: string, status: SessionStatus, over: Partial<Session> = {}): void {
    this.listener?.({ type: 'session.updated', session: session(id, status, over) });
  }
  remove(id: string): void {
    this.listener?.({ type: 'session.removed', id });
  }
}

interface Sent {
  ping: Ping;
  stillWanted: () => boolean;
}

let source: FakeSource;
let sent: Sent[];
let logs: string[];
let notifier: Notifier;

function start(options: Partial<NotifierOptions> = {}, seed: Session[] = []): Notifier {
  source.sessions = seed;
  notifier = new Notifier({
    source,
    send: async (ping, stillWanted) => {
      sent.push({ ping, stillWanted });
      return true;
    },
    link: (id) => boardLink(LINK_HOST, 8080, id),
    hostName: 'box',
    options: { ...NOTIFY_DEFAULTS, ...options },
    log: (line) => logs.push(line),
  });
  notifier.start();
  return notifier;
}

const at = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  source = new FakeSource();
  sent = [];
  logs = [];
});
afterEach(() => {
  notifier?.stop();
  vi.useRealTimers();
});

describe('Notifier: needs you', () => {
  it('running → needs-you → 3 s → one ping with exactly the plan’s content', () => {
    start();
    source.set('s1', 'running');
    source.set('s1', 'needs-you');
    at(2999);
    expect(sent).toHaveLength(0);
    at(1);
    expect(sent.map((s) => s.ping)).toEqual([
      {
        title: 'demo needs you',
        message: 'Fix the login form',
        priority: 4,
        click: 'http://box.tail1.ts.net:8080/#s=s1',
      },
    ]);
  });

  it('a prompt answered within the hold (needs-you → running at 2 s) sends nothing', () => {
    start();
    source.set('s1', 'running');
    source.set('s1', 'needs-you');
    at(2000);
    source.set('s1', 'running');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('a change and back within the hold is a new episode: the first hold sends nothing', () => {
    start();
    source.set('s1', 'needs-you');
    at(1000);
    source.set('s1', 'running');
    source.set('s1', 'needs-you');
    at(2000); // the first hold would have ended here
    expect(sent).toHaveLength(0);
    at(1000);
    expect(sent).toHaveLength(1);
  });

  it('updates inside one episode (a new now line) neither restart nor repeat the hold', () => {
    start();
    source.set('s1', 'needs-you');
    at(2000);
    source.set('s1', 'needs-you', { now: 'Waiting' });
    at(1000);
    expect(sent).toHaveLength(1);
    source.set('s1', 'needs-you', { now: 'Still waiting' });
    at(10_000);
    expect(sent).toHaveLength(1);
  });

  it('one ping per episode, then 120 s quiet per session', () => {
    start();
    source.set('s1', 'needs-you');
    at(3000); // ping at 3 s
    source.set('s1', 'running');
    at(5000);
    source.set('s1', 'needs-you'); // a new prompt 5 s later
    at(3000);
    expect(sent).toHaveLength(1);
    source.set('s1', 'running');
    at(3000 + 121_000 - 11_000);
    source.set('s1', 'needs-you'); // the same, 121 s after the first ping
    at(3000);
    expect(sent).toHaveLength(2);
  });

  it('the quiet period is per session', () => {
    start();
    source.set('s1', 'needs-you');
    source.set('s2', 'needs-you');
    at(3000);
    expect(sent).toHaveLength(2);
  });

  it('a session already waiting at start() is never pinged for that episode', () => {
    start({}, [session('s1', 'needs-you')]);
    at(10_000);
    source.set('s1', 'needs-you', { now: 'still' });
    at(10_000);
    expect(sent).toHaveLength(0);
    // Its next prompt is a new episode.
    source.set('s1', 'running');
    source.set('s1', 'needs-you');
    at(3000);
    expect(sent).toHaveLength(1);
  });

  it('a first sighting after start in needs-you is pinged after the hold', () => {
    start();
    source.set('s9', 'needs-you');
    at(3000);
    expect(sent).toHaveLength(1);
  });

  it('stillWanted turns false once the session leaves needs-you, and on removal', () => {
    start();
    source.set('s1', 'needs-you');
    source.set('s2', 'needs-you');
    at(3000);
    const [one, two] = sent;
    expect(one?.stillWanted()).toBe(true);
    expect(two?.stillWanted()).toBe(true);
    source.set('s1', 'running');
    expect(one?.stillWanted()).toBe(false);
    source.set('s1', 'needs-you'); // a new episode: the old ping's retries stay unwanted
    expect(one?.stillWanted()).toBe(false);
    source.remove('s2');
    expect(two?.stillWanted()).toBe(false);
  });

  it('session.removed during the hold sends nothing', () => {
    start();
    source.set('s1', 'needs-you');
    at(1000);
    source.remove('s1');
    at(5000);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('20 sessions waiting at once → 10 pings and one "skipped 10" line', () => {
    start();
    for (let i = 0; i < 20; i++) source.set(`s${i}`, 'needs-you');
    at(3000);
    expect(sent).toHaveLength(10);
    expect(logs).toEqual([]);
    at(NOTIFY_DEFAULTS.windowMs);
    expect(logs).toEqual(['ntfy: too many pings; skipped 10.']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the window slides: once the oldest ping is 10 minutes old, pings go again', () => {
    start({ quietMs: 0 });
    for (let i = 0; i < 10; i++) {
      source.set(`s${i}`, 'needs-you');
      at(3000);
    }
    expect(sent).toHaveLength(10);
    source.set('late', 'needs-you');
    at(3000); // 33 s: the window is full
    expect(sent).toHaveLength(10);
    at(600_000 - 33_000 + 3000); // the first ping (3 s) left the window
    source.set('later', 'needs-you');
    at(3000);
    expect(sent).toHaveLength(11);
    expect(logs).toEqual(['ntfy: too many pings; skipped 1.']);
  });

  it('an external session gets the fixed text only: no project, task or window name (F3b)', () => {
    start();
    source.set('w7', 'needs-you', { external: true, project: 'prod-db', task: 'ssh prod-db' });
    at(3000);
    expect(sent.map((s) => s.ping)).toEqual([
      {
        title: 'Claude needs you',
        message: 'A Claude session needs you on box',
        priority: 4,
        click: 'http://box.tail1.ts.net:8080/#s=w7',
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('prod-db');
  });
});

describe('Notifier: done (ntfyOnDone)', () => {
  it('done after 61 s running → one ping "demo is done", priority 3', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(61_000);
    source.set('s1', 'done');
    at(3000);
    expect(sent.map((s) => s.ping)).toEqual([
      {
        title: 'demo is done',
        message: 'Fix the login form',
        priority: 3,
        click: 'http://box.tail1.ts.net:8080/#s=s1',
      },
    ]);
  });

  it('done after only 30 s running → none', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(30_000);
    source.set('s1', 'done');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('active time counts from the last done: two short runs are not added up', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(40_000);
    source.set('s1', 'done');
    at(100_000);
    source.set('s1', 'running');
    at(40_000);
    source.set('s1', 'done');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('running through a prompt counts as active (needs-you → done)', () => {
    start({ onDone: true, quietMs: 0 });
    source.set('s1', 'running');
    at(30_000);
    source.set('s1', 'needs-you');
    at(31_000);
    source.set('s1', 'done');
    at(3000);
    expect(sent.map((s) => s.ping.title)).toEqual(['demo needs you', 'demo is done']);
  });

  it('a session seen running at start() counts from start', () => {
    start({ onDone: true }, [session('s1', 'running')]);
    at(61_000);
    source.set('s1', 'done');
    at(3000);
    expect(sent).toHaveLength(1);
  });

  it('without onDone → none', () => {
    start();
    source.set('s1', 'running');
    at(61_000);
    source.set('s1', 'done');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('→ ended → none (a stop is the user’s own act, R84)', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(61_000);
    source.set('s1', 'ended');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('done then ended at 2 s → none (F3a)', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(61_000);
    source.set('s1', 'done');
    at(2000);
    source.set('s1', 'ended');
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('stillWanted for a done ping is "still done, same episode": ended drops a retry (F3a)', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(61_000);
    source.set('s1', 'done');
    at(3000);
    const [done] = sent;
    expect(done?.stillWanted()).toBe(true);
    source.set('s1', 'ended');
    expect(done?.stillWanted()).toBe(false);
  });

  it('external sessions get no done ping', () => {
    start({ onDone: true });
    source.set('w1', 'running', { external: true });
    at(61_000);
    source.set('w1', 'done', { external: true });
    at(10_000);
    expect(sent).toHaveLength(0);
  });

  it('the quiet period applies to done after a needs-you ping', () => {
    start({ onDone: true });
    source.set('s1', 'running');
    at(58_000);
    source.set('s1', 'needs-you');
    at(3000); // needs-you ping at 61 s
    source.set('s1', 'done');
    at(3000);
    expect(sent.map((s) => s.ping.title)).toEqual(['demo needs you']);
  });
});

describe('Notifier: timers', () => {
  it('owns no timer once idle, and none after stop()', () => {
    start();
    expect(vi.getTimerCount()).toBe(0);
    source.set('s1', 'needs-you');
    expect(vi.getTimerCount()).toBe(1);
    at(3000);
    expect(vi.getTimerCount()).toBe(0);
    source.set('s1', 'running');
    source.set('s1', 'needs-you');
    source.set('s2', 'needs-you');
    expect(vi.getTimerCount()).toBe(2);
    notifier.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.listener).toBeNull();
    at(10_000);
    expect(sent).toHaveLength(1);
  });

  it('stop() flushes a pending skipped count and clears its timer', () => {
    start();
    for (let i = 0; i < 11; i++) source.set(`s${i}`, 'needs-you');
    at(3000);
    notifier.stop();
    expect(logs).toEqual(['ntfy: too many pings; skipped 1.']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a send that rejects is ignored', async () => {
    source.sessions = [];
    notifier = new Notifier({
      source,
      send: async () => {
        throw new Error('boom');
      },
      link: () => null,
      hostName: 'box',
      options: NOTIFY_DEFAULTS,
      log: (line) => logs.push(line),
    });
    notifier.start();
    source.set('s1', 'needs-you');
    at(3000);
    await Promise.resolve();
    expect(logs).toEqual([]);
  });
});

describe('pingFor and boardLink', () => {
  it('strips escapes and bidi characters and cuts the task to 100 characters ending in …', () => {
    const task = `\x1b[31m${RLO}${'a'.repeat(300)}`;
    const p = pingFor('needs-you', { id: 's1', project: 'demo', task }, null);
    expect(p.message).toHaveLength(100);
    expect(p.message.endsWith('…')).toBe(true);
    expect(p.message).not.toContain('\x1b');
    expect(p.message).not.toContain(RLO);
    expect(p.message.slice(0, 99)).toBe('a'.repeat(99));
  });

  it('never carries the question, a command, the branch or a path', () => {
    const s = session('s1', 'needs-you', {
      question: { text: 'Run export TOKEN=abc?', options: ['Yes', 'No'] },
      now: 'Running export TOKEN=abc',
      branch: 'kage/secret-branch',
      worktree: '/home/me/secret-path',
    });
    const p = pingFor('needs-you', s, 'http://box:8080/#s=s1');
    const text = JSON.stringify(p);
    expect(text).not.toContain('TOKEN');
    expect(text).not.toContain('secret');
  });

  it('done pings are priority 3, needs-you 4; an empty task falls back to the title', () => {
    expect(pingFor('done', { id: 'x', project: 'web', task: 't' }, null)).toEqual({
      title: 'web is done',
      message: 't',
      priority: 3,
      click: null,
    });
    expect(pingFor('needs-you', { id: 'x', project: 'web', task: '' }, null).message).toBe(
      'web needs you',
    );
  });

  it('boardLink encodes the id', () => {
    expect(boardLink('box.tail1.ts.net', 8080, 's1')).toBe('http://box.tail1.ts.net:8080/#s=s1');
    expect(boardLink('[fd7a:115c:a1e0::1]', 9000, 'a b/#')).toBe(
      'http://[fd7a:115c:a1e0::1]:9000/#s=a%20b%2F%23',
    );
  });
});
