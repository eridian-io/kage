import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisplayLine, Question, Session } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookEvent, HookEventName } from './hooks/event.ts';
import {
  type HookServerLike,
  LiveSource,
  NotImplementedError,
  type StateStoreLike,
  type TailLike,
  type TmuxClientLike,
  type TmuxWatcherLike,
} from './live-source.ts';
import type { SourceEvent } from './source.ts';
import type { SessionRecord } from './state/store.ts';
import type { TmuxWindow } from './tmux/format.ts';
import type { WatchEvent } from './tmux/watcher.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../test/fixtures/panes', `${name}.txt`), 'utf8');

const T0 = 1_800_000_000_000;
const ROOT = '/home/dev/projects';
const TRANSCRIPT = '/home/dev/.claude/projects/-home-dev-projects-shop/s-1.jsonl';

// ---------------------------------------------------------------- fakes

class FakeTmux implements TmuxClientLike {
  windows: TmuxWindow[] = [];
  captures = new Map<string, string[]>();
  captureCalls: string[] = [];
  listCalls = 0;
  /** While set, captures wait for it. */
  gate: Promise<void> | null = null;
  async ensureSession(): Promise<void> {}
  async listWindows(): Promise<TmuxWindow[]> {
    this.listCalls++;
    return this.windows.map((w) => ({ ...w }));
  }
  /** Each call takes the next queued capture; the last one repeats. */
  async capturePane(paneId: string): Promise<string> {
    this.captureCalls.push(paneId);
    if (this.gate) await this.gate;
    const q = this.captures.get(paneId);
    if (!q || q.length === 0) return '';
    return (q.length > 1 ? q.shift() : q[0]) as string;
  }
  setCapture(paneId: string, ...texts: string[]): void {
    this.captures.set(paneId, texts);
  }
}

class FakeWatcher implements TmuxWatcherLike {
  fns = new Set<(e: WatchEvent) => void>();
  started = 0;
  stopped = 0;
  on(fn: (e: WatchEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  emit(e: WatchEvent): void {
    for (const fn of [...this.fns]) fn(e);
  }
}

class FakeHooks implements HookServerLike {
  fns = new Set<(e: HookEvent) => void>();
  on(fn: (e: HookEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  fire(e: HookEvent): void {
    for (const fn of [...this.fns]) fn(e);
  }
}

class FakeStore implements StateStoreLike {
  records: SessionRecord[];
  saves: SessionRecord[][] = [];
  /** Save attempts (epoch ms), failed ones included. */
  attempts: number[] = [];
  /** This many saves fail before they succeed again. */
  fail = 0;
  constructor(records: SessionRecord[]) {
    this.records = records;
  }
  async load(): Promise<SessionRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
  async save(records: SessionRecord[]): Promise<void> {
    this.attempts.push(Date.now());
    if (this.fail > 0) {
      this.fail--;
      throw new Error('disk full');
    }
    this.saves.push(records.map((r) => ({ ...r })));
  }
}

interface TailContent {
  lines?: DisplayLine[];
  question?: Question | null;
  now?: string | null;
}

class FakeTail implements TailLike {
  readonly path: string;
  #lines: DisplayLine[];
  #question: Question | null;
  #now: string | null;
  fns = new Set<(added: DisplayLine[], reset: boolean) => void>();
  interruptFns = new Set<() => void>();
  started = false;
  stopped = false;
  constructor(path: string, c: TailContent = {}) {
    this.path = path;
    this.#lines = c.lines ?? [];
    this.#question = c.question ?? null;
    this.#now = c.now ?? null;
  }
  async start(): Promise<void> {
    this.started = true;
    if (this.#lines.length) for (const fn of [...this.fns]) fn(this.#lines.slice(), false);
  }
  stop(): void {
    this.stopped = true;
  }
  lines(): DisplayLine[] {
    return this.#lines.slice();
  }
  question(): Question | null {
    return this.#question;
  }
  now(): string | null {
    return this.#now;
  }
  on(fn: (added: DisplayLine[], reset: boolean) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  onInterrupt(fn: () => void): () => void {
    this.interruptFns.add(fn);
    return () => this.interruptFns.delete(fn);
  }
  /** Appends lines (or starts over) and updates question/now, like a real batch. */
  push(
    added: DisplayLine[],
    c: { reset?: boolean; question?: Question | null; now?: string | null } = {},
  ): void {
    if (c.reset) this.#lines = [];
    this.#lines.push(...added);
    if (c.question !== undefined) this.#question = c.question;
    if (c.now !== undefined) this.#now = c.now;
    for (const fn of [...this.fns]) fn(added, c.reset ?? false);
  }
  interrupt(): void {
    this.#question = null;
    this.#now = null;
    for (const fn of [...this.interruptFns]) fn();
  }
}

// ---------------------------------------------------------------- builders

const win = (over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  windowId: '@1',
  kageId: null,
  paneId: '%1',
  panePid: 100,
  command: 'bash',
  cwd: `${ROOT}/demo`,
  name: 'demo',
  activity: Math.floor(T0 / 1000) - 60,
  ...over,
});

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  kageId: 'k-1',
  windowId: '@2',
  project: 'shop',
  task: 'Fix the cart total',
  branch: 'kage/fix-the-cart-total',
  worktree: `${ROOT}/shop/.worktrees/fix-the-cart-total`,
  createdAt: T0 - 3_600_000,
  pinned: false,
  archived: false,
  sessionId: null,
  transcriptPath: null,
  ...over,
});

const hook = (event: HookEventName, paneId: string, over: Partial<HookEvent> = {}): HookEvent => ({
  event,
  pane: paneId,
  sessionId: 's-1',
  transcriptPath: TRANSCRIPT,
  cwd: `${ROOT}/shop`,
  notification: null,
  message: null,
  toolName:
    event === 'PreToolUse' || event === 'PostToolUse' || event === 'PermissionRequest'
      ? 'Bash'
      : null,
  toolInput: null,
  at: Date.now(),
  ...over,
});

const permissionNote = (paneId: string): HookEvent =>
  hook('Notification', paneId, {
    notification: 'permission',
    message: 'Claude needs your permission',
  });

/** Lets queued promise callbacks run (captures and tail starts are async). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(
  opts: {
    windows?: TmuxWindow[];
    records?: SessionRecord[];
    tails?: Record<string, TailContent>;
  } = {},
) {
  const tmux = new FakeTmux();
  tmux.windows = opts.windows ?? [];
  const watcher = new FakeWatcher();
  const hooks = new FakeHooks();
  const store = new FakeStore(opts.records ?? []);
  const tails: FakeTail[] = [];
  const source = new LiveSource({
    tmux,
    watcher,
    hooks,
    store,
    tail: (path) => {
      const t = new FakeTail(path, opts.tails?.[path]);
      tails.push(t);
      return t;
    },
    projectsRoot: ROOT,
  });
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));
  const updates = (id?: string): Session[] =>
    events.flatMap((e) =>
      e.type === 'session.updated' && (!id || e.session.id === id) ? [e.session] : [],
    );
  const lineEvents = (id: string) =>
    events.flatMap((e) => (e.type === 'session.lines' && e.id === id ? [e] : []));
  return { tmux, watcher, hooks, store, tails, source, events, updates, lineEvents };
}

const kageWin = (over: Partial<TmuxWindow> = {}) =>
  win({
    windowId: '@2',
    kageId: 'k-1',
    paneId: '%2',
    command: 'claude',
    cwd: `${ROOT}/shop/.worktrees/fix-the-cart-total`,
    name: 'fix-the-cart-total',
    ...over,
  });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe('LiveSource: windows and records', () => {
  it('a window without @kage_id is an external session', async () => {
    const { source } = setup({ windows: [win({ cwd: '/srv/work/notes', name: 'scratch' })] });
    await source.start();
    expect(source.list()).toHaveLength(1);
    expect(source.get('ext-@1')).toMatchObject({
      id: 'ext-@1',
      external: true,
      project: 'notes',
      task: 'scratch',
      worktree: '/srv/work/notes',
      status: 'done',
      lines: [],
    });
  });

  it('an external session is running while there was pane activity in the last 5 s, then done', async () => {
    const { source, watcher, updates, events } = setup({ windows: [win()] });
    await source.start();
    expect(source.get('ext-@1')?.status).toBe('done');
    events.length = 0;
    watcher.emit({ type: 'activity', paneId: '%1' });
    expect(source.get('ext-@1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(4000);
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(source.get('ext-@1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2);
    expect(source.get('ext-@1')?.status).toBe('done');
    expect(updates('ext-@1').map((s) => s.status)).toEqual(['running', 'done']);
  });

  it('a window listed with recent activity starts as running', async () => {
    const { source } = setup({ windows: [win({ activity: Math.floor(T0 / 1000) - 1 })] });
    await source.start();
    expect(source.get('ext-@1')?.status).toBe('running');
  });

  it('a window whose @kage_id matches a record shows the record', async () => {
    const { source, store } = setup({ windows: [kageWin({ windowId: '@7' })], records: [rec()] });
    await source.start();
    expect(source.get('k-1')).toMatchObject({
      id: 'k-1',
      external: false,
      project: 'shop',
      task: 'Fix the cart total',
      branch: 'kage/fix-the-cart-total',
      worktree: `${ROOT}/shop/.worktrees/fix-the-cart-total`,
      startedAt: T0 - 3_600_000,
    });
    // tmux reuses window ids: the record follows the kageId and is saved, debounced.
    expect(store.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.saves.at(-1)?.[0]?.windowId).toBe('@7');
  });

  it('a window with an unknown @kage_id is external', async () => {
    const { source } = setup({ windows: [win({ kageId: 'stranger' })], records: [rec()] });
    await source.start();
    expect(source.get('ext-@1')?.external).toBe(true);
  });

  it('a record whose window is gone is ended and keeps its last transcript lines', async () => {
    const lines: DisplayLine[] = [{ kind: 'say', text: 'All tests pass.' }];
    const { source, tails } = setup({
      records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })],
      tails: { [TRANSCRIPT]: { lines } },
    });
    await source.start();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).toEqual(lines);
    // One read, then no tail is left running for an ended session.
    expect(tails).toHaveLength(1);
    expect(tails[0]?.stopped).toBe(true);
  });

  it('archived records are left out of list() but get() finds them', async () => {
    const { source } = setup({ records: [rec({ archived: true })] });
    await source.start();
    expect(source.list()).toEqual([]);
    expect(source.get('k-1')?.archived).toBe(true);
  });

  it('windows-changed re-lists and emits only real changes', async () => {
    const { source, watcher, tmux, events } = setup({ windows: [win()] });
    await source.start();
    events.length = 0;
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(events).toEqual([]);

    tmux.windows.push(win({ windowId: '@4', paneId: '%4', name: 'logs' }));
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.updated',
      session: { id: 'ext-@4', task: 'logs' },
    });

    events.length = 0;
    tmux.windows = tmux.windows.filter((w) => w.windowId !== '@1');
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(events).toEqual([{ type: 'session.removed', id: 'ext-@1' }]);
    expect(source.get('ext-@1')).toBeUndefined();
  });

  it('a renamed window updates the external task', async () => {
    const { source, watcher, tmux, updates } = setup({ windows: [win()] });
    await source.start();
    (tmux.windows[0] as TmuxWindow).name = 'renamed';
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(updates('ext-@1').at(-1)?.task).toBe('renamed');
  });

  it('a Kage window that closes makes the session ended', async () => {
    const { source, watcher, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
  });

  it('watcher down marks Kage sessions ended and drops external ones; up re-lists', async () => {
    const { source, watcher, tmux, events } = setup({
      windows: [win(), kageWin()],
      records: [rec()],
    });
    await source.start();
    events.length = 0;
    watcher.emit({ type: 'down' });
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.get('ext-@1')).toBeUndefined();
    expect(events).toContainEqual({ type: 'session.removed', id: 'ext-@1' });

    const lists = tmux.listCalls;
    watcher.emit({ type: 'up' });
    await flush();
    expect(tmux.listCalls).toBe(lists + 1);
    expect(source.get('ext-@1')).toBeDefined();
    expect(source.get('k-1')?.status).not.toBe('ended');
  });

  it('remove() rejects with NotImplementedError', async () => {
    const { source } = setup({ windows: [win()] });
    await source.start();
    await expect(source.remove('ext-@1')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('LiveSource: hooks and status', () => {
  it('hook events set the status through nextStatus; statusSince follows', async () => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    hooks.fire(hook('PreToolUse', '%2'));
    expect(source.get('k-1')?.statusSince).toBe(T0);
    hooks.fire(hook('Stop', '%2'));
    expect(source.get('k-1')).toMatchObject({ status: 'done', statusSince: T0 + 1000 });
    hooks.fire(hook('SessionEnd', '%2'));
    expect(source.get('k-1')?.status).toBe('ended');
  });

  it('an unchanged session emits no update', async () => {
    const { source, hooks, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    const n = updates('k-1').length;
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    expect(updates('k-1')).toHaveLength(n);
  });

  it('SessionStart links the pane to the session id, starts a tail and saves the record', async () => {
    const { source, hooks, tails, store } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    expect(tails).toHaveLength(0);
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    expect(tails).toHaveLength(1);
    expect(tails[0]?.path).toBe(TRANSCRIPT);
    expect(tails[0]?.started).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.saves.at(-1)?.[0]).toMatchObject({ sessionId: 's-1', transcriptPath: TRANSCRIPT });
    // The same SessionStart again keeps the one tail.
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    expect(tails).toHaveLength(1);
  });

  it('SessionStart with a new session id replaces the tail and resets the lines', async () => {
    const { source, hooks, tails, lineEvents } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([{ kind: 'say', text: 'old' }]);
    hooks.fire(hook('SessionStart', '%2', { sessionId: 's-2', transcriptPath: '/t/s-2.jsonl' }));
    await flush();
    expect(tails).toHaveLength(2);
    expect(tails[0]?.stopped).toBe(true);
    expect(tails[1]?.path).toBe('/t/s-2.jsonl');
    expect(lineEvents('k-1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'k-1',
      lines: [],
      reset: true,
    });
    expect(source.lines('k-1')).toEqual([]);
  });

  it('transcript lines arrive as session.lines and lines(id) returns the tail lines', async () => {
    const { source, hooks, tails, lineEvents } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    const a: DisplayLine[] = [{ kind: 'say', text: 'Looking at the cart.' }];
    const b: DisplayLine[] = [{ kind: 'tool', text: 'Bash', detail: 'npm test' }];
    tails[0]?.push(a);
    tails[0]?.push(b);
    expect(lineEvents('k-1').slice(-2)).toEqual([
      { type: 'session.lines', id: 'k-1', lines: a, reset: false },
      { type: 'session.lines', id: 'k-1', lines: b, reset: false },
    ]);
    expect(source.lines('k-1')).toEqual([...a, ...b]);
    tails[0]?.push([{ kind: 'say', text: 'fresh' }], { reset: true });
    expect(lineEvents('k-1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'k-1',
      lines: [{ kind: 'say', text: 'fresh' }],
      reset: true,
    });
  });

  it('the now line comes from the tail', async () => {
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([{ kind: 'tool', text: 'Bash', detail: 'npm test' }], {
      now: 'Running npm test',
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')?.now).toBe('Running npm test');
  });

  it('PermissionRequest captures the pane and sets the question; leaving needs-you clears it', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(source.get('k-1')).toMatchObject({
      status: 'needs-you',
      question: {
        options: [
          'Yes',
          'Yes, and don’t ask again for: npm test *',
          'Yes, and switch to auto mode',
          'No',
        ],
      },
    });
    expect(source.get('k-1')?.question?.text).toContain('Do you want to proceed?');
    hooks.fire(hook('PostToolUse', '%2'));
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.get('k-1')?.question).toBeUndefined();
  });

  it('a permission Notification counts only while a tool is pending (R12)', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%2'));
    hooks.fire(permissionNote('%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');

    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(permissionNote('%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    expect(source.get('k-1')?.question?.options[0]).toBe('Yes');

    // Answered: PostToolUse clears pending; a late notice must not re-amber it.
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(permissionNote('%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
  });

  it('retries the pane capture once after 300 ms when the prompt is not drawn yet', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    tmux.setCapture('%2', 'still drawing\n', pane('permission-bash'));
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    const before = tmux.captureCalls.length;
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    expect(source.get('k-1')?.question).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    expect(tmux.captureCalls.length).toBe(before + 2);
    expect(source.get('k-1')?.question?.options).toHaveLength(4);
  });

  it('falls back to the transcript question when the pane shows none', async () => {
    const q: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([], { question: q });
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await vi.advanceTimersByTimeAsync(300);
    expect(source.get('k-1')?.question).toEqual(q);
  });

  it('PreToolUse AskUserQuestion sets the question from the hook input', async () => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(
      hook('PreToolUse', '%2', {
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              question: 'Which separator should slug() use?',
              header: 'Separator',
              options: [{ label: 'Dash' }, { label: 'Underscore', description: 'Keep them.' }],
            },
          ],
        },
      }),
    );
    expect(source.get('k-1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Which separator should slug() use?', options: ['Dash', 'Underscore'] },
    });
  });

  it('a transcript question sets the question too', async () => {
    const q: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([], { question: q, now: 'Asking a question' });
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')).toMatchObject({ status: 'needs-you', question: q });
  });

  it('a transcript interrupt makes the session done and clears the question (R11)', async () => {
    const { source, hooks, tmux, tails } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    tails[0]?.interrupt();
    expect(source.get('k-1')?.status).toBe('done');
    expect(source.get('k-1')?.question).toBeUndefined();
    // Pending was cleared too: a late notice is ignored.
    hooks.fire(permissionNote('%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('pane fallback: activity while needs-you with no prompt on screen any more means done (R11)', async () => {
    const { source, hooks, tmux, watcher } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    // Still on screen: stays amber.
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    await vi.advanceTimersByTimeAsync(300);
    tmux.setCapture('%2', pane('after-exit'));
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    expect(source.get('k-1')?.question).toBeUndefined();
  });

  it('SessionEnd stops the tail after a final flush window', async () => {
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    hooks.fire(hook('SessionEnd', '%2'));
    expect(tails[0]?.stopped).toBe(false);
    tails[0]?.push([{ kind: 'say', text: 'last words' }]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(tails[0]?.stopped).toBe(true);
    expect(source.lines('k-1').at(-1)?.text).toBe('last words');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hook for an unknown pane re-lists once, then applies or drops it', async () => {
    const { source, hooks, tmux } = setup({ windows: [], records: [rec()] });
    await source.start();
    const lists = tmux.listCalls;
    tmux.windows = [kageWin({ paneId: '%5' })];
    hooks.fire(hook('SessionStart', '%5'));
    hooks.fire(hook('PreToolUse', '%5'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.listCalls).toBe(lists + 1);
    expect(source.get('k-1')?.status).toBe('running');

    hooks.fire(hook('Stop', '%9'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.listCalls).toBe(lists + 2);
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.list()).toHaveLength(1);
  });
});

describe('LiveSource: pane captures and throttling', () => {
  it('a session without a transcript gets pane lines on activity, throttled, as a reset', async () => {
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', '$ ls\nREADME.md  src\n$ \n');
    await source.start();
    source.setViewed(new Set(['ext-@1']));
    await vi.advanceTimersByTimeAsync(250);
    const start = tmux.captureCalls.length;
    for (let i = 0; i < 20; i++) {
      watcher.emit({ type: 'activity', paneId: '%1' });
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(250);
    const captures = tmux.captureCalls.length - start;
    expect(captures).toBeGreaterThan(0);
    expect(captures).toBeLessThanOrEqual(5); // 1000 ms + trailing at 250 ms each
    expect(lineEvents('ext-@1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'ext-@1',
      lines: [
        { kind: 'out', text: '$ ls' },
        { kind: 'out', text: 'README.md  src' },
        { kind: 'out', text: '$' },
      ],
      reset: true,
    });
    expect(source.lines('ext-@1')).toHaveLength(3);
  });

  it('a Kage session with a transcript is not captured on activity', async () => {
    const { source, hooks, watcher, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    const n = tmux.captureCalls.length;
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tmux.captureCalls.length).toBe(n);
  });

  it('activity produces at most 4 session.updated per second per session', async () => {
    const { source, hooks, tails, watcher, updates } = setup({
      windows: [kageWin()],
      records: [rec()],
    });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    const before = updates('k-1').length;
    for (let i = 0; i < 40; i++) {
      tails[0]?.push([{ kind: 'tool', text: 'Bash', detail: `step ${i}` }], {
        now: `Running step ${i}`,
      });
      watcher.emit({ type: 'activity', paneId: '%2' });
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(updates('k-1').length - before).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')?.now).toBe('Running step 39');
    expect(updates('k-1').at(-1)?.now).toBe('Running step 39');
  });

  it('a hook update is not delayed by the activity throttle', async () => {
    const { source, hooks, tails, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([], { now: 'Running a' });
    hooks.fire(hook('Stop', '%2'));
    expect(updates('k-1').at(-1)?.status).toBe('done');
  });
});

describe('LiveSource: startup screens (R9)', () => {
  const trust =
    ' Accessing workspace:\n\n /home/dev/projects/shop\n\n Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n';

  it('a Kage window with no SessionStart that shows a startup screen needs you', async () => {
    const { source, tmux, watcher } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', trust);
    await source.start();
    expect(source.get('k-1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Trust this folder?', options: ['No, exit', 'Yes, I trust this folder'] },
    });
    tmux.setCapture('%2', ' ▐▛███▛█   Claude Code v2.1.330\n');
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(250); // the capture throttle's trailing edge
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.get('k-1')?.question).toBeUndefined();
  });

  it('an external claude window shows the login screen as needs-you', async () => {
    const { source, tmux } = setup({ windows: [win({ command: 'claude' })] });
    tmux.setCapture(
      '%1',
      ' Select login method:\n\n ❯ 1. Claude account\n   2. Anthropic Console\n',
    );
    await source.start();
    expect(source.get('ext-@1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Sign in to Claude Code in the terminal', options: [] },
    });
  });

  it('an external shell window is not checked for startup screens', async () => {
    const { source, tmux } = setup({ windows: [win({ command: 'bash' })] });
    tmux.setCapture(
      '%1',
      ' Select login method:\n\n ❯ 1. Claude account\n   2. Anthropic Console\n',
    );
    await source.start();
    expect(source.get('ext-@1')?.status).toBe('done');
  });
});

describe('LiveSource: restart (review focus 1)', () => {
  const linked = () => rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT });

  it('rebuilds needs-you from the transcript question', async () => {
    const q: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
    const { source, tails } = setup({
      windows: [kageWin()],
      records: [linked()],
      tails: { [TRANSCRIPT]: { question: q, now: 'Asking a question' } },
    });
    await source.start();
    expect(tails[0]?.stopped).toBe(false);
    expect(source.get('k-1')).toMatchObject({ status: 'needs-you', question: q });
  });

  it('rebuilds running from a turn in progress (a now line)', async () => {
    const { source } = setup({
      windows: [kageWin()],
      records: [linked()],
      tails: {
        [TRANSCRIPT]: {
          now: 'Running npm test',
          lines: [{ kind: 'tool', text: 'Bash', detail: 'npm test' }],
        },
      },
    });
    await source.start();
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Running npm test' });
    expect(source.lines('k-1')).toHaveLength(1);
  });

  it('rebuilds running from recent pane activity, and done otherwise', async () => {
    const recent = setup({
      windows: [kageWin({ activity: Math.floor(T0 / 1000) - 2 })],
      records: [linked()],
    });
    await recent.source.start();
    expect(recent.source.get('k-1')?.status).toBe('running');

    const quiet = setup({ windows: [kageWin()], records: [linked()] });
    await quiet.source.start();
    expect(quiet.source.get('k-1')?.status).toBe('done');
  });

  it('rebuilds needs-you from a permission prompt on screen', async () => {
    const { source, tmux } = setup({ windows: [kageWin()], records: [linked()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    expect(source.get('k-1')?.status).toBe('needs-you');
    expect(source.get('k-1')?.question?.options[0]).toBe('Yes');
  });

  it('later hooks take over from the rebuilt status', async () => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [linked()] });
    await source.start();
    hooks.fire(hook('PreToolUse', '%2'));
    expect(source.get('k-1')?.status).toBe('running');
  });
});

describe('LiveSource: lifecycle', () => {
  it('leaves no timers when nothing changes', async () => {
    const { source } = setup({
      windows: [win(), kageWin()],
      records: [rec(), rec({ kageId: 'k-2', windowId: null })],
    });
    await source.start();
    await vi.advanceTimersByTimeAsync(1000); // the debounced windowId save
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the watcher; stop() stops it and the tails, flushes the save and unsubscribes', async () => {
    const { source, hooks, watcher, tails, store, updates } = setup({
      windows: [kageWin()],
      records: [rec()],
    });
    await source.start();
    expect(watcher.started).toBe(1);
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    await source.stop();
    expect(watcher.stopped).toBe(1);
    expect(tails[0]?.stopped).toBe(true);
    expect(store.saves.at(-1)?.[0]?.sessionId).toBe('s-1');
    expect(vi.getTimerCount()).toBe(0);
    const n = updates().length;
    hooks.fire(hook('Stop', '%2'));
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(updates().length).toBe(n);
    expect(hooks.fns.size).toBe(0);
    expect(watcher.fns.size).toBe(0);
  });

  it('removing an external window stops its tail', async () => {
    const { source, hooks, watcher, tmux, tails } = setup({
      windows: [win({ command: 'claude' })],
    });
    await source.start();
    hooks.fire(hook('SessionStart', '%1'));
    await flush();
    expect(tails).toHaveLength(1);
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(tails[0]?.stopped).toBe(true);
    expect(source.get('ext-@1')).toBeUndefined();
  });

  it('lines() is [] for an unknown id', async () => {
    const { source } = setup();
    await source.start();
    expect(source.lines('nope')).toEqual([]);
    expect(source.get('nope')).toBeUndefined();
  });
});

describe('LiveSource: fix round 1', () => {
  const linked = () => rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT });

  it('on restart, a linked Kage window that no longer runs claude is ended', async () => {
    const lines: DisplayLine[] = [{ kind: 'say', text: 'Bye.' }];
    const { source, tmux } = setup({
      windows: [kageWin({ command: 'bash' })],
      records: [linked()],
      tails: { [TRANSCRIPT]: { lines } },
    });
    await source.start();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).toEqual(lines);
    expect(tmux.captureCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a Kage window that never ran claude is not ended by its shell', async () => {
    const { source } = setup({ windows: [kageWin({ command: 'bash' })], records: [rec()] });
    await source.start();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('a running session whose next listing shows a shell is ended (re-checked on activity)', async () => {
    const { source, hooks, tmux, tails, watcher } = setup({
      windows: [kageWin()],
      records: [rec()],
    });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    await flush();
    const lists = tmux.listCalls;
    for (let i = 0; i < 8; i++) {
      watcher.emit({ type: 'activity', paneId: '%2' });
      await vi.advanceTimersByTimeAsync(250);
    }
    // Coalesced: at most one re-list per second.
    expect(tmux.listCalls - lists).toBeGreaterThanOrEqual(1);
    expect(tmux.listCalls - lists).toBeLessThanOrEqual(3);
    expect(source.get('k-1')?.status).toBe('running');
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(2500);
    expect(tails[0]?.stopped).toBe(true);
  });

  it('Stop re-lists about 300 ms later', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    const lists = tmux.listCalls;
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    hooks.fire(hook('Stop', '%2'));
    await vi.advanceTimersByTimeAsync(299);
    expect(tmux.listCalls).toBe(lists);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(tmux.listCalls).toBe(lists + 1);
    expect(source.get('k-1')?.status).toBe('ended');
  });

  it('nothing happens after stop(): no emit, timer or capture from work in flight', async () => {
    const { source, watcher, tmux, events } = setup({ windows: [win()] });
    await source.start();
    let open = () => {};
    tmux.gate = new Promise<void>((r) => {
      open = r;
    });
    tmux.windows.push(
      win({ windowId: '@4', paneId: '%4', command: 'claude', activity: Math.floor(T0 / 1000) }),
    );
    watcher.emit({ type: 'windows-changed' });
    await flush();
    await source.stop();
    events.length = 0;
    const captures = tmux.captureCalls.length;
    open();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(tmux.captureCalls.length).toBe(captures);
  });

  it('pane fallback lines are captured only for viewed sessions', async () => {
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', '$ make\nok\n');
    await source.start();
    const n = tmux.captureCalls.length;
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tmux.captureCalls.length).toBe(n);
    source.setViewed(new Set(['ext-@1']));
    await vi.advanceTimersByTimeAsync(250);
    expect(tmux.captureCalls.length).toBe(n + 1);
    expect(
      lineEvents('ext-@1')
        .at(-1)
        ?.lines.map((l) => l.text),
    ).toEqual(['$ make', 'ok']);
    source.setViewed(new Set());
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tmux.captureCalls.length).toBe(n + 1);
  });

  it('an ended session never gets pane fallback captures; its transcript lines stay', async () => {
    const { source, hooks, tmux, tails, watcher } = setup({
      windows: [kageWin()],
      records: [rec()],
    });
    tmux.setCapture('%2', '$ \n');
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    tails[0]?.push([{ kind: 'say', text: 'Done here.' }]);
    hooks.fire(hook('SessionEnd', '%2'));
    await vi.advanceTimersByTimeAsync(2500);
    source.setViewed(new Set(['k-1']));
    const n = tmux.captureCalls.length;
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tmux.captureCalls.length).toBe(n);
    expect(source.lines('k-1')).toEqual([{ kind: 'say', text: 'Done here.' }]);
  });

  it('a failed save is retried with backoff (500 ms doubling)', async () => {
    const { source, store } = setup({ windows: [kageWin({ windowId: '@7' })], records: [rec()] });
    store.fail = 2;
    await source.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.attempts.map((t) => t - T0)).toEqual([500, 1000, 2000]);
    expect(store.saves.at(-1)?.[0]?.windowId).toBe('@7');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('save retries back off to at most 30 s', async () => {
    const { source, store } = setup({ windows: [kageWin({ windowId: '@7' })], records: [rec()] });
    store.fail = 1000;
    await source.start();
    await vi.advanceTimersByTimeAsync(300_000);
    const gaps = store.attempts.slice(1).map((t, i) => t - (store.attempts[i] as number));
    expect(gaps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 16_000]);
    expect(Math.max(...gaps)).toBe(30_000);
    await source.stop();
  });

  it('emits no session.updated for archived sessions', async () => {
    const { source, hooks, updates } = setup({
      windows: [kageWin()],
      records: [rec({ archived: true })],
    });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(updates('k-1')).toEqual([]);
    expect(source.get('k-1')?.status).toBe('done');
  });
});
