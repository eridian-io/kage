import { join } from 'node:path';
import {
  type ArchivedSession,
  type DisplayLine,
  LIMITS,
  type Session,
  type SessionStatus,
} from '@kage/shared';
import type { ControlTarget } from './control/actions.ts';
import type { PromptKind } from './control/keys.ts';
import type { AutoArchiver, AutoCandidate } from './finish/auto-archive.ts';
import type { HookEvent } from './hooks/event.ts';
import type { HookServer } from './hooks/server.ts';
import { nextStatus } from './hooks/status.ts';
import {
  ACTIVE_MS,
  multiSelectByQuestion,
  previewTarget,
  questionFromToolInput,
  questionKey,
  type SessionView,
  sameLines,
  sameSession,
  toSession,
  viewChange,
} from './live/session-view.ts';
import {
  numberedPromptKind,
  paneLines,
  parsePermissionPrompt,
  parseStartupScreen,
  showsDenial,
  showsDenialLast,
  showsIdleBox,
  showsPrompt,
} from './pane/prompt.ts';
import type { PreviewPatch, PreviewTarget, PreviewTracker } from './preview/tracker.ts';
import { NotImplementedError, type SessionSource, type SourceEvent } from './source.ts';
import type { SessionRecord, StateStore } from './state/store.ts';
import type { TmuxClient } from './tmux/client.ts';
import { isClaude, type TmuxWindow } from './tmux/format.ts';
import type { TmuxWatcher, WatchEvent } from './tmux/watcher.ts';
import type { TranscriptTail } from './transcript/tail.ts';

export { NotImplementedError } from './source.ts';

export type TmuxClientLike = Pick<
  TmuxClient,
  'ensureSession' | 'listWindows' | 'capturePane' | 'clearPlaceholder'
>;
export type TmuxWatcherLike = Pick<TmuxWatcher, 'on' | 'start' | 'stop'>;
export type HookServerLike = Pick<HookServer, 'on'>;
export type StateStoreLike = Pick<StateStore, 'load' | 'save'>;
export type TailLike = Pick<
  TranscriptTail,
  'start' | 'stop' | 'setIdle' | 'lines' | 'question' | 'now' | 'on' | 'onInterrupt' | 'onTurnEnd'
>;

/** What LiveSource tells the preview tracker. */
export type PreviewLike = Pick<
  PreviewTracker,
  'setViewed' | 'touch' | 'statusChanged' | 'refresh' | 'forget' | 'stop'
>;
/** What the preview tracker reads from and writes to LiveSource. */
export interface PreviewHost {
  previewTarget(id: string): PreviewTarget | null;
  setPreview(id: string, patch: PreviewPatch, always?: boolean): void;
}

/** What LiveSource tells the auto-archiver. */
export type AutoArchiverLike = Pick<AutoArchiver, 'start' | 'touch' | 'sync' | 'stop'>;
/** What the auto-archiver reads from LiveSource. */
export interface AutoArchiveHost {
  autoCandidates(): AutoCandidate[];
}

/** What FinishActions reads before pin, archive or restore. */
export interface FinishTarget {
  id: string;
  /** A copy; null for an external session. */
  record: SessionRecord | null;
  /** Null once the window is gone. */
  windowId: string | null;
  /** The window's pane, for the busy-footer check right before a kill; null once gone. */
  paneId: string | null;
  status: SessionStatus;
  external: boolean;
}

/** What the terminal WebSocket opens (Task 12); see LiveSource.terminalTarget. */
export interface TerminalTarget {
  windowId: string | null;
  paneId: string | null;
  kageId: string | null;
  external: boolean;
  status: SessionStatus;
}

/** PostToolUse of these tools changed files (Task 8). */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface LiveSourceDeps {
  tmux: TmuxClientLike;
  watcher: TmuxWatcherLike;
  /** Kage subscribes only; the caller owns listen() and close(). */
  hooks: HookServerLike;
  store: StateStoreLike;
  tail: (path: string) => TailLike;
  /** Not used by LiveSource itself yet; Task 10 passes it through for snapshot paths. */
  projectsRoot: string;
  /** Wall clock (epoch ms) for statusSince and first-seen times. */
  now?: () => number;
  /** Monotonic clock (ms) for throttles, idle and re-check timing (default performance.now). */
  clock?: () => number;
  /** Makes the preview tracker (ports and changed files of viewed sessions); none without it. */
  preview?: (host: PreviewHost) => PreviewLike;
  /** Makes the auto-archiver (spec §5.8); none without it. */
  autoArchive?: (host: AutoArchiveHost) => AutoArchiverLike;
  /** F11: a session with an open terminal is never archived automatically (Task 12 wires it). */
  isTerminalOpen?: (id: string) => boolean;
  /** One line for Kage's log (serve passes stderr): a failed resume (R63). */
  log?: (line: string) => void;
  /**
   * Called once in start(), after the loaded sessions are emitted and before the hook events
   * that came in meanwhile replay: the notifier's seeds end here (Task 6 fix round).
   */
  onLoaded?: () => void;
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
/** I4: ended records' transcripts are read after start, at most this many at a time. */
const READ_ONCE_CONCURRENCY = 4;
/** A claude window still in its startup checks is captured once more this long after attach. */
const STARTUP_RECHECK_MS = 1000;
/** P4F1: a still-starting launch is looked at once a second for at most this long (Task 0). */
const STARTING_LOOKS_MS = 60_000;
/** A hook pane still unknown after a re-list is dropped without re-listing for this long. */
const UNKNOWN_PANE_MS = 5000;
/** B34: hooks from unknown panes kept this many deep (for UNKNOWN_PANE_MS) for a later claim. */
const SET_ASIDE_MAX = 32;
/** Pane fallback: a new capture continues the last one when they overlap by this many lines (or all of the last). */
const MIN_OVERLAP = 3;
/** After an answer, look at the pane once more this much later (a next question or screen). */
const ANSWER_CHECK_MS = 500;
/** A transcript interrupt this soon after a reply is Kage's own Escape (Review Focus 6). */
const REPLY_INTERRUPT_MS = 5000;
/** The now line of a launched session until Claude says what it is doing. */
const STARTING = 'Starting Claude…';
/** R63: `--resume` found no conversation (a SessionEnd with another, random session id). */
export const RESUME_FAILED =
  "Claude couldn't find this conversation, so the session wasn't resumed.";
/** P3F1: a launched session that had its SessionStart but no first prompt is looked at again this much later. */
const FIRST_PROMPT_MS = 10_000;
/** P3F1: a failed capture at that fallback (a tmux error) is tried once more this much later. */
const FIRST_PROMPT_RETRY_MS = 2000;
/** Claude's footer while a turn runs. */
const BUSY_FOOTER = /esc to interrupt/i;
/**
 * I2: a hooks-mode session the transcript says finished its turn, still running (its Stop lost),
 * has its pane looked at this much later: no busy footer and no prompt there means done.
 */
const TURN_END_CHECK_MS = 2000;

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
/** R22: ensureSession's placeholder window, hidden while it sits at a shell. */
const hiddenPlaceholder = (w: TmuxWindow): boolean => w.placeholder && atShell(w.command);

/**
 * Pane fallback deltas: when `next` continues `prev` (the tail of `prev` is the head of `next`),
 * the lines appended after the overlap; null when they don't overlap (the screen was redrawn) or
 * when `next` is only a strict suffix of `prev` (the capture shrank: nothing to append, but the
 * head the client holds is gone).
 */
function appended(prev: DisplayLine[], next: DisplayLine[]): DisplayLine[] | null {
  if (prev.length === 0) return null;
  const same = (a: DisplayLine | undefined, b: DisplayLine | undefined) =>
    a !== undefined && b !== undefined && a.kind === b.kind && a.text === b.text;
  const min = Math.min(prev.length, MIN_OVERLAP);
  for (let k = Math.min(prev.length, next.length); k >= min; k--) {
    let match = true;
    for (let i = 0; i < k && match; i++) match = same(prev[prev.length - k + i], next[i]);
    if (match) return k === next.length ? null : next.slice(k);
  }
  return null;
}

type TimerName =
  | 'emit'
  | 'idle'
  | 'capture'
  | 'retry'
  | 'retire'
  | 'startup'
  | 'answered'
  | 'replying'
  | 'firstPrompt'
  | 'turnEnd';

interface Live extends SessionView {
  /** 'activity': status from pane activity (no hooks yet); 'hooks': from hooks and the transcript. */
  mode: 'activity' | 'hooks';
  /** The question is a startup screen (R9). */
  startup: boolean;
  /** What kind of prompt the question is (how SessionControls answers it); null unless needs-you. */
  promptKind: PromptKind | null;
  /**
   * Set just before Kage's reply Escape and cleared by its 5 s timer: meanwhile the transcript's
   * interrupt record and the pane's denial line are Kage's own, not a No.
   */
  replying: boolean;
  /**
   * P3F1: Kage launched this session (adopt) and Claude hasn't taken its first prompt yet. Its
   * SessionStart then keeps it running, "Starting Claude…", instead of a brief done (R21) before
   * the task's own UserPromptSubmit. Cleared by the first UserPromptSubmit, PreToolUse or
   * SessionEnd, or by the FIRST_PROMPT_MS fallback after SessionStart.
   */
  firstPromptPending: boolean;
  /** P4F1: when the idle rule first looked at this still-starting launch (monotonic ms), else null. */
  startingSince: number | null;
  /**
   * B7: Kage resumed this session and no hook has come from the new Claude yet; `sessionId` is
   * the id passed to `--resume` (null for `--continue`). R63: a SessionEnd naming another id
   * first means the resume failed.
   */
  resuming: { sessionId: string | null } | null;
  /** The last AskUserQuestion's multiSelect per question text (whitespace collapsed). */
  askMulti: Map<string, boolean>;
  /** The pane has shown the prompt for this needs-you (gates the R11 pane fallback). */
  promptSeen: boolean;
  /** R12: a PreToolUse or PermissionRequest without its PostToolUse, failure, Stop or end yet. */
  pending: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  /** The window's pane has been seen running `claude`. */
  sawClaude: boolean;
  /** A hook arrived from this window: Claude is past its startup screens (no more R9 checks). */
  hookSeen: boolean;
  /** Hooks applied so far: an attach that awaited its tail sees whether one landed meanwhile. */
  hookCount: number;
  /** A capture showed Claude's idle input box: past its startup screens (no more R9 checks). */
  idleSeen: boolean;
  /**
   * The pane was back at a shell after this session was linked: a claude started there next is a
   * new one, so it gets the R9 startup checks although a Claude session is still linked.
   */
  claudeExited: boolean;
  /** Ended because the pane went back to a shell (not by SessionEnd): a non-shell command revives it. */
  shellEnded: boolean;
  tail: TailLike | null;
  tailPath: string | null;
  tailOff: (() => void)[];
  tailQuestionKey: string | null;
  /** Pane fallback lines, or the last transcript lines once the tail stopped. */
  lines: DisplayLine[];
  /** Monotonic ms of the last pane activity. */
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
  readonly #clock: () => number;
  /** Hook panes found in no window by the last re-list, until (monotonic ms). */
  readonly #ignoredPanes = new Map<string, number>();
  /**
   * B14: panes that sent hooks. Listings prefer them when a window has several panes; one that
   * the next listing does not pick for any window is dropped.
   */
  readonly #hookPanes = new Set<string>();
  readonly #listeners = new Set<(e: SourceEvent) => void>();
  readonly #sessions = new Map<string, Live>();
  readonly #records = new Map<string, SessionRecord>();
  /** Window id → kageId for windows Kage just opened, until a listing shows the tag (claim). */
  readonly #claims = new Map<string, string>();
  /** Window id → the listing count when it was claimed: a later listing without it ends the claim. */
  readonly #claimSeq = new Map<string, number>();
  /** B34: window id → the pane id new-window printed, so a claim matches hooks with no listing. */
  readonly #claimPanes = new Map<string, string>();
  /** B34: hooks dropped as from an unknown pane, newest last, for a claim that names the pane. */
  #setAside: { e: HookEvent; at: number }[] = [];
  /** Listings started so far. */
  #listSeq = 0;
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
  readonly #preview: PreviewLike | null;
  readonly #auto: AutoArchiverLike | null;

  constructor(deps: LiveSourceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#clock = deps.clock ?? (() => performance.now());
    this.#preview = deps.preview?.(this) ?? null;
    this.#auto = deps.autoArchive?.(this) ?? null;
  }

  // ------------------------------------------------------------ SessionSource

  list(): Session[] {
    return [...this.#sessions.values()].map(toSession).filter((s) => !s.archived);
  }

  get(id: string): Session | undefined {
    const st = this.#view(id);
    return st ? toSession(st) : undefined;
  }

  /** The project of the newest record (by createdAt), or null. */
  lastProject(): string | null {
    let best: SessionRecord | null = null;
    for (const r of this.#records.values()) if (!best || r.createdAt > best.createdAt) best = r;
    return best?.project ?? null;
  }

  lines(id: string): DisplayLine[] {
    const st = this.#sessions.get(id);
    if (!st) return [];
    return (st.tail ? st.tail.lines() : st.lines).slice(-MAX_LINES).map((l) => ({ ...l }));
  }

  async remove(_id: string): Promise<void> {
    throw new NotImplementedError('Deleting sessions arrives in a later version');
  }

  /** Pane fallback lines are captured, and preview data gathered, only for viewed sessions. */
  setViewed(ids: ReadonlySet<string>): void {
    const before = this.#viewed;
    this.#viewed = new Set(ids);
    if (!this.#running) return;
    if (this.#ready) this.#preview?.setViewed(this.#viewed);
    for (const id of this.#viewed) {
      const st = this.#sessions.get(id);
      if (st && !before.has(id)) this.#requestCapture(st);
    }
  }

  /** R32: another tab views a session that was viewed already; its preview values go out again. */
  refreshView(id: string): void {
    if (this.#ready) this.#preview?.refresh(id);
  }

  subscribe(fn: (e: SourceEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // ------------------------------------------------------------ preview (PreviewTracker)

  /** The folder, base and pane the tracker looks at (F6); null for an unknown id. */
  previewTarget(id: string): PreviewTarget | null {
    const st = this.#sessions.get(id);
    if (!st) return null;
    // The record's project folder: its worktree's git is pinned to it (security M4).
    return previewTarget(st, st.record ? join(this.#d.projectsRoot, st.record.project) : null);
  }

  /**
   * New preview values: session.ports / session.files go out when the value changed, or with
   * `always` (the first value after a view, R32); changed branch counts go out as one
   * session.updated. toSession carries the latest values.
   */
  setPreview(id: string, patch: PreviewPatch, always = false): void {
    const st = this.#sessions.get(id);
    if (!st || !this.#running) return;
    if (patch.ports) {
      const changed = JSON.stringify(patch.ports) !== JSON.stringify(st.ports ?? []);
      st.ports = patch.ports.map((p) => ({ ...p }));
      if (changed || always) {
        this.#emit({ type: 'session.ports', id, ports: st.ports.map((p) => ({ ...p })) });
      }
    }
    if (patch.files) {
      const total = patch.filesTotal ?? patch.files.length;
      const changed =
        total !== (st.filesTotal ?? 0) ||
        JSON.stringify(patch.files) !== JSON.stringify(st.files ?? []) ||
        patch.filesNote !== st.filesNote;
      st.files = patch.files.map((f) => ({ ...f }));
      st.filesTotal = total;
      // The note goes with each files value: a list without one clears it.
      if (patch.filesNote !== undefined) st.filesNote = patch.filesNote;
      else delete st.filesNote;
      if (changed || always) {
        this.#emit({
          type: 'session.files',
          id,
          files: st.files.map((f) => ({ ...f })),
          filesTotal: total,
          ...(st.filesNote !== undefined ? { note: st.filesNote } : {}),
        });
      }
    }
    if (
      patch.unpushed !== undefined ||
      patch.uncommitted !== undefined ||
      patch.ignored !== undefined
    ) {
      // Branch counts travel in session.updated; emitNow sends one only when a value changed.
      if (patch.unpushed !== undefined) st.unpushed = patch.unpushed;
      if (patch.uncommitted !== undefined) st.uncommitted = patch.uncommitted;
      if (patch.ignored !== undefined) st.ignored = patch.ignored;
      this.#emitNow(st);
    }
  }

  // ------------------------------------------------------------ launches (TaskLauncher)

  /**
   * A task Kage is starting: the record is saved at once (awaited; a failed save throws and
   * leaves nothing), then the session shows as running, "Starting Claude…", until its window
   * is listed.
   */
  async adopt(record: SessionRecord): Promise<void> {
    const r = { ...record };
    this.#records.set(r.kageId, r);
    try {
      await this.#d.store.save([...this.#records.values()].map((x) => ({ ...x })));
    } catch (e) {
      this.#records.delete(r.kageId);
      throw e;
    }
    const st = this.#fresh(r.kageId, r);
    st.status = 'running';
    st.now = STARTING;
    st.firstPromptPending = true;
    st.startingSince = null;
    st.lastActivity = this.#clock();
    this.#sessions.set(r.kageId, st);
    this.#emitNow(st);
    this.#auto?.sync();
  }

  /**
   * The window `windowId` is this record's, even while a listing doesn't show its `@kage_id`
   * yet (hooks can arrive first: review focus 6). An `ext-<windowId>` session that a listing
   * made of it meanwhile goes (session.removed); then the windows are listed again.
   * Hooks already applied to that `ext-<windowId>` session are not replayed: every hook names
   * its Claude session and transcript, so the record's session re-learns them (link, tail,
   * status) from the next hook its pane sends.
   * B34: `paneId` is the pane new-window printed. A window that dies before any listing shows
   * it (a failed `--resume` exits at once) still has its hooks matched: those queued for the
   * pane, and those set aside as unknown in the last 5 s, go to the record's session.
   */
  claim(kageId: string, windowId: string, paneId: string): void {
    if (!this.#records.has(kageId)) return;
    this.#claims.set(windowId, kageId);
    this.#claimSeq.set(windowId, this.#listSeq);
    this.#claimPanes.set(windowId, paneId);
    const ext = this.#sessions.get(`ext-${windowId}`);
    if (ext) this.#removeSession(ext);
    if (!this.#running) return;
    this.#ignoredPanes.delete(paneId);
    const since = this.#clock() - UNKNOWN_PANE_MS;
    const mine = this.#setAside.filter((x) => x.e.pane === paneId && x.at >= since);
    this.#setAside = this.#setAside.filter((x) => x.e.pane !== paneId);
    if (mine.length > 0) {
      this.#unknown.push(...mine.map((x) => x.e));
      this.#unknownTimer ??= setTimeout(() => void this.#resolveUnknown(), RELIST_DEBOUNCE_MS);
    }
    void this.#relist();
  }

  /**
   * B7: Kage opened a window that resumes this ended record (`claude --resume`): running,
   * "Starting Claude…", statusSince now, until the P3F1 rule ends the wait (its first prompt,
   * PreToolUse, SessionEnd or the fallback after SessionStart). The record's transcript is
   * followed again (a resume appends to the same file). Leaving ended re-syncs auto-archive.
   * Anything but an ended record is left alone. `sessionId` is the id passed to `--resume`, or
   * null for `--continue` (then whatever session Claude picks is linked).
   */
  resumed(kageId: string, sessionId: string | null): void {
    const st = this.#sessions.get(kageId);
    if (!st?.record || st.record.kageId !== kageId || st.status !== 'ended' || !this.#running) {
      return;
    }
    this.#clearTimers(st, ['retire', 'firstPrompt']);
    st.resuming = { sessionId };
    st.firstPromptPending = true;
    st.startingSince = null;
    // A new claude in a new window: its startup screens are checked afresh (R9).
    st.claudeExited = true;
    st.hookSeen = false;
    st.idleSeen = false;
    st.pending = false;
    st.lastActivity = this.#clock();
    this.#setStatus(st, 'running');
    st.now = STARTING;
    if (st.transcriptPath) void this.#ensureTail(st);
    this.#emitNow(st);
  }

  /**
   * R101: the resume's window didn't open (tmux failed after resumed()): ended again, the wait
   * and the resume cleared (#setStatus), the tail retired as for any end. A session that has
   * moved on meanwhile (a window, a hook) is left alone.
   */
  resumeAborted(kageId: string): void {
    const st = this.#sessions.get(kageId);
    if (!st?.record || st.status === 'ended' || st.window || !st.resuming || !this.#running) return;
    this.#setStatus(st, 'ended');
    st.now = null;
    this.#retireTailSoon(st);
    this.#emitNow(st);
  }

  /**
   * A listed window carries this kage id, or Kage just opened one for it (a claim). A claim
   * whose window a later listing didn't show is gone already (#reconcile drops it).
   */
  hasWindow(kageId: string): boolean {
    const st = this.#sessions.get(kageId);
    if (st?.record?.kageId === kageId && st.window) return true;
    for (const k of this.#claims.values()) if (k === kageId) return true;
    return false;
  }

  /** The launch failed: the record and its session go (session.removed), and that is saved. */
  abandon(kageId: string): Promise<void> {
    return this.forget(kageId);
  }

  /**
   * Delete (and a failed launch): the record and its session go (session.removed), the records
   * are saved at once (a failed save retries in the background), and auto-archive forgets it.
   * An archived record also sends archive {count}. An unknown id does nothing.
   */
  async forget(id: string): Promise<void> {
    for (const [w, k] of this.#claims) if (k === id) this.#dropClaim(w);
    const st = this.#sessions.get(id);
    if (st) this.#removeSession(st);
    const r = this.#records.get(id);
    if (!r) return;
    // An archived record has no session (I4), but the board still hears that it went.
    if (!st && this.#running) this.#emit({ type: 'session.removed', id });
    this.#records.delete(id);
    this.#auto?.sync();
    await this.#saveNow();
    if (r.archived && this.#running) this.#emit({ type: 'archive', count: this.archivedCount() });
  }

  /** True when a record of `project` (archived ones too) uses `branch`. */
  branchTaken(project: string, branch: string): boolean {
    for (const r of this.#records.values()) {
      if (r.project === project && r.branch === branch) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ controls (SessionControls)

  /** What SessionControls checks before it sends keys; null only for an unknown id. */
  target(id: string): ControlTarget | null {
    const st = this.#view(id);
    if (!st) return null;
    const q = st.question;
    return {
      id: st.id,
      kageId: st.record?.kageId ?? null,
      windowId: st.window?.windowId ?? null,
      paneId: st.window?.paneId ?? null,
      status: st.status,
      question: q ? { ...q, options: q.options.slice() } : null,
      promptKind: st.status === 'needs-you' ? st.promptKind : null,
      multiSelect: q !== null && (st.askMulti.get(q.text.replace(/ +/g, ' ').trim()) ?? false),
      external: st.record === null,
    };
  }

  /**
   * Kage answered the prompt: needs-you → running, the question cleared. One check capture
   * 500 ms later shows what came next: another prompt or startup screen (needs-you with it), or
   * the denial line under the tool (done, the answer was No). Any status change meanwhile bumps
   * the gen, and the check is dropped.
   */
  markAnswered(id: string): void {
    const st = this.#sessions.get(id);
    if (st?.status !== 'needs-you' || !this.#running) return;
    this.#clearTimers(st, ['retry', 'answered']);
    this.#setStatus(st, 'running');
    st.lastActivity = this.#clock();
    this.#scheduleIdle(st);
    this.#emitNow(st);
    const gen = st.gen;
    st.timers.answered = setTimeout(() => {
      delete st.timers.answered;
      void this.#checkAfterAnswer(st, gen);
    }, ANSWER_CHECK_MS);
  }

  async #checkAfterAnswer(st: Live, gen: number): Promise<void> {
    if (!this.#running || st.gen !== gen) return;
    const text = await this.#capture(st);
    if (text === null || !this.#running || st.gen !== gen || st.status !== 'running') return;
    if (!showsPrompt(text) && showsDenialLast(text)) {
      this.#clearTimers(st, ['idle']);
      this.#setStatus(st, 'done');
      st.pending = false;
      this.#emitNow(st);
      return;
    }
    // As a first look: a prompt on screen means needs-you even in hooks mode.
    this.#processCapture(st, text, gen, true);
  }

  /**
   * Kage is about to send Escape at a prompt to reply: for 5 s from now the transcript's interrupt
   * record and the pane's denial line are Kage's own, not a No. Should the reply then fail, one
   * capture at the end of those 5 s lets the pane fallback (R11) settle the status.
   */
  markReplying(id: string): void {
    const st = this.#sessions.get(id);
    if (!st || st.status === 'ended' || !this.#running) return;
    st.replying = true;
    this.#clearTimers(st, ['replying']);
    st.timers.replying = setTimeout(() => {
      delete st.timers.replying;
      // Cleared here, so the settling capture below always runs the pane fallback.
      st.replying = false;
      if (st.status === 'needs-you') this.#requestCapture(st);
    }, REPLY_INTERRUPT_MS);
  }

  /** Kage sent a reply: running. The replying window runs on: the interrupt may still land. */
  markReplied(id: string): void {
    const st = this.#sessions.get(id);
    if (!st || st.status === 'ended') return;
    this.#clearTimers(st, ['retry', 'answered']);
    st.pending = false;
    this.#setStatus(st, 'running');
    st.lastActivity = this.#clock();
    this.#scheduleIdle(st);
    this.#emitNow(st);
  }

  // ------------------------------------------------------------ finishing (FinishActions)

  /** What FinishActions checks before pin, archive or restore; null only for an unknown id. */
  finishTarget(id: string): FinishTarget | null {
    const st = this.#view(id);
    if (!st) return null;
    return {
      id: st.id,
      record: st.record ? { ...st.record } : null,
      windowId: st.window?.windowId ?? null,
      paneId: st.window?.paneId ?? null,
      status: st.status,
      external: st.record === null,
    };
  }

  // ------------------------------------------------------------ terminal (TerminalServer)

  /**
   * What the terminal opens (Task 12): the window and pane from the listing, never from the URL.
   * Null only for an unknown id; a known session with no window (or an archived one) has null
   * window and pane, which the terminal answers with "This session has ended." (4409).
   */
  terminalTarget(id: string): TerminalTarget | null {
    const st = this.#view(id);
    if (!st) return null;
    const w = st.record?.archived ? undefined : st.window;
    return {
      windowId: w?.windowId ?? null,
      paneId: w?.paneId ?? null,
      kageId: st.record?.kageId ?? null,
      external: st.record === null,
      status: st.status,
    };
  }

  /** The last terminal on a window closed: its record session's auto-archive check runs (F11). */
  windowIdle(windowId: string): void {
    for (const st of this.#sessions.values()) {
      if (st.window?.windowId !== windowId) continue;
      if (st.record) this.#auto?.touch(st.id);
      return;
    }
  }

  /**
   * Sets a record's pinned and archived flags and saves at once (awaited; a failed save throws
   * and leaves the flags as they were, with no event). Archiving stamps archivedAt and emits
   * session.removed, then archive {count}; restoring clears archivedAt, stamps restoredAt (F2:
   * auto-archive skips it until its next done) and emits session.updated, then archive {count}.
   */
  async setFlags(id: string, f: { pinned?: boolean; archived?: boolean }): Promise<void> {
    // I4: an archived record usually has no session; its record is enough here.
    const st = this.#sessions.get(id);
    const r = this.#records.get(id);
    if (!r || (st && st.record !== r)) return;
    const before = { ...r };
    const archiving = f.archived === true && !r.archived;
    const restoring = f.archived === false && r.archived;
    if (f.pinned !== undefined) r.pinned = f.pinned;
    // R69: an unpinned session's age for auto-archive starts again now.
    if (before.pinned && f.pinned === false) r.unpinnedAt = this.#now();
    if (archiving) {
      r.archived = true;
      r.archivedAt = this.#now();
    } else if (restoring) {
      r.archived = false;
      r.archivedAt = null;
      r.restoredAt = this.#now();
    }
    if (r.pinned === before.pinned && !archiving && !restoring) return;
    try {
      await this.#d.store.save([...this.#records.values()].map((x) => ({ ...x })));
    } catch (e) {
      Object.assign(r, before);
      throw e;
    }
    this.#auto?.sync();
    if (!this.#running) return;
    const now = this.#sessions.get(id);
    if (archiving) {
      if (now) {
        // Hidden from the board: the preview stops looking, and a restore sends it afresh.
        now.last = null;
        this.#preview?.forget(id);
        this.#emit({ type: 'session.removed', id });
        // I4: an archived record keeps no session, tail or lines; a restore builds them again.
        this.#dropSession(now);
      }
      this.#emit({ type: 'archive', count: this.archivedCount() });
      return;
    }
    if (restoring) {
      if (now) {
        now.last = null;
        this.#emitNow(now);
        this.#emit({ type: 'archive', count: this.archivedCount() });
        return;
      }
      // I4: the session is built, and its transcript read, now rather than at start.
      const fresh = this.#fresh(id, r);
      this.#sessions.set(id, fresh);
      this.#trackDone(fresh);
      this.#emitNow(fresh);
      this.#emit({ type: 'archive', count: this.archivedCount() });
      await this.#readLater(fresh);
      return;
    }
    if (now && now === st) this.#emitNow(now);
  }

  /**
   * Auto-archive candidates (spec §5.8): record sessions that are done or ended, with a doneAt,
   * not pinned, not archived, not restored since their last done (F2) and with no open terminal
   * (F11). External and active sessions never are. Their age counts from ageFrom (R69).
   */
  autoCandidates(): AutoCandidate[] {
    const out: AutoCandidate[] = [];
    for (const st of this.#sessions.values()) {
      const r = st.record;
      if (!r || r.pinned || r.archived || r.doneAt === null) continue;
      if (st.status !== 'done' && st.status !== 'ended') continue;
      if (r.restoredAt !== null && r.doneAt <= r.restoredAt) continue;
      if (this.#d.isTerminalOpen?.(st.id)) continue;
      out.push({
        id: st.id,
        repo: join(this.#d.projectsRoot, r.project),
        worktree: r.worktree,
        branch: r.branch,
        base: r.base,
        baseCommit: r.baseCommit,
        doneAt: r.doneAt,
        // R69: the age rule counts from the latest of the last done, restore and unpin.
        ageFrom: Math.max(r.doneAt, r.restoredAt ?? r.doneAt, r.unpinnedAt ?? r.doneAt),
      });
    }
    return out;
  }

  /** Archived sessions, newest first, at most LIMITS.archived. */
  archivedList(): ArchivedSession[] {
    return [...this.#records.values()]
      .filter((r) => r.archived)
      .map((r) => ({
        id: r.kageId,
        project: r.project,
        task: r.task,
        branch: r.branch,
        archivedAt: r.archivedAt ?? r.createdAt,
      }))
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .slice(0, LIMITS.archived);
  }

  archivedCount(): number {
    let n = 0;
    for (const r of this.#records.values()) if (r.archived) n++;
    return n;
  }

  /** Kage killed the window: ended now; the window-close listing confirms it. */
  markStopped(id: string): void {
    const st = this.#sessions.get(id);
    if (!st || st.status === 'ended') return;
    this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
    st.mode = 'hooks';
    this.#setStatus(st, 'ended');
    st.pending = false;
    this.#retireTailSoon(st);
    this.#emitNow(st);
    this.#recheckSoon(STOP_RECHECK_MS);
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
    // I4: archived records get no session and no read; archivedList() reads the records.
    for (const r of this.#records.values()) {
      if (!r.archived) this.#sessions.set(r.kageId, this.#fresh(r.kageId, r));
    }
    try {
      await this.#d.tmux.ensureSession();
    } catch {
      // No tmux: every record shows as ended; the watcher retries with backoff.
    }
    let listing: { windows: TmuxWindow[]; seq: number } = { windows: [], seq: this.#listSeq };
    try {
      listing = await this.#listWindows();
    } catch {}
    if (!this.#running) return;
    await this.#reconcile(listing.windows, listing.seq);
    // A record saved before phase 4 that is done or ended now gets the load time as its doneAt.
    for (const st of this.#sessions.values()) this.#trackDone(st);
    for (const st of this.#sessions.values()) this.#emitNow(st);
    try {
      this.#d.onLoaded?.();
    } catch {
      // a broken listener must not stop the source
    }
    this.#ready = true;
    if (this.#viewed.size > 0) this.#preview?.setViewed(this.#viewed);
    const early = this.#early;
    this.#early = [];
    for (const e of early) this.#onHook(e);
    this.#d.watcher.start();
    this.#auto?.start();
    // I4: ended records' last lines are read after the board is up and the early hooks applied,
    // a few at a time; each session's lines go out as its read finishes.
    void this.#readEnded(
      [...this.#sessions.values()].filter((st) => !st.window && st.transcriptPath && !st.tail),
    );
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#ready = false;
    for (const off of this.#off) off();
    this.#off = [];
    this.#d.watcher.stop();
    this.#auto?.stop();
    if (this.#unknownTimer) clearTimeout(this.#unknownTimer);
    this.#unknownTimer = null;
    if (this.#recheckTimer) clearTimeout(this.#recheckTimer);
    this.#recheckTimer = null;
    this.#unknown = [];
    this.#early = [];
    this.#setAside = [];
    for (const st of this.#sessions.values()) {
      this.#clearTimers(st);
      this.#stopTail(st);
    }
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#preview?.stop();
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
      promptKind: null,
      replying: false,
      firstPromptPending: false,
      startingSince: null,
      resuming: null,
      askMulti: new Map(),
      promptSeen: false,
      pending: false,
      sessionId: record?.sessionId ?? null,
      transcriptPath: record?.transcriptPath ?? null,
      sawClaude: false,
      hookSeen: false,
      hookCount: 0,
      idleSeen: false,
      claudeExited: false,
      shellEnded: false,
      tail: null,
      tailPath: null,
      tailOff: [],
      tailQuestionKey: null,
      lines: [],
      lastActivity: Number.NEGATIVE_INFINITY,
      gen: 0,
      last: null,
      lastEmitAt: Number.NEGATIVE_INFINITY,
      lastCaptureAt: Number.NEGATIVE_INFINITY,
      capturing: false,
      captureAgain: false,
      timers: {},
    };
  }

  /**
   * Lists windows, each by its hook pane when it has one (B14). Hook panes the listing asked
   * about and found in no window are forgotten; ones that arrived meanwhile stay.
   */
  async #listWindows(): Promise<{ windows: TmuxWindow[]; seq: number }> {
    const seq = ++this.#listSeq;
    const asked = new Set(this.#hookPanes);
    const windows = await this.#d.tmux.listWindows(asked);
    const listed = new Set(windows.map((w) => w.paneId));
    for (const p of asked) if (!listed.has(p)) this.#hookPanes.delete(p);
    return { windows, seq };
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
          let listing: { windows: TmuxWindow[]; seq: number };
          try {
            listing = await this.#listWindows();
          } catch {
            continue; // a failed listing changes nothing; the watcher reports a dead server
          }
          if (!this.#running) return;
          await this.#reconcile(listing.windows, listing.seq);
        } while (this.#listAgain && this.#running);
      } finally {
        this.#listing = null;
      }
    })();
    return this.#listing;
  }

  /** A listed window's last activity (epoch seconds) on the monotonic clock. */
  #activityAt(w: TmuxWindow): number {
    return this.#clock() - Math.max(0, this.#now() - w.activity * 1000);
  }

  /** `seq`: the listing's number (#listWindows), to tell which claims it can end. */
  async #reconcile(windows: TmuxWindow[], seq: number): Promise<void> {
    const seen = new Set<string>();
    const attaching: Promise<void>[] = [];
    // A claim lasts until a listing shows the window's tag (or abandon, or the server goes
    // down), or until a listing that started after the claim doesn't show the window (it died
    // just after the launch). Not any listing without it: one begun before new-window ran
    // would drop it too early.
    for (const w of windows) if (w.kageId) this.#dropClaim(w.windowId);
    const listed = new Set(windows.map((w) => w.windowId));
    /** Records whose claimed window died before any listing showed it → the claimed pane. */
    const lost = new Map<string, string | undefined>();
    for (const [w, at] of this.#claimSeq) {
      if (!this.#claims.has(w)) this.#dropClaim(w);
      else if (at < seq && !listed.has(w)) {
        lost.set(this.#claims.get(w) as string, this.#claimPanes.get(w));
        this.#dropClaim(w);
      }
    }
    for (const w of windows) {
      const claimed = this.#claims.get(w.windowId);
      if (claimed && this.#records.has(claimed)) w.kageId = claimed;
      this.#ignoredPanes.delete(w.paneId);
      // R22: Kage's placeholder stays hidden while it sits at a shell; once it runs anything
      // else it is an ordinary window, so its tag goes.
      if (hiddenPlaceholder(w)) continue;
      if (w.placeholder) {
        this.#d.tmux.clearPlaceholder(w.windowId).catch(() => {});
        w.placeholder = false;
      }
      const record = w.kageId ? this.#records.get(w.kageId) : undefined;
      const id = record ? record.kageId : `ext-${w.windowId}`;
      seen.add(id);
      let st = this.#sessions.get(id);
      if (!st) {
        st = this.#fresh(id, record ?? null);
        this.#sessions.set(id, st);
      }
      if (atShell(w.command)) this.#atShell(st);
      if (st.window?.windowId === w.windowId) {
        const old = st.window;
        st.window = w;
        st.lastActivity = Math.max(st.lastActivity, this.#activityAt(w));
        if (this.#claudeGone(st, w)) {
          if (st.status !== 'ended') this.#endInWindow(st);
        } else if (st.status === 'ended' && st.shellEnded) {
          // Ctrl+Z then fg: claude is in front again. Re-attach, which restarts the tail.
          attaching.push(this.#attach(st, w));
        } else {
          if (!st.record && (old.name !== w.name || old.cwd !== w.cwd)) {
            // Only an external session shows window fields (task, project, worktree).
            this.#emitNow(st);
          }
          // claude started in a shell window: look for its startup screens (F2).
          if (old.command !== w.command && this.#startupEligible(st)) {
            this.#requestCapture(st);
            this.#scheduleStartupCheck(st);
          }
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
    // A launched or resumed window that died before any listing showed it: the session was
    // never attached, so nothing above ends it. Ended now (which also ends the resume and the
    // first-prompt wait), unless another listed window carries its id.
    for (const [id, pane] of lost) {
      const st = this.#sessions.get(id);
      if (!st?.record || st.window || st.status === 'ended') continue;
      // B34: the pane's hooks waiting on this listing are its own (a failed resume's SessionEnd).
      const mine = this.#unknown.filter((e) => e.pane === pane);
      if (mine.length > 0) {
        this.#unknown = this.#unknown.filter((e) => e.pane !== pane);
        for (const e of mine) this.#applyHook(st, e);
        // TS keeps the narrowing from above; #applyHook may have ended it (resumeFailed).
        if ((st.status as SessionStatus) === 'ended') continue;
      }
      this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
      st.mode = 'hooks';
      st.pending = false;
      this.#setStatus(st, 'ended');
      this.#retireTailSoon(st);
      this.#emitNow(st);
    }
    await Promise.all(attaching);
  }

  /** Links a session to its window and works out its status (restart rebuild, §5.8a). */
  async #attach(st: Live, w: TmuxWindow): Promise<void> {
    st.window = w;
    st.gen++;
    this.#clearTimers(st, ['retire']);
    st.lastActivity = Math.max(st.lastActivity, this.#activityAt(w));
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
      const hooks = st.hookCount;
      await this.#ensureTail(st);
      if (!this.#running || st.window !== w) return;
      // A resumed session's transcript is its last run's: until the first prompt, P3F1 decides.
      // A hook that landed during the await is fresher than the transcript (R101): it stands.
      if (!st.firstPromptPending && st.hookCount === hooks) this.#rebuildFromTail(st);
    }
    this.#scheduleIdle(st);
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!this.#running || st.window !== w) return;
    if (text !== null) this.#processCapture(st, text, gen, true);
    this.#scheduleStartupCheck(st);
    this.#emitNow(st);
  }

  /**
   * F2: a window seen before Claude has drawn anything (or whose output arrived before it was
   * listed) may show a startup screen that then sits still, with no activity to trigger a
   * capture. Look once more a second later while it still needs startup checks.
   */
  #scheduleStartupCheck(st: Live): void {
    if (!this.#running || st.timers.startup || st.startup || !this.#startupEligible(st)) return;
    st.timers.startup = setTimeout(() => {
      delete st.timers.startup;
      if (!st.startup) this.#requestCapture(st);
    }, STARTUP_RECHECK_MS);
  }

  /**
   * Spec §5.3 and R17: a session whose `claude` is gone is ended. True when the pane is back at
   * a shell and the session had a Claude: it linked a Claude session, or it is Kage's and its
   * pane ran something other than a shell. A dead pane (its process exited and `remain-on-exit`
   * keeps it shown) is gone too, whatever command it still names.
   */
  #claudeGone(st: Live, w: TmuxWindow): boolean {
    if (w.dead) return st.sessionId !== null || st.record !== null || st.sawClaude;
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

  /**
   * The pane is at a shell: whatever claude ran there is gone, so the next one starts its
   * startup checks afresh (R9), even in a window whose earlier claude sent hooks.
   */
  #atShell(st: Live): void {
    st.hookSeen = false;
    st.idleSeen = false;
    st.claudeExited = true;
  }

  /** pane_current_command changes fire no tmux event: re-list, at most once per second. */
  #recheckSoon(delay: number): void {
    if (!this.#running || this.#recheckTimer) return;
    const now = this.#clock();
    const wait = Math.max(delay, this.#lastRecheckAt + RECHECK_MS - now);
    this.#recheckTimer = setTimeout(() => {
      this.#recheckTimer = null;
      this.#lastRecheckAt = this.#clock();
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
    this.#preview?.forget(st.id);
    this.#emit({ type: 'session.removed', id: st.id });
    if (st.record) this.#auto?.sync();
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
        // A new server numbers its panes afresh: old hook panes would mislead the next listing.
        this.#hookPanes.clear();
        // …and its windows afresh: a claimed id could name someone else's window.
        this.#claims.clear();
        this.#claimSeq.clear();
        this.#claimPanes.clear();
        this.#setAside = [];
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
    if (!st) {
      // A hidden placeholder (R22), or a window not listed yet: re-list to see what runs there.
      this.#recheckSoon(0);
      return;
    }
    st.lastActivity = this.#clock();
    if (st.mode === 'activity' && !st.startup) {
      this.#setStatus(st, 'running');
      this.#scheduleIdle(st);
      this.#emitThrottled(st);
    }
    // Re-list to see claude exit, or come back after Ctrl+Z (a shell-ended session revives), or
    // a shell window start claude (pane_current_command changes fire no tmux event).
    if (
      (st.mode === 'hooks' && (st.status !== 'ended' || st.shellEnded)) ||
      (st.mode === 'activity' && st.window !== null && atShell(st.window.command))
    ) {
      this.#recheckSoon(0);
    }
    this.#requestCapture(st);
  }

  #activityStatus(st: Live): SessionStatus {
    return this.#clock() - st.lastActivity < ACTIVE_MS ? 'running' : 'done';
  }

  /**
   * Activity mode: running turns done 5 s after the last activity (one timer, re-armed lazily).
   * P4F1: a launched or resumed claude that has sent no hook yet is still starting (a quiet pane
   * may be a startup screen drawn after the last capture), so the idle rule looks at the pane
   * instead: a startup screen is needs-you; anything else stays running, "Starting Claude…", and
   * is looked at again STARTUP_RECHECK_MS later, until the first hook, the idle input box, the
   * window's end, or STARTING_LOOKS_MS of looks (then the usual rule: done).
   */
  #scheduleIdle(st: Live, after?: number): void {
    if (!this.#running) return;
    if (st.timers.idle || st.mode !== 'activity' || st.status !== 'running' || st.startup) return;
    const wait = after ?? Math.max(0, st.lastActivity + ACTIVE_MS - this.#clock());
    st.timers.idle = setTimeout(() => {
      delete st.timers.idle;
      if (!this.#running || st.mode !== 'activity' || st.status !== 'running' || st.startup) {
        return;
      }
      if (this.#clock() - st.lastActivity < ACTIVE_MS) this.#scheduleIdle(st);
      else if (this.#stillStarting(st)) void this.#startingCheck(st);
      else {
        // R104: the looks are over, so is the resume: its replayed question no longer hides a new one.
        st.resuming = null;
        this.#setStatus(st, 'done');
        this.#emitNow(st);
      }
    }, wait);
  }

  /**
   * P4F1: a Kage claude with no hook yet and no idle input box seen: still on its way in. Not
   * once its looks have run for STARTING_LOOKS_MS: a pane that quiet is left to the activity rule.
   */
  #stillStarting(st: Live): boolean {
    return (
      st.record !== null &&
      st.firstPromptPending &&
      this.#startupEligible(st) &&
      (st.startingSince === null || this.#clock() - st.startingSince < STARTING_LOOKS_MS)
    );
  }

  /** P4F1: the idle rule's look at a still-starting pane (see #scheduleIdle). */
  async #startingCheck(st: Live): Promise<void> {
    st.startingSince ??= this.#clock();
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!this.#running || this.#sessions.get(st.id) !== st || st.gen !== gen) return;
    if (st.mode !== 'activity' || st.status !== 'running' || st.startup) return;
    if (text !== null) this.#processCapture(st, text, gen, false);
    if (st.mode !== 'activity' || st.status !== 'running' || st.startup) return;
    // Once the idle input box showed, it is no longer starting: the usual rule from here.
    this.#scheduleIdle(st, this.#stillStarting(st) ? STARTUP_RECHECK_MS : undefined);
  }

  // ------------------------------------------------------------ hooks

  #onHook(e: HookEvent): void {
    if (!this.#running) return;
    if (!this.#ready) {
      this.#early.push(e);
      return;
    }
    if (e.pane === null) return;
    this.#hookPanes.add(e.pane);
    const st = this.#byPane(e.pane);
    if (!st) {
      // A hooks-enabled Claude outside the kage session: one re-list per 5 s, not per burst.
      const until = this.#ignoredPanes.get(e.pane);
      if (until !== undefined && this.#clock() < until) {
        this.#setAsideHook(e);
        return;
      }
      this.#ignoredPanes.delete(e.pane);
    }
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
      if (e.pane === null || !this.#running) continue;
      const st = this.#byPane(e.pane);
      if (st) this.#applyHook(st, e);
      else {
        this.#ignoredPanes.set(e.pane, this.#clock() + UNKNOWN_PANE_MS);
        this.#setAsideHook(e);
      }
    }
  }

  /** B34: keeps a dropped hook for a claim that may name its pane soon (the newest 32). */
  #setAsideHook(e: HookEvent): void {
    this.#setAside.push({ e, at: this.#clock() });
    if (this.#setAside.length > SET_ASIDE_MAX) this.#setAside.shift();
  }

  /** A claim ends: its window, listing number and pane go together. */
  #dropClaim(windowId: string): void {
    this.#claims.delete(windowId);
    this.#claimSeq.delete(windowId);
    this.#claimPanes.delete(windowId);
  }

  #applyHook(st: Live, e: HookEvent): void {
    if (st.resuming) {
      const want = st.resuming.sessionId;
      st.resuming = null;
      if (e.event === 'SessionEnd' && want !== null && e.sessionId !== want) {
        this.#resumeFailed(st, want);
        return;
      }
    }
    // R12: a permission Notification counts only while a tool is pending.
    const counts = !(e.event === 'Notification' && e.notification === 'permission' && !st.pending);
    // Every hook names its session and transcript: link on any of them, so a pane whose
    // SessionStart Kage missed (a restart, a hook lost) still gets its tail.
    this.#link(st, e);
    st.hookSeen = true;
    st.hookCount++;
    st.claudeExited = false;
    // A compaction (auto-compact can run mid-turn) is the same turn going on (R21 exception).
    const compact = e.event === 'SessionStart' && e.source === 'compact';
    // I2: a hook says what Claude is doing; a turn-end check armed before it is moot.
    this.#clearTimers(st, ['startup', 'turnEnd']);
    if (e.event === 'PreToolUse' || e.event === 'PermissionRequest') st.pending = true;
    if (
      e.event === 'PostToolUse' ||
      e.event === 'PostToolUseFailure' ||
      e.event === 'Stop' ||
      e.event === 'SessionEnd' ||
      (e.event === 'SessionStart' && !compact)
    ) {
      st.pending = false;
    }
    st.mode = 'hooks';
    st.startup = false;
    this.#clearTimers(st, ['idle']);
    if (e.event === 'UserPromptSubmit' || e.event === 'PreToolUse' || e.event === 'SessionEnd') {
      this.#endFirstPromptWait(st);
    }
    const before = st.status;
    let next = counts ? (nextStatus(st.status, e) ?? st.status) : st.status;
    // P3F1: a launched session's SessionStart comes just before its task's first prompt.
    if (e.event === 'SessionStart' && !compact && st.firstPromptPending && before !== 'ended') {
      next = 'running';
      st.now = STARTING;
      this.#clearTimers(st, ['firstPrompt']);
      st.timers.firstPrompt = setTimeout(() => {
        delete st.timers.firstPrompt;
        void this.#firstPromptFallback(st);
      }, FIRST_PROMPT_MS);
    }
    this.#setStatus(st, next);
    if (before === 'ended' && next !== 'ended') this.#clearTimers(st, ['retire']);
    if (next === 'needs-you') {
      if (e.event === 'PreToolUse' && e.toolName === 'AskUserQuestion') {
        st.question =
          questionFromToolInput(e.toolInput) ?? st.question ?? st.tail?.question() ?? null;
        st.promptKind = 'ask';
        st.askMulti = multiSelectByQuestion(e.toolInput);
      } else if (
        e.event === 'PermissionRequest' ||
        (e.event === 'Notification' && counts && !st.question)
      ) {
        if (e.event === 'PermissionRequest') st.promptKind = 'permission';
        void this.#capturePrompt(st, false);
      }
    }
    if (next === 'ended') this.#retireTailSoon(st);
    if (e.event === 'Stop' || e.event === 'SessionEnd') this.#recheckSoon(STOP_RECHECK_MS);
    // Status, question and count changes go at once; a hook that only moved the now line (a
    // tool hook in a running turn) shares the 250 ms throttle with the transcript (spec §5.5).
    this.#emitThrottled(st);
    if (e.event === 'PostToolUse' && e.toolName !== null && EDIT_TOOLS.has(e.toolName)) {
      this.#preview?.touch(st.id, 'edit');
    } else if (e.event === 'Stop') this.#preview?.touch(st.id, 'turn-end');
    // A turn end checks the session for auto-archive, also when it was done already.
    if (e.event === 'Stop' && st.record) this.#auto?.touch(st.id);
  }

  /**
   * R63: `--resume <id>` found no conversation; Claude sent a SessionEnd with a new random id and
   * exits. The session is ended again, keeping its old link (never the random id), and the
   * error is reported: a line on the card and one in Kage's log.
   */
  #resumeFailed(st: Live, sessionId: string): void {
    this.#endFirstPromptWait(st);
    this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
    st.mode = 'hooks';
    st.pending = false;
    this.#setStatus(st, 'ended');
    const line: DisplayLine = { kind: 'out', text: RESUME_FAILED };
    st.lines = [...(st.tail ? st.tail.lines() : st.lines), line].slice(-MAX_LINES);
    this.#stopTail(st);
    st.now = null;
    this.#emitLines(st, [line], false);
    this.#emitNow(st);
    this.#d.log?.(
      `kage: session ${st.id} wasn't resumed: Claude found no conversation ${sessionId}`,
    );
    this.#recheckSoon(STOP_RECHECK_MS);
  }

  /** The wait ends (its fallback and retry timers too); "Starting Claude…" goes with it. */
  #endFirstPromptWait(st: Live): void {
    st.firstPromptPending = false;
    st.resuming = null;
    this.#clearTimers(st, ['firstPrompt']);
    if (st.now === STARTING) st.now = st.tail?.now() ?? null;
  }

  /**
   * P3F1 fallback: FIRST_PROMPT_MS after SessionStart no first prompt came. In hooks mode nothing
   * else would move the status, so it never stays running unless Claude is busy: a startup
   * screen or a dialog on the pane makes it needs-you with that question; "esc to interrupt"
   * keeps it running; anything else is done. A failed capture is retried once FIRST_PROMPT_RETRY_MS
   * later; when that fails too, it is done. A hook that ends the wait meanwhile wins.
   */
  async #firstPromptFallback(st: Live, retried = false): Promise<void> {
    if (!st.firstPromptPending) return;
    if (!this.#running || st.status !== 'running') {
      this.#endFirstPromptWait(st);
      return;
    }
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!st.firstPromptPending || !this.#running || this.#sessions.get(st.id) !== st) return;
    if (st.gen !== gen || st.status !== 'running') {
      this.#endFirstPromptWait(st);
      this.#emitNow(st);
      return;
    }
    if (text === null && !retried) {
      // A SessionStart during the capture may have armed a fresh fallback in this slot.
      this.#clearTimers(st, ['firstPrompt']);
      st.timers.firstPrompt = setTimeout(() => {
        delete st.timers.firstPrompt;
        void this.#firstPromptFallback(st, true);
      }, FIRST_PROMPT_RETRY_MS);
      return;
    }
    this.#endFirstPromptWait(st);
    const screen = text === null ? null : parseStartupScreen(text);
    const prompt = text === null || screen ? null : parsePermissionPrompt(text);
    if (screen) {
      this.#clearTimers(st, ['idle', 'startup']);
      this.#setStatus(st, 'needs-you');
      st.startup = true;
      st.question = { text: screen.text, options: screen.options, startup: true };
      st.promptKind = screen.screen;
    } else if (prompt && text !== null) {
      this.#clearTimers(st, ['idle']);
      this.#setStatus(st, 'needs-you');
      st.question = prompt;
      st.promptKind = numberedPromptKind(text) ?? 'permission';
      st.promptSeen = true;
      st.pending = true;
    } else if (text === null || !BUSY_FOOTER.test(text)) {
      this.#clearTimers(st, ['idle']);
      this.#setStatus(st, 'done');
    }
    this.#emitNow(st);
  }

  /**
   * Links the pane to the hook's Claude session and follows its transcript. A hook without a
   * transcript path keeps the one in use unless the session changed.
   */
  #link(st: Live, e: HookEvent): void {
    const newSession = e.sessionId !== st.sessionId;
    const path = e.transcriptPath ?? (newSession ? null : st.transcriptPath);
    const changed = newSession || path !== st.transcriptPath;
    if (changed) {
      st.sessionId = e.sessionId;
      st.transcriptPath = path;
      if (st.record) {
        st.record.sessionId = e.sessionId;
        st.record.transcriptPath = path;
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
    // An ended session's tail is retired; only a SessionStart (a resume) follows it again.
    if ((changed || !st.tail) && (st.status !== 'ended' || e.event === 'SessionStart')) {
      void this.#ensureTail(st);
    }
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
    tail.setIdle(st.status !== 'running');
    st.tailOff = [
      tail.on((added, reset) => {
        if (st.tail !== tail) return;
        this.#emitLines(st, reset ? tail.lines() : added, reset);
        this.#onTailChange(st, tail);
      }),
      tail.onInterrupt(() => {
        if (st.tail !== tail) return;
        // Kage's reply at a prompt starts with Escape, whose interrupt record lands after it.
        // B26: a real Esc meanwhile looks the same, so the pane decides a moment later.
        if (this.#replying(st)) {
          this.#armTurnEndCheck(st);
          return;
        }
        // R11: No or Esc fires no hook; the transcript shows it.
        if (st.status !== 'ended') this.#setStatus(st, 'done');
        st.question = null;
        st.pending = false;
        st.now = tail.now();
        this.#emitNow(st);
      }),
      tail.onTurnEnd(() => {
        if (st.tail !== tail) return;
        this.#armTurnEndCheck(st);
      }),
    ];
    this.#emitLines(st, [], true);
    try {
      await tail.start();
    } catch {}
  }

  /**
   * I2: the transcript says the turn ended (or B26: an interrupt taken for Kage's own Escape)
   * while a hooks-mode session is running. Its Stop may be lost (`kage hook` gives up after
   * 1.5 s), and nothing else would move it, so one check looks at the pane TURN_END_CHECK_MS
   * later. Any hook cancels it. One timer per session, armed only then.
   */
  #armTurnEndCheck(st: Live): void {
    if (!this.#running || st.mode !== 'hooks' || st.status !== 'running') return;
    this.#clearTimers(st, ['turnEnd']);
    const gen = st.gen;
    const hooks = st.hookCount;
    st.timers.turnEnd = setTimeout(() => {
      delete st.timers.turnEnd;
      void this.#turnEndCheck(st, gen, hooks);
    }, TURN_END_CHECK_MS);
  }

  /**
   * Done, through #setStatus (doneAt, the done ping and auto-archive follow), only when the pane
   * agrees: no busy footer ("esc to interrupt": a tool or a turn still runs) and no prompt or
   * startup screen. A failed capture, a status change or a hook meanwhile leaves it as it is.
   */
  async #turnEndCheck(st: Live, gen: number, hooks: number): Promise<void> {
    const still = () =>
      this.#running &&
      this.#sessions.get(st.id) === st &&
      st.gen === gen &&
      st.hookCount === hooks &&
      st.mode === 'hooks' &&
      st.status === 'running';
    if (!still()) return;
    const text = await this.#capture(st);
    if (!still() || text === null || BUSY_FOOTER.test(text) || showsPrompt(text)) return;
    this.#clearTimers(st, ['idle']);
    st.pending = false;
    this.#setStatus(st, 'done');
    st.now = st.tail?.now() ?? null;
    this.#emitNow(st);
    // As at a Stop: the files and ports refresh.
    this.#preview?.touch(st.id, 'turn-end');
  }

  #onTailChange(st: Live, tail: TailLike): void {
    st.now = tail.now() ?? (st.firstPromptPending ? STARTING : null);
    const q = tail.question();
    const key = questionKey(q);
    if (st.resuming) {
      // A resume replays the old transcript before the new claude's first hook: an open
      // question there belongs to the ended run. Remember it so it never shows (or pings).
      st.tailQuestionKey = key;
    } else if (key !== st.tailQuestionKey) {
      st.tailQuestionKey = key;
      if (q && st.status !== 'ended') {
        if (st.status !== 'needs-you') this.#setStatus(st, 'needs-you');
        st.question ??= q;
        st.promptKind ??= 'ask';
      }
    } else if (q && st.status === 'needs-you' && !st.question) {
      st.question = q;
      st.promptKind ??= 'ask';
    }
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
      st.promptKind = 'ask';
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

  /**
   * I4: reads ended sessions' transcripts after start, READ_ONCE_CONCURRENCY at a time. A session
   * that moved on meanwhile (a window, a resume, archived or forgotten) is skipped.
   */
  async #readEnded(list: Live[]): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (this.#running && next < list.length) await this.#readLater(list[next++] as Live);
    };
    await Promise.all(
      Array.from({ length: Math.min(READ_ONCE_CONCURRENCY, list.length) }, () => worker()),
    );
  }

  /**
   * A deferred read (after start, or at a restore): the session's last lines from its transcript,
   * sent as session.lines {reset}. The tail's first read fires no listener (M1, F28). Skipped, or
   * its result dropped, when the session has a window or a tail by then, or is gone.
   */
  async #readLater(st: Live): Promise<void> {
    const current = () =>
      this.#running && this.#sessions.get(st.id) === st && !st.window && !st.tail;
    const path = st.transcriptPath;
    if (!path || !current()) return;
    const tail = this.#d.tail(path);
    let lines: DisplayLine[] | null = null;
    try {
      await tail.start();
      lines = tail.lines();
    } catch {
    } finally {
      tail.stop();
    }
    if (lines === null || !current() || st.transcriptPath !== path) return;
    st.lines = lines;
    st.now = null;
    if (lines.length > 0 && !st.record?.archived) this.#emitLines(st, lines, true);
  }

  /** I4: an archived session leaves memory: its timers, tail and lines go with it. */
  #dropSession(st: Live): void {
    this.#clearTimers(st);
    this.#stopTail(st);
    st.window = null;
    st.gen++;
    this.#sessions.delete(st.id);
  }

  /**
   * The session, or for an archived record without one (I4) a throwaway ended view of it, so
   * get, finishTarget, terminalTarget and target still answer for it. Never stored.
   */
  #view(id: string): Live | undefined {
    const st = this.#sessions.get(id);
    if (st) return st;
    const r = this.#records.get(id);
    return r?.archived ? this.#fresh(id, r) : undefined;
  }

  #retireTailSoon(st: Live): void {
    if (!this.#running || !st.tail || st.timers.retire) return;
    // The final flush keeps its one size poll (fs.watch can miss events): the tail stops after it.
    st.tail.setIdle(false);
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
    st.lastCaptureAt = this.#clock();
    try {
      return await this.#d.tmux.capturePane(paneId, MAX_LINES);
    } catch {
      return null;
    }
  }

  /**
   * R9 startup checks: a Kage window, or one running claude, with no Claude session linked yet
   * (or whose linked claude exited to the shell). They stop once a hook arrived or the idle input
   * box showed, so a claude window is not captured on every activity forever; the pane going
   * back to a shell starts them again for the next claude.
   */
  #startupEligible(st: Live): boolean {
    return (
      st.window !== null &&
      (st.sessionId === null || st.claudeExited) &&
      !st.hookSeen &&
      !st.idleSeen &&
      (st.record !== null || isClaude(st.window.command))
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
    const wait = st.lastCaptureAt + THROTTLE_MS - this.#clock();
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
        // A capture that continues the last one sends only what was appended.
        const added = appended(st.lines, lines);
        st.lines = lines;
        if (added === null) this.#emitLines(st, lines, true);
        else this.#emitLines(st, added, false);
      }
    }
    // The status changed while the capture ran: what it shows may predate that change.
    if (gen !== st.gen && !initial) return;
    if (this.#startupEligible(st)) {
      const screen = parseStartupScreen(text);
      if (screen) {
        this.#clearTimers(st, ['startup']);
        this.#setStatus(st, 'needs-you');
        st.startup = true;
        st.question = { text: screen.text, options: screen.options, startup: true };
        st.promptKind = screen.screen;
        this.#emitNow(st);
        return;
      }
      if (showsIdleBox(text)) {
        st.idleSeen = true;
        this.#clearTimers(st, ['startup']);
      }
      if (st.startup) {
        st.startup = false;
        // A screen answered: the wait for the next one is a fresh one (its own 60 s of looks).
        st.startingSince = null;
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
        st.promptKind ??= numberedPromptKind(text);
        this.#emitNow(st);
      } else if (st.promptSeen && !showsPrompt(text) && !this.#replying(st)) {
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
      st.promptKind = numberedPromptKind(text);
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
      st.promptKind = numberedPromptKind(text as string) ?? 'permission';
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

  /** Within 5 s of Kage's reply Escape (Review Focus 6). */
  #replying(st: Live): boolean {
    return st.replying;
  }

  #setStatus(st: Live, status: SessionStatus): void {
    if (status === st.status) return;
    const wasFinished = st.status === 'done' || st.status === 'ended';
    st.status = status;
    st.shellEnded = false;
    st.statusSince = this.#now();
    st.gen++;
    // P7: only a running session's tail polls; a hook, activity or the watcher wakes the others.
    st.tail?.setIdle(status !== 'running');
    // Ended (SessionEnd, the window gone, claude back at a shell, a kill) before any hook: no
    // resume or first prompt is awaited any more.
    if (status === 'ended') {
      st.resuming = null;
      if (st.firstPromptPending) this.#endFirstPromptWait(st);
    }
    this.#trackDone(st);
    if (status !== 'needs-you') {
      st.question = null;
      st.promptKind = null;
      st.promptSeen = false;
      st.startup = false;
      this.#clearTimers(st, ['retry']);
    }
    if (this.#ready) this.#preview?.statusChanged(st.id);
    // Auto-archive: a move into done or ended checks the session; leaving them re-syncs.
    if (this.#ready && st.record) {
      if (status === 'done' || status === 'ended') this.#auto?.touch(st.id);
      else if (wasFinished) this.#auto?.sync();
    }
  }

  /**
   * A record's doneAt: set on its move into done or ended (kept from done to ended), cleared on
   * running or needs you; saved with the debounced save.
   */
  #trackDone(st: Live): void {
    const r = st.record;
    if (!r) return;
    const finished = st.status === 'done' || st.status === 'ended';
    if (finished && r.doneAt === null) r.doneAt = this.#now();
    else if (!finished && r.doneAt !== null) r.doneAt = null;
    else return;
    this.#saveSoon();
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
    st.lastEmitAt = this.#clock();
    this.#emit({ type: 'session.updated', session: s });
  }

  /**
   * Hook-, activity- and transcript-driven updates. A change to the now line alone goes out at
   * most once per 250 ms per session, with a trailing edge that carries the latest state; any
   * other visible change (status, question, counts) goes at once and takes the pending one along.
   */
  #emitThrottled(st: Live): void {
    if (!this.#running) return;
    const change = viewChange(st.last, st);
    // Nothing new: nothing to send, and no timer waits to send it.
    if (change === 'none') return;
    if (change === 'other') {
      this.#emitNow(st);
      return;
    }
    if (st.timers.emit) return;
    const wait = st.lastEmitAt + THROTTLE_MS - this.#clock();
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
