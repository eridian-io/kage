import type { DisplayLine, Session, SessionStatus } from '@kage/shared';
import type { HookEvent } from './hooks/event.ts';
import type { HookServer } from './hooks/server.ts';
import { nextStatus } from './hooks/status.ts';
import {
  ACTIVE_MS,
  questionFromToolInput,
  questionKey,
  type SessionView,
  sameLines,
  sameSession,
  toSession,
} from './live/session-view.ts';
import {
  paneLines,
  parsePermissionPrompt,
  parseStartupScreen,
  showsDenial,
  showsPrompt,
} from './pane/prompt.ts';
import { NotImplementedError, type SessionSource, type SourceEvent } from './source.ts';
import type { SessionRecord, StateStore } from './state/store.ts';
import type { TmuxClient } from './tmux/client.ts';
import type { TmuxWindow } from './tmux/format.ts';
import type { TmuxWatcher, WatchEvent } from './tmux/watcher.ts';
import type { TranscriptTail } from './transcript/tail.ts';

export { NotImplementedError } from './source.ts';

export type TmuxClientLike = Pick<TmuxClient, 'ensureSession' | 'listWindows' | 'capturePane'>;
export type TmuxWatcherLike = Pick<TmuxWatcher, 'on' | 'start' | 'stop'>;
export type HookServerLike = Pick<HookServer, 'on'>;
export type StateStoreLike = Pick<StateStore, 'load' | 'save'>;
export type TailLike = Pick<
  TranscriptTail,
  'start' | 'stop' | 'lines' | 'question' | 'now' | 'on' | 'onInterrupt'
>;

export interface LiveSourceDeps {
  tmux: TmuxClientLike;
  watcher: TmuxWatcherLike;
  /** Kage subscribes only; the caller owns listen() and close(). */
  hooks: HookServerLike;
  store: StateStoreLike;
  tail: (path: string) => TailLike;
  /** Not used by LiveSource itself yet; Task 10 passes it through for snapshot paths. */
  projectsRoot: string;
  now?: () => number;
}

/** At most one activity-driven update and one pane capture per session per this many ms. */
const THROTTLE_MS = 250;
/** A permission prompt can render a moment after its hook: look once more after this. */
const PROMPT_RETRY_MS = 300;
const SAVE_DEBOUNCE_MS = 500;
/** An unknown hook pane waits this long for a re-list (several hooks share one). */
const RELIST_DEBOUNCE_MS = 50;
/** After a session ends, the tail keeps reading this long (one 2 s poll) before it stops. */
const FINAL_FLUSH_MS = 2500;
/** Pane-command re-checks (claude gone → ended): at most one re-list per this many ms. */
const RECHECK_MS = 1000;
/** After Stop or SessionEnd, re-list this much later to see whether claude exited. */
const STOP_RECHECK_MS = 300;
/** A failed save retries after 500 ms, doubling up to this. */
const SAVE_MAX_MS = 30_000;
/** Lines kept and scrollback captured. */
const MAX_LINES = 200;

/** R17: a pane whose command is one of these (or `-<shell>`, a login shell) is back at a shell. */
const SHELLS = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
  'fish',
  'ksh',
  'mksh',
  'tcsh',
  'csh',
  'nu',
  'pwsh',
  'login',
]);
const atShell = (command: string): boolean =>
  SHELLS.has(command.startsWith('-') ? command.slice(1) : command);

type TimerName = 'emit' | 'idle' | 'capture' | 'retry' | 'retire';

interface Live extends SessionView {
  /** 'activity': status from pane activity (no hooks yet); 'hooks': from hooks and the transcript. */
  mode: 'activity' | 'hooks';
  /** The question is a startup screen (R9). */
  startup: boolean;
  /** The pane has shown the prompt for this needs-you (gates the R11 pane fallback). */
  promptSeen: boolean;
  /** R12: a PreToolUse or PermissionRequest without its PostToolUse, failure, Stop or end yet. */
  pending: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  /** The window's pane has been seen running `claude`. */
  sawClaude: boolean;
  /** Ended because the pane went back to a shell (not by SessionEnd): a non-shell command revives it. */
  shellEnded: boolean;
  tail: TailLike | null;
  tailPath: string | null;
  tailOff: (() => void)[];
  tailQuestionKey: string | null;
  /** Pane fallback lines, or the last transcript lines once the tail stopped. */
  lines: DisplayLine[];
  lastActivity: number;
  /** Bumped on each status change and on detach; stale async results check it. */
  gen: number;
  last: Session | null;
  lastEmitAt: number;
  lastCaptureAt: number;
  capturing: boolean;
  captureAgain: boolean;
  timers: Partial<Record<TimerName, ReturnType<typeof setTimeout>>>;
}

/**
 * The live board's sessions: tmux windows in the `kage` session joined with Kage's records,
 * with status from hooks (spec §5.3), lines from transcripts or pane captures (§5.4), and
 * restart reconciliation (§5.8a). Session id: the record's kageId, or `ext-<windowId>`.
 */
export class LiveSource implements SessionSource {
  readonly #d: LiveSourceDeps;
  readonly #now: () => number;
  readonly #listeners = new Set<(e: SourceEvent) => void>();
  readonly #sessions = new Map<string, Live>();
  readonly #records = new Map<string, SessionRecord>();
  #running = false;
  #ready = false;
  #early: HookEvent[] = [];
  #unknown: HookEvent[] = [];
  #unknownTimer: ReturnType<typeof setTimeout> | null = null;
  #off: (() => void)[] = [];
  #listing: Promise<void> | null = null;
  #listAgain = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saveFailures = 0;
  #dirty = false;
  #viewed = new Set<string>();
  #recheckTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRecheckAt = Number.NEGATIVE_INFINITY;

  constructor(deps: LiveSourceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------ SessionSource

  list(): Session[] {
    return [...this.#sessions.values()].map(toSession).filter((s) => !s.archived);
  }

  get(id: string): Session | undefined {
    const st = this.#sessions.get(id);
    return st ? toSession(st) : undefined;
  }

  lines(id: string): DisplayLine[] {
    const st = this.#sessions.get(id);
    if (!st) return [];
    return (st.tail ? st.tail.lines() : st.lines).slice(-MAX_LINES).map((l) => ({ ...l }));
  }

  async remove(_id: string): Promise<void> {
    throw new NotImplementedError('Deleting sessions arrives in a later version');
  }

  /** Pane fallback lines are captured only for viewed sessions. */
  setViewed(ids: ReadonlySet<string>): void {
    const before = this.#viewed;
    this.#viewed = new Set(ids);
    if (!this.#running) return;
    for (const id of this.#viewed) {
      const st = this.#sessions.get(id);
      if (st && !before.has(id)) this.#requestCapture(st);
    }
  }

  subscribe(fn: (e: SourceEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#off = [
      this.#d.hooks.on((e) => this.#onHook(e)),
      this.#d.watcher.on((e) => this.#onWatch(e)),
    ];
    for (const r of await this.#d.store.load()) this.#records.set(r.kageId, r);
    for (const r of this.#records.values()) this.#sessions.set(r.kageId, this.#fresh(r.kageId, r));
    try {
      await this.#d.tmux.ensureSession();
    } catch {
      // No tmux: every record shows as ended; the watcher retries with backoff.
    }
    let windows: TmuxWindow[] = [];
    try {
      windows = await this.#d.tmux.listWindows();
    } catch {}
    if (!this.#running) return;
    await this.#reconcile(windows);
    await Promise.all(
      [...this.#sessions.values()]
        .filter((st) => !st.window && st.transcriptPath)
        .map((st) => this.#readOnce(st)),
    );
    if (!this.#running) return;
    for (const st of this.#sessions.values()) this.#emitNow(st);
    this.#ready = true;
    const early = this.#early;
    this.#early = [];
    for (const e of early) this.#onHook(e);
    this.#d.watcher.start();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#ready = false;
    for (const off of this.#off) off();
    this.#off = [];
    this.#d.watcher.stop();
    if (this.#unknownTimer) clearTimeout(this.#unknownTimer);
    this.#unknownTimer = null;
    if (this.#recheckTimer) clearTimeout(this.#recheckTimer);
    this.#recheckTimer = null;
    this.#unknown = [];
    this.#early = [];
    for (const st of this.#sessions.values()) {
      this.#clearTimers(st);
      this.#stopTail(st);
    }
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#dirty) await this.#saveNow();
  }

  // ------------------------------------------------------------ windows

  #fresh(id: string, record: SessionRecord | null): Live {
    const t = this.#now();
    return {
      id,
      record,
      window: null,
      firstSeen: t,
      status: 'ended',
      statusSince: t,
      question: null,
      now: null,
      mode: 'activity',
      startup: false,
      promptSeen: false,
      pending: false,
      sessionId: record?.sessionId ?? null,
      transcriptPath: record?.transcriptPath ?? null,
      sawClaude: false,
      shellEnded: false,
      tail: null,
      tailPath: null,
      tailOff: [],
      tailQuestionKey: null,
      lines: [],
      lastActivity: 0,
      gen: 0,
      last: null,
      lastEmitAt: Number.NEGATIVE_INFINITY,
      lastCaptureAt: Number.NEGATIVE_INFINITY,
      capturing: false,
      captureAgain: false,
      timers: {},
    };
  }

  /** Re-lists windows; calls during a listing run once more after it. */
  #relist(): Promise<void> {
    if (this.#listing) {
      this.#listAgain = true;
      return this.#listing;
    }
    this.#listing = (async () => {
      try {
        do {
          this.#listAgain = false;
          let windows: TmuxWindow[];
          try {
            windows = await this.#d.tmux.listWindows();
          } catch {
            continue; // a failed listing changes nothing; the watcher reports a dead server
          }
          if (!this.#running) return;
          await this.#reconcile(windows);
        } while (this.#listAgain && this.#running);
      } finally {
        this.#listing = null;
      }
    })();
    return this.#listing;
  }

  async #reconcile(windows: TmuxWindow[]): Promise<void> {
    const seen = new Set<string>();
    const attaching: Promise<void>[] = [];
    for (const w of windows) {
      const record = w.kageId ? this.#records.get(w.kageId) : undefined;
      const id = record ? record.kageId : `ext-${w.windowId}`;
      seen.add(id);
      let st = this.#sessions.get(id);
      if (!st) {
        st = this.#fresh(id, record ?? null);
        this.#sessions.set(id, st);
      }
      if (st.window?.windowId === w.windowId) {
        const old = st.window;
        st.window = w;
        st.lastActivity = Math.max(st.lastActivity, w.activity * 1000);
        if (this.#claudeGone(st, w)) {
          if (st.status !== 'ended') this.#endInWindow(st);
        } else if (st.status === 'ended' && st.shellEnded) {
          // Ctrl+Z then fg: claude is in front again. Re-attach, which restarts the tail.
          attaching.push(this.#attach(st, w));
        } else if (!st.record && (old.name !== w.name || old.cwd !== w.cwd)) {
          // Only an external session shows window fields (task, project, worktree).
          this.#emitNow(st);
        }
      } else {
        attaching.push(this.#attach(st, w));
      }
    }
    for (const st of [...this.#sessions.values()]) {
      if (seen.has(st.id)) continue;
      if (!st.record) this.#removeSession(st);
      else if (st.window) this.#detach(st);
    }
    await Promise.all(attaching);
  }

  /** Links a session to its window and works out its status (restart rebuild, §5.8a). */
  async #attach(st: Live, w: TmuxWindow): Promise<void> {
    st.window = w;
    st.gen++;
    this.#clearTimers(st, ['retire']);
    st.lastActivity = Math.max(st.lastActivity, w.activity * 1000);
    if (st.record && st.record.windowId !== w.windowId) {
      st.record.windowId = w.windowId;
      this.#saveSoon();
    }
    st.mode = 'activity';
    st.pending = false;
    if (this.#claudeGone(st, w)) {
      this.#endInWindow(st);
      if (!st.tail && st.transcriptPath) await this.#readOnce(st);
      if (this.#running) this.#emitNow(st);
      return;
    }
    this.#setStatus(st, this.#activityStatus(st));
    if (st.transcriptPath) {
      await this.#ensureTail(st);
      if (!this.#running || st.window !== w) return;
      this.#rebuildFromTail(st);
    }
    this.#scheduleIdle(st);
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!this.#running || st.window !== w) return;
    if (text !== null) this.#processCapture(st, text, gen, true);
    this.#emitNow(st);
  }

  /**
   * Spec §5.3 and R17: a session whose `claude` is gone is ended. True when the pane is back at
   * a shell and the session had a Claude: it linked a Claude session, or it is Kage's and its
   * pane ran something other than a shell. (The listing has no `pane_dead`, so that part is skipped.)
   */
  #claudeGone(st: Live, w: TmuxWindow): boolean {
    if (!atShell(w.command)) {
      st.sawClaude = true;
      return false;
    }
    return st.sessionId !== null || (st.record !== null && st.sawClaude);
  }

  /** Ended while the window lives on (claude exited to a shell); a SessionStart revives it. */
  #endInWindow(st: Live): void {
    this.#clearTimers(st, ['idle', 'capture', 'retry']);
    st.mode = 'hooks';
    this.#setStatus(st, 'ended');
    st.shellEnded = true;
    st.pending = false;
    st.question = null;
    this.#retireTailSoon(st);
    this.#emitNow(st);
  }

  /** pane_current_command changes fire no tmux event: re-list, at most once per second. */
  #recheckSoon(delay: number): void {
    if (!this.#running || this.#recheckTimer) return;
    const now = this.#now();
    const wait = Math.max(delay, this.#lastRecheckAt + RECHECK_MS - now);
    this.#recheckTimer = setTimeout(() => {
      this.#recheckTimer = null;
      this.#lastRecheckAt = this.#now();
      if (this.#running) void this.#relist();
    }, wait);
  }

  /** The window is gone (or tmux is down): a Kage session is ended. */
  #detach(st: Live): void {
    st.window = null;
    this.#clearTimers(st, ['emit', 'retire']);
    this.#setStatus(st, 'ended');
    st.gen++;
    st.pending = false;
    st.question = null;
    this.#retireTailSoon(st);
    this.#emitNow(st);
  }

  #removeSession(st: Live): void {
    this.#clearTimers(st);
    this.#stopTail(st);
    st.window = null;
    st.gen++;
    this.#sessions.delete(st.id);
    this.#emit({ type: 'session.removed', id: st.id });
  }

  #byPane(paneId: string): Live | undefined {
    for (const st of this.#sessions.values()) if (st.window?.paneId === paneId) return st;
    return undefined;
  }

  #onWatch(e: WatchEvent): void {
    if (!this.#running || !this.#ready) return;
    switch (e.type) {
      case 'windows-changed':
      case 'up':
        void this.#relist();
        break;
      case 'down':
        for (const st of [...this.#sessions.values()]) {
          if (!st.record) this.#removeSession(st);
          else if (st.window) this.#detach(st);
        }
        break;
      case 'activity':
        this.#onActivity(e.paneId);
        break;
    }
  }

  #onActivity(paneId: string): void {
    const st = this.#byPane(paneId);
    if (!st) return;
    st.lastActivity = this.#now();
    if (st.mode === 'activity' && !st.startup) {
      this.#setStatus(st, 'running');
      this.#scheduleIdle(st);
      this.#emitThrottled(st);
    }
    // Re-list to see claude exit, or come back after Ctrl+Z (a shell-ended session revives).
    if (st.mode === 'hooks' && (st.status !== 'ended' || st.shellEnded)) this.#recheckSoon(0);
    this.#requestCapture(st);
  }

  #activityStatus(st: Live): SessionStatus {
    return this.#now() - st.lastActivity < ACTIVE_MS ? 'running' : 'done';
  }

  /** Activity mode: running turns done 5 s after the last activity (one timer, re-armed lazily). */
  #scheduleIdle(st: Live): void {
    if (!this.#running) return;
    if (st.timers.idle || st.mode !== 'activity' || st.status !== 'running' || st.startup) return;
    const wait = Math.max(0, st.lastActivity + ACTIVE_MS - this.#now());
    st.timers.idle = setTimeout(() => {
      delete st.timers.idle;
      if (st.mode !== 'activity' || st.status !== 'running' || st.startup) return;
      if (this.#now() - st.lastActivity >= ACTIVE_MS) {
        this.#setStatus(st, 'done');
        this.#emitNow(st);
      } else this.#scheduleIdle(st);
    }, wait);
  }

  // ------------------------------------------------------------ hooks

  #onHook(e: HookEvent): void {
    if (!this.#running) return;
    if (!this.#ready) {
      this.#early.push(e);
      return;
    }
    if (e.pane === null) return;
    const st = this.#byPane(e.pane);
    // Keep a pane's events in order while an earlier one waits for the re-list.
    if (!st || this.#unknown.some((u) => u.pane === e.pane)) {
      this.#unknown.push(e);
      this.#unknownTimer ??= setTimeout(() => void this.#resolveUnknown(), RELIST_DEBOUNCE_MS);
      return;
    }
    this.#applyHook(st, e);
  }

  /** Re-lists once for hooks from unknown panes; those still unknown are dropped. */
  async #resolveUnknown(): Promise<void> {
    this.#unknownTimer = null;
    await this.#relist();
    const queued = this.#unknown;
    this.#unknown = [];
    for (const e of queued) {
      const st = e.pane === null ? undefined : this.#byPane(e.pane);
      if (st && this.#running) this.#applyHook(st, e);
    }
  }

  #applyHook(st: Live, e: HookEvent): void {
    // R12: a permission Notification counts only while a tool is pending.
    const counts = !(e.event === 'Notification' && e.notification === 'permission' && !st.pending);
    if (e.event === 'SessionStart') this.#link(st, e);
    if (e.event === 'PreToolUse' || e.event === 'PermissionRequest') st.pending = true;
    if (
      e.event === 'PostToolUse' ||
      e.event === 'PostToolUseFailure' ||
      e.event === 'Stop' ||
      e.event === 'SessionEnd' ||
      e.event === 'SessionStart'
    ) {
      st.pending = false;
    }
    st.mode = 'hooks';
    st.startup = false;
    this.#clearTimers(st, ['idle']);
    const before = st.status;
    const next = counts ? (nextStatus(st.status, e) ?? st.status) : st.status;
    this.#setStatus(st, next);
    if (before === 'ended' && next !== 'ended') this.#clearTimers(st, ['retire']);
    if (next === 'needs-you') {
      if (e.event === 'PreToolUse' && e.toolName === 'AskUserQuestion') {
        st.question =
          questionFromToolInput(e.toolInput) ?? st.question ?? st.tail?.question() ?? null;
      } else if (
        e.event === 'PermissionRequest' ||
        (e.event === 'Notification' && counts && !st.question)
      ) {
        void this.#capturePrompt(st, false);
      }
    }
    if (next === 'ended') this.#retireTailSoon(st);
    if (e.event === 'Stop' || e.event === 'SessionEnd') this.#recheckSoon(STOP_RECHECK_MS);
    this.#emitNow(st);
  }

  /** SessionStart: link the pane to Claude's session and follow its transcript. */
  #link(st: Live, e: HookEvent): void {
    const changed = e.sessionId !== st.sessionId || e.transcriptPath !== st.transcriptPath;
    if (changed) {
      st.sessionId = e.sessionId;
      st.transcriptPath = e.transcriptPath;
      if (st.record) {
        st.record.sessionId = e.sessionId;
        st.record.transcriptPath = e.transcriptPath;
        this.#saveSoon();
      }
    }
    if (!st.transcriptPath) {
      if (st.tail) {
        this.#stopTail(st);
        st.lines = [];
        this.#emitLines(st, [], true);
      }
      return;
    }
    if (changed || !st.tail) void this.#ensureTail(st);
  }

  // ------------------------------------------------------------ transcript tails

  async #ensureTail(st: Live): Promise<void> {
    const path = st.transcriptPath;
    if (!path || (st.tail && st.tailPath === path)) return;
    this.#clearTimers(st, ['retire']);
    this.#stopTail(st);
    const tail = this.#d.tail(path);
    st.tail = tail;
    st.tailPath = path;
    st.tailQuestionKey = null;
    st.lines = [];
    st.tailOff = [
      tail.on((added, reset) => {
        if (st.tail !== tail) return;
        this.#emitLines(st, reset ? tail.lines() : added, reset);
        this.#onTailChange(st, tail);
      }),
      tail.onInterrupt(() => {
        if (st.tail !== tail) return;
        // R11: No or Esc fires no hook; the transcript shows it.
        if (st.status !== 'ended') this.#setStatus(st, 'done');
        st.question = null;
        st.pending = false;
        st.now = tail.now();
        this.#emitNow(st);
      }),
    ];
    this.#emitLines(st, [], true);
    try {
      await tail.start();
    } catch {}
  }

  #onTailChange(st: Live, tail: TailLike): void {
    st.now = tail.now();
    const q = tail.question();
    const key = questionKey(q);
    if (key !== st.tailQuestionKey) {
      st.tailQuestionKey = key;
      if (q && st.status !== 'ended') {
        if (st.status !== 'needs-you') this.#setStatus(st, 'needs-you');
        st.question ??= q;
      }
    } else if (q && st.status === 'needs-you' && !st.question) st.question = q;
    this.#emitThrottled(st);
  }

  /** Status after a restart: the transcript's open question, a turn in progress, or activity. */
  #rebuildFromTail(st: Live): void {
    const tail = st.tail;
    if (!tail) return;
    st.mode = 'hooks';
    st.now = tail.now();
    const q = tail.question();
    st.tailQuestionKey = questionKey(q);
    if (q) {
      this.#setStatus(st, 'needs-you');
      st.question = q;
    } else this.#setStatus(st, st.now !== null ? 'running' : this.#activityStatus(st));
  }

  /** An ended session from the state file: read its transcript once for its last lines. */
  async #readOnce(st: Live): Promise<void> {
    if (!st.transcriptPath) return;
    const tail = this.#d.tail(st.transcriptPath);
    try {
      await tail.start();
      st.lines = tail.lines();
      st.now = null;
    } catch {
    } finally {
      tail.stop();
    }
  }

  #retireTailSoon(st: Live): void {
    if (!this.#running || !st.tail || st.timers.retire) return;
    st.timers.retire = setTimeout(() => {
      delete st.timers.retire;
      if (st.status !== 'ended' || !st.tail) return;
      st.lines = st.tail.lines();
      this.#stopTail(st);
      st.now = null;
      this.#emitNow(st);
    }, FINAL_FLUSH_MS);
  }

  #stopTail(st: Live): void {
    for (const off of st.tailOff) off();
    st.tailOff = [];
    st.tail?.stop();
    st.tail = null;
    st.tailPath = null;
  }

  // ------------------------------------------------------------ pane captures

  async #capture(st: Live): Promise<string | null> {
    const paneId = st.window?.paneId;
    if (!paneId) return null;
    st.lastCaptureAt = this.#now();
    try {
      return await this.#d.tmux.capturePane(paneId, MAX_LINES);
    } catch {
      return null;
    }
  }

  #startupEligible(st: Live): boolean {
    return (
      st.window !== null &&
      st.sessionId === null &&
      (st.record !== null || st.window.command === 'claude')
    );
  }

  /**
   * Pane fallback lines only for viewed sessions without a transcript; prompt and startup
   * checks for any session that needs them; never for an ended session.
   */
  #needsCapture(st: Live): boolean {
    if (!st.window || st.status === 'ended') return false;
    return (
      (!st.tail && this.#viewed.has(st.id)) ||
      st.status === 'needs-you' ||
      this.#startupEligible(st)
    );
  }

  /** Activity-driven capture: leading edge plus one trailing capture, at most one per 250 ms. */
  #requestCapture(st: Live): void {
    if (!this.#running || !this.#needsCapture(st)) return;
    if (st.capturing) {
      st.captureAgain = true;
      return;
    }
    if (st.timers.capture) return;
    const wait = st.lastCaptureAt + THROTTLE_MS - this.#now();
    if (wait <= 0) void this.#runCapture(st);
    else {
      st.timers.capture = setTimeout(() => {
        delete st.timers.capture;
        void this.#runCapture(st);
      }, wait);
    }
  }

  async #runCapture(st: Live): Promise<void> {
    if (!this.#running || !this.#needsCapture(st)) return;
    st.capturing = true;
    const gen = st.gen;
    const text = await this.#capture(st);
    st.capturing = false;
    if (text !== null) this.#processCapture(st, text, gen, false);
    if (st.captureAgain) {
      st.captureAgain = false;
      this.#requestCapture(st);
    }
  }

  #processCapture(st: Live, text: string, gen: number, initial: boolean): void {
    if (!this.#running || !st.window || this.#sessions.get(st.id) !== st) return;
    if (st.status === 'ended') return;
    if (!st.tail && this.#viewed.has(st.id)) {
      const lines = paneLines(text, MAX_LINES);
      if (!sameLines(lines, st.lines)) {
        st.lines = lines;
        this.#emitLines(st, lines, true);
      }
    }
    // The status changed while the capture ran: what it shows may predate that change.
    if (gen !== st.gen && !initial) return;
    if (this.#startupEligible(st)) {
      const screen = parseStartupScreen(text);
      if (screen) {
        this.#setStatus(st, 'needs-you');
        st.startup = true;
        st.question = screen;
        this.#emitNow(st);
        return;
      }
      if (st.startup) {
        st.startup = false;
        this.#setStatus(st, this.#activityStatus(st));
        st.question = null;
        this.#scheduleIdle(st);
        this.#emitNow(st);
        return;
      }
    }
    const prompt = parsePermissionPrompt(text);
    if (st.status === 'needs-you') {
      if (prompt) {
        st.promptSeen = true;
        st.question ??= prompt;
        this.#emitNow(st);
      } else if (st.promptSeen && !showsPrompt(text)) {
        // R11 fallback: the prompt went away without a hook. No or Esc leaves Claude's denial
        // line and ends the turn. Otherwise it was a Yes: the tool runs, and no hook fires until
        // its PostToolUse, which may be minutes away for a long command.
        if (showsDenial(text)) {
          this.#setStatus(st, 'done');
          st.pending = false;
        } else {
          this.#setStatus(st, 'running');
          this.#scheduleIdle(st);
        }
        this.#emitNow(st);
      }
      return;
    }
    // A prompt already on screen at start, or in a window without hooks.
    if (prompt && (initial || st.mode === 'activity')) {
      this.#clearTimers(st, ['idle']);
      this.#setStatus(st, 'needs-you');
      st.question = prompt;
      st.promptSeen = true;
      st.pending = true;
      this.#emitNow(st);
    }
  }

  /** PermissionRequest or a counted Notification: read the prompt now, once more 300 ms later. */
  async #capturePrompt(st: Live, retried: boolean): Promise<void> {
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!this.#running || gen !== st.gen || st.status !== 'needs-you') return;
    const prompt = text === null ? null : parsePermissionPrompt(text);
    if (prompt) {
      st.question = prompt;
      st.promptSeen = true;
      this.#emitNow(st);
      return;
    }
    const fallback = st.tail?.question() ?? null;
    if (fallback && !st.question) {
      st.question = fallback;
      this.#emitNow(st);
    }
    if (!retried && !st.timers.retry && this.#running) {
      st.timers.retry = setTimeout(() => {
        delete st.timers.retry;
        void this.#capturePrompt(st, true);
      }, PROMPT_RETRY_MS);
    }
  }

  // ------------------------------------------------------------ state and events

  #setStatus(st: Live, status: SessionStatus): void {
    if (status === st.status) return;
    st.status = status;
    st.shellEnded = false;
    st.statusSince = this.#now();
    st.gen++;
    if (status !== 'needs-you') {
      st.question = null;
      st.promptSeen = false;
      st.startup = false;
      this.#clearTimers(st, ['retry']);
    }
  }

  #clearTimers(st: Live, names?: TimerName[]): void {
    for (const name of names ?? (Object.keys(st.timers) as TimerName[])) {
      const t = st.timers[name];
      if (t) clearTimeout(t);
      delete st.timers[name];
    }
  }

  #emit(e: SourceEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {}
    }
  }

  #emitLines(st: Live, lines: DisplayLine[], reset: boolean): void {
    if (!reset && lines.length === 0) return;
    this.#emit({ type: 'session.lines', id: st.id, lines: lines.map((l) => ({ ...l })), reset });
  }

  /** Emits session.updated when a visible field changed. */
  #emitNow(st: Live): void {
    this.#clearTimers(st, ['emit']);
    if (!this.#running || this.#sessions.get(st.id) !== st) return;
    // Archived sessions are hidden from the board: no updates for them.
    if (st.record?.archived) return;
    const s = toSession(st);
    if (sameSession(st.last, s)) return;
    st.last = s;
    st.lastEmitAt = this.#now();
    this.#emit({ type: 'session.updated', session: s });
  }

  /** Activity- and transcript-driven updates: at most one per 250 ms per session. */
  #emitThrottled(st: Live): void {
    if (!this.#running || st.timers.emit) return;
    const wait = st.lastEmitAt + THROTTLE_MS - this.#now();
    if (wait <= 0) this.#emitNow(st);
    else {
      st.timers.emit = setTimeout(() => {
        delete st.timers.emit;
        this.#emitNow(st);
      }, wait);
    }
  }

  #saveSoon(): void {
    this.#dirty = true;
    if (this.#saveTimer || !this.#running) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  async #saveNow(): Promise<void> {
    this.#dirty = false;
    try {
      await this.#d.store.save([...this.#records.values()].map((r) => ({ ...r })));
      this.#saveFailures = 0;
    } catch {
      this.#dirty = true;
      this.#saveFailures++;
      if (!this.#running || this.#saveTimer) return;
      const wait = Math.min(SAVE_DEBOUNCE_MS * 2 ** (this.#saveFailures - 1), SAVE_MAX_MS);
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = null;
        void this.#saveNow();
      }, wait);
    }
  }
}
