import { join } from 'node:path';
import {
  type ArchivedSession,
  type Cause,
  type DisplayLine,
  LIMITS,
  type Session,
  type SessionStatus,
  type Transition,
} from '@kage/shared';
import type { ControlTarget } from './control/actions.ts';
import type { PromptKind } from './control/keys.ts';
import type { AutoArchiver, AutoCandidate } from './finish/auto-archive.ts';
import type { HookEvent } from './hooks/event.ts';
import type { HookServer } from './hooks/server.ts';
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
  type FirstPromptScreen,
  holdsFirstPrompt,
  type Observation,
  type PromptRead,
  permissionCounts,
  resumeFails,
  type StatusFacts,
  step,
} from './live/status.ts';
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
import { SessionMissing, type TmuxClient } from './tmux/client.ts';
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
  | 'start'
  | 'stop'
  | 'setIdle'
  | 'poke'
  | 'lines'
  | 'question'
  | 'now'
  | 'on'
  | 'onInterrupt'
  | 'onTurnEnd'
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

/**
 * Kills the window: true when killed, false when it was gone already; a throw aborts with nothing
 * changed (Task 9).
 */
export type Close = () => Promise<boolean>;

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
/**
 * M9: pane activity from a running hooks-mode session (Claude's spinner) re-lists at most this
 * often, for the R17 exit check. A Stop or SessionEnd re-lists at once, as do activity-mode and
 * shell-ended sessions.
 */
const ACTIVITY_RELIST_MS = 5000;

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
/**
 * A pane whose shell hasn't started yet: tmux's forked child before its exec (`tmux`), or no
 * foreground process to name. The first listing after new-session can see this under load.
 */
const starting = (command: string): boolean => command === 'tmux' || command === '';
/** R22: ensureSession's placeholder window, hidden while it sits at (or is starting) a shell. */
const hiddenPlaceholder = (w: TmuxWindow): boolean =>
  w.placeholder && (atShell(w.command) || starting(w.command));

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
  /**
   * The session is on the board: a transition placed it. Until then `status` is #fresh's 'ended'
   * and the status module sees null (the first transition's `from`).
   */
  placed: boolean;
  /**
   * An attach at start or after the watcher's up is under way: what it learns is reconcile (F3).
   * `catchUp` is that attach's token, so an overlapping attach doesn't clear it early.
   */
  catchingUp: boolean;
  catchUp: object | null;
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
  /**
   * R12: tools with a PreToolUse or PermissionRequest and no PostToolUse, failure, Stop or end
   * yet, by `tool_use_id` (M11: parallel tools' hooks can arrive reversed); UNNAMED_TOOL for one
   * without an id. A permission Notification counts only while this isn't empty.
   */
  pending: Set<string>;
  /** M11: ids whose PostToolUse arrived before their PreToolUse: that PreToolUse adds nothing. */
  toolsDone: Set<string>;
  /**
   * M3: when Kage began launching or resuming this record (monotonic ms; adopt or resumed, both
   * before new-window): hooks set aside before then can't be from its new window.
   */
  launchedAt: number;
  /**
   * When Kage first saw this session (monotonic ms; `firstSeen` is the wall-clock time shown as
   * an external session's start). R152's young-window check reads this one, so a wall clock
   * that steps neither reopens the loss path nor sets an old window's hooks aside.
   */
  firstSeenAt: number;
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
  /** I2: the cause that armed the `turnEnd` timer (F19), kept and cleared with it. */
  turnEndCause: Cause | null;
  /** The cause of the last transition (#apply); #fresh's 'reconcile' until one (F18). */
  lastCause: Cause;
  /**
   * The status and statusSince the last frame showed, or that a suppressed frame (archived) would
   * have shown: a frame carries `lastCause` only when they changed (Task 8). Null: no frame yet.
   */
  framed: { status: SessionStatus; since: number } | null;
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
  /**
   * B34: hooks dropped as from an unknown pane, newest last, for a claim that names the pane;
   * `gen` is the server generation they were set aside in (M3).
   */
  #setAside: { e: HookEvent; at: number; gen: number }[] = [];
  /**
   * Task 0: a resuming session ended because its window went before any hook said why, by pane:
   * the session, the id passed to `--resume`, when (monotonic ms) and the server generation.
   * A SessionEnd from that pane within UNKNOWN_PANE_MS is the failed resume's (R63).
   */
  #lateResumes = new Map<string, { id: string; want: string; at: number; gen: number }>();
  /** When each hook reached #onHook (monotonic ms): a set-aside entry's `at` is its arrival. */
  readonly #arrivedAt = new WeakMap<HookEvent, number>();
  /** M3: bumped at each `down`: a new tmux server numbers its panes and windows afresh. */
  #serverGen = 0;
  /** M4: the watcher saw `up` and no `down` since: its control client is attached. */
  #attached = false;
  /** M4: the "session isn't there by that name" line was logged in this episode. */
  #missingLogged = false;
  /** M9: when the last activity-driven re-list of a running hooks-mode session was asked. */
  #activityRelistAt = Number.NEGATIVE_INFINITY;
  #activityTimer: ReturnType<typeof setTimeout> | null = null;
  /** Listings started so far. */
  #listSeq = 0;
  #running = false;
  #ready = false;
  /**
   * From the watcher's `up` until the re-list it starts has finished: an attach meanwhile is
   * catching up. `#resyncSeq` names the latest `up`, so an earlier one's re-list doesn't end it.
   */
  #resyncing = false;
  #resyncSeq = 0;
  #early: HookEvent[] = [];
  /**
   * Task 9: sessions inside archive, restore or stopSession, from its first line to its last.
   * No listing, `down` or lost claim touches them meanwhile, and their hooks wait in `#held`.
   */
  #finishing = new Set<string>();
  #held = new Map<string, HookEvent[]>();
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
    st.now = STARTING;
    st.startingSince = null;
    st.lastActivity = this.#clock();
    st.launchedAt = this.#clock();
    // F17: on the map before its first transition (null → running, act; the first-prompt wait on).
    this.#sessions.set(r.kageId, st);
    this.#apply(st, { kind: 'launched' });
    this.#emitNow(st);
    // While ready, its transition (from off the board) re-synced auto-archive already.
    if (!this.#ready) this.#auto?.sync();
  }

  /**
   * The window `windowId` is this record's, even while a listing doesn't show its `@kage_id`
   * yet (hooks can arrive first: review focus 6). An `ext-<windowId>` session that a listing
   * made of it meanwhile goes (session.removed); then the windows are listed again.
   * R152: hooks applied to that `ext-<windowId>` session while its window was younger than
   * UNKNOWN_PANE_MS were set aside too, so they go to the record's session like any set-aside
   * hook below (a failed resume's SessionEnd that landed before the tag). Older ones are not
   * replayed: every hook names its Claude session and transcript, so the record's session
   * re-learns them (link, tail, status) from the next hook its pane sends.
   * B34: `paneId` is the pane new-window printed. A window that dies before any listing shows
   * it (a failed `--resume` exits at once) still has its hooks matched: those queued for the
   * pane, and those set aside as unknown in the last 5 s, go to the record's session.
   * M3: only those set aside since the launch began (adopt or resumed, both before new-window)
   * and on the current tmux server: a dead server's pane numbers come back on the new one.
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
    const launched = this.#sessions.get(kageId)?.launchedAt ?? Number.NEGATIVE_INFINITY;
    const since = Math.max(this.#clock() - UNKNOWN_PANE_MS, launched);
    const mine = this.#setAside.filter(
      (x) => x.e.pane === paneId && x.at >= since && x.gen === this.#serverGen,
    );
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
    if (!st?.record || !this.#running) return;
    // Ended → running, act: resuming, the first-prompt wait on, nothing pending. The module
    // decides whether it moves (an ended record on the board only); if not, nothing changes.
    if (!this.#apply(st, { kind: 'resumed', sessionId })) return;
    this.#clearTimers(st, ['retire', 'firstPrompt']);
    st.startingSince = null;
    // A new claude in a new window: its startup screens are checked afresh (R9).
    st.claudeExited = true;
    st.hookSeen = false;
    st.idleSeen = false;
    st.lastActivity = this.#clock();
    st.launchedAt = this.#clock();
    st.now = STARTING;
    if (st.transcriptPath) void this.#ensureTail(st);
    this.#emitNow(st);
  }

  /**
   * R101: the resume's window didn't open (tmux failed after resumed()): ended again, the wait
   * and the resume cleared (#apply), the tail retired as for any end. A session that has
   * moved on meanwhile (a window, a hook) is left alone.
   */
  resumeAborted(kageId: string): void {
    const st = this.#sessions.get(kageId);
    if (!st?.record || !this.#running) return;
    // The module moves only a record on the board, not ended, still resuming, with no window.
    if (!this.#apply(st, { kind: 'resume-aborted' })) return;
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
    if (!st || !this.#running) return;
    // The module moves only a needs-you session.
    if (!this.#apply(st, { kind: 'answered' })) return;
    this.#clearTimers(st, ['retry', 'answered']);
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
      // Running (checked above): done, no tool pending; act, as the answer it follows (Task 6).
      this.#apply(st, { kind: 'answer-denied' });
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
    if (!st) return;
    // Running, act, nothing pending (also when it was running already). The module leaves a
    // session that is ended or off the board as it is; then nothing else changes either.
    this.#apply(st, { kind: 'replied' });
    if (!st.placed || st.status !== 'running') return;
    this.#clearTimers(st, ['retry', 'answered']);
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
   * Sets a record's pin and saves at once (awaited; a failed save throws and leaves it as it was,
   * with no event). Unpinning stamps unpinnedAt (R69). The session's next frame shows it.
   */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    // I4: an archived record usually has no session; its record is enough here.
    const st = this.#sessions.get(id);
    const r = this.#records.get(id);
    if (!r || (st && st.record !== r) || r.pinned === pinned) return;
    const before = { pinned: r.pinned, unpinnedAt: r.unpinnedAt };
    r.pinned = pinned;
    // R69: an unpinned session's age for auto-archive starts again now.
    if (!pinned) r.unpinnedAt = this.#now();
    try {
      await this.#save();
    } catch (e) {
      Object.assign(r, before);
      throw e;
    }
    this.#auto?.sync();
    if (!this.#running) return;
    const now = this.#sessions.get(id);
    if (now && now === st) this.#emitNow(now);
  }

  /**
   * Archive as one operation (Task 9, R140). `close` (null: no window to close) runs first, with
   * no await before it (R70); its throw aborts with nothing changed. Then the session is ended
   * (`stopped`, act, unless it was ended already), archived and archivedAt are set and saved
   * (awaited: a failed save puts the flags back and throws; the session stays, ended if it was
   * killed, and no session.removed goes). Then exactly one session.removed, the preview
   * forgets it, the session is dropped (I4), archive {count} goes and auto-archive re-syncs.
   * No listing touches the session meanwhile (#finishing).
   */
  async archive(id: string, close: Close | null): Promise<void> {
    const st = this.#sessions.get(id);
    const r = this.#records.get(id);
    if (!r || r.archived || (st && st.record !== r)) return;
    await this.#finish(id, close, async () => {
      const cur = this.#sessions.get(id);
      if (cur) this.#stopped(cur);
      r.archived = true;
      r.archivedAt = this.#now();
      try {
        await this.#save();
      } catch (e) {
        r.archived = false;
        r.archivedAt = null;
        throw e;
      }
      if (this.#running) {
        const now = this.#sessions.get(id);
        if (now) {
          // Hidden from the board: the preview stops looking, and a restore sends it afresh.
          this.#emit({ type: 'session.removed', id });
          this.#preview?.forget(id);
          now.last = null;
          // I4: an archived record keeps no session, tail or lines; a restore builds them again.
          this.#dropSession(now);
        }
        this.#emit({ type: 'archive', count: this.archivedCount() });
      }
      this.#auto?.sync();
    });
  }

  /**
   * Restore as one operation (Task 9): archived and archivedAt cleared, restoredAt stamped (F2:
   * auto-archive skips it until its next done) and saved (awaited; a failed save puts them back
   * and throws, with no event). A fresh session goes back on the board as ended (`restored`, null
   * → ended, act), with its frame, then archive {count}; its transcript is read after the
   * operation. F11: an archived record whose session still exists (a stale listing, a failed
   * kill) gets no transition, only its frame, then archive {count}.
   */
  async restore(id: string): Promise<void> {
    const st = this.#sessions.get(id);
    const r = this.#records.get(id);
    if (!r?.archived || (st && st.record !== r)) return;
    let fresh: Live | null = null;
    await this.#finish(id, null, async () => {
      const before = { archived: r.archived, archivedAt: r.archivedAt, restoredAt: r.restoredAt };
      r.archived = false;
      r.archivedAt = null;
      r.restoredAt = this.#now();
      try {
        await this.#save();
      } catch (e) {
        Object.assign(r, before);
        throw e;
      }
      this.#auto?.sync();
      if (!this.#running) return;
      const now = this.#sessions.get(id);
      if (now) {
        now.last = null;
        // F11: no transition here, so its frame carries no cause (Task 8).
        now.framed = { status: now.status, since: now.statusSince };
        this.#emitNow(now);
        this.#emit({ type: 'archive', count: this.archivedCount() });
        return;
      }
      // I4: the session is built, and its transcript read, now rather than at start.
      fresh = this.#fresh(id, r);
      this.#sessions.set(id, fresh);
      // A restore is Kage's act: back on the board as ended (null → ended).
      this.#apply(fresh, { kind: 'restored' });
      this.#emitNow(fresh);
      this.#emit({ type: 'archive', count: this.archivedCount() });
    });
    // F11: after the operation, so listings don't wait on a slow transcript read.
    if (fresh) await this.#readLater(fresh);
  }

  /**
   * Stop as one operation (Task 9, F1; the lifecycle stop is `stop()`): `close` kills the window
   * (its throw aborts with nothing changed), then the session is ended (`stopped`, act). No
   * listing touches the session meanwhile (#finishing); the closing re-list confirms the window
   * gone.
   */
  async stopSession(id: string, close: Close): Promise<void> {
    await this.#finish(id, close, async () => {
      const st = this.#sessions.get(id);
      if (st) this.#stopped(st);
    });
  }

  /**
   * One finishing operation on `id`, from its first line to its last: `close` is called at once
   * (no await before it: R70), then `rest` runs. Meanwhile #reconcile, the watcher's `down` and
   * the lost-claim path leave the session alone (F10), and its hooks wait. After it (thrown or
   * not) the hooks that waited are applied to the session if it is still there (an archived one
   * isn't: they move nothing), and a re-list catches up on what the listings skipped.
   */
  async #finish(id: string, close: Close | null, rest: () => Promise<void>): Promise<void> {
    this.#finishing.add(id);
    try {
      const closing = close?.();
      if (closing) await closing;
      await rest();
    } finally {
      this.#finishing.delete(id);
      const held = this.#held.get(id) ?? [];
      this.#held.delete(id);
      for (const e of held) {
        const st = this.#sessions.get(id);
        if (st && this.#running) this.#applyHook(st, e);
      }
      this.#recheckSoon(STOP_RECHECK_MS);
    }
  }

  /**
   * Kage closed the window: ended now (act), in hooks mode with nothing pending; its timers and
   * tail wind down. The module moves only a session on the board and not ended.
   */
  #stopped(st: Live): void {
    if (!this.#apply(st, { kind: 'stopped' })) return;
    this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
    this.#retireTailSoon(st);
    this.#emitNow(st);
  }

  /** The records, saved at once (awaited). */
  #save(): Promise<void> {
    return this.#d.store.save([...this.#records.values()].map((x) => ({ ...x })));
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

  /** Hook panes ignored for now (M11: expired ones are pruned at each hook); for tests. */
  ignoredPaneCount(): number {
    return this.#ignoredPanes.size;
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
    // Each session no window placed goes on the board as ended (null → ended, reconcile); a
    // record saved before phase 4 thereby gets the load time as its doneAt.
    for (const st of this.#sessions.values()) if (!st.placed) this.#apply(st, { kind: 'loaded' });
    for (const st of this.#sessions.values()) this.#emitNow(st);
    // Hooks that came in meanwhile replay below as live transitions; the start's own are
    // reconcile, so the notifier pings only the former (ADR 0001).
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
    this.#resyncing = false;
    for (const off of this.#off) off();
    this.#off = [];
    this.#d.watcher.stop();
    this.#auto?.stop();
    if (this.#unknownTimer) clearTimeout(this.#unknownTimer);
    this.#unknownTimer = null;
    if (this.#recheckTimer) clearTimeout(this.#recheckTimer);
    this.#recheckTimer = null;
    if (this.#activityTimer) clearTimeout(this.#activityTimer);
    this.#activityTimer = null;
    this.#attached = false;
    this.#missingLogged = false;
    this.#unknown = [];
    this.#early = [];
    this.#setAside = [];
    this.#lateResumes.clear();
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
      placed: false,
      catchingUp: false,
      catchUp: null,
      mode: 'activity',
      startup: false,
      promptKind: null,
      replying: false,
      firstPromptPending: false,
      startingSince: null,
      resuming: null,
      askMulti: new Map(),
      promptSeen: false,
      pending: new Set(),
      toolsDone: new Set(),
      launchedAt: Number.NEGATIVE_INFINITY,
      firstSeenAt: this.#clock(),
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
      turnEndCause: null,
      lastCause: 'reconcile',
      framed: null,
    };
  }

  /**
   * Lists windows, each by its hook pane when it has one (B14). Hook panes the listing asked
   * about and found in no window are forgotten; ones that arrived meanwhile stay.
   */
  async #listWindows(): Promise<{ windows: TmuxWindow[]; seq: number }> {
    const seq = ++this.#listSeq;
    const asked = new Set(this.#hookPanes);
    // M4: strict, so a renamed session (SessionMissing) isn't read as "no windows".
    const windows = await this.#d.tmux.listWindows(asked, { strict: true });
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
          } catch (e) {
            if (!(e instanceof SessionMissing)) continue; // the watcher reports a dead server
            if (this.#attached) {
              // M4: the watcher is still attached, so the session lives under another name
              // (rename-session): every state stays, and Resume still finds the window.
              this.#sessionMissing(e);
              continue;
            }
            listing = { windows: [], seq: this.#listSeq };
          }
          if (!this.#running) return;
          this.#missingLogged = false;
          await this.#reconcile(listing.windows, listing.seq);
        } while (this.#listAgain && this.#running);
      } finally {
        this.#listing = null;
      }
    })();
    return this.#listing;
  }

  /** M4: logged once per episode; a listing that works, or a `down`, ends the episode. */
  #sessionMissing(e: SessionMissing): void {
    if (this.#missingLogged) return;
    this.#missingLogged = true;
    this.#d.log?.(
      `kage: the tmux session "${e.session}" isn't there by that name any more, so Kage keeps the last state.`,
    );
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
    const listedPanes = new Set(windows.map((w) => w.paneId));
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
      // Task 9: a session inside archive, restore or stop is left alone; its re-list catches up.
      if (this.#finishing.has(id)) continue;
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
      if (seen.has(st.id) || this.#finishing.has(st.id)) continue;
      if (!st.record) this.#removeSession(st);
      else if (st.window) {
        // Task 0: hooks that waited on this listing came from the window now gone (a failed
        // resume's SessionEnd, queued while an earlier listing still showed the window). Not
        // when this listing shows the pane in another window: they are that window's.
        const pane = st.window.paneId;
        if (!listedPanes.has(pane)) this.#takeQueued(st, pane);
        this.#rememberResume(st, pane);
        this.#detach(st);
      }
      // R138: an archived record keeps no session without a window.
      else if (st.record.archived) this.#dropSession(st);
    }
    // A launched or resumed window that died before any listing showed it: the session was
    // never attached, so nothing above ends it. Ended now (which also ends the resume and the
    // first-prompt wait), unless another listed window carries its id.
    for (const [id, pane] of lost) {
      const st = this.#sessions.get(id);
      // F10: the operation's own `stopped` ends a finishing session. If that operation's close
      // threw instead, nothing would end it: its claim is dropped above and no later listing
      // reports it lost. Unreachable today (R157): a lost session has no window, and with no
      // window no caller passes a close that can throw (archive's close is null and stop
      // answers 409 before the operation; restore's close is always null).
      if (!st?.record || st.window || st.status === 'ended' || this.#finishing.has(id)) continue;
      // B34: the pane's hooks waiting on this listing are its own (a failed resume's SessionEnd).
      this.#takeQueued(st, pane);
      // TS keeps the narrowing from above; #applyHook may have ended it (resumeFailed).
      if ((st.status as SessionStatus) === 'ended') continue;
      this.#rememberResume(st, pane);
      this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
      this.#apply(st, { kind: 'window-gone', serverDown: false });
      this.#retireTailSoon(st);
      this.#emitNow(st);
    }
    await Promise.all(attaching);
  }

  /** Links a session to its window and works out its status (restart rebuild, §5.8a). */
  async #attach(st: Live, w: TmuxWindow): Promise<void> {
    // F3: an attach at start or after the watcher's up catches up (reconcile); one while Kage
    // watches doesn't. This attach's token: an overlapping one takes over, and only the latest
    // clears it.
    const token = {};
    st.catchUp = token;
    st.catchingUp = !this.#ready || this.#resyncing;
    try {
      await this.#attachWindow(st, w);
    } finally {
      if (st.catchUp === token) {
        st.catchUp = null;
        st.catchingUp = false;
      }
    }
  }

  async #attachWindow(st: Live, w: TmuxWindow): Promise<void> {
    st.window = w;
    st.gen++;
    this.#clearTimers(st, ['retire']);
    st.lastActivity = Math.max(st.lastActivity, this.#activityAt(w));
    if (st.record && st.record.windowId !== w.windowId) {
      st.record.windowId = w.windowId;
      this.#saveSoon();
    }
    if (this.#claudeGone(st, w)) {
      this.#endInWindow(st);
      if (!st.tail && st.transcriptPath) await this.#readOnce(st);
      if (this.#running) this.#emitNow(st);
      return;
    }
    // R141: a session that was done when Kage stopped (its record's doneAt) isn't made running by
    // a recent redraw alone; its transcript decides below. Else a restart blinked it running,
    // reset its doneAt (auto-archive's age) and, once the turn-end check settled it, sent a done
    // ping for a turn that ended before the restart.
    const wasDone = st.record?.doneAt != null && st.transcriptPath !== null;
    // Activity mode, no tool pending; then done or running (status module).
    this.#apply(st, { kind: 'attached', active: this.#active(st), wasDone });
    if (st.transcriptPath) {
      const hooks = st.hookCount;
      await this.#ensureTail(st);
      if (!this.#running || st.window !== w) return;
      // A resumed session's transcript is its last run's: until the first prompt, P3F1 decides.
      // A hook that landed during the await is fresher than the transcript (R101): it stands.
      if (!st.firstPromptPending && st.hookCount === hooks) this.#rebuildFromTail(st, wasDone);
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
    // Ended and shellEnded, hooks mode, no tool pending (status module).
    this.#apply(st, { kind: 'claude-exited' });
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

  /**
   * The hooks waiting on a listing (#unknown) from `paneId`, a pane this listing found gone, are
   * this session's: applied in order and taken off the queue, so #resolveUnknown doesn't set
   * them aside for a pane no session has any more (Task 0, B34).
   */
  #takeQueued(st: Live, paneId: string | undefined): void {
    if (paneId === undefined) return;
    const mine = this.#unknown.filter((e) => e.pane === paneId);
    if (mine.length === 0) return;
    this.#unknown = this.#unknown.filter((e) => e.pane !== paneId);
    for (const e of mine) this.#applyHook(st, e);
  }

  /**
   * The window is gone (or tmux is: `serverDown`, the watcher's down, reconcile): a Kage session
   * is ended, with no tool pending (status module).
   */
  #detach(st: Live, serverDown = false): void {
    st.window = null;
    this.#clearTimers(st, ['emit', 'retire']);
    this.#apply(st, { kind: 'window-gone', serverDown });
    st.gen++;
    this.#retireTailSoon(st);
    this.#emitNow(st);
    // R138: an archived record's session (a stale listing, a failed kill) goes with its window.
    if (st.record?.archived) this.#dropSession(st);
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
      case 'up': {
        this.#attached = true;
        // What this re-list's attaches learn is Kage catching up after a reattach (reconcile).
        const seq = ++this.#resyncSeq;
        this.#resyncing = true;
        void this.#relist().finally(() => {
          if (this.#resyncSeq === seq) this.#resyncing = false;
        });
        break;
      }
      case 'windows-changed':
        void this.#relist();
        break;
      case 'down':
        this.#attached = false;
        this.#missingLogged = false;
        // A new server numbers its panes afresh: old hook panes would mislead the next listing.
        this.#hookPanes.clear();
        // …and its windows afresh: a claimed id could name someone else's window.
        this.#claims.clear();
        this.#claimSeq.clear();
        this.#claimPanes.clear();
        // M3: hooks waiting on a listing, ignored panes and set-aside hooks are the old server's;
        // anything set aside from now on carries the new generation.
        this.#serverGen++;
        this.#setAside = [];
        this.#lateResumes.clear();
        this.#unknown = [];
        this.#ignoredPanes.clear();
        if (this.#unknownTimer) clearTimeout(this.#unknownTimer);
        this.#unknownTimer = null;
        // …and so are the hooks waiting on a finishing operation.
        this.#held.clear();
        for (const st of [...this.#sessions.values()]) {
          // F10: a finishing session is the operation's; its closing re-list catches up.
          if (this.#finishing.has(st.id)) continue;
          if (!st.record) this.#removeSession(st);
          else if (st.window) this.#detach(st, true);
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
    // R138: an idle tail (the session isn't running) takes one size check: a turn the hooks
    // haven't announced yet doesn't wait on fs.watch alone.
    if (st.status !== 'running') st.tail?.poke();
    // F12: the poke above reads the status before this move.
    if (st.mode === 'activity' && !st.startup) {
      this.#apply(st, { kind: 'activity' });
      this.#scheduleIdle(st);
      this.#emitThrottled(st);
    }
    // Re-list to see claude exit, or come back after Ctrl+Z (a shell-ended session revives), or
    // a shell window start claude (pane_current_command changes fire no tmux event).
    if (st.mode === 'hooks' && st.status === 'running') {
      // M9: Claude's spinner draws all turn long; its Stop or SessionEnd re-lists at once.
      this.#activityRelist();
    } else if (
      (st.mode === 'hooks' && (st.status !== 'ended' || st.shellEnded)) ||
      (st.mode === 'activity' && st.window !== null && atShell(st.window.command))
    ) {
      this.#recheckSoon(0);
    }
    this.#requestCapture(st);
  }

  /**
   * M9: a re-list for a running hooks-mode session's activity, at most once per
   * ACTIVITY_RELIST_MS; activity inside that wait arms one trailing re-list at its end, so a
   * Claude that dies without its SessionEnd is still seen.
   */
  #activityRelist(): void {
    if (!this.#running || this.#activityTimer) return;
    const wait = this.#activityRelistAt + ACTIVITY_RELIST_MS - this.#clock();
    if (wait <= 0) {
      this.#activityRelistAt = this.#clock();
      this.#recheckSoon(0);
      return;
    }
    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = null;
      this.#activityRelistAt = this.#clock();
      this.#recheckSoon(0);
    }, wait);
  }

  /** The pane drew within the last 5 s. */
  #active(st: Live): boolean {
    return this.#clock() - st.lastActivity < ACTIVE_MS;
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
        // Done; R104: the looks are over, so is the resume (`step` ends it).
        this.#apply(st, { kind: 'idle', at: this.#now() });
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
    // Kept from the first time it came in (an early hook is replayed through here once ready).
    if (!this.#arrivedAt.has(e)) this.#arrivedAt.set(e, this.#clock());
    if (!this.#ready) {
      this.#early.push(e);
      return;
    }
    if (e.pane === null) return;
    this.#hookPanes.add(e.pane);
    // M11: entries past their expiry go, also for panes that never send again.
    const now = this.#clock();
    for (const [p, until] of this.#ignoredPanes) if (now >= until) this.#ignoredPanes.delete(p);
    const st = this.#byPane(e.pane);
    if (!st) {
      // A hooks-enabled Claude outside the kage session: one re-list per 5 s, not per burst.
      if (this.#ignoredPanes.has(e.pane)) {
        if (!this.#lateResumeFailed(e)) this.#setAsideHook(e);
        return;
      }
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
    const gen = this.#serverGen;
    await this.#relist();
    // M3: a `down` meanwhile cleared the queue; what came after it waits for its own re-list.
    if (gen !== this.#serverGen) return;
    const queued = this.#unknown;
    this.#unknown = [];
    for (const e of queued) {
      if (e.pane === null || !this.#running) continue;
      const st = this.#byPane(e.pane);
      if (st) this.#applyHook(st, e);
      else if (!this.#lateResumeFailed(e)) {
        this.#ignoredPanes.set(e.pane, this.#clock() + UNKNOWN_PANE_MS);
        this.#setAsideHook(e);
      }
    }
  }

  /**
   * Task 0: the resume's window went (the session ended with no line), and then its SessionEnd
   * came, naming another session than the one resumed: Claude found no conversation (R63).
   * True when it was applied so. Entries past UNKNOWN_PANE_MS, or from an earlier tmux server, go.
   */
  #lateResumeFailed(e: HookEvent): boolean {
    const now = this.#clock();
    for (const [p, r] of this.#lateResumes) {
      if (now - r.at > UNKNOWN_PANE_MS || r.gen !== this.#serverGen) this.#lateResumes.delete(p);
    }
    if (e.pane === null || e.event !== 'SessionEnd') return false;
    const late = this.#lateResumes.get(e.pane);
    if (!late) return false;
    this.#lateResumes.delete(e.pane);
    const st = this.#sessions.get(late.id);
    if (e.sessionId === late.want || !st?.record || st.window || st.status !== 'ended')
      return false;
    this.#resumeFailed(st, late.want);
    return true;
  }

  /** Task 0: a resuming session about to end with its window gone, before any hook said why. */
  #rememberResume(st: Live, paneId: string | undefined): void {
    const want = st.resuming?.sessionId;
    if (paneId === undefined || want == null) return;
    this.#lateResumes.set(paneId, {
      id: st.id,
      want,
      at: this.#clock(),
      gen: this.#serverGen,
    });
  }

  /** B34: keeps a dropped hook for a claim that may name its pane soon (the newest 32). */
  #setAsideHook(e: HookEvent): void {
    // Its arrival, not now: a hook that came before a launch began isn't that launch's, even
    // when its re-list ended after (M3, Task 10's review).
    this.#setAside.push({ e, at: this.#arrivedAt.get(e) ?? this.#clock(), gen: this.#serverGen });
    if (this.#setAside.length > SET_ASIDE_MAX) this.#setAside.shift();
  }

  /** A claim ends: its window, listing number and pane go together. */
  #dropClaim(windowId: string): void {
    this.#claims.delete(windowId);
    this.#claimSeq.delete(windowId);
    this.#claimPanes.delete(windowId);
  }

  #applyHook(st: Live, e: HookEvent): void {
    // Task 9: a session inside archive, restore or stop takes its hooks after the operation.
    if (this.#finishing.has(st.id)) {
      const held = this.#held.get(st.id);
      if (held) held.push(e);
      else this.#held.set(st.id, [e]);
      return;
    }
    // R152: a listing can show Kage's new window before its tag lands, as `ext-<windowId>`. Its
    // hooks are kept for a claim too while the window is young: claim() moves them to #unknown,
    // so the record's session gets them (a failed resume's SessionEnd above all).
    if (!st.record && e.pane !== null && this.#clock() - st.firstSeenAt < UNKNOWN_PANE_MS) {
      this.#setAsideHook(e);
    }
    const facts = this.#factsOf(st);
    const want = st.resuming?.sessionId ?? null;
    if (want !== null && resumeFails(facts, e)) {
      this.#resumeFailed(st, want);
      return;
    }
    // The hook's step ends the resume too; it ends here first, so a tail #link starts below
    // doesn't take this Claude's transcript for the resume's replay (#onTailChange).
    st.resuming = null;
    // R12: a permission Notification counts only while a tool is pending.
    const counts = permissionCounts(facts, e);
    // Every hook names its session and transcript: link on any of them, so a pane whose
    // SessionStart Kage missed (a restart, a hook lost) still gets its tail.
    this.#link(st, e);
    st.hookSeen = true;
    st.hookCount++;
    st.claudeExited = false;
    // I2: a hook says what Claude is doing; a turn-end check armed before it is moot.
    this.#clearTimers(st, ['startup', 'turnEnd', 'idle']);
    // P3F1: a launched session's SessionStart comes just before its task's first prompt; `step`
    // keeps it running, and its fallback looks at the pane if no prompt comes.
    if (holdsFirstPrompt(this.#factsOf(st), e)) {
      st.now = STARTING;
      this.#clearTimers(st, ['firstPrompt']);
      st.timers.firstPrompt = setTimeout(() => {
        delete st.timers.firstPrompt;
        void this.#firstPromptFallback(st);
      }, FIRST_PROMPT_MS);
    }
    const before = st.status;
    // F3: a hook is live, also while an attach catches up. Tools, mode and the waits follow too,
    // and the prompt it carries, so a transition into needs-you has its question (Task 6b).
    const prompt = this.#hookPrompt(st, e);
    this.#apply(st, prompt ? { kind: 'hook', event: e, prompt } : { kind: 'hook', event: e });
    const next = st.status;
    if (before === 'ended' && next !== 'ended') this.#clearTimers(st, ['retire']);
    // The pane's prompt is read after the move; prompt-captured sets it (#capturePrompt).
    if (
      next === 'needs-you' &&
      (e.event === 'PermissionRequest' || (e.event === 'Notification' && counts && !st.question))
    ) {
      void this.#capturePrompt(st, false);
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
   * The prompt a hook carries into needs-you: an AskUserQuestion's question (else the one shown,
   * else the transcript's), its kind and multiSelect; a PermissionRequest's kind.
   */
  #hookPrompt(st: Live, e: HookEvent): PromptRead | undefined {
    if (e.event === 'PreToolUse' && e.toolName === 'AskUserQuestion') {
      const question = questionFromToolInput(e.toolInput);
      const set = { promptKind: 'ask' as const, askMulti: multiSelectByQuestion(e.toolInput) };
      if (question) return { set: { ...set, question } };
      return st.question ? { set } : { set, fill: { question: st.tail?.question() ?? null } };
    }
    if (e.event === 'PermissionRequest') return { set: { promptKind: 'permission' } };
    return undefined;
  }

  /**
   * R63: `--resume <id>` found no conversation; Claude sent a SessionEnd with a new random id and
   * exits. The session is ended again, keeping its old link (never the random id), and the
   * error is reported: a line on the card and one in Kage's log.
   */
  #resumeFailed(st: Live, sessionId: string): void {
    this.#clearTimers(st, ['idle', 'capture', 'retry', 'startup', 'answered']);
    // Ended, hooks mode, no tool pending, the resume and the first-prompt wait over (#apply ends
    // the wait's timer and its "Starting Claude…" line). Always live (F3).
    this.#apply(st, { kind: 'resume-failed' });
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
    this.#firstPromptWaitEnded(st);
  }

  /** The first-prompt wait's side effects once it ended (here, or in #apply's move into ended). */
  #firstPromptWaitEnded(st: Live): void {
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
    const screen = text === null ? null : parseStartupScreen(text);
    const prompt = text === null || screen ? null : parsePermissionPrompt(text);
    let seen: FirstPromptScreen;
    if (text === null) seen = 'failed';
    else if (screen) seen = 'startup';
    else if (prompt) seen = 'prompt';
    else seen = BUSY_FOOTER.test(text) ? 'busy' : 'idle';
    if (seen !== 'busy') this.#clearTimers(st, seen === 'startup' ? ['idle', 'startup'] : ['idle']);
    // Ends the wait (#apply runs its clean-up); a startup screen or a prompt is needs-you (with
    // an unnamed tool pending for the prompt), a busy footer stays running, anything else done.
    // A SessionStart's timer armed it: live, also while an attach catches up (F3).
    // The screen's question goes with the move (Task 6b).
    let read: PromptRead | undefined;
    if (screen) {
      read = {
        set: {
          question: { text: screen.text, options: screen.options, startup: true },
          promptKind: screen.screen,
        },
      };
    } else if (prompt && text !== null) {
      read = {
        set: {
          question: prompt,
          promptKind: numberedPromptKind(text) ?? 'permission',
          promptSeen: true,
        },
      };
    }
    this.#apply(st, {
      kind: 'first-prompt-check',
      screen: seen,
      at: this.#now(),
      ...(read ? { prompt: read } : {}),
    });
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
        // There the status module moves nothing, and the check is armed as Kage's act
        // (decision 10).
        const mine = this.#replying(st);
        // R11: No or Esc fires no hook; the transcript shows it: done unless ended, no tool
        // pending.
        this.#apply(st, { kind: 'transcript-interrupt' });
        if (mine) {
          this.#armTurnEndCheck(st, 'act');
          return;
        }
        st.now = tail.now();
        this.#emitNow(st);
      }),
      tail.onTurnEnd(() => {
        if (st.tail !== tail) return;
        this.#armTurnEndCheck(st, st.catchingUp ? 'reconcile' : 'live');
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
   * later. Any hook cancels it. One timer per session, armed only then. `armedBy` is the
   * transition's cause should the check confirm it (I2): live from the transcript (reconcile
   * while catching up), act from Kage's Escape, reconcile from a restart. A later arming
   * replaces the timer and its cause (F19).
   */
  #armTurnEndCheck(st: Live, armedBy: Cause): void {
    if (!this.#running || st.mode !== 'hooks' || st.status !== 'running') return;
    this.#clearTimers(st, ['turnEnd']);
    const gen = st.gen;
    const hooks = st.hookCount;
    st.turnEndCause = armedBy;
    st.timers.turnEnd = setTimeout(() => {
      delete st.timers.turnEnd;
      void this.#turnEndCheck(st, gen, hooks);
    }, TURN_END_CHECK_MS);
  }

  /**
   * Done, through #apply (doneAt, the done ping and auto-archive follow), only when the pane
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
      st.status === 'running' &&
      // A turn the transcript shows going on again (its hooks lost too) isn't done.
      (st.tail?.now() ?? null) === null;
    if (!still()) return;
    const text = await this.#capture(st);
    if (!still() || text === null || BUSY_FOOTER.test(text) || showsPrompt(text)) return;
    // The latest arming's cause (F19). Whatever clears it (a hook, the stop, the drop) also
    // fails still(); null here is only a guard.
    const armedBy = st.turnEndCause;
    if (armedBy === null) return;
    st.turnEndCause = null;
    this.#clearTimers(st, ['idle']);
    // Running in hooks mode (still()): done with the arming's cause, no tool pending.
    this.#apply(st, { kind: 'turn-ended', armedBy });
    st.now = st.tail?.now() ?? null;
    this.#emitNow(st);
    // As at a Stop: the files and ports refresh.
    this.#preview?.touch(st.id, 'turn-end');
  }

  #onTailChange(st: Live, tail: TailLike): void {
    st.now = tail.now() ?? (st.firstPromptPending ? STARTING : null);
    const q = tail.question();
    const key = questionKey(q);
    // A resume replays the old transcript before the new claude's first hook: an open question
    // there belongs to the ended run. Its key is remembered all the same, and the status module
    // ignores it while resuming, so it never shows (or pings).
    const prompt: PromptRead = { fill: { question: q, promptKind: 'ask' } };
    if (key !== st.tailQuestionKey) {
      st.tailQuestionKey = key;
      if (q && st.status !== 'ended') this.#apply(st, { kind: 'transcript-question', prompt });
    } else if (q && st.status === 'needs-you' && !st.question) {
      this.#apply(st, { kind: 'transcript-question', prompt });
    }
    this.#emitThrottled(st);
  }

  /** Status after a restart: the transcript's open question, a turn in progress, or activity. */
  #rebuildFromTail(st: Live, wasDone = false): void {
    const tail = st.tail;
    if (!tail) return;
    st.now = tail.now();
    const q = tail.question();
    st.tailQuestionKey = questionKey(q);
    // Hooks mode; needs-you, running, or as attached (R141 keeps a done session done).
    this.#apply(st, {
      kind: 'rebuilt',
      question: q !== null,
      turn: st.now !== null,
      active: this.#active(st),
      wasDone,
      ...(q ? { prompt: { set: { question: q, promptKind: 'ask' as const } } } : {}),
    });
    // A restart within 5 s of a lost Stop: running from recent activity, but the transcript's
    // turn has ended, so the pane decides as after a turn end (I2).
    if (st.status === 'running' && tail.now() === null) this.#armTurnEndCheck(st, 'reconcile');
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
        this.#apply(st, {
          kind: 'startup-shown',
          prompt: {
            set: {
              question: { text: screen.text, options: screen.options, startup: true },
              promptKind: screen.screen,
            },
          },
        });
        this.#emitNow(st);
        return;
      }
      if (showsIdleBox(text)) {
        st.idleSeen = true;
        this.#clearTimers(st, ['startup']);
      }
      if (st.startup) {
        // A screen answered: the wait for the next one is a fresh one (its own 60 s of looks).
        st.startingSince = null;
        const active = this.#active(st);
        this.#apply(st, { kind: 'startup-gone', active });
        this.#scheduleIdle(st);
        this.#emitNow(st);
        return;
      }
    }
    const prompt = parsePermissionPrompt(text);
    if (st.status === 'needs-you') {
      if (prompt) {
        this.#apply(st, {
          kind: 'prompt-captured',
          prompt: {
            set: { promptSeen: true },
            fill: { question: prompt, promptKind: numberedPromptKind(text) },
          },
        });
        this.#emitNow(st);
      } else if (st.promptSeen && !showsPrompt(text) && !this.#replying(st)) {
        // R11 fallback: the prompt went away without a hook. No or Esc leaves Claude's denial
        // line and ends the turn. Otherwise it was a Yes: the tool runs, and no hook fires until
        // its PostToolUse, which may be minutes away for a long command.
        const denial = showsDenial(text);
        this.#apply(st, { kind: 'prompt-gone', denial });
        if (!denial) this.#scheduleIdle(st);
        this.#emitNow(st);
      }
      return;
    }
    // A prompt already on screen at start, or in a window without hooks.
    if (prompt && (initial || st.mode === 'activity')) {
      this.#clearTimers(st, ['idle']);
      // Needs-you, with an unnamed tool pending for the prompt, and the prompt itself.
      this.#apply(st, {
        kind: 'prompt-shown',
        prompt: {
          set: { question: prompt, promptKind: numberedPromptKind(text), promptSeen: true },
        },
      });
      this.#emitNow(st);
    }
  }

  /** PermissionRequest or a counted Notification: read the prompt now, once more 300 ms later. */
  async #capturePrompt(st: Live, retried: boolean): Promise<void> {
    const gen = st.gen;
    const text = await this.#capture(st);
    if (!this.#running || gen !== st.gen || st.status !== 'needs-you') return;
    const prompt = text === null ? null : parsePermissionPrompt(text);
    // Read after the move: the prompt goes in through the module, with no move (Task 6b).
    if (prompt) {
      this.#apply(st, {
        kind: 'prompt-captured',
        prompt: {
          set: {
            question: prompt,
            promptKind: numberedPromptKind(text as string) ?? 'permission',
            promptSeen: true,
          },
        },
      });
      this.#emitNow(st);
      return;
    }
    const fallback = st.tail?.question() ?? null;
    if (fallback && !st.question) {
      this.#apply(st, { kind: 'prompt-captured', prompt: { fill: { question: fallback } } });
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

  /** The facts the status module reads off a session. */
  #factsOf(st: Live): StatusFacts {
    return {
      status: st.placed ? st.status : null,
      mode: st.mode,
      startup: st.startup,
      shellEnded: st.shellEnded,
      replying: st.replying,
      catchingUp: st.catchingUp,
      pending: st.pending,
      toolsDone: st.toolsDone,
      record: st.record
        ? { firstPromptPending: st.firstPromptPending, resuming: st.resuming }
        : null,
      hasWindow: st.window !== null,
      question: st.question,
      promptKind: st.promptKind,
      promptSeen: st.promptSeen,
      askMulti: st.askMulti,
    };
  }

  /**
   * The one door for status (ADR 0001): the only writer of `st.status`. The status module's
   * facts are written back on every step, move or not (F4); then the side effects follow from
   * what changed: the first-prompt wait's end, and on a move statusSince, gen, the tail's idle
   * poll, the needs-you clean-up and #onTransition. A timed observation's `at` is the
   * transition's.
   */
  #apply(st: Live, obs: Observation): Transition | null {
    const before = this.#factsOf(st);
    const { facts, move } = step(before, obs);
    if (facts.status !== null) st.status = facts.status;
    st.placed = facts.status !== null;
    st.mode = facts.mode;
    st.startup = facts.startup;
    st.shellEnded = facts.shellEnded;
    st.replying = facts.replying;
    if (facts.pending !== st.pending) st.pending = new Set(facts.pending);
    if (facts.toolsDone !== st.toolsDone) st.toolsDone = new Set(facts.toolsDone);
    if (facts.record) {
      st.firstPromptPending = facts.record.firstPromptPending;
      st.resuming = facts.record.resuming;
    }
    // The prompt is written before the transition goes out, so its handlers see the question.
    st.question = facts.question;
    st.promptKind = facts.promptKind;
    st.promptSeen = facts.promptSeen;
    if (facts.askMulti !== st.askMulti) st.askMulti = new Map(facts.askMulti);
    if (before.record?.firstPromptPending && !facts.record?.firstPromptPending) {
      this.#firstPromptWaitEnded(st);
    }
    if (!move) return null;
    const t: Transition = { id: st.id, ...move, at: 'at' in obs ? obs.at : this.#now() };
    st.statusSince = t.at;
    st.lastCause = t.cause;
    st.gen++;
    // P7: only a running session's tail polls; a hook, activity or the watcher wakes the others.
    st.tail?.setIdle(t.to !== 'running');
    // The prompt itself was cleared by the step (moveTo); its capture retry goes here.
    if (t.to !== 'needs-you') this.#clearTimers(st, ['retry']);
    this.#onTransition(st, t);
    return t;
  }

  /**
   * What follows a transition: a record's doneAt (set on its move into done or ended, kept from
   * done to ended, cleared on running or needs-you; saved with the debounced save), the preview
   * and auto-archive while ready (a move into done or ended checks the session; leaving them, or
   * a first placement, re-syncs), then the transition event.
   */
  #onTransition(st: Live, t: Transition): void {
    const r = st.record;
    const finished = t.to === 'done' || t.to === 'ended';
    if (r && finished && r.doneAt === null) {
      r.doneAt = t.at;
      this.#saveSoon();
    } else if (r && !finished && r.doneAt !== null) {
      r.doneAt = null;
      this.#saveSoon();
    }
    if (this.#ready) {
      this.#preview?.statusChanged(st.id);
      if (r) {
        if (finished) this.#auto?.touch(st.id);
        else if (t.from === null || t.from === 'done' || t.from === 'ended') this.#auto?.sync();
      }
    }
    this.#emit({ type: 'session.transition', transition: t });
  }

  #clearTimers(st: Live, names?: TimerName[]): void {
    for (const name of names ?? (Object.keys(st.timers) as TimerName[])) {
      const t = st.timers[name];
      if (t) clearTimeout(t);
      delete st.timers[name];
      if (name === 'turnEnd') st.turnEndCause = null;
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

  /**
   * Emits session.updated when a visible field changed. The frame carries the last transition's
   * cause only when its status or statusSince differs from the last frame's (or it is the first):
   * a frame with a cause always shows a transition, and a suppressed one leaves none behind.
   */
  #emitNow(st: Live): void {
    this.#clearTimers(st, ['emit']);
    if (!this.#running || this.#sessions.get(st.id) !== st) return;
    const f = st.framed;
    const moved = !f || f.status !== st.status || f.since !== st.statusSince;
    if (moved) st.framed = { status: st.status, since: st.statusSince };
    // Archived sessions are hidden from the board: no updates for them.
    if (st.record?.archived) return;
    const s = toSession(st);
    if (sameSession(st.last, s)) return;
    st.last = s;
    st.lastEmitAt = this.#clock();
    this.#emit(
      moved
        ? { type: 'session.updated', session: s, cause: st.lastCause }
        : { type: 'session.updated', session: s },
    );
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
