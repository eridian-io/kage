import type { Cause, SessionStatus, Transition } from '@kage/shared';
import type { HookEvent } from '../hooks/event.ts';
import { nextStatus } from '../hooks/status.ts';

/**
 * The status module (ADR 0001): every status change of a session goes through `step`, which
 * turns the session's status facts and one Observation into the next facts and the move, if
 * any, with its cause. Pure: no I/O, no timers, no clock, and it never mutates its input.
 * LiveSource keeps the state, the timers and the captures, and applies what `step` returns.
 */

/** What a record (a session Kage started) adds to the status facts. */
export interface RecordFacts {
  /** P3F1: Kage launched this session and Claude hasn't taken its first prompt yet. */
  firstPromptPending: boolean;
  /** B7, R63: Kage resumed this session and no hook has come from the new Claude yet. */
  resuming: { sessionId: string | null } | null;
}

/** The facts a session's status follows from. */
export interface StatusFacts {
  /** null: not on the board yet. */
  status: SessionStatus | null;
  mode: 'activity' | 'hooks';
  /** The question is a startup screen (R9). */
  startup: boolean;
  shellEnded: boolean;
  /** Inside Kage's reply window. */
  replying: boolean;
  /** An attach at start or after the watcher's up: what it learns is reconcile. */
  catchingUp: boolean;
  /** R12, M11: tools with no end yet, by tool_use_id. */
  pending: ReadonlySet<string>;
  toolsDone: ReadonlySet<string>;
  /** null for an external session (decision 9). */
  record: RecordFacts | null;
}

/** M11: a pending tool whose hook had no `tool_use_id` (a PermissionRequest, a prompt on screen). */
export const UNNAMED_TOOL = '';
/** M11: `tool_use_id`s whose PostToolUse came before their PreToolUse, kept at most this many. */
const TOOLS_DONE_MAX = 64;

export type Move = Pick<Transition, 'from' | 'to' | 'cause'>;

export interface StatusStep {
  facts: StatusFacts;
  move: Move | null;
}

/** One thing Kage learned about a session, as the status module reads it. */
export type Observation =
  /** The start places a session no window placed: ended. */
  | { kind: 'loaded' }
  /** A Claude Code hook for this session. Always live, also while an attach catches up (F3). */
  | { kind: 'hook'; event: HookEvent }
  /** R63: the resume found no conversation (see `resumeFails`). Always live (F3). */
  | { kind: 'resume-failed' }
  /** A new open question in the transcript. */
  | { kind: 'transcript-question' }
  /** "[Request interrupted…" or a user-rejected tool result: No or Esc fires no hook (R11). */
  | { kind: 'transcript-interrupt' }
  /** I2: the turn-end check's capture confirms the turn ended; the cause is the arming's. */
  | { kind: 'turn-ended'; armedBy: Cause }
  /** Pane output. */
  | { kind: 'activity' }
  /** The 5 s rule found the pane quiet and not still starting; `at` is when it decided. */
  | { kind: 'idle'; at: number }
  /** The check after an answer shows the denial line (the answer was No). */
  | { kind: 'answer-denied' }
  /**
   * P3F1's fallback, R57, R58: what the pane showed when no first prompt came; `at` as idle's.
   * Always live: a hook (SessionStart) armed it (F3).
   */
  | { kind: 'first-prompt-check'; screen: FirstPromptScreen; at: number }
  /** R9: a startup screen on the pane. */
  | { kind: 'startup-shown' }
  /** A startup screen was answered; `active`: the pane drew within the last 5 s. */
  | { kind: 'startup-gone'; active: boolean }
  /** A prompt on screen at start, or in activity mode. */
  | { kind: 'prompt-shown' }
  /** R11's pane fallback: the prompt went away with no hook; `denial`: the denial line shows. */
  | { kind: 'prompt-gone'; denial: boolean }
  /**
   * §5.8a: a window linked to its session (start, the watcher's up, a new window, fg). `active`:
   * the pane drew within the last 5 s; `wasDone`: the record was done before (R141).
   */
  | { kind: 'attached'; active: boolean; wasDone: boolean }
  /** From the transcript at an attach: its open question, a turn in progress, else as attached. */
  | { kind: 'rebuilt'; question: boolean; turn: boolean; active: boolean; wasDone: boolean }
  /** R17: the pane is back at a shell, its window lives on. */
  | { kind: 'claude-exited' }
  /** The window is gone, or tmux is (`serverDown`: the watcher's down). */
  | { kind: 'window-gone'; serverDown: boolean }
  // Kage's acts (group 5): each moves only from the status it names, always with cause act.
  /** Kage launched a task (adopt): a record off the board goes running, its first prompt awaited. */
  | { kind: 'launched' }
  /** B7: Kage opened a window resuming an ended record: running, resuming, nothing pending. */
  | { kind: 'resumed'; sessionId: string | null }
  /** R101: the resume's window didn't open; a record still resuming is ended again. */
  | { kind: 'resume-aborted' }
  /** Kage answered the prompt: needs-you → running. */
  | { kind: 'answered' }
  /** Kage sent a reply: running, nothing pending; an ended session stays ended. */
  | { kind: 'replied' }
  /** Kage killed the window: ended, hooks mode, nothing pending. */
  | { kind: 'stopped' }
  /** A restore: back on the board (null → ended). */
  | { kind: 'restored' };

/** What the first-prompt fallback's capture showed; `failed`: no capture, twice. */
export type FirstPromptScreen = 'startup' | 'prompt' | 'busy' | 'idle' | 'failed';

/** R63: resuming with an id, and a SessionEnd naming another. */
export function resumeFails(facts: StatusFacts, e: HookEvent): boolean {
  const want = facts.record?.resuming?.sessionId ?? null;
  return e.event === 'SessionEnd' && want !== null && e.sessionId !== want;
}

/** P3F1: a non-compact SessionStart while the record waits for its first prompt, not ended. */
export function holdsFirstPrompt(facts: StatusFacts, e: HookEvent): boolean {
  return (
    e.event === 'SessionStart' &&
    e.source !== 'compact' &&
    facts.record?.firstPromptPending === true &&
    facts.status !== 'ended'
  );
}

/** R12: a permission Notification counts only while a tool is pending; every other hook counts. */
export function permissionCounts(facts: StatusFacts, e: HookEvent): boolean {
  return !(
    e.event === 'Notification' &&
    e.notification === 'permission' &&
    facts.pending.size === 0
  );
}

/** Why the transition an observation makes would happen (the whole rule). */
export function causeOf(facts: StatusFacts, obs: Observation): Cause {
  switch (obs.kind) {
    case 'launched':
    case 'resumed':
    case 'resume-aborted':
    case 'answered':
    case 'replied':
    case 'stopped':
    case 'restored':
    // Task 6: the answer check sees the No Kage itself sent (only markAnswered arms it).
    case 'answer-denied':
      return 'act';
    case 'loaded':
      return 'reconcile';
    case 'hook':
    case 'resume-failed':
    // F3: a SessionStart's timer armed it, so a hook triggers it indirectly: live too.
    case 'first-prompt-check':
      return 'live';
    case 'turn-ended':
      return obs.armedBy;
    // A dead server's end is Kage losing sight of the session, not something it watched happen.
    case 'window-gone':
      return obs.serverDown || facts.catchingUp ? 'reconcile' : 'live';
    default:
      return facts.catchingUp ? 'reconcile' : 'live';
  }
}

/** The next facts and the move, if any. Returns new objects; never mutates `facts`. */
export function step(facts: StatusFacts, obs: Observation): StatusStep {
  const to = target(facts, obs);
  const next = observe(facts, obs);
  return to === null || to === facts.status
    ? { facts: next, move: null }
    : moveTo(next, { from: facts.status, to, cause: causeOf(facts, obs) });
}

/**
 * The status the observation leads to; `facts.status` when it moves nothing (null too: still off
 * the board).
 */
function target(facts: StatusFacts, obs: Observation): SessionStatus | null {
  switch (obs.kind) {
    case 'loaded':
      return facts.status ?? 'ended';
    case 'hook': {
      const e = obs.event;
      // P3F1: a launched session's SessionStart comes just before its task's first prompt.
      if (holdsFirstPrompt(facts, e)) return 'running';
      const prev = facts.status ?? undefined;
      const next = permissionCounts(facts, e) ? nextStatus(prev, e) : prev;
      // Off the board and left as it is: ended, LiveSource's default for a session not placed.
      return next ?? facts.status ?? 'ended';
    }
    case 'resume-failed':
      return 'ended';
    // Off the board (null) the transcript places nothing, as with LiveSource's unplaced default
    // (ended): placing is the attach's.
    case 'transcript-question':
      return onBoard(facts) ? 'needs-you' : facts.status;
    case 'transcript-interrupt':
      // B26: inside Kage's reply window it is taken for Kage's own Escape; LiveSource arms the
      // turn-end check (act) and the pane decides.
      return onBoard(facts) && !facts.replying ? 'done' : facts.status;
    case 'turn-ended':
      return endsTurn(facts) ? 'done' : facts.status;
    // The screen and activity (group 3). Off the board (null) they place nothing either.
    case 'activity':
      return facts.status !== null && facts.mode === 'activity' && !facts.startup
        ? 'running'
        : facts.status;
    case 'idle':
      return goesIdle(facts) ? 'done' : facts.status;
    case 'answer-denied':
      return facts.status === 'running' ? 'done' : facts.status;
    case 'first-prompt-check':
      if (facts.status !== 'running') return facts.status;
      switch (obs.screen) {
        case 'startup':
        case 'prompt':
          return 'needs-you';
        case 'busy':
          return 'running';
        default:
          return 'done';
      }
    case 'startup-shown':
    case 'prompt-shown':
      return facts.status === null ? null : 'needs-you';
    case 'startup-gone':
      if (facts.status === null) return null;
      return obs.active ? 'running' : 'done';
    case 'prompt-gone':
      if (!promptGoes(facts)) return facts.status;
      return obs.denial ? 'done' : 'running';
    // Windows and restarts (group 4).
    case 'attached':
      return attachedStatus(obs);
    case 'rebuilt':
      if (obs.question) return 'needs-you';
      return obs.turn ? 'running' : attachedStatus(obs);
    case 'claude-exited':
    case 'window-gone':
      return 'ended';
    // Kage's acts (group 5).
    case 'launched':
      return launches(facts) ? 'running' : facts.status;
    case 'resumed':
      return resumes(facts) ? 'running' : facts.status;
    case 'resume-aborted':
      return onBoard(facts) && facts.record?.resuming ? 'ended' : facts.status;
    case 'answered':
      return facts.status === 'needs-you' ? 'running' : facts.status;
    case 'replied':
      return onBoard(facts) ? 'running' : facts.status;
    case 'stopped':
      return onBoard(facts) ? 'ended' : facts.status;
    case 'restored':
      return facts.status ?? 'ended';
  }
}

/** Only a record off the board is launched (adopt builds it fresh). */
function launches(facts: StatusFacts): boolean {
  return facts.status === null && facts.record !== null;
}

/** B7: only an ended record is resumed. */
function resumes(facts: StatusFacts): boolean {
  return facts.status === 'ended' && facts.record !== null;
}

/** R141: a record that was done stays done whatever the pane drew; else the 5 s rule. */
function attachedStatus(obs: { active: boolean; wasDone: boolean }): SessionStatus {
  return !obs.wasDone && obs.active ? 'running' : 'done';
}

/** Activity mode's 5 s rule applies to a running session with no startup screen. */
function goesIdle(facts: StatusFacts): boolean {
  return facts.mode === 'activity' && facts.status === 'running' && !facts.startup;
}

/** R11's pane fallback moves a needs-you session, outside Kage's reply window (B26). */
function promptGoes(facts: StatusFacts): boolean {
  return facts.status === 'needs-you' && !facts.replying;
}

/** A pending tool for the prompt on screen (it names none). */
function withUnnamed(facts: StatusFacts): Pick<StatusFacts, 'pending'> {
  return { pending: new Set(facts.pending).add(UNNAMED_TOOL) };
}

/** Placed and not ended. */
function onBoard(facts: StatusFacts): boolean {
  return facts.status !== null && facts.status !== 'ended';
}

/** I2: only a running hooks-mode session's turn end is confirmed into done. */
function endsTurn(facts: StatusFacts): boolean {
  return facts.mode === 'hooks' && facts.status === 'running';
}

/** What the observation sets, whether it moves the status or not. */
function observe(facts: StatusFacts, obs: Observation): StatusFacts {
  switch (obs.kind) {
    case 'loaded':
    case 'transcript-question':
    case 'activity':
    case 'resume-aborted':
    case 'answered':
    case 'restored':
      return { ...facts };
    case 'launched':
      return launches(facts) && facts.record
        ? { ...facts, record: { ...facts.record, firstPromptPending: true } }
        : { ...facts };
    case 'resumed':
      return resumes(facts)
        ? {
            ...facts,
            ...noTools(),
            record: { firstPromptPending: true, resuming: { sessionId: obs.sessionId } },
          }
        : { ...facts };
    case 'replied':
      return onBoard(facts) ? { ...facts, ...noTools() } : { ...facts };
    case 'stopped':
      return onBoard(facts) ? { ...facts, mode: 'hooks', ...noTools() } : { ...facts };
    case 'idle':
      // R104: the quiet ends the resume too: its replayed question no longer hides a new one.
      return goesIdle(facts)
        ? { ...facts, record: facts.record && { ...facts.record, resuming: null } }
        : { ...facts };
    case 'answer-denied':
      return facts.status === 'running' ? { ...facts, ...noTools() } : { ...facts };
    case 'first-prompt-check': {
      // The check always ends the wait (and the resume); only a running session takes the screen.
      const next: StatusFacts = {
        ...facts,
        record: facts.record && { firstPromptPending: false, resuming: null },
      };
      if (facts.status !== 'running') return next;
      if (obs.screen === 'startup') return { ...next, startup: true };
      if (obs.screen === 'prompt') return { ...next, ...withUnnamed(facts) };
      return next;
    }
    case 'startup-shown':
      return facts.status === null ? { ...facts } : { ...facts, startup: true };
    case 'startup-gone':
      return { ...facts, startup: false };
    case 'prompt-shown':
      return facts.status === null ? { ...facts } : { ...facts, ...withUnnamed(facts) };
    case 'prompt-gone':
      return promptGoes(facts) && obs.denial ? { ...facts, ...noTools() } : { ...facts };
    case 'transcript-interrupt':
      // R11: No or Esc ends the tool, whatever the status; Kage's own Escape leaves it.
      return facts.replying ? { ...facts } : { ...facts, ...noTools() };
    case 'turn-ended':
      return endsTurn(facts) ? { ...facts, ...noTools() } : { ...facts };
    case 'hook': {
      const e = obs.event;
      const endsWait =
        e.event === 'UserPromptSubmit' || e.event === 'PreToolUse' || e.event === 'SessionEnd';
      return {
        ...facts,
        ...trackTools(facts, e),
        mode: 'hooks',
        startup: false,
        // Any hook is the new Claude's, so the resume is over; these three end the first-prompt wait.
        record: facts.record && {
          firstPromptPending: facts.record.firstPromptPending && !endsWait,
          resuming: null,
        },
      };
    }
    case 'resume-failed':
      return {
        ...facts,
        mode: 'hooks',
        ...noTools(),
        record: facts.record && { firstPromptPending: false, resuming: null },
      };
    case 'attached':
      return { ...facts, mode: 'activity', ...noTools() };
    case 'rebuilt':
      return { ...facts, mode: 'hooks' };
    case 'claude-exited':
      return { ...facts, mode: 'hooks', shellEnded: true, ...noTools() };
    // The mode of a session with no pane is never read; an attach resets it.
    case 'window-gone':
      return { ...facts, mode: 'hooks', ...noTools() };
  }
}

/** No tool pending, and the early-PostToolUse notes gone with them. */
function noTools(): Pick<StatusFacts, 'pending' | 'toolsDone'> {
  return { pending: new Set(), toolsDone: new Set() };
}

/**
 * R12 with M11: which tools are pending, by `tool_use_id`. A PostToolUse that arrives before its
 * PreToolUse (parallel tools, separate `kage hook` processes) leaves a note, and that PreToolUse
 * then adds nothing. A turn's end (Stop, SessionEnd, a new session) clears them. New sets where
 * they change, the same ones where they don't.
 */
function trackTools(facts: StatusFacts, e: HookEvent): Pick<StatusFacts, 'pending' | 'toolsDone'> {
  const { pending, toolsDone } = facts;
  const id = e.toolUseId;
  switch (e.event) {
    case 'PreToolUse': {
      if (id !== null && toolsDone.has(id)) {
        const done = new Set(toolsDone);
        done.delete(id);
        return { pending, toolsDone: done };
      }
      return { pending: new Set(pending).add(id ?? UNNAMED_TOOL), toolsDone };
    }
    case 'PermissionRequest':
      // It carries no tool_use_id; its tool's PreToolUse has usually added it already.
      return { pending: pending.size === 0 ? new Set([UNNAMED_TOOL]) : pending, toolsDone };
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (id === null) return { pending: new Set(), toolsDone: new Set() };
      const left = new Set(pending);
      left.delete(UNNAMED_TOOL);
      if (left.delete(id)) return { pending: left, toolsDone };
      const done = new Set(toolsDone).add(id);
      if (done.size > TOOLS_DONE_MAX) done.delete(done.values().next().value as string);
      return { pending: left, toolsDone: done };
    }
    case 'Stop':
    case 'SessionEnd':
      return { pending: new Set(), toolsDone: new Set() };
    case 'SessionStart':
      return e.source === 'compact'
        ? { pending, toolsDone }
        : { pending: new Set(), toolsDone: new Set() };
    default:
      return { pending, toolsDone };
  }
}

/**
 * A move: what any move resets, and what a move into ended ends (F4). Only an ended session can
 * be shellEnded, so a move keeps it only into ended, where claude-exited sets it.
 */
function moveTo(facts: StatusFacts, move: Move): StatusStep {
  const { to } = move;
  const next: StatusFacts = {
    ...facts,
    status: to,
    shellEnded: to === 'ended' && facts.shellEnded,
    startup: to === 'needs-you' ? facts.startup : false,
  };
  // Ended before any hook: no resume or first prompt is awaited any more.
  if (to === 'ended' && next.record) {
    next.record = { firstPromptPending: false, resuming: null };
  }
  return { facts: next, move };
}
