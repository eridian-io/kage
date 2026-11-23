import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DisplayLine, LIMITS, type Question, type Session } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinishActions } from './finish/actions.ts';
import { AutoArchiver } from './finish/auto-archive.ts';
import type { HookEvent, HookEventName } from './hooks/event.ts';
import {
  type AutoArchiveHost,
  type AutoArchiverLike,
  type HookServerLike,
  LiveSource,
  NotImplementedError,
  type PreviewHost,
  type PreviewLike,
  type StateStoreLike,
  type TailLike,
  type TmuxClientLike,
  type TmuxWatcherLike,
} from './live-source.ts';
import { NOTIFY_DEFAULTS, Notifier } from './notify/notifier.ts';
import type { SourceEvent } from './source.ts';
import type { SessionRecord } from './state/store.ts';
import { SessionMissing } from './tmux/client.ts';
import { pickPanes, type TmuxPane, type TmuxWindow } from './tmux/format.ts';
import type { WatchEvent } from './tmux/watcher.ts';
import { TranscriptTail } from './transcript/tail.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../test/fixtures/panes', `${name}.txt`), 'utf8');

const RULE = '─'.repeat(60);
/** The pane after No or Esc on a prompt (spec §1, "Denial, cancel and failure"). */
const DENIED_PANE = [
  '● Bash(npm test)',
  '  ⎿  Interrupted · What should Claude do instead?',
  '',
  RULE,
  '❯ ',
  RULE,
  '',
].join('\n');
/** The pane right after Yes: the command runs and no hook has fired yet. */
const APPROVED_PANE = ['● Bash(npm test)', '  ⎿  Running…', '', RULE, '❯ ', RULE, ''].join('\n');

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
  /** Windows whose @kage_placeholder was cleared (R22). */
  cleared: string[] = [];
  async ensureSession(): Promise<void> {}
  async clearPlaceholder(windowId: string): Promise<void> {
    this.cleared.push(windowId);
    for (const w of this.windows) if (w.windowId === windowId) w.placeholder = false;
  }
  /** When set, listWindows picks one of these per window (B14) instead of returning `windows`. */
  panes: TmuxPane[] | null = null;
  /** The hook panes each listWindows call was given. */
  hookPanesSeen: string[][] = [];
  /** M4: tmux says "can't find session" (renamed): strict listings throw SessionMissing. */
  missing = false;
  /** The strict flag of each listWindows call. */
  strictSeen: boolean[] = [];
  async listWindows(
    hookPanes: ReadonlySet<string> = new Set(),
    o: { strict?: boolean } = {},
  ): Promise<TmuxWindow[]> {
    this.listCalls++;
    this.hookPanesSeen.push([...hookPanes]);
    this.strictSeen.push(o.strict === true);
    if (this.missing) {
      if (o.strict) throw new SessionMissing('kage');
      return [];
    }
    if (this.panes)
      return pickPanes(
        this.panes.map((p) => ({ ...p })),
        hookPanes,
      );
    return this.windows.map((w) => ({ ...w }));
  }
  /** This many next captures fail (a tmux error). */
  failCaptures = 0;
  /** Each call takes the next queued capture; the last one repeats. */
  async capturePane(paneId: string): Promise<string> {
    this.captureCalls.push(paneId);
    if (this.gate) await this.gate;
    if (this.failCaptures > 0) {
      this.failCaptures--;
      throw new Error("can't find pane");
    }
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

/** A tail start a test holds open: set `wait`, then resolve it. */
interface TailGate {
  wait: Promise<void> | null;
}

/** A gate that holds tail starts until `open()`. */
function holdTails(gate: TailGate): () => void {
  let open = () => {};
  gate.wait = new Promise<void>((r) => {
    open = r;
  });
  return () => {
    gate.wait = null;
    open();
  };
}

class FakeTail implements TailLike {
  readonly path: string;
  #lines: DisplayLine[];
  #question: Question | null;
  #now: string | null;
  fns = new Set<(added: DisplayLine[], reset: boolean) => void>();
  interruptFns = new Set<() => void>();
  turnEndFns = new Set<() => void>();
  started = false;
  stopped = false;
  /** While `gate.wait` is set, start() waits for it: a hook can land while a tail starts. */
  readonly #gate: TailGate | null;
  constructor(path: string, c: TailContent = {}, gate: TailGate | null = null) {
    this.path = path;
    this.#lines = c.lines ?? [];
    this.#question = c.question ?? null;
    this.#now = c.now ?? null;
    this.#gate = gate;
  }
  async start(): Promise<void> {
    const wait = this.#gate?.wait;
    if (wait) await wait;
    this.started = true;
    if (this.#lines.length) for (const fn of [...this.fns]) fn(this.#lines.slice(), false);
  }
  stop(): void {
    this.stopped = true;
  }
  /** Every setIdle call, in order (Task 9: a tail that isn't running doesn't poll). */
  idleCalls: boolean[] = [];
  /** poke() calls (R138: pane activity on a session that isn't running). */
  pokes = 0;
  poke(): void {
    this.pokes++;
  }
  setIdle(idle: boolean): void {
    this.idleCalls.push(idle);
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
  onTurnEnd(fn: () => void): () => void {
    this.turnEndFns.add(fn);
    return () => this.turnEndFns.delete(fn);
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
  /** A record that ends the turn (an end_turn reply, stop_hook_summary or turn_duration). */
  turnEnd(): void {
    this.#now = null;
    for (const fn of [...this.turnEndFns]) fn();
  }
}

/** Records what LiveSource tells the preview tracker. */
class FakePreview implements PreviewLike {
  host: PreviewHost | null = null;
  calls: string[] = [];
  viewed: string[][] = [];
  setViewed(ids: ReadonlySet<string>): void {
    this.viewed.push([...ids]);
  }
  touch(id: string, reason: string): void {
    this.calls.push(`touch ${id} ${reason}`);
  }
  statusChanged(id: string): void {
    this.calls.push(`status ${id}`);
  }
  refresh(id: string): void {
    this.calls.push(`refresh ${id}`);
  }
  forget(id: string): void {
    this.calls.push(`forget ${id}`);
  }
  stop(): void {
    this.calls.push('stop');
  }
}

/** Records what LiveSource tells the auto-archiver. */
class FakeAuto implements AutoArchiverLike {
  host: AutoArchiveHost | null = null;
  calls: string[] = [];
  start(): void {
    this.calls.push('start');
  }
  touch(id: string): void {
    this.calls.push(`touch ${id}`);
  }
  sync(): void {
    this.calls.push('sync');
  }
  stop(): void {
    this.calls.push('stop');
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
  placeholder: false,
  dead: false,
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
  base: null,
  permissionMode: 'default',
  baseCommit: null,
  doneAt: null,
  archivedAt: null,
  restoredAt: null,
  unpinnedAt: null,
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
  toolUseId: null,
  source: null,
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
    /** A real tail instead of FakeTail. */
    tail?: (path: string) => TailLike;
    /** A real auto-archiver instead of FakeAuto. */
    auto?: (host: AutoArchiveHost) => AutoArchiverLike;
    onLoaded?: () => void;
    /** Every FakeTail's start() waits while its `wait` is set. */
    tailGate?: TailGate;
    /** Kage's log lines. */
    log?: (line: string) => void;
  } = {},
) {
  const preview = new FakePreview();
  const auto = new FakeAuto();
  /** Sessions with an open terminal (F11). */
  const terminals = new Set<string>();
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
    tail:
      opts.tail ??
      ((path) => {
        const t = new FakeTail(path, opts.tails?.[path], opts.tailGate ?? null);
        tails.push(t);
        return t;
      }),
    projectsRoot: ROOT,
    preview: (host) => {
      preview.host = host;
      return preview;
    },
    autoArchive: (host) => {
      auto.host = host;
      return opts.auto ? opts.auto(host) : auto;
    },
    isTerminalOpen: (id) => terminals.has(id),
    ...(opts.onLoaded ? { onLoaded: opts.onLoaded } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));
  const updates = (id?: string): Session[] =>
    events.flatMap((e) =>
      e.type === 'session.updated' && (!id || e.session.id === id) ? [e.session] : [],
    );
  const lineEvents = (id: string) =>
    events.flatMap((e) => (e.type === 'session.lines' && e.id === id ? [e] : []));
  return {
    tmux,
    watcher,
    hooks,
    store,
    tails,
    source,
    events,
    updates,
    lineEvents,
    preview,
    auto,
    terminals,
  };
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
    // I4: the read runs after start, in the background.
    await flush();
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

  it('tmux attach -d at the PC keeps needs-you, emits no ended and touches no auto-archive', async () => {
    // The review's R1 with the fixed watcher: a detached control client re-attaches while the
    // server lives and reports only `up` (a resync), never `down`.
    const { source, watcher, tmux, hooks, auto, events } = setup({
      windows: [win(), kageWin()],
      records: [rec()],
    });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    events.length = 0;
    auto.calls = [];
    const lists = tmux.listCalls;
    watcher.emit({ type: 'up' });
    await flush();
    expect(tmux.listCalls).toBe(lists + 1);
    expect(source.get('k-1')?.status).toBe('needs-you');
    expect(source.get('ext-@1')).toBeDefined();
    expect(events.filter((e) => e.type === 'session.removed')).toEqual([]);
    expect(events.some((e) => e.type === 'session.updated' && e.session.status === 'ended')).toBe(
      false,
    );
    expect(auto.calls.filter((c) => c.startsWith('touch'))).toEqual([]);
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
    // R21: a new session waits for input.
    expect(source.get('k-1')).toMatchObject({ status: 'done', statusSince: T0 });
    await vi.advanceTimersByTimeAsync(1000);
    hooks.fire(hook('UserPromptSubmit', '%2'));
    expect(source.get('k-1')).toMatchObject({ status: 'running', statusSince: T0 + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    hooks.fire(hook('PreToolUse', '%2'));
    expect(source.get('k-1')?.statusSince).toBe(T0 + 1000);
    hooks.fire(hook('Stop', '%2'));
    expect(source.get('k-1')).toMatchObject({ status: 'done', statusSince: T0 + 2000 });
    hooks.fire(hook('SessionEnd', '%2'));
    expect(source.get('k-1')?.status).toBe('ended');
  });

  it('an unchanged session emits no update', async () => {
    const { source, hooks, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%2'));
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
    hooks.fire(hook('UserPromptSubmit', '%2'));
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

  it('pane fallback: the prompt gone and the denial on screen means done (R11, No or Esc)', async () => {
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
    tmux.setCapture('%2', DENIED_PANE);
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    expect(source.get('k-1')?.question).toBeUndefined();
  });

  it('pane fallback: the prompt gone without a denial is an answered Yes: running until the Stop', async () => {
    // Found by the live e2e: a long approved command fires no hook until its PostToolUse.
    const { source, hooks, tmux, watcher } = setup({ windows: [kageWin()], records: [rec()] });
    tmux.setCapture('%2', pane('permission-bash'));
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(source.get('k-1')?.status).toBe('needs-you');
    tmux.setCapture('%2', APPROVED_PANE);
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.get('k-1')?.question).toBeUndefined();
    // Still running while the command runs, with more output and no hook.
    await vi.advanceTimersByTimeAsync(6000);
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
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

describe('LiveSource: split windows (B14) and dead panes', () => {
  const twoPanes = (): TmuxPane[] => [
    { ...kageWin({ paneId: '%2', command: 'bash' }), active: true },
    { ...kageWin({ paneId: '%7', command: 'node' }), active: false },
  ];

  it("a hook from a pane that isn't the window's first pane maps to that window", async () => {
    const { source, hooks, tmux } = setup({ records: [rec()] });
    tmux.panes = twoPanes();
    await source.start();
    // Before any hook the active pane stands for the window.
    expect(source.get('k-1')?.status).not.toBe('ended');
    hooks.fire(hook('SessionStart', '%7'));
    hooks.fire(hook('PreToolUse', '%7'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.hookPanesSeen.at(-1)).toEqual(['%7']);
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.list()).toHaveLength(1);
    // The window now follows the hook pane: the next hook applies without a re-list.
    const lists = tmux.listCalls;
    hooks.fire(hook('Stop', '%7'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    expect(tmux.listCalls).toBe(lists);
  });

  it('a hook pane found in no window is not passed to later listings', async () => {
    const { source, hooks, tmux, watcher } = setup({ windows: [win()] });
    await source.start();
    hooks.fire(hook('Stop', '%9'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.hookPanesSeen.at(-1)).toEqual(['%9']);
    tmux.windows = [win(), win({ windowId: '@3', paneId: '%3' })];
    watcher.emit({ type: 'windows-changed' });
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.hookPanesSeen.at(-1)).toEqual([]);
  });

  it('watcher down forgets the hook panes (pane ids restart with a new server)', async () => {
    const { source, hooks, tmux, watcher } = setup({ records: [rec()] });
    tmux.panes = twoPanes();
    await source.start();
    hooks.fire(hook('SessionStart', '%7'));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.hookPanesSeen.at(-1)).toEqual(['%7']);
    watcher.emit({ type: 'down' });
    watcher.emit({ type: 'up' });
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(tmux.hookPanesSeen.at(-1)).toEqual([]);
  });

  it('a Kage window whose pane is dead (remain-on-exit) is ended although it shows claude', async () => {
    const { source } = setup({ windows: [kageWin({ dead: true })], records: [rec()] });
    await source.start();
    expect(source.get('k-1')?.status).toBe('ended');
  });

  it('a running session whose pane dies is ended', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    (tmux.windows[0] as TmuxWindow).dead = true;
    hooks.fire(hook('Stop', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
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
    hooks.fire(hook('UserPromptSubmit', '%2'));
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

  /** A running session whose transcript moves the now line before each tool hook (as Claude does). */
  async function toolBurst() {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    const step = (i: number) => {
      s.tails[0]?.push([{ kind: 'tool', text: 'Bash', detail: `step ${i}` }], {
        now: `Running step ${i}`,
      });
      s.hooks.fire(hook(i % 2 === 0 ? 'PreToolUse' : 'PostToolUse', '%2'));
    };
    return { ...s, step };
  }

  it('10 tool hooks in 1 s emit at most 4 session.updated, the last with the last now line', async () => {
    const { source, updates, step } = await toolBurst();
    const before = updates('k-1').length;
    for (let i = 0; i < 10; i++) {
      step(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(updates('k-1').length - before).toBeLessThanOrEqual(4);
    // The trailing edge: the final state is never dropped.
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')?.now).toBe('Running step 9');
    expect(updates('k-1').at(-1)?.now).toBe('Running step 9');
    expect(updates('k-1').length - before).toBeLessThanOrEqual(5);
  });

  it('a tool hook that changes nothing visible arms no throttle timer', async () => {
    const { hooks, updates, step } = await toolBurst();
    step(0);
    await vi.advanceTimersByTimeAsync(300);
    const sent = updates('k-1').length;
    const timers = vi.getTimerCount();
    // Same now line, same status: nothing to send, and nothing waits to send it.
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(300);
    expect(updates('k-1').length).toBe(sent);
  });

  it('a PermissionRequest in a burst of tool hooks emits at once', async () => {
    const { hooks, updates, step } = await toolBurst();
    for (let i = 0; i < 5; i++) {
      step(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    hooks.fire(hook('PermissionRequest', '%2'));
    // No timer has run: the update went out synchronously.
    expect(updates('k-1').at(-1)?.status).toBe('needs-you');
    hooks.fire(hook('PostToolUse', '%2'));
    expect(updates('k-1').at(-1)?.status).toBe('running');
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
    // Only the debounced save of its new doneAt (phase 4 Task 3) is pending; no capture timer.
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bash', '-zsh', 'fish', 'login', 'pwsh'])(
    'R17: a linked window back at the shell %s is ended',
    async (command) => {
      const { source } = setup({ windows: [kageWin({ command })], records: [linked()] });
      await source.start();
      expect(source.get('k-1')?.status).toBe('ended');
    },
  );

  it.each(['node', 'claude', '2.1.330', 'claude-2.1'])(
    'R17: a linked window running %s still counts as Claude',
    async (command) => {
      const { source } = setup({ windows: [kageWin({ command })], records: [linked()] });
      await source.start();
      expect(source.get('k-1')?.status).not.toBe('ended');
    },
  );

  it('R17: a running session whose listing turns from node to -zsh is ended', async () => {
    const { source, hooks, tmux } = setup({
      windows: [kageWin({ command: 'node' })],
      records: [rec()],
    });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    hooks.fire(hook('Stop', '%2'));
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    (tmux.windows[0] as TmuxWindow).command = '-zsh';
    hooks.fire(hook('Stop', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
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
    // Coalesced: at most one re-list per 5 s while it runs (M9, hardening Task 10).
    expect(tmux.listCalls - lists).toBeGreaterThanOrEqual(1);
    expect(tmux.listCalls - lists).toBeLessThanOrEqual(2);
    expect(source.get('k-1')?.status).toBe('running');
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(5000);
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

describe('LiveSource: Task 10 carried minors', () => {
  const linked = () => rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT });

  it('setViewed before start() takes effect at start', async () => {
    const { source, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', '$ make\nok\n');
    source.setViewed(new Set(['ext-@1']));
    await source.start();
    await flush();
    expect(
      lineEvents('ext-@1')
        .at(-1)
        ?.lines.map((l) => l.text),
    ).toEqual(['$ make', 'ok']);
  });

  it('Ctrl+Z then fg: a session ended at its shell revives when claude is back, with its tail', async () => {
    const lines: DisplayLine[] = [{ kind: 'say', text: 'Working on it.' }];
    const { source, tmux, tails, watcher } = setup({
      windows: [kageWin()],
      records: [linked()],
      tails: { [TRANSCRIPT]: { lines } },
    });
    await source.start();
    expect(source.get('k-1')?.status).not.toBe('ended');
    // Ctrl+Z: claude is suspended and the shell is in front.
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(3000);
    expect(tails[0]?.stopped).toBe(true);
    // fg: claude is in front again. Typing in the shell is activity, which re-checks.
    (tmux.windows[0] as TmuxWindow).command = 'claude';
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('k-1')?.status).not.toBe('ended');
    expect(tails).toHaveLength(2);
    expect(tails[1]?.started).toBe(true);
    expect(tails[1]?.stopped).toBe(false);
    expect(source.lines('k-1')).toEqual(lines);
    await source.stop();
  });

  it('a session ended by SessionEnd is not revived while claude is still exiting', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [linked()] });
    await source.start();
    hooks.fire(hook('SessionEnd', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    // The 300 ms re-list still sees claude in the pane.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(tmux.windows[0]?.command).toBe('claude');
    expect(source.get('k-1')?.status).toBe('ended');
    await source.stop();
  });
});

describe('LiveSource: final fix wave', () => {
  const RULE80 = '─'.repeat(80);
  const IDLE = `● Done.\n\n${RULE80}\n❯ \n${RULE80}\n  ⏸ manual mode on · ? for shortcuts\n`;

  it('any hook links the pane: after a restart, a PreToolUse starts the tail and now and lines flow', async () => {
    const { source, hooks, tails, lineEvents } = setup({
      windows: [win({ command: 'claude' })],
    });
    await source.start();
    expect(tails).toHaveLength(0);
    hooks.fire(hook('PreToolUse', '%1'));
    await flush();
    expect(tails).toHaveLength(1);
    expect(tails[0]?.path).toBe(TRANSCRIPT);
    expect(tails[0]?.started).toBe(true);
    tails[0]?.push([{ kind: 'tool', text: 'Bash', detail: 'npm test' }], {
      now: 'Running npm test',
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('ext-@1')).toMatchObject({ status: 'running', now: 'Running npm test' });
    expect(lineEvents('ext-@1').at(-1)?.lines).toEqual([
      { kind: 'tool', text: 'Bash', detail: 'npm test' },
    ]);
    // The same session and transcript on the next hook keep the one tail.
    hooks.fire(hook('PostToolUse', '%1'));
    await flush();
    expect(tails).toHaveLength(1);
  });

  it('a hook with a new session id moves the tail; one without a transcript path keeps it', async () => {
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    hooks.fire(hook('Stop', '%2', { transcriptPath: null }));
    await flush();
    expect(tails).toHaveLength(1);
    hooks.fire(
      hook('UserPromptSubmit', '%2', { sessionId: 's-2', transcriptPath: '/t/s-2.jsonl' }),
    );
    await flush();
    expect(tails).toHaveLength(2);
    expect(tails[0]?.stopped).toBe(true);
    expect(tails[1]?.path).toBe('/t/s-2.jsonl');
  });

  it('a hooked claude window is not captured on every activity', async () => {
    const { source, hooks, watcher, tmux } = setup({ windows: [win({ command: 'claude' })] });
    await source.start();
    hooks.fire(hook('Notification', '%1', { notification: 'idle' }));
    await flush();
    const n = tmux.captureCalls.length;
    for (let i = 0; i < 10; i++) {
      watcher.emit({ type: 'activity', paneId: '%1' });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(tmux.captureCalls.length).toBe(n);
  });

  it('a claude window without hooks stops the startup checks once its idle box shows', async () => {
    const { source, watcher, tmux } = setup({ windows: [win({ command: 'claude' })] });
    tmux.setCapture('%1', IDLE);
    await source.start();
    await vi.advanceTimersByTimeAsync(2000);
    const n = tmux.captureCalls.length;
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      watcher.emit({ type: 'activity', paneId: '%1' });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(tmux.captureCalls.length).toBe(n);
  });

  it('F2: a startup screen drawn after the first capture is still found', async () => {
    const { source, tmux } = setup({ windows: [win({ command: 'claude' })] });
    // Claude is still loading at the first capture; the trust screen comes a moment later and
    // then sits still, so no further activity arrives.
    tmux.setCapture('%1', '', pane('real-trust-80'));
    await source.start();
    expect(source.get('ext-@1')?.status).not.toBe('needs-you');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('ext-@1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Trust this folder?' },
    });
  });

  it('F2: a shell window that starts claude is re-listed on activity and checked for startup screens', async () => {
    const { source, tmux, watcher } = setup({ windows: [win({ command: 'bash' })] });
    tmux.setCapture('%1', pane('real-trust-80'));
    await source.start();
    expect(source.get('ext-@1')?.status).toBe('done');
    (tmux.windows[0] as TmuxWindow).command = 'claude';
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('ext-@1')?.status).toBe('needs-you');
  });

  it('rebuild: a finished turn without turn_duration is not running (real transcript)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-live-'));
    try {
      const path = join(dir, 's.jsonl');
      const r = (o: unknown) => `${JSON.stringify(o)}\n`;
      writeFileSync(
        path,
        r({ type: 'user', message: { role: 'user', content: 'Run the tests' } }) +
          r({
            type: 'assistant',
            message: {
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
              ],
            },
          }) +
          r({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          }) +
          r({
            type: 'assistant',
            message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All green.' }] },
          }),
      );
      const { source } = setup({
        windows: [kageWin()],
        records: [rec({ sessionId: 's-1', transcriptPath: path })],
        tail: (p) => new TranscriptTail(p, { watch: false }),
      });
      await source.start();
      expect(source.get('k-1')?.status).toBe('done');
      expect(source.get('k-1')?.now).toBeUndefined();
      expect(source.lines('k-1').at(-1)).toEqual({ kind: 'say', text: 'All green.' });
      await source.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pane fallback: a capture that extends the last one sends only the new lines', async () => {
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', '$ make\nstep 1\n', '$ make\nstep 1\nstep 2\nstep 3\n');
    source.setViewed(new Set(['ext-@1']));
    await source.start();
    await flush();
    expect(lineEvents('ext-@1').at(-1)).toMatchObject({ reset: true });
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(lineEvents('ext-@1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'ext-@1',
      lines: [
        { kind: 'out', text: 'step 2' },
        { kind: 'out', text: 'step 3' },
      ],
      reset: false,
    });
    expect(source.lines('ext-@1').map((l) => l.text)).toEqual([
      '$ make',
      'step 1',
      'step 2',
      'step 3',
    ]);
  });

  it('pane fallback: a capture that scrolled the head away still sends only the new lines', async () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const after = [...before.slice(2), 'line 200', 'line 201'];
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', `${before.join('\n')}\n`, `${after.join('\n')}\n`);
    source.setViewed(new Set(['ext-@1']));
    await source.start();
    await flush();
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(lineEvents('ext-@1').at(-1)).toMatchObject({
      lines: [
        { kind: 'out', text: 'line 200' },
        { kind: 'out', text: 'line 201' },
      ],
      reset: false,
    });
  });

  it('pane fallback: a capture with no overlap (a cleared screen) resets', async () => {
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', '$ make\nstep 1\nstep 2\n', '$ vim\n');
    source.setViewed(new Set(['ext-@1']));
    await source.start();
    await flush();
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(lineEvents('ext-@1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'ext-@1',
      lines: [{ kind: 'out', text: '$ vim' }],
      reset: true,
    });
  });

  it('R22: the placeholder window is hidden while it sits at a shell', async () => {
    const { source } = setup({
      windows: [win({ placeholder: true, command: 'bash' }), kageWin()],
      records: [rec()],
    });
    await source.start();
    expect(source.list().map((s) => s.id)).toEqual(['k-1']);
  });

  it('R22: once the placeholder runs something else its tag is cleared and it shows', async () => {
    const { source, tmux, watcher } = setup({
      windows: [win({ placeholder: true, command: 'bash' })],
    });
    await source.start();
    expect(source.list()).toHaveLength(0);
    (tmux.windows[0] as TmuxWindow).command = 'claude';
    // Activity in a hidden window re-lists (at most once a second) to see what it runs.
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(tmux.cleared).toEqual(['@1']);
    expect(source.list().map((s) => s.id)).toEqual(['ext-@1']);
  });

  it('hooks from a pane outside the kage session re-list at most once per 5 s', async () => {
    const { source, hooks, tmux } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    const lists = tmux.listCalls;
    hooks.fire(hook('PreToolUse', '%9'));
    hooks.fire(hook('PostToolUse', '%9'));
    await vi.advanceTimersByTimeAsync(100);
    expect(tmux.listCalls).toBe(lists + 1);
    hooks.fire(hook('PreToolUse', '%9'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(tmux.listCalls).toBe(lists + 1);
    await vi.advanceTimersByTimeAsync(1000);
    hooks.fire(hook('PreToolUse', '%9'));
    await vi.advanceTimersByTimeAsync(100);
    expect(tmux.listCalls).toBe(lists + 2);
  });

  it('idle and throttle use a monotonic clock: the wall clock stepping back changes nothing', async () => {
    const { source, watcher } = setup({ windows: [win()] });
    await source.start();
    watcher.emit({ type: 'activity', paneId: '%1' });
    expect(source.get('ext-@1')?.status).toBe('running');
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(5001);
    expect(source.get('ext-@1')?.status).toBe('done');
  });

  it('the now line is not on the wire after Stop (F3)', async () => {
    const { source, hooks, tails } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    tails[0]?.push([], { now: 'Running npm test' });
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')?.now).toBe('Running npm test');
    hooks.fire(hook('Stop', '%2'));
    expect(source.get('k-1')?.now).toBeUndefined();
  });
});

describe('LiveSource: phase 2 residuals (phase 3 Task 0)', () => {
  const RULE80 = '─'.repeat(80);
  const IDLE = `● Done.\n\n${RULE80}\n❯ \n${RULE80}\n  ⏸ manual mode on · ? for shortcuts\n`;
  const ask = {
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        { question: 'Which separator?', options: [{ label: 'Dash' }, { label: 'Snake' }] },
      ],
    },
  };

  it('SessionStart source=compact keeps a running session running, with its now line and tail', async () => {
    const { source, hooks, tails, lineEvents } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2', { source: 'startup' }));
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    tails[0]?.push([{ kind: 'tool', text: 'Bash', detail: 'npm test' }], {
      now: 'Running npm test',
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Running npm test' });
    const before = lineEvents('k-1').length;
    hooks.fire(hook('SessionStart', '%2', { source: 'compact' }));
    await flush();
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Running npm test' });
    expect(tails).toHaveLength(1);
    expect(tails[0]?.stopped).toBe(false);
    expect(lineEvents('k-1').length).toBe(before);
    expect(source.lines('k-1')).toEqual([{ kind: 'tool', text: 'Bash', detail: 'npm test' }]);
  });

  it('SessionStart source=compact keeps needs-you and its question', async () => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2', ask));
    const q = { text: 'Which separator?', options: ['Dash', 'Snake'] };
    expect(source.get('k-1')).toMatchObject({ status: 'needs-you', question: q });
    hooks.fire(hook('SessionStart', '%2', { source: 'compact' }));
    await flush();
    expect(source.get('k-1')).toMatchObject({ status: 'needs-you', question: q });
  });

  it('SessionStart source=compact keeps a pending tool: a later permission notice still counts (R12)', async () => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('PreToolUse', '%2'));
    hooks.fire(hook('SessionStart', '%2', { source: 'compact' }));
    expect(source.get('k-1')?.status).toBe('running');
    hooks.fire(permissionNote('%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
  });

  it.each(['resume', 'clear'])('SessionStart source=%s is done (R21)', async (src) => {
    const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%2'));
    expect(source.get('k-1')?.status).toBe('running');
    hooks.fire(hook('SessionStart', '%2', { source: src }));
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('a claude window without hooks that returns to its shell gets a second claude checked for startup screens', async () => {
    const { source, tmux, watcher } = setup({ windows: [win({ command: 'claude' })] });
    tmux.setCapture('%1', IDLE);
    await source.start();
    await vi.advanceTimersByTimeAsync(2000);
    // The first claude exits to the shell.
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    watcher.emit({ type: 'windows-changed' });
    await flush();
    // A second claude starts there and shows the trust screen.
    tmux.setCapture('%1', pane('real-trust-80'));
    (tmux.windows[0] as TmuxWindow).command = 'claude';
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('ext-@1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Trust this folder?' },
    });
  });

  it('a hooked Kage window that returns to its shell gets a second claude checked for startup screens', async () => {
    const { source, tmux, watcher, hooks } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('SessionStart', '%2'));
    await flush();
    (tmux.windows[0] as TmuxWindow).command = 'bash';
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    tmux.setCapture('%2', pane('real-trust-80'));
    (tmux.windows[0] as TmuxWindow).command = 'claude';
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(source.get('k-1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Trust this folder?' },
    });
    await source.stop();
  });

  it('pane fallback: a capture that shrank to a strict suffix of the last one resets', async () => {
    const { source, watcher, tmux, lineEvents } = setup({ windows: [win()] });
    tmux.setCapture('%1', 'a\nb\nc\nd\ne\n', 'c\nd\ne\n');
    source.setViewed(new Set(['ext-@1']));
    await source.start();
    await flush();
    watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(lineEvents('ext-@1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'ext-@1',
      lines: [
        { kind: 'out', text: 'c' },
        { kind: 'out', text: 'd' },
        { kind: 'out', text: 'e' },
      ],
      reset: true,
    });
    expect(source.lines('ext-@1').map((l) => l.text)).toEqual(['c', 'd', 'e']);
  });
});

describe('LiveSource: launches (phase 3 Task 6)', () => {
  const launched = (over: Partial<SessionRecord> = {}) =>
    rec({
      kageId: 'k-9',
      windowId: null,
      task: 'Add a dark mode',
      branch: 'kage/add-a-dark-mode',
      worktree: `${ROOT}/shop/.worktrees/add-a-dark-mode`,
      createdAt: T0,
      base: 'main',
      permissionMode: 'acceptEdits',
      ...over,
    });
  const newWin = (over: Partial<TmuxWindow> = {}) =>
    win({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      command: 'claude',
      cwd: `${ROOT}/shop/.worktrees/add-a-dark-mode`,
      name: 'add-a-dark-mode',
      activity: Math.floor(T0 / 1000),
      ...over,
    });

  it('adopt saves the record before it emits the session as running, "Starting Claude…"', async () => {
    const { source, store, events } = setup();
    await source.start();
    let savedAtEmit = false;
    source.subscribe((e) => {
      if (e.type === 'session.updated' && e.session.id === 'k-9') {
        savedAtEmit = store.saves.some((s) => s.some((r) => r.kageId === 'k-9'));
      }
    });
    await source.adopt(launched());
    expect(savedAtEmit).toBe(true);
    expect(store.saves.at(-1)).toEqual([launched()]);
    expect(events.at(-1)).toMatchObject({
      type: 'session.updated',
      session: { id: 'k-9', status: 'running', now: 'Starting Claude…', task: 'Add a dark mode' },
    });
  });

  it('a failed save makes adopt throw and leaves no session', async () => {
    const { source, store, events } = setup();
    await source.start();
    store.fail = 1;
    await expect(source.adopt(launched())).rejects.toThrow('disk full');
    expect(source.get('k-9')).toBeUndefined();
    expect(events).toEqual([]);
    expect(source.branchTaken('shop', 'kage/add-a-dark-mode')).toBe(false);
  });

  it('an adopted session without its window yet stays running through a re-list', async () => {
    const { source, watcher } = setup();
    await source.start();
    await source.adopt(launched());
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('k-9')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
  });

  it('claim before the re-list: the untagged window attaches to the record, not as ext-@7', async () => {
    const { source, tmux, events, store } = setup();
    await source.start();
    await source.adopt(launched());
    tmux.windows = [newWin()];
    source.claim('k-9', '@7', '%7');
    await flush();
    expect(source.get('ext-@7')).toBeUndefined();
    expect(events.some((e) => e.type === 'session.updated' && e.session.id === 'ext-@7')).toBe(
      false,
    );
    expect(source.get('k-9')).toMatchObject({ status: 'running', external: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(store.saves.at(-1)?.find((r) => r.kageId === 'k-9')?.windowId).toBe('@7');
  });

  it('claim after an ext-@7 session appeared: ext-@7 is removed, then the record attaches', async () => {
    const { source, tmux, watcher, events } = setup();
    await source.start();
    await source.adopt(launched());
    tmux.windows = [newWin()];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('ext-@7')).toBeDefined();
    events.length = 0;
    source.claim('k-9', '@7', '%7');
    await flush();
    expect(events[0]).toEqual({ type: 'session.removed', id: 'ext-@7' });
    expect(source.get('ext-@7')).toBeUndefined();
    expect(source.get('k-9')?.status).toBe('running');
    // Later listings, now with the tag, keep it the record's.
    tmux.windows = [newWin({ kageId: 'k-9' })];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.get('ext-@7')).toBeUndefined();
    expect(source.list().map((s) => s.id)).toEqual(['k-9']);
  });

  it("a hook from the claimed window's pane goes to the record", async () => {
    const { source, tmux, hooks } = setup();
    await source.start();
    await source.adopt(launched());
    tmux.windows = [newWin()];
    source.claim('k-9', '@7', '%7');
    await flush();
    hooks.fire(hook('UserPromptSubmit', '%7'));
    await flush();
    expect(source.get('k-9')?.status).toBe('running');
    hooks.fire(hook('Stop', '%7'));
    await flush();
    expect(source.get('k-9')?.status).toBe('done');
    expect(source.get('ext-@7')).toBeUndefined();
  });

  it('hooks applied to ext-@7 before the claim are re-learned from the next hook', async () => {
    const { source, tmux, watcher, hooks, store, tails } = setup();
    await source.start();
    await source.adopt(launched());
    tmux.windows = [newWin()];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
    await flush();
    expect(source.get('ext-@7')).toBeDefined();
    source.claim('k-9', '@7', '%7');
    await flush();
    // The record's session has no Claude session yet; the next hook links it.
    hooks.fire(hook('UserPromptSubmit', '%7'));
    await flush();
    expect(source.get('k-9')?.status).toBe('running');
    expect(tails.some((t) => t.path === TRANSCRIPT && t.started)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.saves.at(-1)?.find((r) => r.kageId === 'k-9')).toMatchObject({
      windowId: '@7',
      sessionId: 's-1',
      transcriptPath: TRANSCRIPT,
    });
  });

  it('abandon removes the record and its session (session.removed) and saves', async () => {
    const { source, store, events } = setup();
    await source.start();
    await source.adopt(launched());
    events.length = 0;
    await source.abandon('k-9');
    expect(events).toEqual([{ type: 'session.removed', id: 'k-9' }]);
    expect(source.get('k-9')).toBeUndefined();
    expect(store.saves.at(-1)).toEqual([]);
    expect(source.branchTaken('shop', 'kage/add-a-dark-mode')).toBe(false);
  });

  it('forget (delete): drops the record and the session (session.removed), saves at once and syncs auto-archive', async () => {
    const { source, store, events, auto } = setup({
      windows: [kageWin()],
      records: [rec(), rec({ kageId: 'k-2', windowId: null, branch: 'kage/other' })],
    });
    await source.start();
    events.length = 0;
    auto.calls = [];
    const saves = store.saves.length;
    await source.forget('k-1');
    expect(events).toEqual([{ type: 'session.removed', id: 'k-1' }]);
    expect(source.get('k-1')).toBeUndefined();
    expect(source.finishTarget('k-1')).toBeNull();
    expect(store.saves.length).toBe(saves + 1);
    expect(store.saves.at(-1)?.map((r) => r.kageId)).toEqual(['k-2']);
    expect(auto.calls).toContain('sync');
    expect(source.branchTaken('shop', 'kage/fix-the-cart-total')).toBe(false);
    // The window's close listing that follows brings nothing back.
    await vi.advanceTimersByTimeAsync(5000);
    expect(source.get('k-1')).toBeUndefined();
  });

  it('forget of an archived record: also archive {count} goes out; an unknown id does nothing', async () => {
    const { source, store, events } = setup({
      records: [rec({ windowId: null, archived: true, archivedAt: 5 })],
    });
    await source.start();
    expect(source.archivedCount()).toBe(1);
    events.length = 0;
    await source.forget('k-1');
    expect(events).toEqual([
      { type: 'session.removed', id: 'k-1' },
      { type: 'archive', count: 0 },
    ]);
    expect(store.saves.at(-1)).toEqual([]);
    const saves = store.saves.length;
    events.length = 0;
    await source.forget('nope');
    expect(events).toEqual([]);
    expect(store.saves.length).toBe(saves);
  });

  it('branchTaken: any record of the project using the branch, archived ones included', async () => {
    const { source } = setup({ records: [rec({ archived: true })] });
    await source.start();
    expect(source.branchTaken('shop', 'kage/fix-the-cart-total')).toBe(true);
    expect(source.branchTaken('other', 'kage/fix-the-cart-total')).toBe(false);
    expect(source.branchTaken('shop', 'kage/else')).toBe(false);
  });

  describe('until the first prompt (P3F1)', () => {
    /** The idle input box, Claude waiting for input. */
    const IDLE = ['', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');
    const BUSY = ['✻ Thinking… (esc to interrupt)', '', RULE, '❯ ', RULE, ''].join('\n');
    async function launchedWindow(capture = IDLE) {
      const s = setup();
      await s.source.start();
      await s.source.adopt(launched());
      s.tmux.windows = [newWin()];
      s.tmux.setCapture('%7', capture);
      s.source.claim('k-9', '@7', '%7');
      await flush();
      return s;
    }

    it('a SessionStart before the first UserPromptSubmit keeps it running, "Starting Claude…"', async () => {
      const { source, hooks, updates } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      await flush();
      expect(source.get('k-9')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
      hooks.fire(hook('UserPromptSubmit', '%7'));
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
      hooks.fire(hook('Stop', '%7'));
      await flush();
      expect(updates('k-9').map((s) => s.status)).not.toContain('needs-you');
      const statuses = updates('k-9').map((s) => s.status);
      expect(statuses.indexOf('done')).toBe(statuses.length - 1);
    });

    it('after the first prompt, a SessionStart (a /clear) means done again', async () => {
      const { source, hooks } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      hooks.fire(hook('UserPromptSubmit', '%7'));
      hooks.fire(hook('Stop', '%7'));
      hooks.fire(hook('SessionStart', '%7', { source: 'clear' }));
      await flush();
      expect(source.get('k-9')?.status).toBe('done');
    });

    it('a PreToolUse also ends the wait; a SessionEnd ends the session', async () => {
      const a = await launchedWindow();
      a.hooks.fire(hook('PreToolUse', '%7'));
      a.hooks.fire(hook('Stop', '%7'));
      a.hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
      await flush();
      expect(a.source.get('k-9')?.status).toBe('done');
      const b = await launchedWindow();
      b.hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      b.hooks.fire(hook('SessionEnd', '%7'));
      await flush();
      expect(b.source.get('k-9')?.status).toBe('ended');
    });

    it('after the trust screen is answered, SessionStart does not blink done', async () => {
      const { source, hooks, tmux, updates } = await launchedWindow(pane('trust'));
      expect(source.get('k-9')).toMatchObject({ status: 'needs-you' });
      expect(source.get('k-9')?.question?.startup).toBe(true);
      tmux.setCapture('%7', IDLE);
      source.markAnswered('k-9');
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      await vi.advanceTimersByTimeAsync(600);
      expect(source.get('k-9')?.status).toBe('running');
      hooks.fire(hook('UserPromptSubmit', '%7'));
      await flush();
      expect(updates('k-9').map((s) => s.status)).not.toContain('done');
    });

    it('10 s after SessionStart with no prompt and an idle box on screen, it is done', async () => {
      const { source, hooks } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(source.get('k-9')?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(source.get('k-9')?.status).toBe('done');
    });

    it('the 10 s fallback leaves it running while Claude shows "esc to interrupt", and stops waiting', async () => {
      const { source, hooks } = await launchedWindow(BUSY);
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
      hooks.fire(hook('Stop', '%7'));
      hooks.fire(hook('SessionStart', '%7', { source: 'clear' }));
      await flush();
      expect(source.get('k-9')?.status).toBe('done');
    });

    it('the 10 s fallback clears "Starting Claude…" also when it leaves the session running', async () => {
      const { source, hooks } = await launchedWindow(BUSY);
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
      expect(source.get('k-9')?.now).toBeUndefined();
    });

    it('the first UserPromptSubmit clears "Starting Claude…" with the wait', async () => {
      const { source, hooks } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      hooks.fire(hook('UserPromptSubmit', '%7'));
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
      expect(source.get('k-9')?.now).toBeUndefined();
    });

    it('10 s after SessionStart, a pane with neither an idle box nor "esc to interrupt" is done', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.setCapture('%7', ' ▐▛███▛█   Claude Code v2.1.330\n');
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      expect(source.get('k-9')).toMatchObject({ status: 'done' });
    });

    it('10 s after SessionStart, a permission dialog on screen makes it needs-you with that question', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.setCapture('%7', pane('permission-bash'));
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      const s = source.get('k-9');
      expect(s?.status).toBe('needs-you');
      expect(s?.question?.text).toBeTruthy();
      expect(s?.question?.options.length).toBeGreaterThan(1);
      expect(s?.now).not.toBe('Starting Claude…');
    });

    it('10 s after SessionStart, a startup screen on screen makes it needs-you with that screen', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.setCapture('%7', pane('trust'));
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      const s = source.get('k-9');
      expect(s?.status).toBe('needs-you');
      expect(s?.question).toMatchObject({ text: 'Trust this folder?', startup: true });
    });

    it('a failed capture at the 10 s fallback is retried once 2 s later', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 1;
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(source.get('k-9')).toMatchObject({ status: 'done' });
    });

    it('when the retry fails too, the session is not left running', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 2;
      await vi.advanceTimersByTimeAsync(12_100);
      await flush();
      expect(source.get('k-9')).toMatchObject({ status: 'done' });
    });

    it('a hook during the 2 s retry wins over it', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 1;
      await vi.advanceTimersByTimeAsync(10_100);
      hooks.fire(hook('PreToolUse', '%7'));
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(source.get('k-9')?.status).toBe('running');
    });

    it('a session Kage did not just launch still goes done on SessionStart (R21)', async () => {
      const { source, hooks } = setup({ windows: [kageWin()], records: [rec()] });
      await source.start();
      hooks.fire(hook('SessionStart', '%2', { source: 'startup' }));
      await flush();
      expect(source.get('k-1')?.status).toBe('done');
    });

    // Phase 4 Task 4: Task 0's carried minors.
    it('a SessionStart during the fallback capture leaves one first-prompt timer (the slot is cleared before re-use)', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 1;
      let release: () => void = () => {};
      tmux.gate = new Promise((r) => {
        release = r;
      });
      await vi.advanceTimersByTimeAsync(10_100);
      // The fallback's capture is waiting; a second SessionStart arms a fresh 10 s timer.
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.gate = null;
      release();
      await flush();
      // The failed capture schedules its 2 s retry in the same slot: the 10 s timer must go.
      await source.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stop() cancels the first-prompt retry', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 1;
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      const captures = tmux.captureCalls.length;
      await source.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(tmux.captureCalls.length).toBe(captures);
    });

    it('removing the session (abandon) cancels the first-prompt retry', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.failCaptures = 1;
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      const captures = tmux.captureCalls.length;
      await source.abandon('k-9');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(tmux.captureCalls.length).toBe(captures);
      expect(source.get('k-9')).toBeUndefined();
    });

    it('10 s after SessionStart, a dialog on screen with "esc to interrupt" in the footer is still needs-you', async () => {
      const { source, hooks, tmux } = await launchedWindow();
      hooks.fire(hook('SessionStart', '%7', { source: 'startup' }));
      tmux.setCapture('%7', `✻ Thinking… (esc to interrupt)\n${pane('permission-bash')}`);
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();
      expect(source.get('k-9')?.status).toBe('needs-you');
      expect(source.get('k-9')?.question?.options.length).toBeGreaterThan(1);
    });
  });
});

describe('LiveSource: controls (phase 3 Task 7)', () => {
  const ASK_INPUT = {
    questions: [
      {
        question: 'Should slug() use dashes or underscores as the word separator?',
        header: 'Separator',
        options: [{ label: 'Dashes' }, { label: 'Underscores' }],
      },
      {
        question: 'Add a test for slug()?',
        header: 'Test',
        options: [{ label: 'Add one' }, { label: 'Skip it' }],
      },
    ],
  };
  /** ask.txt moved on to the second question of the same AskUserQuestion. */
  const askSecond = (): string =>
    pane('ask')
      .replace(
        'Should slug() use dashes or underscores as the word separator?',
        'Add a test for slug()?',
      )
      .replace('1. Dashes', '1. Add one')
      .replace('2. Underscores', '2. Skip it');

  async function asking() {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2', { toolName: 'AskUserQuestion', toolInput: ASK_INPUT }));
    await flush();
    return s;
  }

  async function permission() {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('permission-bash'));
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    return s;
  }

  it('target: ids, window and pane, status, a copy of the question, promptKind ask after an AskUserQuestion PreToolUse', async () => {
    const { source } = await asking();
    const t = source.target('k-1');
    expect(t).toEqual({
      id: 'k-1',
      kageId: 'k-1',
      windowId: '@2',
      paneId: '%2',
      status: 'needs-you',
      question: {
        text: 'Should slug() use dashes or underscores as the word separator?',
        options: ['Dashes', 'Underscores'],
      },
      promptKind: 'ask',
      multiSelect: false,
      external: false,
    });
    t?.question?.options.push('mutated');
    expect(source.target('k-1')?.question?.options).toEqual(['Dashes', 'Underscores']);
  });

  it('target: promptKind permission after a PermissionRequest capture', async () => {
    const { source } = await permission();
    expect(source.target('k-1')).toMatchObject({ status: 'needs-you', promptKind: 'permission' });
    expect(source.target('k-1')?.question?.options[0]).toBe('Yes');
  });

  it('target: promptKind trust for the trust screen, and question.startup is true', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('trust'));
    await s.source.start();
    expect(s.source.target('k-1')).toMatchObject({
      status: 'needs-you',
      promptKind: 'trust',
      question: {
        text: 'Trust this folder?',
        options: ['No, exit', 'Yes, I trust this folder'],
        startup: true,
      },
    });
    expect(s.source.get('k-1')?.question?.startup).toBe(true);
    // The screen kind never reaches the wire (F8).
    expect(s.source.get('k-1')?.question).not.toHaveProperty('screen');
    expect(s.source.target('nope')).toBeNull();
  });

  it('target: an external session has no kageId; a gone window has no window or pane', async () => {
    const { source, tmux, watcher } = setup({ windows: [win()], records: [rec()] });
    await source.start();
    expect(source.target('ext-@1')).toMatchObject({
      external: true,
      kageId: null,
      windowId: '@1',
      paneId: '%1',
    });
    expect(source.target('k-1')).toMatchObject({
      status: 'ended',
      windowId: null,
      paneId: null,
      kageId: 'k-1',
    });
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.target('ext-@1')).toBeNull();
  });

  it('promptKind clears when the session leaves needs-you', async () => {
    const { source, hooks } = await permission();
    hooks.fire(hook('PostToolUse', '%2'));
    expect(source.target('k-1')).toMatchObject({
      status: 'running',
      promptKind: null,
      question: null,
    });
  });

  it('markAnswered: needs-you → running with the question cleared, at once', async () => {
    const { source, updates } = await permission();
    source.markAnswered('k-1');
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.get('k-1')?.question).toBeUndefined();
    expect(updates('k-1').at(-1)?.status).toBe('running');
  });

  it('markAnswered: the check capture 500 ms later finds the next question of an AskUserQuestion', async () => {
    const { source, tmux } = await asking();
    tmux.setCapture('%2', askSecond());
    source.markAnswered('k-1');
    await vi.advanceTimersByTimeAsync(499);
    expect(source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(source.target('k-1')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Add a test for slug()?', options: ['Add one', 'Skip it'] },
      promptKind: 'ask',
    });
  });

  it('markAnswered: the check capture showing the denial line → done', async () => {
    const { source, tmux } = await permission();
    tmux.setCapture('%2', DENIED_PANE);
    source.markAnswered('k-1');
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('markAnswered: an old denial above the running tool is not this answer (stays running)', async () => {
    const { source, tmux } = await permission();
    tmux.setCapture(
      '%2',
      [
        '● Bash(sh ./a.sh)',
        '  ⎿  Interrupted · What should Claude do instead?',
        '',
        '● Bash(npm test)',
        '  ⎿  Running…',
        '',
        RULE,
        '❯ ',
        RULE,
        '',
      ].join('\n'),
    );
    source.markAnswered('k-1');
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
  });

  it('markAnswered: a capture taken after a later status change cannot undo it (gen)', async () => {
    const { source, tmux, hooks } = await permission();
    source.markAnswered('k-1');
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('Stop', '%2'));
    expect(source.get('k-1')?.status).toBe('done');
    // The old prompt is still in the scripted capture: it must not bring needs-you back.
    tmux.setCapture('%2', pane('permission-bash'));
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('markAnswered on the trust screen: the check finds the next startup screen', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('trust'));
    await s.source.start();
    s.source.markAnswered('k-1');
    expect(s.source.get('k-1')?.status).toBe('running');
    s.tmux.setCapture(
      '%2',
      ' Security notes:\n\n 1. Claude can make mistakes\n\n Press Enter to continue…',
    );
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(s.source.target('k-1')).toMatchObject({
      status: 'needs-you',
      promptKind: 'security',
      question: { text: 'Security notes', options: ['Continue'], startup: true },
    });
  });

  it('markAnswered does nothing unless the session needs you', async () => {
    const { source, hooks } = await permission();
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('Stop', '%2'));
    source.markAnswered('k-1');
    expect(source.get('k-1')?.status).toBe('done');
    source.markAnswered('nope');
  });

  it("markReplied: → running; a transcript interrupt within 5 s of Kage's Escape is its own, one after sets done", async () => {
    const { source, tails } = await permission();
    source.markReplying('k-1');
    source.markReplied('k-1');
    expect(source.get('k-1')?.status).toBe('running');
    expect(source.get('k-1')?.question).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4000);
    tails[0]?.interrupt();
    expect(source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1001);
    tails[0]?.interrupt();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('markReplied from done', async () => {
    const { source, hooks } = await permission();
    hooks.fire(hook('PostToolUse', '%2'));
    hooks.fire(hook('Stop', '%2'));
    source.markReplied('k-1');
    expect(source.get('k-1')?.status).toBe('running');
  });

  it('markStopped → ended now, question cleared; a later listing without the window keeps it ended', async () => {
    const { source, tmux, watcher, updates } = await permission();
    source.markStopped('k-1');
    expect(source.get('k-1')).toMatchObject({ status: 'ended' });
    expect(source.get('k-1')?.question).toBeUndefined();
    expect(updates('k-1').at(-1)?.status).toBe('ended');
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(source.target('k-1')).toMatchObject({ status: 'ended', windowId: null });
  });
});

describe('LiveSource: Task 7 fix round 1', () => {
  async function permission() {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('permission-bash'));
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    return s;
  }

  it('the interrupt record and the denial on screen between the Escape and markReplied never show done', async () => {
    const { source, tails, tmux, watcher, updates } = await permission();
    expect(source.get('k-1')?.status).toBe('needs-you');
    const from = updates('k-1').length;
    source.markReplying('k-1');
    // Kage's Escape: the transcript records the interrupt, and the pane shows the denial.
    tails[0]?.interrupt();
    await vi.advanceTimersByTimeAsync(300);
    tmux.setCapture('%2', DENIED_PANE);
    watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    source.markReplied('k-1');
    expect(source.get('k-1')?.status).toBe('running');
    expect(
      updates('k-1')
        .slice(from)
        .map((u) => u.status),
    ).toEqual(['running']);
  });

  it('a reply that fails after its Escape: the pane fallback settles the status 5 s later', async () => {
    const { source, tmux } = await permission();
    source.markReplying('k-1');
    tmux.setCapture('%2', DENIED_PANE);
    await vi.advanceTimersByTimeAsync(4900);
    expect(source.get('k-1')?.status).toBe('needs-you');
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('target.multiSelect comes from the AskUserQuestion hook, per question text', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(
      hook('PreToolUse', '%2', {
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              question: 'Which  checks should run?',
              header: 'Checks',
              multiSelect: true,
              options: [{ label: 'Lint' }, { label: 'Tests' }],
            },
          ],
        },
      }),
    );
    expect(s.source.target('k-1')).toMatchObject({ promptKind: 'ask', multiSelect: true });
  });

  it('R39: a permission prompt marks "Yes, and switch to auto mode" disabled on the wire', async () => {
    const { source } = await permission();
    expect(source.get('k-1')?.question?.disabledOptions).toEqual([3]);
    // The options stay as text (R5).
    expect(source.get('k-1')?.question?.options[2]).toBe('Yes, and switch to auto mode');
  });

  it('R39: the renderer offer marks "Yes, try it" disabled; other screens have none', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture(
      '%2',
      ' Try the new fullscreen renderer?\n\n ❯ 1. Yes, try it\n   2. Not now\n',
    );
    await s.source.start();
    expect(s.source.get('k-1')?.question).toMatchObject({ startup: true, disabledOptions: [1] });

    const t = setup({ windows: [kageWin()], records: [rec()] });
    t.tmux.setCapture('%2', pane('trust'));
    await t.source.start();
    expect(t.source.get('k-1')?.question).not.toHaveProperty('disabledOptions');
  });
});

describe('LiveSource: Task 7 fix round 2', () => {
  it('the replying window ends in its own timer: the settling capture at exactly 5 s runs the fallback', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('permission-bash'));
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    s.source.markReplying('k-1');
    s.tmux.setCapture('%2', DENIED_PANE);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
  });

  it('markReplied keeps the window open: an interrupt landing after it (within 5 s) is still Kage’s own', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    s.tmux.setCapture('%2', pane('permission-bash'));
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    s.source.markReplying('k-1');
    await vi.advanceTimersByTimeAsync(1000);
    s.source.markReplied('k-1');
    await vi.advanceTimersByTimeAsync(2000);
    s.tails[0]?.interrupt();
    expect(s.source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2000);
    s.tails[0]?.interrupt();
    expect(s.source.get('k-1')?.status).toBe('done');
  });
});

describe('LiveSource: preview data (Task 8)', () => {
  it('a PostToolUse of an edit tool touches files; another tool does not; Stop is a turn end', async () => {
    const { source, hooks, preview } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    preview.calls = [];
    for (const toolName of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read']) {
      hooks.fire(hook('PostToolUse', '%2', { toolName }));
    }
    hooks.fire(hook('PreToolUse', '%2', { toolName: 'Edit' }));
    hooks.fire(hook('PostToolUseFailure', '%2', { toolName: 'Edit' }));
    hooks.fire(hook('Stop', '%2'));
    expect(preview.calls).toEqual([
      'touch k-1 edit',
      'touch k-1 edit',
      'touch k-1 edit',
      'touch k-1 edit',
      'status k-1',
      'touch k-1 turn-end',
    ]);
  });

  it('every status change is told to the tracker (F6)', async () => {
    const { source, hooks, preview } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    preview.calls = [];
    hooks.fire(hook('SessionStart', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%2'));
    source.markStopped('k-1');
    expect(preview.calls.filter((c) => c.startsWith('status'))).toHaveLength(2);
  });

  it('views go to the tracker once started, and refreshView asks for the values again', async () => {
    const { source, preview } = setup({ windows: [kageWin()], records: [rec()] });
    source.setViewed(new Set(['k-1']));
    expect(preview.viewed).toEqual([]);
    await source.start();
    expect(preview.viewed).toEqual([['k-1']]);
    source.setViewed(new Set());
    expect(preview.viewed).toEqual([['k-1'], []]);
    source.refreshView('k-1');
    expect(preview.calls).toContain('refresh k-1');
  });

  it('previewTarget: a record gives its worktree, base and pane pid; active while running', async () => {
    const { source, hooks, preview } = setup({
      windows: [kageWin({ panePid: 4100 }), win({ windowId: '@7', paneId: '%7', panePid: 77 })],
      records: [rec({ base: 'main', baseCommit: 'd'.repeat(40) })],
    });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    expect(preview.host?.previewTarget('k-1')).toEqual({
      id: 'k-1',
      worktree: `${ROOT}/shop/.worktrees/fix-the-cart-total`,
      repo: join(ROOT, 'shop'),
      base: 'main',
      branch: 'kage/fix-the-cart-total',
      baseCommit: 'd'.repeat(40),
      panePid: 4100,
      active: true,
    });
    hooks.fire(hook('Stop', '%2'));
    expect(preview.host?.previewTarget('k-1')?.active).toBe(false);
    // An external window: its pane cwd and no base.
    expect(preview.host?.previewTarget('ext-@7')).toMatchObject({
      worktree: `${ROOT}/demo`,
      base: null,
      branch: null,
      baseCommit: null,
      panePid: 77,
    });
    expect(preview.host?.previewTarget('nope')).toBeNull();
  });

  it('an ended session has no pane pid', async () => {
    const { source, preview } = setup({ windows: [], records: [rec()] });
    await source.start();
    expect(preview.host?.previewTarget('k-1')).toMatchObject({ panePid: null, active: false });
  });

  it('setPreview emits session.ports and session.files with filesTotal, only on a real change', async () => {
    const { source, events } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    events.length = 0;
    const files = [{ path: 'a.ts', added: 2, removed: 1 }];
    const ports = [{ port: 5173, process: 'vite', localOnly: true }];
    source.setPreview('k-1', { files, filesTotal: 140 });
    source.setPreview('k-1', { ports });
    source.setPreview('k-1', { files: files.map((f) => ({ ...f })), filesTotal: 140 });
    source.setPreview('k-1', { ports: [{ ...ports[0] } as (typeof ports)[0]] });
    expect(events).toEqual([
      { type: 'session.files', id: 'k-1', files, filesTotal: 140 },
      { type: 'session.ports', id: 'k-1', ports },
    ]);
    // R32: a view's value goes out although unchanged.
    source.setPreview('k-1', { ports }, true);
    expect(events).toHaveLength(3);
    // Unknown sessions: nothing.
    source.setPreview('nope', { ports }, true);
    expect(events).toHaveLength(3);
  });

  it('a files value with a note carries it on session.files and the session; one without clears it (M4)', async () => {
    const { source, events } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    events.length = 0;
    source.setPreview('k-1', { files: [], filesTotal: 0, filesNote: 'Refused.' });
    expect(events).toEqual([
      { type: 'session.files', id: 'k-1', files: [], filesTotal: 0, note: 'Refused.' },
    ]);
    expect(source.get('k-1')?.filesNote).toBe('Refused.');
    source.setPreview('k-1', { files: [], filesTotal: 0 });
    expect(events.at(-1)).toEqual({ type: 'session.files', id: 'k-1', files: [], filesTotal: 0 });
    expect(source.get('k-1')).not.toHaveProperty('filesNote');
  });

  it('toSession carries the latest ports and files (snapshots and updates)', async () => {
    const { source, hooks, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    const files = [{ path: 'a.ts', added: 2, removed: 1 }];
    const ports = [{ port: 5173, process: 'vite', localOnly: true }];
    source.setPreview('k-1', { files, filesTotal: 3, ports });
    expect(source.get('k-1')).toMatchObject({ files, filesTotal: 3, ports });
    expect(source.list().find((s) => s.id === 'k-1')).toMatchObject({ files, ports });
    hooks.fire(hook('UserPromptSubmit', '%2'));
    expect(updates('k-1').at(-1)).toMatchObject({ files, filesTotal: 3, ports });
  });

  it('a removed session is forgotten; stop() stops the tracker', async () => {
    const { source, watcher, tmux, preview } = setup({
      windows: [win({ windowId: '@7', paneId: '%7' })],
    });
    await source.start();
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await vi.advanceTimersByTimeAsync(100);
    expect(preview.calls).toContain('forget ext-@7');
    await source.stop();
    expect(preview.calls.at(-1)).toBe('stop');
  });
});

describe('LiveSource: branch state (phase 4 Task 3)', () => {
  it('a changed count emits session.updated once; an unchanged one emits nothing', async () => {
    const { source, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    const n = updates('k-1').length;
    source.setPreview('k-1', { unpushed: 2, uncommitted: 3 });
    expect(updates('k-1')).toHaveLength(n + 1);
    expect(updates('k-1').at(-1)).toMatchObject({ unpushed: 2, uncommitted: 3 });
    source.setPreview('k-1', { unpushed: 2, uncommitted: 3 });
    source.setPreview('k-1', { unpushed: 2, uncommitted: 3 }, true);
    expect(updates('k-1')).toHaveLength(n + 1);
    source.setPreview('k-1', { unpushed: 0, uncommitted: 3 });
    source.setPreview('k-1', { ignored: 4 });
    expect(updates('k-1').at(-1)).toMatchObject({ unpushed: 0, uncommitted: 3, ignored: 4 });
    expect(updates('k-1')).toHaveLength(n + 3);
    expect(source.get('k-1')).toMatchObject({ unpushed: 0, uncommitted: 3, ignored: 4 });
    expect(source.list().find((s) => s.id === 'k-1')).toMatchObject({ uncommitted: 3 });
  });

  it('an external session keeps 0 and 0 (it never gets counts)', async () => {
    const { source } = setup({ windows: [win({ windowId: '@7', paneId: '%7' })] });
    await source.start();
    expect(source.get('ext-@7')).toMatchObject({ unpushed: 0, uncommitted: 0 });
  });

  it('doneAt is set on Stop, cleared on UserPromptSubmit, and saved (debounced)', async () => {
    const { source, hooks, store } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saves.at(-1)?.[0]?.doneAt ?? null).toBeNull();
    hooks.fire(hook('Stop', '%2'));
    const stoppedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saves.at(-1)?.[0]?.doneAt).toBe(stoppedAt);
    // A follow-up: active again, so no doneAt.
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saves.at(-1)?.[0]?.doneAt).toBeNull();
    hooks.fire(hook('Stop', '%2'));
    const again = Date.now();
    expect(again).toBeGreaterThan(stoppedAt);
    await vi.advanceTimersByTimeAsync(1000);
    // done → ended keeps the time it finished.
    hooks.fire(hook('SessionEnd', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.get('k-1')?.status).toBe('ended');
    expect(store.saves.at(-1)?.[0]?.doneAt).toBe(again);
  });

  it('a phase 3 record that is done or ended at load gets doneAt = the load time', async () => {
    const { source, store } = setup({
      windows: [],
      records: [rec(), rec({ kageId: 'k-2', windowId: '@3', doneAt: T0 - 5000 })],
    });
    await vi.advanceTimersByTimeAsync(2000);
    const loadedAt = Date.now();
    await source.start();
    expect(source.get('k-1')?.status).toBe('ended');
    await vi.advanceTimersByTimeAsync(1000);
    const saved = store.saves.at(-1);
    expect(saved?.find((r) => r.kageId === 'k-1')?.doneAt).toBe(loadedAt);
    // One that has a doneAt keeps it.
    expect(saved?.find((r) => r.kageId === 'k-2')?.doneAt).toBe(T0 - 5000);
  });
});

describe('LiveSource: pin, archive and restore (phase 4 Task 4)', () => {
  /** killOwnedWindow over the live-source FakeTmux's windows (re-checks the tag, as tmux does). */
  const killer = (tmux: FakeTmux, calls: string[]) => ({
    capturePane: (paneId: string) => tmux.capturePane(paneId),
    async killOwnedWindow(windowId: string, kageId: string): Promise<boolean> {
      calls.push(`kill ${windowId} ${kageId}`);
      const w = tmux.windows.find((x) => x.windowId === windowId);
      if (!w || w.kageId !== kageId) return false;
      tmux.windows = tmux.windows.filter((x) => x !== w);
      return true;
    },
    async windowKageId(windowId: string): Promise<string | null> {
      const w = tmux.windows.find((x) => x.windowId === windowId);
      if (!w) throw Object.assign(new Error("can't find window"), { stderr: "can't find window" });
      return w.kageId;
    },
  });

  it('pin saves at once (awaited) and the next session.updated has pinned: true', async () => {
    const { source, store, updates } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    const saves = store.saves.length;
    await source.setFlags('k-1', { pinned: true });
    expect(store.saves.length).toBe(saves + 1);
    expect(store.saves.at(-1)?.[0]?.pinned).toBe(true);
    expect(updates('k-1').at(-1)?.pinned).toBe(true);
    expect(source.finishTarget('k-1')?.record?.pinned).toBe(true);
  });

  it('archive of a done session with a live window: kill with the record kage id, session.removed, then archive {count: 1}', async () => {
    const { source, tmux, hooks, events, store } = setup({
      windows: [kageWin()],
      records: [rec()],
    });
    await source.start();
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    const calls: string[] = [];
    const finish = new FinishActions({
      tmux: killer(tmux, calls),
      source,
      git: async () => ({ stdout: '', stderr: '' }),
      projectsRoot: '/p',
      worktreeDir: '.worktrees',
      branchPrefix: 'kage/',
      counts: async () => ({ unpushed: 0, uncommitted: 0, ignored: 0 }),
      publish: () => {},
    });
    events.length = 0;
    await finish.archive('k-1', true);
    expect(calls).toEqual(['kill @2 k-1']);
    const tail = events.filter((e) => e.type === 'session.removed' || e.type === 'archive');
    expect(tail).toEqual([
      { type: 'session.removed', id: 'k-1' },
      { type: 'archive', count: 1 },
    ]);
    expect(source.list().map((s) => s.id)).not.toContain('k-1');
    expect(source.archivedList()).toEqual([
      {
        id: 'k-1',
        project: 'shop',
        task: 'Fix the cart total',
        branch: 'kage/fix-the-cart-total',
        archivedAt: Date.now(),
      },
    ]);
    expect(source.archivedCount()).toBe(1);
    expect(store.saves.at(-1)?.[0]).toMatchObject({ archived: true, archivedAt: Date.now() });
    // The window-close listing that follows sends nothing for the hidden session.
    events.length = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.filter((e) => e.type === 'session.updated')).toEqual([]);
  });

  it('restore stamps restoredAt, emits session.updated (status ended), then archive {count: 0}', async () => {
    const { source, events, store } = setup({
      records: [rec({ archived: true, archivedAt: T0 - 1000, doneAt: T0 - 2000 })],
    });
    await source.start();
    expect(source.list()).toEqual([]);
    expect(source.archivedCount()).toBe(1);
    events.length = 0;
    await source.setFlags('k-1', { archived: false });
    expect(events.map((e) => e.type)).toEqual(['session.updated', 'archive']);
    expect(events[0]).toMatchObject({
      type: 'session.updated',
      session: { id: 'k-1', status: 'ended', archived: false },
    });
    expect(events[1]).toEqual({ type: 'archive', count: 0 });
    expect(source.list().map((s) => s.id)).toEqual(['k-1']);
    expect(store.saves.at(-1)?.[0]).toMatchObject({
      archived: false,
      archivedAt: null,
      restoredAt: Date.now(),
      doneAt: T0 - 2000,
    });
  });

  it('archive then restore of the same session sends a fresh session.updated', async () => {
    const { source, updates } = setup({ records: [rec()] });
    await source.start();
    await source.setFlags('k-1', { archived: true });
    const n = updates('k-1').length;
    await source.setFlags('k-1', { archived: false });
    expect(updates('k-1').length).toBe(n + 1);
  });

  it('archivedList() is newest first and capped at LIMITS.archived', async () => {
    const records = Array.from({ length: LIMITS.archived + 5 }, (_, i) =>
      rec({ kageId: `k-${i}`, windowId: null, archived: true, archivedAt: T0 - 1_000_000 + i * 7 }),
    );
    const { source } = setup({ records: [...records.reverse(), rec({ kageId: 'live' })] });
    await source.start();
    const list = source.archivedList();
    expect(list).toHaveLength(LIMITS.archived);
    expect(list[0]?.id).toBe(`k-${LIMITS.archived + 4}`);
    const times = list.map((s) => s.archivedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(source.archivedCount()).toBe(LIMITS.archived + 5);
  });

  it('a failed save leaves the flags as they were and emits nothing', async () => {
    const { source, store, events } = setup({ records: [rec()] });
    await source.start();
    store.fail = 1;
    events.length = 0;
    await expect(source.setFlags('k-1', { archived: true })).rejects.toThrow('disk full');
    expect(events).toEqual([]);
    expect(source.finishTarget('k-1')?.record).toMatchObject({ archived: false, archivedAt: null });
    expect(source.list().map((s) => s.id)).toEqual(['k-1']);
  });

  it('finishTarget gives a copy of the record, the window and the status; external sessions have no record', async () => {
    const { source } = setup({
      windows: [kageWin(), win({ windowId: '@7', paneId: '%7' })],
      records: [rec()],
    });
    await source.start();
    const t = source.finishTarget('k-1');
    expect(t).toMatchObject({ id: 'k-1', windowId: '@2', external: false });
    if (t?.record) t.record.pinned = true;
    expect(source.finishTarget('k-1')?.record?.pinned).toBe(false);
    expect(source.finishTarget('ext-@7')).toMatchObject({
      record: null,
      windowId: '@7',
      external: true,
    });
    expect(source.finishTarget('nope')).toBeNull();
  });
});

describe('LiveSource: terminal (phase 4 Task 12)', () => {
  it('terminalTarget gives the window, pane, kage id, ownership and status; null only for an unknown id', async () => {
    const { source } = setup({
      windows: [kageWin(), win({ windowId: '@7', paneId: '%7' })],
      records: [rec(), rec({ kageId: 'k-2', worktree: `${ROOT}/shop/.worktrees/other` })],
    });
    await source.start();
    expect(source.terminalTarget('k-1')).toEqual({
      windowId: '@2',
      paneId: '%2',
      kageId: 'k-1',
      external: false,
      status: source.get('k-1')?.status,
    });
    expect(source.terminalTarget('ext-@7')).toMatchObject({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      external: true,
    });
    // A record with no window: known, so the terminal says it ended (4409), not 4404.
    expect(source.terminalTarget('k-2')).toMatchObject({ windowId: null, paneId: null });
    expect(source.terminalTarget('nope')).toBeNull();
  });

  it("windowIdle(window) touches its record session's auto-archive check (F11); others do nothing", async () => {
    const { source, auto } = setup({
      windows: [kageWin(), win({ windowId: '@7', paneId: '%7' })],
      records: [rec()],
    });
    await source.start();
    auto.calls = [];
    source.windowIdle('@2');
    source.windowIdle('@7');
    source.windowIdle('@99');
    expect(auto.calls).toEqual(['touch k-1']);
  });
});

describe('LiveSource: auto-archive (phase 4 Task 5)', () => {
  const cand = (over: Record<string, unknown> = {}) => ({
    id: 'k-1',
    repo: join(ROOT, 'shop'),
    worktree: `${ROOT}/shop/.worktrees/fix-the-cart-total`,
    branch: 'kage/fix-the-cart-total',
    base: 'main',
    baseCommit: 'b'.repeat(40),
    doneAt: T0 - 5000,
    ageFrom: T0 - 5000,
    ...over,
  });

  it('start() starts the auto-archiver after the records are loaded and reconciled; stop() stops it', async () => {
    const { source, auto } = setup({
      records: [rec({ doneAt: T0 - 5000, base: 'main', baseCommit: 'b'.repeat(40) })],
    });
    await source.start();
    expect(auto.calls).toEqual(['start']);
    expect(auto.host?.autoCandidates()).toEqual([cand()]);
    await source.stop();
    expect(auto.calls).toEqual(['start', 'stop']);
  });

  it("a record session's Stop → touch(id), also when it was already done", async () => {
    const { source, hooks, auto } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    auto.calls = [];
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    expect(auto.calls).toContain('touch k-1');
    auto.calls = [];
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(auto.calls).toEqual(['touch k-1']);
  });

  it('a move into ended touches; a move back to running syncs (the candidate left)', async () => {
    const { source, hooks, auto } = setup({ windows: [kageWin()], records: [rec()] });
    await source.start();
    hooks.fire(hook('Stop', '%2'));
    await flush();
    auto.calls = [];
    hooks.fire(hook('UserPromptSubmit', '%2'));
    expect(auto.calls).toEqual(['sync']);
    auto.calls = [];
    hooks.fire(hook('SessionEnd', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(auto.calls).toContain('touch k-1');
  });

  it('pin, unpin, archive and restore each → sync()', async () => {
    const { source, auto } = setup({ records: [rec({ doneAt: T0 - 1000 })] });
    await source.start();
    for (const f of [
      { pinned: true },
      { pinned: false },
      { archived: true },
      { archived: false },
    ]) {
      auto.calls = [];
      await source.setFlags('k-1', f);
      expect(auto.calls, JSON.stringify(f)).toEqual(['sync']);
    }
    // No change: no save, no sync.
    auto.calls = [];
    await source.setFlags('k-1', { pinned: false });
    expect(auto.calls).toEqual([]);
  });

  it('a new record (adopt) and an abandoned launch → sync()', async () => {
    const { source, auto } = setup();
    await source.start();
    auto.calls = [];
    await source.adopt(rec({ kageId: 'k-9', windowId: null }));
    expect(auto.calls).toEqual(['sync']);
    auto.calls = [];
    await source.abandon('k-9');
    expect(auto.calls).toContain('sync');
  });

  it('candidates: done or ended record sessions; never external, running, needs-you, pinned or archived', async () => {
    const { source, hooks, auto } = setup({
      windows: [
        kageWin(),
        kageWin({ windowId: '@3', kageId: 'k-run', paneId: '%3' }),
        win({ windowId: '@7', paneId: '%7', command: 'claude' }),
      ],
      records: [
        rec({ base: 'main', baseCommit: 'b'.repeat(40) }),
        rec({ kageId: 'k-run', windowId: '@3', branch: 'kage/run' }),
        rec({ kageId: 'k-pin', windowId: null, pinned: true, doneAt: T0 - 1 }),
        rec({ kageId: 'k-arch', windowId: null, archived: true, archivedAt: T0, doneAt: T0 - 1 }),
        rec({ kageId: 'k-end', windowId: null, project: 'blog', doneAt: T0 - 99 }),
      ],
    });
    await source.start();
    hooks.fire(hook('Stop', '%2'));
    hooks.fire(hook('UserPromptSubmit', '%3', { sessionId: 's-3' }));
    hooks.fire(hook('Stop', '%7', { sessionId: 's-7' }));
    await flush();
    expect(source.get('k-run')?.status).toBe('running');
    expect(source.get('ext-@7')?.status).toBe('done');
    const ids = (auto.host?.autoCandidates() ?? []).map((c) => c.id).sort();
    expect(ids).toEqual(['k-1', 'k-end']);
    const end = auto.host?.autoCandidates().find((c) => c.id === 'k-end');
    expect(end).toMatchObject({ repo: join(ROOT, 'blog'), doneAt: T0 - 99 });
    // needs-you is never a candidate either.
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('needs-you');
    expect((auto.host?.autoCandidates() ?? []).map((c) => c.id)).toEqual(['k-end']);
  });

  it('F2: a restored session is no candidate until its next done', async () => {
    const { source, hooks, auto } = setup({
      windows: [kageWin()],
      records: [rec({ archived: true, archivedAt: T0 - 1000, doneAt: T0 - 30 * 86_400_000 })],
    });
    await source.start();
    await source.setFlags('k-1', { archived: false });
    expect(auto.host?.autoCandidates()).toEqual([]);
    vi.advanceTimersByTime(1000);
    hooks.fire(hook('UserPromptSubmit', '%2'));
    vi.advanceTimersByTime(1000);
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect((auto.host?.autoCandidates() ?? []).map((c) => [c.id, c.doneAt])).toEqual([
      ['k-1', Date.now()],
    ]);
  });

  it('F11: a session with an open terminal is no candidate', async () => {
    const { source, auto, terminals } = setup({ records: [rec({ doneAt: T0 - 1 })] });
    await source.start();
    expect((auto.host?.autoCandidates() ?? []).map((c) => c.id)).toEqual(['k-1']);
    terminals.add('k-1');
    expect(auto.host?.autoCandidates()).toEqual([]);
  });

  it('onLoaded runs once, after the loaded sessions are emitted and before early hooks replay', async () => {
    let atLoaded: Session[] | null = null;
    let calls = 0;
    const ctx = setup({
      windows: [kageWin()],
      records: [rec()],
      onLoaded: () => {
        calls += 1;
        atLoaded = ctx.updates('k-1');
      },
    });
    const started = ctx.source.start();
    // Hooks that arrive while start() loads are kept and replayed once it is ready.
    ctx.hooks.fire(hook('SessionStart', '%2'));
    ctx.hooks.fire(hook('PreToolUse', '%2'));
    await started;
    expect(calls).toBe(1);
    const seen = atLoaded as Session[] | null;
    expect(seen?.length).toBeGreaterThan(0);
    expect(seen?.some((x) => x.status === 'running')).toBe(false);
    expect(ctx.updates('k-1').at(-1)?.status).toBe('running');
  });

  it('no touch or sync while start() reconciles (only start, once it is ready)', async () => {
    const { source, auto } = setup({
      windows: [kageWin({ command: 'bash' })],
      records: [rec(), rec({ kageId: 'k-2', windowId: null })],
    });
    await source.start();
    expect(auto.calls).toEqual(['start']);
  });
});

describe('LiveSource: auto-archive fix round 1 (R69)', () => {
  const DAY = 86_400_000;

  it('unpin stamps unpinnedAt and saves it; pin leaves it; the candidate ageFrom is the latest of done, restore and unpin', async () => {
    const { source, store, auto } = setup({
      records: [rec({ pinned: true, doneAt: T0 - 20 * DAY, restoredAt: T0 - 30 * DAY })],
    });
    await source.start();
    expect(auto.host?.autoCandidates()).toEqual([]);
    vi.advanceTimersByTime(1000);
    await source.setFlags('k-1', { pinned: false });
    expect(store.saves.at(-1)?.[0]).toMatchObject({ pinned: false, unpinnedAt: T0 + 1000 });
    expect(auto.host?.autoCandidates()[0]).toMatchObject({
      doneAt: T0 - 20 * DAY,
      ageFrom: T0 + 1000,
    });
    vi.advanceTimersByTime(1000);
    await source.setFlags('k-1', { pinned: true });
    expect(store.saves.at(-1)?.[0]).toMatchObject({ pinned: true, unpinnedAt: T0 + 1000 });
  });

  it('ageFrom is doneAt when there was no later unpin or restore', async () => {
    const { source, auto } = setup({
      records: [rec({ doneAt: T0 - 3 * DAY, restoredAt: T0 - 9 * DAY, unpinnedAt: T0 - 8 * DAY })],
    });
    await source.start();
    expect(auto.host?.autoCandidates()[0]?.ageFrom).toBe(T0 - 3 * DAY);
  });

  it('unpinning a session done 20 days ago does not archive it until 14 days after the unpin (real AutoArchiver)', async () => {
    const archived: string[] = [];
    const { source } = setup({
      records: [rec({ windowId: null, pinned: true, doneAt: T0 - 20 * DAY })],
      auto: (host) =>
        new AutoArchiver({
          config: { onMerge: false, afterDays: 14 },
          candidates: () => host.autoCandidates(),
          state: async () => {
            throw new Error('no git in this test');
          },
          archive: async (id) => {
            archived.push(id);
          },
          confirm: async () => true,
          gitDir: async (repo) => repo,
          watch: () => ({ close() {} }),
        }),
    });
    await source.start();
    await source.setFlags('k-1', { pinned: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(archived).toEqual([]);
    await vi.advanceTimersByTimeAsync(14 * DAY - 2000);
    expect(archived).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(archived).toEqual(['k-1']);
    await source.stop();
  });
});

describe('LiveSource: resume (phase 4 Task 7)', () => {
  const OLD: DisplayLine[] = [
    { kind: 'say', text: 'Fixed the total.' },
    { kind: 'tool', text: 'Bash', detail: 'npm test' },
  ];
  const IDLE = ['', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');
  const ended = () => rec({ windowId: '@2', sessionId: 's-1', transcriptPath: TRANSCRIPT });
  const resumedWin = (over: Partial<TmuxWindow> = {}) =>
    kageWin({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      activity: Math.floor(T0 / 1000),
      ...over,
    });
  async function endedSession() {
    const s = setup({ records: [ended()], tails: { [TRANSCRIPT]: { lines: OLD.slice() } } });
    await s.source.start();
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    return s;
  }
  /** resumed, then the new window as the launcher opens and claims it. */
  async function resumedSession(capture = IDLE) {
    const s = await endedSession();
    vi.setSystemTime(T0 + 60_000);
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    s.tmux.setCapture('%7', capture);
    s.source.claim('k-1', '@7', '%7');
    await flush();
    return s;
  }

  it('resumed: ended → running, "Starting Claude…", statusSince now; emits; re-syncs auto-archive', async () => {
    const { source, updates, auto, store } = await endedSession();
    vi.setSystemTime(T0 + 60_000);
    auto.calls = [];
    source.resumed('k-1', 's-1');
    expect(updates('k-1').at(-1)).toMatchObject({
      status: 'running',
      now: 'Starting Claude…',
      statusSince: T0 + 60_000,
    });
    expect(auto.calls).toContain('sync');
    // A running session has no doneAt (auto-archive age restarts at its next done).
    await vi.advanceTimersByTimeAsync(600);
    expect(store.saves.at(-1)?.find((r) => r.kageId === 'k-1')?.doneAt).toBeNull();
  });

  it('resumed does nothing for a session that is not ended, an external one or an unknown id', async () => {
    const { source, updates } = setup({ windows: [kageWin(), win()], records: [rec()] });
    await source.start();
    await flush();
    const before = updates().length;
    const status = source.get('k-1')?.status;
    source.resumed('k-1', 's-1');
    source.resumed('ext-@1', 's-1');
    source.resumed('nope', 's-1');
    expect(updates().length).toBe(before);
    expect(source.get('k-1')?.status).toBe(status);
  });

  it('hasWindow: a listed window or a claim carries the kage id; an ended session without one has none', async () => {
    const s = setup({
      windows: [kageWin()],
      records: [rec(), rec({ kageId: 'k-2', windowId: null, branch: 'kage/other' })],
    });
    await s.source.start();
    await flush();
    expect(s.source.hasWindow('k-1')).toBe(true);
    expect(s.source.hasWindow('k-2')).toBe(false);
    expect(s.source.hasWindow('nope')).toBe(false);
    s.source.claim('k-2', '@9', '%9');
    expect(s.source.hasWindow('k-2')).toBe(true);
  });

  it('the new window keeps it running, "Starting Claude…" (P3F1), and the transcript keeps its lines', async () => {
    const { source, updates } = await resumedSession();
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    expect(source.lines('k-1')).toEqual(OLD);
    expect(updates('k-1').map((s) => s.status)).not.toContain('done');
  });

  it('a SessionStart (source resume) does not flip it to done before the first UserPromptSubmit', async () => {
    const { source, hooks, tails, updates, store } = await resumedSession();
    const n = updates('k-1').length;
    hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await flush();
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    expect(source.lines('k-1')).toEqual(OLD);
    // The same transcript file goes on: new lines append to the old ones.
    tails.at(-1)?.push([{ kind: 'say', text: 'Back again.' }]);
    expect(source.lines('k-1')).toEqual([...OLD, { kind: 'say', text: 'Back again.' }]);
    hooks.fire(hook('UserPromptSubmit', '%7'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    hooks.fire(hook('Stop', '%7'));
    await flush();
    const statuses = updates('k-1')
      .slice(n)
      .map((s) => s.status);
    expect(statuses.indexOf('done')).toBe(statuses.length - 1);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.saves.at(-1)?.find((r) => r.kageId === 'k-1')).toMatchObject({
      sessionId: 's-1',
      transcriptPath: TRANSCRIPT,
      windowId: '@7',
    });
  });

  it('R101: a SessionStart that lands while a listing attaches the resumed window (before resumed()) is kept: done, not stuck running', async () => {
    const gate: TailGate = { wait: null };
    const s = setup({
      records: [ended()],
      tails: { [TRANSCRIPT]: { lines: OLD.slice() } },
      tailGate: gate,
    });
    await s.source.start();
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    // The launcher's window is tagged and listed before it calls resumed(); the tail start blocks.
    const open = holdTails(gate);
    s.tmux.windows = [resumedWin({ kageId: 'k-1' })];
    s.tmux.setCapture('%7', IDLE);
    s.watcher.emit({ type: 'windows-changed' });
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    // The resumed claude's SessionStart lands during that await.
    s.hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await flush();
    open();
    await flush();
    s.source.resumed('k-1', 's-1');
    s.source.claim('k-1', '@7', '%7');
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
  });

  it('R101: resumeAborted (the window never opened) ends it again with no wait or resume left; a later hook-less window is not "Starting Claude…"', async () => {
    const { source, updates } = await endedSession();
    source.resumed('k-1', 's-1');
    expect(source.get('k-1')?.status).toBe('running');
    source.resumeAborted('k-1');
    expect(source.get('k-1')).toMatchObject({ status: 'ended' });
    expect(source.get('k-1')?.now).toBeUndefined();
    expect(updates('k-1').at(-1)?.status).toBe('ended');
    // Nothing armed: no fallback moves it later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.get('k-1')?.status).toBe('ended');
    // Not ended by a resume (or unknown): left alone.
    const n = updates().length;
    source.resumeAborted('k-1');
    source.resumeAborted('nope');
    expect(updates().length).toBe(n);
  });

  it('R101: resumed() before the window is listed (the launcher order): the attach keeps the wait, and the fallback reaches done', async () => {
    const gate: TailGate = { wait: null };
    const s = setup({
      records: [ended()],
      tails: { [TRANSCRIPT]: { lines: OLD.slice() } },
      tailGate: gate,
    });
    await s.source.start();
    await flush();
    s.source.resumed('k-1', 's-1');
    await flush();
    const open = holdTails(gate);
    s.tmux.windows = [resumedWin({ kageId: 'k-1' })];
    s.tmux.setCapture('%7', IDLE);
    s.source.claim('k-1', '@7', '%7');
    await flush();
    s.hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await flush();
    open();
    await flush();
    expect(s.source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
  });

  it('with no prompt, the 10 s fallback after SessionStart makes it done at the idle box', async () => {
    const { source, hooks } = await resumedSession();
    hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
  });

  it('R63: a SessionEnd with another session id is a failed resume: ended, the record keeps its id, the error is reported', async () => {
    const s = setup({ records: [ended()], tails: { [TRANSCRIPT]: { lines: OLD.slice() } } });
    const logs: string[] = [];
    // The same source with a log (serve passes io.err).
    const source = new LiveSource({
      tmux: s.tmux,
      watcher: s.watcher,
      hooks: s.hooks,
      store: s.store,
      tail: (path) => new FakeTail(path, path === TRANSCRIPT ? { lines: OLD } : {}),
      projectsRoot: ROOT,
      log: (line) => logs.push(line),
    });
    const events: SourceEvent[] = [];
    source.subscribe((e) => events.push(e));
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    source.claim('k-1', '@7', '%7');
    await flush();
    s.hooks.fire(
      hook('SessionEnd', '%7', {
        sessionId: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
        transcriptPath: '/home/dev/.claude/projects/-x/7d444840.jsonl',
      }),
    );
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.finishTarget('k-1')?.record).toMatchObject({
      sessionId: 's-1',
      transcriptPath: TRANSCRIPT,
    });
    const failed = "Claude couldn't find this conversation, so the session wasn't resumed.";
    expect(source.lines('k-1')).toEqual([...OLD, { kind: 'out', text: failed }]);
    expect(events).toContainEqual({
      type: 'session.lines',
      id: 'k-1',
      lines: [{ kind: 'out', text: failed }],
      reset: false,
    });
    expect(logs).toEqual([`kage: session k-1 wasn't resumed: Claude found no conversation s-1`]);
    // The window then closes; it stays ended with the old link, and can be resumed again.
    s.tmux.windows = [];
    s.watcher.emit({ type: 'windows-changed' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.finishTarget('k-1')?.record?.sessionId).toBe('s-1');
    expect(source.lines('k-1')).toEqual([...OLD, { kind: 'out', text: failed }]);
    await source.stop();
  });

  it('a resume that links the same session id is not a failure; a SessionEnd after it ends the session as usual', async () => {
    const { source, hooks, store } = await resumedSession();
    hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    hooks.fire(hook('UserPromptSubmit', '%7'));
    hooks.fire(hook('Stop', '%7'));
    hooks.fire(hook('SessionEnd', '%7'));
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).toEqual(OLD);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.saves.at(-1)?.find((r) => r.kageId === 'k-1')?.sessionId).toBe('s-1');
  });

  it('a --continue resume (no session id) links whatever session Claude picks', async () => {
    const s = setup({ records: [rec({ windowId: '@2' })] });
    await s.source.start();
    await flush();
    s.source.resumed('k-1', null);
    s.tmux.windows = [resumedWin()];
    s.source.claim('k-1', '@7', '%7');
    await flush();
    s.hooks.fire(hook('SessionStart', '%7', { source: 'resume', sessionId: 's-9' }));
    await flush();
    expect(s.source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    expect(s.source.finishTarget('k-1')?.record?.sessionId).toBe('s-9');
  });

  it("a resume replays the old transcript's open question without showing it: running, no needs-you, until a new question after the first hook", async () => {
    const old: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
    const s = setup({
      records: [ended()],
      tails: { [TRANSCRIPT]: { lines: OLD.slice(), question: old } },
    });
    await s.source.start();
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    const pings: string[] = [];
    const notifier = new Notifier({
      source: s.source,
      send: async (p) => {
        pings.push(p.title);
        return true;
      },
      link: () => null,
      hostName: 'box',
      options: NOTIFY_DEFAULTS,
      log: () => {},
    });
    notifier.start();
    const before = s.updates('k-1').length;
    vi.setSystemTime(T0 + 60_000);
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    s.tmux.setCapture('%7', IDLE);
    s.source.claim('k-1', '@7', '%7');
    await flush();
    // Past the notifier's 3 s hold.
    await vi.advanceTimersByTimeAsync(3_500);
    const during = s.updates('k-1').slice(before);
    expect(during.some((u) => u.status === 'needs-you')).toBe(false);
    expect(s.source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    expect(s.source.get('k-1')?.question).toBeUndefined();
    expect(pings).toEqual([]);
    // The new claude's first hook: the old question (still last in the file) stays hidden.
    s.hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await flush();
    s.tails.at(-1)?.push([{ kind: 'say', text: 'Back.' }]);
    await vi.advanceTimersByTimeAsync(600);
    expect(s.source.get('k-1')?.status).not.toBe('needs-you');
    // A new question asked after it shows.
    const q: Question = { text: 'Add a test?', options: ['Yes', 'No'] };
    s.hooks.fire(hook('UserPromptSubmit', '%7'));
    await flush();
    s.tails.at(-1)?.push([], { question: q, now: 'Asking a question' });
    await vi.advanceTimersByTimeAsync(600);
    expect(s.source.get('k-1')).toMatchObject({ status: 'needs-you', question: q });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatch(/needs you$/);
    notifier.stop();
  });
});

describe('LiveSource: phase 5 residuals (phase 6 Task 0)', () => {
  const OLD: DisplayLine[] = [
    { kind: 'say', text: 'Fixed the total.' },
    { kind: 'tool', text: 'Bash', detail: 'npm test' },
  ];
  const IDLE = ['', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');
  const resumedWin = (over: Partial<TmuxWindow> = {}) =>
    kageWin({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      activity: Math.floor(T0 / 1000),
      ...over,
    });
  const ended = () => rec({ windowId: '@2', sessionId: 's-1', transcriptPath: TRANSCRIPT });
  const A: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
  const B: Question = { text: 'Add a test?', options: ['Yes', 'No'] };
  async function replaying(capture: string) {
    const s = setup({
      records: [ended()],
      tails: { [TRANSCRIPT]: { lines: OLD.slice(), question: A } },
    });
    await s.source.start();
    await flush();
    vi.setSystemTime(T0 + 60_000);
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    s.tmux.setCapture('%7', capture);
    s.source.claim('k-1', '@7', '%7');
    await flush();
    expect(s.source.get('k-1')?.status).not.toBe('needs-you');
    return s;
  }

  it('R104: a hookless resumed session drops the resume when its first-prompt wait ends; a new tail question then shows', async () => {
    const s = await replaying('Loading…');
    // The P4F1 looks run their 60 s; then the idle rule gives done.
    await vi.advanceTimersByTimeAsync(70_000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    const tail = s.tails.at(-1);
    tail?.push([], { question: B, now: 'Asking a question' });
    await vi.advanceTimersByTimeAsync(600);
    expect(s.source.get('k-1')).toMatchObject({ status: 'needs-you', question: B });
    expect(s.source.target('k-1')?.promptKind).toBe('ask');
    // B answered: a later tail change with B gone shows nothing, and no needs-you comes back.
    tail?.push([], { question: null, now: null });
    s.hooks.fire(hook('UserPromptSubmit', '%7'));
    await flush();
    tail?.push([{ kind: 'say', text: 'ok' }]);
    await vi.advanceTimersByTimeAsync(600);
    expect(s.source.get('k-1')?.status).not.toBe('needs-you');
  });

  it('R104: the P3F1 fallback also ends the resume', async () => {
    const s = await replaying(IDLE);
    s.hooks.fire(hook('SessionStart', '%7', { source: 'resume' }));
    await vi.advanceTimersByTimeAsync(10_500);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    s.tails.at(-1)?.push([], { question: B, now: 'Asking a question' });
    await vi.advanceTimersByTimeAsync(600);
    expect(s.source.get('k-1')).toMatchObject({ status: 'needs-you', question: B });
  });
});

describe('LiveSource: resume hardening (Task 7 review)', () => {
  const resumedWin = (over: Partial<TmuxWindow> = {}) =>
    kageWin({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      activity: Math.floor(T0 / 1000),
      ...over,
    });
  const ended = () => rec({ windowId: '@2', sessionId: 's-1', transcriptPath: TRANSCRIPT });
  const failed = "Claude couldn't find this conversation, so the session wasn't resumed.";

  it('a claim whose window a later listing does not show is dropped: hasWindow is false again', async () => {
    const { source } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.claim('k-1', '@9', '%9');
    expect(source.hasWindow('k-1')).toBe(true);
    // The claim's own re-list started after it and found no @9: the window died at launch.
    await flush();
    expect(source.hasWindow('k-1')).toBe(false);
  });

  it('a listing that started before the claim does not drop it', async () => {
    const { source, tmux, watcher } = setup({ records: [ended()] });
    await source.start();
    await flush();
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' }); // this listing starts now, before the window exists
    tmux.windows = [resumedWin({ windowId: '@9', paneId: '%9' })];
    source.claim('k-1', '@9', '%9');
    await flush();
    expect(source.hasWindow('k-1')).toBe(true);
    expect(source.get('ext-@9')).toBeUndefined();
    expect(source.finishTarget('k-1')?.windowId).toBe('@9');
  });

  it('a resumed window that vanishes before any hook ends the wait: a later claude is not "Starting Claude…" and is no failed resume', async () => {
    const s = setup({ records: [ended()] });
    await s.source.start();
    await flush();
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    s.source.claim('k-1', '@7', '%7');
    await flush();
    // claude exits back to a shell before sending any hook (#endInWindow)…
    s.tmux.windows = [resumedWin({ command: 'bash' })];
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    // …then someone starts claude there by hand: R21, done after its SessionStart.
    s.tmux.windows = [resumedWin()];
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    s.hooks.fire(hook('SessionStart', '%7', { source: 'startup', sessionId: 's-7' }));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    expect(s.source.get('k-1')?.now).toBeUndefined();
    expect(s.source.finishTarget('k-1')?.record?.sessionId).toBe('s-7');
  });

  it('a resumed window that is gone before any hook (#detach) clears the resume: a later SessionEnd with another id links', async () => {
    const s = setup({ records: [ended()] });
    await s.source.start();
    await flush();
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [resumedWin()];
    s.source.claim('k-1', '@7', '%7');
    await flush();
    s.tmux.windows = [];
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    expect(s.source.hasWindow('k-1')).toBe(false);
    // A window Kage opens later for the record (a second resume) is a fresh start.
    s.source.resumed('k-1', null);
    s.tmux.windows = [resumedWin({ windowId: '@8', paneId: '%8' })];
    s.source.claim('k-1', '@8', '%8');
    await flush();
    s.hooks.fire(hook('SessionEnd', '%8', { sessionId: 's-8' }));
    await flush();
    expect(s.source.lines('k-1')).not.toContainEqual({ kind: 'out', text: failed });
    expect(s.source.finishTarget('k-1')?.record?.sessionId).toBe('s-8');
  });

  it('with --continue (null), a SessionEnd naming any id is not a failed resume', async () => {
    const s = setup({ records: [ended()] });
    await s.source.start();
    await flush();
    s.source.resumed('k-1', null);
    s.tmux.windows = [resumedWin()];
    s.source.claim('k-1', '@7', '%7');
    await flush();
    s.hooks.fire(hook('SessionEnd', '%7', { sessionId: 's-other' }));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    expect(s.source.lines('k-1')).not.toContainEqual({ kind: 'out', text: failed });
    expect(s.source.finishTarget('k-1')?.record?.sessionId).toBe('s-other');
  });
});

describe('LiveSource: resume fix round 2 (a window that dies unseen)', () => {
  const ended = () => rec({ windowId: '@2', sessionId: 's-1', transcriptPath: TRANSCRIPT });

  it('a resumed window no listing ever shows ends the session: ended, the wait cleared, resumable again', async () => {
    const { source, updates } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    source.claim('k-1', '@9', '%9'); // the claim's own re-list finds no @9
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(updates('k-1').at(-1)).toMatchObject({ status: 'ended' });
    expect(source.get('k-1')?.now).toBeUndefined();
    expect(source.hasWindow('k-1')).toBe(false);
    // A later resume is allowed (ended, no window) and starts afresh.
    const t = source.finishTarget('k-1');
    expect(t).toMatchObject({ status: 'ended', windowId: null });
    source.resumed('k-1', 's-1');
    expect(source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
  });

  it('the cleared wait holds: a hook arriving later is no "Starting Claude…" and no failed resume', async () => {
    const { source, hooks, tmux, watcher } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    source.claim('k-1', '@9', '%9');
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    // The record's window shows up later, tagged (say, opened by hand), with another session.
    tmux.windows = [kageWin({ windowId: '@10', paneId: '%10' })];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    hooks.fire(hook('SessionEnd', '%10', { sessionId: 's-2' }));
    await flush();
    expect(source.lines('k-1')).not.toContainEqual({
      kind: 'out',
      text: "Claude couldn't find this conversation, so the session wasn't resumed.",
    });
    expect(source.finishTarget('k-1')?.record?.sessionId).toBe('s-2');
  });

  const failedLine = {
    kind: 'out',
    text: "Claude couldn't find this conversation, so the session wasn't resumed.",
  };
  const otherEnd = () =>
    hook('SessionEnd', '%7', { sessionId: '7d444840-9dc0-11d1-b245-5ffdce74fad2' });

  it('B34: a failed resume whose window dies before any listing still reports the failure (claimed by pane id)', async () => {
    const { source, hooks } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    source.claim('k-1', '@7', '%7'); // no listing ever shows @7
    hooks.fire(otherEnd());
    await vi.advanceTimersByTimeAsync(200);
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).toContainEqual(failedLine);
    expect(source.finishTarget('k-1')?.record?.sessionId).toBe('s-1');
  });

  it('B34: the SessionEnd that came before the claim (window already gone) is matched once the claim names its pane', async () => {
    const { source, hooks } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    hooks.fire(otherEnd());
    await vi.advanceTimersByTimeAsync(200); // the re-list finds no %7: the hook is set aside
    expect(source.lines('k-1')).not.toContainEqual(failedLine);
    source.claim('k-1', '@7', '%7');
    await vi.advanceTimersByTimeAsync(200);
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).toContainEqual(failedLine);
  });

  it('B34: a set-aside hook from another pane, or older than 5 s, is not replayed', async () => {
    const { source, hooks } = setup({ records: [ended()] });
    await source.start();
    await flush();
    source.resumed('k-1', 's-1');
    hooks.fire(hook('SessionEnd', '%8', { sessionId: 's-other' }));
    hooks.fire(otherEnd());
    await vi.advanceTimersByTimeAsync(6_000);
    source.claim('k-1', '@7', '%7');
    await vi.advanceTimersByTimeAsync(200);
    expect(source.get('k-1')?.status).toBe('ended');
    expect(source.lines('k-1')).not.toContainEqual(failedLine);
  });

  it('a launched window that dies unseen ends the launch too', async () => {
    const { source } = setup();
    await source.start();
    await source.adopt(rec({ kageId: 'k-9', windowId: null, branch: 'kage/x', createdAt: T0 }));
    source.claim('k-9', '@7', '%7');
    await flush();
    expect(source.get('k-9')?.status).toBe('ended');
  });
});

describe('LiveSource: a launch on its startup screens (P4F1)', () => {
  const launched = () =>
    rec({
      kageId: 'k-9',
      windowId: null,
      task: 'Add a dark mode',
      branch: 'kage/add-a-dark-mode',
      worktree: `${ROOT}/shop/.worktrees/add-a-dark-mode`,
      createdAt: T0,
    });
  const newWin = () =>
    win({
      windowId: '@7',
      paneId: '%7',
      kageId: null,
      command: 'claude',
      cwd: `${ROOT}/shop/.worktrees/add-a-dark-mode`,
      name: 'add-a-dark-mode',
      activity: Math.floor(T0 / 1000),
    });
  /** A launched window drawing (activity) for its first 5 s, its pane still blank. */
  async function loading() {
    const s = setup();
    await s.source.start();
    await s.source.adopt(launched());
    s.tmux.windows = [newWin()];
    s.tmux.setCapture('%7', '');
    s.source.claim('k-9', '@7', '%7');
    await flush();
    for (let t = 0; t < 5; t++) {
      s.watcher.emit({ type: 'activity', paneId: '%7' });
      await vi.advanceTimersByTimeAsync(1000);
    }
    return s;
  }

  it('activity stops at 5 s, the trust screen is drawn at 6 s: needs-you, never done', async () => {
    const s = await loading();
    await vi.advanceTimersByTimeAsync(1000);
    s.tmux.setCapture('%7', pane('real-trust-80'));
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(s.source.get('k-9')).toMatchObject({
      status: 'needs-you',
      question: { text: 'Trust this folder?', startup: true },
    });
    expect(s.updates('k-9').map((u) => u.status)).not.toContain('done');
  });

  it('a still pane with no screen yet stays running, "Starting Claude…", and is looked at again', async () => {
    const s = await loading();
    await vi.advanceTimersByTimeAsync(6000); // 11 s: the idle rule has run, the pane is blank
    expect(s.source.get('k-9')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    s.tmux.setCapture('%7', pane('real-trust-80'));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-9')?.status).toBe('needs-you');
    expect(s.updates('k-9').map((u) => u.status)).not.toContain('done');
  });

  it('the window dying still ends the wait', async () => {
    const s = await loading();
    await vi.advanceTimersByTimeAsync(6000);
    s.tmux.windows = [];
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(s.source.get('k-9')?.status).toBe('ended');
    const calls = s.tmux.captureCalls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.tmux.captureCalls.length).toBe(calls);
  });

  it('after the first hook the idle rule is the usual one', async () => {
    const s = await loading();
    s.hooks.fire(hook('UserPromptSubmit', '%7'));
    s.hooks.fire(hook('Stop', '%7'));
    await flush();
    expect(s.source.get('k-9')?.status).toBe('done');
  });

  it('the per-second look stops after 60 s: then the activity rule (done after 5 s idle)', async () => {
    const s = await loading();
    // The idle rule first looks at ~9 s; 60 s of looks later it gives up.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.source.get('k-9')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
    expect(s.source.get('k-9')?.status).toBe('done');
    const calls = s.tmux.captureCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.tmux.captureCalls.length).toBe(calls);
  });

  it('activity after the cap is the activity rule: running, then done 5 s after it stops', async () => {
    const s = await loading();
    await vi.advanceTimersByTimeAsync(70_000);
    await flush();
    expect(s.source.get('k-9')?.status).toBe('done');
    s.watcher.emit({ type: 'activity', paneId: '%7' });
    await flush();
    expect(s.source.get('k-9')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(s.source.get('k-9')?.status).toBe('done');
  });
});

describe('LiveSource: a turn that ends without a Stop (hardening Task 7: I2, M1, B26)', () => {
  const IDLE = ['● Fixed the total.', '', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');
  const BUSY = ['✻ Thinking… (esc to interrupt)', '', RULE, '❯ ', RULE, ''].join('\n');
  const DONE_LINE: DisplayLine = { kind: 'say', text: 'Fixed the total.' };

  /** A hooked turn whose tool ran; no Stop comes. */
  async function turn() {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.hooks.fire(hook('PostToolUse', '%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    return s;
  }

  it('a lost Stop: the turn ends in the transcript and the pane is idle, so the session is done 2 s later', async () => {
    const s = await turn();
    s.tmux.setCapture('%2', IDLE);
    s.auto.calls = [];
    s.preview.calls = [];
    const captures = s.tmux.captureCalls.length;
    s.tails[0]?.push([DONE_LINE], { now: null });
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.source.get('k-1')?.status).toBe('running');
    expect(s.tmux.captureCalls.length).toBe(captures);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    expect(s.tmux.captureCalls.length).toBe(captures + 1);
    expect(s.updates('k-1').at(-1)?.status).toBe('done');
    // As a Stop would: doneAt stamped and saved, auto-archive and the preview told.
    expect(s.auto.calls).toContain('touch k-1');
    expect(s.preview.calls).toContain('touch k-1 turn-end');
    const doneAt = Date.now();
    await vi.advanceTimersByTimeAsync(600);
    expect(s.store.saves.at(-1)?.find((r) => r.kageId === 'k-1')?.doneAt).toBe(doneAt);
    // One look, no timer left behind.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.tmux.captureCalls.length).toBe(captures + 1);
  });

  it('a hook within those 2 s cancels the check', async () => {
    const s = await turn();
    s.tmux.setCapture('%2', IDLE);
    const captures = s.tmux.captureCalls.length;
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(1000);
    // Claude goes on (a stale turn end, or the next tool): its hook wins.
    s.hooks.fire(hook('PreToolUse', '%2'));
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    expect(s.tmux.captureCalls.length).toBe(captures);
  });

  it('a hook during the check capture wins over it', async () => {
    const s = await turn();
    s.tmux.setCapture('%2', IDLE);
    let open = () => {};
    s.tmux.gate = new Promise<void>((r) => {
      open = r;
    });
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(2000);
    s.hooks.fire(hook('PreToolUse', '%2'));
    s.tmux.gate = null;
    open();
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
  });

  it('a busy footer at the check keeps it running', async () => {
    const s = await turn();
    s.tmux.setCapture('%2', BUSY);
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.source.get('k-1')?.status).toBe('running');
  });

  it('a prompt on screen at the check, or a failed capture, keeps it running', async () => {
    const s = await turn();
    s.tmux.setCapture('%2', pane('permission-bash'));
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    s.tmux.setCapture('%2', IDLE);
    s.tmux.failCaptures = 1;
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
  });

  it('a turn end while done arms nothing (the records after a Stop)', async () => {
    const s = await turn();
    s.hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    s.tmux.setCapture('%2', IDLE);
    // stop_hook_summary and turn_duration land after the Stop.
    const captures = s.tmux.captureCalls.length;
    s.tails[0]?.turnEnd();
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(s.tmux.captureCalls.length).toBe(captures);
    expect(s.source.get('k-1')?.status).toBe('done');
  });

  it('a fallback done pings like a Stop: from running, after 60 s of work', async () => {
    const s = await turn();
    const pings: string[] = [];
    const notifier = new Notifier({
      source: s.source,
      send: async (p) => {
        pings.push(p.title);
        return true;
      },
      link: () => null,
      hostName: 'box',
      options: { ...NOTIFY_DEFAULTS, onDone: true },
      log: () => {},
    });
    notifier.start();
    await vi.advanceTimersByTimeAsync(61_000);
    s.tmux.setCapture('%2', IDLE);
    s.tails[0]?.turnEnd();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    await vi.advanceTimersByTimeAsync(3500);
    expect(pings).toEqual(['shop is done']);
    notifier.stop();
  });

  it('a resume over a transcript ending in an interrupt stays Starting Claude…', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-ls-'));
    try {
      const path = join(dir, 's-1.jsonl');
      const r = (o: unknown) => `${JSON.stringify(o)}\n`;
      writeFileSync(
        path,
        r({ type: 'user', message: { role: 'user', content: 'Run the tests' } }) +
          r({
            type: 'assistant',
            message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Running.' }] },
          }) +
          r({ type: 'user', message: { content: '[Request interrupted by user]' } }),
      );
      const starts: Promise<void>[] = [];
      const s = setup({
        records: [rec({ sessionId: 's-1', transcriptPath: path })],
        tail: (p) => {
          const t = new TranscriptTail(p, { watch: false });
          const start = t.start.bind(t);
          t.start = () => {
            const started = start();
            starts.push(started);
            return started;
          };
          return t;
        },
      });
      await s.source.start();
      await Promise.all(starts);
      expect(s.source.get('k-1')?.status).toBe('ended');
      const from = s.updates('k-1').length;
      vi.setSystemTime(T0 + 60_000);
      s.source.resumed('k-1', 's-1');
      await Promise.all(starts);
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(s.source.get('k-1')).toMatchObject({ status: 'running', now: 'Starting Claude…' });
      expect(
        s
          .updates('k-1')
          .slice(from)
          .map((u) => u.status),
      ).not.toContain('done');
      await vi.advanceTimersByTimeAsync(600);
      expect(s.store.saves.at(-1)?.find((x) => x.kageId === 'k-1')?.doneAt).toBeNull();
      await s.source.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('B26: an Esc inside the reply window', () => {
    async function prompted() {
      const s = setup({ windows: [kageWin()], records: [rec()] });
      s.tmux.setCapture('%2', pane('permission-bash'));
      await s.source.start();
      s.hooks.fire(hook('SessionStart', '%2'));
      s.hooks.fire(hook('PreToolUse', '%2'));
      s.hooks.fire(hook('PermissionRequest', '%2'));
      await flush();
      expect(s.source.get('k-1')?.status).toBe('needs-you');
      return s;
    }
    async function replied() {
      const s = await prompted();
      s.source.markReplying('k-1');
      s.source.markReplied('k-1');
      expect(s.source.get('k-1')?.status).toBe('running');
      return s;
    }

    it('an Esc swallowed by the reply window still ends in done when the pane is idle', async () => {
      const s = await replied();
      s.tmux.setCapture('%2', IDLE);
      await vi.advanceTimersByTimeAsync(1000);
      // The user's own Esc in the terminal: taken for Kage's, so no done at once.
      s.tails[0]?.interrupt();
      expect(s.source.get('k-1')?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(s.source.get('k-1')?.status).toBe('done');
    });

    it("Kage's own Escape, with Claude busy on the reply, stays running", async () => {
      const s = await replied();
      s.tmux.setCapture('%2', BUSY);
      await vi.advanceTimersByTimeAsync(300);
      s.tails[0]?.interrupt();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(s.source.get('k-1')?.status).toBe('running');
    });

    it("Kage's Escape before markReplied (still needs-you) arms nothing", async () => {
      const s = await prompted();
      s.source.markReplying('k-1');
      s.tails[0]?.interrupt();
      s.tmux.setCapture('%2', IDLE);
      const captures = s.tmux.captureCalls.length;
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(s.tmux.captureCalls.length).toBe(captures);
      expect(s.source.get('k-1')?.status).toBe('needs-you');
    });
  });
});

describe('LiveSource: history at start and done tails (hardening Task 9: I4, P7)', () => {
  const endedRec = (i: number, over: Partial<SessionRecord> = {}) =>
    rec({
      kageId: `k-${i}`,
      windowId: null,
      branch: `kage/task-${i}`,
      sessionId: `s-${i}`,
      transcriptPath: `/home/dev/.claude/projects/-home-dev-projects-shop/s-${i}.jsonl`,
      doneAt: T0 - 10_000,
      ...over,
    });
  const archivedRec = (i: number) =>
    endedRec(i, { archived: true, archivedAt: T0 - 1_000_000 + i });

  it('50 archived records start no tail; GET /api/archive still lists them', async () => {
    const records = Array.from({ length: 50 }, (_, i) => archivedRec(i));
    const { source, tails } = setup({ records });
    await source.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tails).toHaveLength(0);
    expect(source.archivedCount()).toBe(50);
    const list = source.archivedList();
    expect(list).toHaveLength(Math.min(50, LIMITS.archived));
    expect(list[0]).toMatchObject({ id: 'k-49', project: 'shop', branch: 'kage/task-49' });
    // FinishActions still finds them, so restore works.
    expect(source.finishTarget('k-3')).toMatchObject({
      id: 'k-3',
      windowId: null,
      status: 'ended',
      external: false,
      record: { archived: true },
    });
    expect(source.list()).toEqual([]);
    await source.stop();
  });

  it('a start with 500 archived records reads no archived transcript', async () => {
    const records = Array.from({ length: 500 }, (_, i) => archivedRec(i));
    const { source, tails } = setup({ records: [...records, endedRec(900)] });
    await source.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tails.map((t) => t.path)).toEqual([endedRec(900).transcriptPath]);
    await source.stop();
  });

  it('restoring an archived record reads its transcript and shows its lines', async () => {
    const r = archivedRec(1);
    const lines: DisplayLine[] = [{ kind: 'say', text: 'The cart total is fixed.' }];
    const { source, tails, events, lineEvents } = setup({
      records: [r],
      tails: { [r.transcriptPath as string]: { lines } },
    });
    await source.start();
    expect(tails).toHaveLength(0);
    events.length = 0;
    await source.setFlags('k-1', { archived: false });
    await flush();
    expect(tails).toHaveLength(1);
    expect(tails[0]?.stopped).toBe(true);
    expect(source.lines('k-1')).toEqual(lines);
    expect(events.map((e) => e.type)).toEqual(['session.updated', 'archive', 'session.lines']);
    expect(lineEvents('k-1').at(-1)).toEqual({
      type: 'session.lines',
      id: 'k-1',
      lines,
      reset: true,
    });
    expect(source.list().map((s) => s.id)).toEqual(['k-1']);
    await source.stop();
  });

  it('archiving drops the session after session.removed; restoring builds it again', async () => {
    const lines: DisplayLine[] = [{ kind: 'say', text: 'Ready.' }];
    const r = endedRec(1);
    const { source, tails, events } = setup({
      records: [r],
      tails: { [r.transcriptPath as string]: { lines } },
    });
    await source.start();
    await flush();
    events.length = 0;
    await source.setFlags('k-1', { archived: true });
    expect(events.map((e) => e.type)).toEqual(['session.removed', 'archive']);
    expect(source.lines('k-1')).toEqual([]);
    expect(source.get('k-1')?.archived).toBe(true);
    await source.setFlags('k-1', { archived: false });
    await flush();
    expect(tails).toHaveLength(2);
    expect(source.lines('k-1')).toEqual(lines);
    await source.stop();
  });

  it("F28: a restored record ending in an interrupt doesn't blink done", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-ls-'));
    try {
      const path = join(dir, 's-1.jsonl');
      const j = (o: unknown) => `${JSON.stringify(o)}\n`;
      writeFileSync(
        path,
        j({ type: 'user', message: { role: 'user', content: 'Run the tests' } }) +
          j({ type: 'user', message: { content: '[Request interrupted by user]' } }),
      );
      const s = setup({
        records: [endedRec(1, { transcriptPath: path, archived: true, archivedAt: T0 - 5 })],
        tail: (p) => new TranscriptTail(p, { watch: false }),
      });
      await s.source.start();
      await s.source.setFlags('k-1', { archived: false });
      await vi.advanceTimersByTimeAsync(3000);
      expect(s.source.get('k-1')?.status).toBe('ended');
      expect(s.updates('k-1').map((u) => u.status)).not.toContain('done');
      expect(s.source.lines('k-1').length).toBeGreaterThan(0);
      await s.source.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a hook that arrives during start is applied before the transcript reads finish', async () => {
    const gate: TailGate = { wait: null };
    const open = holdTails(gate);
    const ended = endedRec(5);
    const { source, hooks, tails } = setup({
      windows: [kageWin()],
      records: [rec(), ended],
      tailGate: gate,
    });
    const started = source.start();
    hooks.fire(hook('UserPromptSubmit', '%2', { transcriptPath: null }));
    await started;
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    const endedTail = tails.find((t) => t.path === ended.transcriptPath);
    expect(endedTail?.started).toBe(false);
    open();
    await flush();
    expect(endedTail?.started).toBe(true);
    await source.stop();
  });

  it('ended records read at most 4 transcripts at a time, each emitting its lines as it finishes', async () => {
    const records = Array.from({ length: 10 }, (_, i) => endedRec(i));
    let active = 0;
    let max = 0;
    const release: (() => void)[] = [];
    const made: FakeTail[] = [];
    const { source, lineEvents } = setup({
      records,
      tail: (path) => {
        const t = new FakeTail(path, { lines: [{ kind: 'say', text: path }] });
        const start = t.start.bind(t);
        t.start = async () => {
          active++;
          max = Math.max(max, active);
          await new Promise<void>((r) => release.push(r));
          active--;
          await start();
        };
        made.push(t);
        return t;
      },
    });
    await source.start();
    await flush();
    expect(made).toHaveLength(4);
    (release.shift() as () => void)();
    await flush();
    // The first finished read is on the board before the others finish.
    const first = made[0] as FakeTail;
    const firstId = records.find((r) => r.transcriptPath === first.path)?.kageId as string;
    expect(lineEvents(firstId).at(-1)).toMatchObject({
      reset: true,
      lines: [{ text: first.path }],
    });
    expect(made).toHaveLength(5);
    while (release.length > 0) {
      (release.shift() as () => void)();
      await flush();
    }
    expect(made).toHaveLength(10);
    expect(max).toBe(4);
    for (const r of records) expect(source.lines(r.kageId)).toHaveLength(1);
    await source.stop();
  });

  it("a done session's tail is idle, and running again makes it poll", async () => {
    const { source, hooks, tails } = setup({
      windows: [kageWin()],
      records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })],
    });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    const t = tails.find((x) => x.path === TRANSCRIPT) as FakeTail;
    expect(t.idleCalls.at(-1)).toBe(false);
    hooks.fire(hook('Stop', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('done');
    expect(t.idleCalls.at(-1)).toBe(true);
    // The next turn's hook re-arms the poll.
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('running');
    expect(t.idleCalls.at(-1)).toBe(false);
    hooks.fire(hook('PermissionRequest', '%2'));
    await flush();
    expect(t.idleCalls.at(-1)).toBe(true);
    // Ended: the final flush keeps its one poll, then the tail stops.
    hooks.fire(hook('SessionEnd', '%2'));
    await flush();
    expect(source.get('k-1')?.status).toBe('ended');
    expect(t.idleCalls.slice(-2)).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.stopped).toBe(true);
    await source.stop();
  });
});

describe('LiveSource: tmux edges (hardening Task 10: reliability M3, M4, M9, M11)', () => {
  const FAILED = "Claude couldn't find this conversation, so the session wasn't resumed.";
  const MISSING_LOG =
    'kage: the tmux session "kage" isn\'t there by that name any more, so Kage keeps the last state.';

  it("a hook from a dead server's %1 isn't claimed by the new server's %1", async () => {
    // M3, the review's steps 1–4: a kage window %1, then the tmux server dies.
    const s = setup({
      windows: [kageWin({ windowId: '@1', paneId: '%1' })],
      records: [rec({ windowId: '@1' })],
    });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    await flush();
    s.watcher.emit({ type: 'down' });
    s.tmux.windows = [];
    // The dying Claude's SessionEnd lands after the down; the re-list shows no %1.
    s.hooks.fire(hook('SessionEnd', '%1', { sessionId: 'old' }));
    await vi.advanceTimersByTimeAsync(60);
    // A fresh launch on the new server, whose panes start over: new-window prints %1.
    await s.source.adopt(
      rec({ kageId: 'k-2', windowId: '@1', branch: 'kage/add-a-coupon', task: 'Add a coupon' }),
    );
    s.tmux.windows = [kageWin({ windowId: '@1', paneId: '%1', kageId: 'k-2' })];
    s.source.claim('k-2', '@1', '%1');
    await vi.advanceTimersByTimeAsync(60);
    expect(s.source.get('k-2')?.status).not.toBe('ended');
    await vi.advanceTimersByTimeAsync(600);
    const saved = s.store.saves.at(-1)?.find((r) => r.kageId === 'k-2');
    expect(saved?.sessionId).not.toBe('old');
    await s.source.stop();
  });

  it("a dead server's SessionEnd doesn't fail the resume opened in its pane number", async () => {
    const s = setup({
      windows: [kageWin({ windowId: '@1', paneId: '%1' })],
      records: [rec({ windowId: '@1', sessionId: 's-1', transcriptPath: TRANSCRIPT })],
    });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    await flush();
    s.watcher.emit({ type: 'down' });
    s.tmux.windows = [];
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    s.hooks.fire(hook('SessionEnd', '%1', { sessionId: 'old' }));
    await vi.advanceTimersByTimeAsync(60);
    // Resume at once: the new server's first window is %1 again.
    s.source.resumed('k-1', 's-1');
    s.tmux.windows = [kageWin({ windowId: '@1', paneId: '%1' })];
    s.source.claim('k-1', '@1', '%1');
    await vi.advanceTimersByTimeAsync(60);
    expect(s.source.get('k-1')?.status).toBe('running');
    expect(s.source.lines('k-1').some((l) => l.text === FAILED)).toBe(false);
    await s.source.stop();
  });

  it('a hook set aside after the launch began is still claimed (B34 stays)', async () => {
    const s = setup({ records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })] });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    await flush();
    s.source.resumed('k-1', 's-1');
    // The resume's window dies before any listing shows it: its SessionEnd is set aside.
    s.hooks.fire(hook('SessionEnd', '%4', { sessionId: 'random' }));
    await vi.advanceTimersByTimeAsync(60);
    s.source.claim('k-1', '@4', '%4');
    await vi.advanceTimersByTimeAsync(60);
    expect(s.source.get('k-1')?.status).toBe('ended');
    expect(s.source.lines('k-1').some((l) => l.text === FAILED)).toBe(true);
    await s.source.stop();
  });

  it('a hook that arrived before the launch began is not claimed, though set aside after it', async () => {
    // Task 10's minor: a set-aside entry keeps its arrival time, not the time the re-list ended.
    const s = setup({ records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })] });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    await flush();
    // Another Claude's SessionEnd from %4 lands; its re-list is still 50 ms away.
    s.hooks.fire(hook('SessionEnd', '%4', { sessionId: 'random' }));
    await vi.advanceTimersByTimeAsync(10);
    s.source.resumed('k-1', 's-1');
    await vi.advanceTimersByTimeAsync(60); // the re-list finds no %4: set aside now
    // The resume's window opens as %4 too (the other Claude's pane has gone).
    s.tmux.windows = [kageWin({ windowId: '@4', paneId: '%4' })];
    s.source.claim('k-1', '@4', '%4');
    await vi.advanceTimersByTimeAsync(60);
    expect(s.source.get('k-1')?.status).toBe('running');
    expect(s.source.lines('k-1').some((l) => l.text === FAILED)).toBe(false);
    await s.source.stop();
  });

  it('the session missing while the watcher is attached keeps every state and logs once', async () => {
    const logs: string[] = [];
    const s = setup({
      windows: [win({ windowId: '@1', paneId: '%1' }), kageWin()],
      records: [rec()],
      log: (l) => logs.push(l),
    });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    s.events.length = 0;
    // `tmux rename-session -t kage work`: the watcher stays attached.
    s.tmux.missing = true;
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    s.watcher.emit({ type: 'activity', paneId: '%1' });
    await vi.advanceTimersByTimeAsync(2000);
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(s.tmux.strictSeen.at(-1)).toBe(true);
    expect(s.source.get('k-1')?.status).toBe('running');
    expect(s.source.get('ext-@1')).toBeDefined();
    expect(s.source.hasWindow('k-1')).toBe(true);
    expect(s.source.terminalTarget('k-1')?.windowId).toBe('@2');
    expect(s.events.some((e) => e.type === 'session.removed')).toBe(false);
    expect(s.updates().some((u) => u.status === 'ended')).toBe(false);
    expect(logs).toEqual([MISSING_LOG]);
    // The name comes back: the episode ends, and a later one logs again.
    s.tmux.missing = false;
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    s.tmux.missing = true;
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(logs).toEqual([MISSING_LOG, MISSING_LOG]);
    await s.source.stop();
  });

  it('the session missing with no watcher attached reads as no windows, as before', async () => {
    const logs: string[] = [];
    const s = setup({ windows: [kageWin()], records: [rec()], log: (l) => logs.push(l) });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    await flush();
    s.watcher.emit({ type: 'down' });
    await flush();
    s.tmux.missing = true;
    s.watcher.emit({ type: 'windows-changed' });
    await flush();
    expect(s.source.get('k-1')?.status).toBe('ended');
    expect(s.source.hasWindow('k-1')).toBe(false);
    expect(logs).toEqual([]);
    await s.source.stop();
  });

  it('a running hooks-mode session under constant activity re-lists about once per 5 s', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.watcher.emit({ type: 'up' });
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.source.get('k-1')?.status).toBe('running');
    const before = s.tmux.listCalls;
    // Claude's spinner: activity every 250 ms for 10 s.
    for (let i = 0; i < 40; i++) {
      s.watcher.emit({ type: 'activity', paneId: '%2' });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(s.tmux.listCalls - before).toBeGreaterThanOrEqual(1);
    expect(s.tmux.listCalls - before).toBeLessThanOrEqual(3);
    // A Stop still re-lists at once (300 ms), whatever the activity throttle says.
    const atStop = s.tmux.listCalls;
    s.hooks.fire(hook('Stop', '%2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.tmux.listCalls).toBeGreaterThan(atStop);
    await s.source.stop();
  });

  it('activity in a shell-ended session still re-lists at once', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    // Claude exits to the shell.
    s.tmux.windows = [kageWin({ command: 'bash' })];
    s.watcher.emit({ type: 'windows-changed' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.source.get('k-1')?.status).toBe('ended');
    // fg: claude is in front again; its output re-lists within a second.
    s.tmux.windows = [kageWin()];
    const before = s.tmux.listCalls;
    s.watcher.emit({ type: 'activity', paneId: '%2' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.tmux.listCalls).toBeGreaterThan(before);
    await s.source.stop();
  });

  it('a PostToolUse arriving before its PreToolUse leaves no tool pending', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    // Parallel tools: t1's hooks arrive reversed.
    s.hooks.fire(hook('PostToolUse', '%2', { toolUseId: 't1' }));
    s.hooks.fire(hook('PreToolUse', '%2', { toolUseId: 't1' }));
    await flush();
    // No tool pending, so a late permission Notification doesn't count (R12).
    s.hooks.fire(permissionNote('%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    await s.source.stop();
  });

  it("one parallel tool's PostToolUse leaves the other pending", async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    s.hooks.fire(hook('PreToolUse', '%2', { toolUseId: 't1' }));
    s.hooks.fire(hook('PreToolUse', '%2', { toolUseId: 't2' }));
    s.hooks.fire(hook('PostToolUse', '%2', { toolUseId: 't1' }));
    await flush();
    s.hooks.fire(permissionNote('%2'));
    await flush();
    expect(s.source.get('k-1')?.status).toBe('needs-you');
    await s.source.stop();
  });

  it('expired ignored panes are pruned', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    // A hooks-enabled Claude outside the kage session: its pane is ignored for 5 s.
    s.hooks.fire(hook('UserPromptSubmit', '%7'));
    await vi.advanceTimersByTimeAsync(60);
    expect(s.source.ignoredPaneCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(6000);
    // Any later hook prunes the entries past their expiry, though %7 never sends again.
    s.hooks.fire(hook('PreToolUse', '%2'));
    expect(s.source.ignoredPaneCount()).toBe(0);
    await s.source.stop();
  });
});

describe('LiveSource: turn-end check, carried minors (hardening Task 10, from Task 7)', () => {
  const IDLE = ['● Fixed the total.', '', RULE, '❯ ', RULE, '  ? for shortcuts', ''].join('\n');

  it('a restart within 5 s of a lost Stop: running from the rebuild, then done once the pane is idle', async () => {
    const s = setup({
      // Claude drew within the last 5 s, and the transcript's turn ended (now is null).
      windows: [kageWin({ activity: Math.floor(T0 / 1000) - 1 })],
      records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })],
      tails: { [TRANSCRIPT]: { now: null } },
    });
    s.tmux.setCapture('%2', IDLE);
    await s.source.start();
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('done');
    await s.source.stop();
  });

  it('a new turn in the transcript during the check keeps it running', async () => {
    const s = setup({ windows: [kageWin()], records: [rec()] });
    await s.source.start();
    s.hooks.fire(hook('SessionStart', '%2'));
    s.hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    s.tmux.setCapture('%2', IDLE);
    const t = s.tails[0] as FakeTail;
    t.turnEnd();
    await vi.advanceTimersByTimeAsync(1000);
    // The next turn starts with its hooks lost: the transcript says Claude is at work again.
    t.push([{ kind: 'tool', text: 'Read src/cart.ts' }], { now: 'Reading src/cart.ts' });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(s.source.get('k-1')?.status).toBe('running');
    await s.source.stop();
  });
});

describe('LiveSource: Task 9 round (R138)', () => {
  it("pane activity pokes a non-running session's tail once; a running one's not at all", async () => {
    const { source, hooks, watcher, tails } = setup({
      windows: [kageWin()],
      records: [rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT })],
    });
    await source.start();
    hooks.fire(hook('UserPromptSubmit', '%2'));
    await flush();
    const t = tails.find((x) => x.path === TRANSCRIPT) as FakeTail;
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(t.pokes).toBe(0);
    hooks.fire(hook('Stop', '%2'));
    await flush();
    watcher.emit({ type: 'activity', paneId: '%2' });
    await flush();
    expect(t.pokes).toBe(1);
    await source.stop();
  });

  it("an archived record's session goes with its window (a stale listing or a failed kill)", async () => {
    const { source, watcher, tmux, tails } = setup({
      windows: [kageWin()],
      records: [
        rec({ sessionId: 's-1', transcriptPath: TRANSCRIPT, archived: true, archivedAt: T0 - 5 }),
      ],
    });
    await source.start();
    await flush();
    expect(tails).toHaveLength(1);
    expect(tails[0]?.stopped).toBe(false);
    tmux.windows = [];
    watcher.emit({ type: 'windows-changed' });
    await flush();
    // Dropped at once: no 2.5 s retire wait, no lines kept.
    expect(tails[0]?.stopped).toBe(true);
    expect(source.lines('k-1')).toEqual([]);
    expect(source.get('k-1')).toMatchObject({ archived: true, status: 'ended' });
    expect(source.archivedList().map((s) => s.id)).toEqual(['k-1']);
    await source.stop();
  });
});
