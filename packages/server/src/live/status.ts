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
  /** Migration shim: a call site not moved yet names the status and cause. Task 6 deletes it. */
  | { kind: 'set'; to: SessionStatus; cause: Cause }
  /** The start places a session no window placed: ended. */
  | { kind: 'loaded' }
  /** A Claude Code hook for this session. Always live, also while an attach catches up (F3). */
  | { kind: 'hook'; event: HookEvent }
  /** R63: the resume found no conversation (see `resumeFails`). Always live (F3). */
  | { kind: 'resume-failed' };

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
    case 'set':
      return obs.cause;
    case 'loaded':
      return 'reconcile';
    case 'hook':
    case 'resume-failed':
      return 'live';
    default:
      return facts.catchingUp ? 'reconcile' : 'live';
  }
}

/** The next facts and the move, if any. Returns new objects; never mutates `facts`. */
export function step(facts: StatusFacts, obs: Observation): StatusStep {
  const to = target(facts, obs);
  const next = observe(facts, obs);
  return to === facts.status
    ? { facts: next, move: null }
    : moveTo(next, { from: facts.status, to, cause: causeOf(facts, obs) });
}

/** The status the observation leads to; `facts.status` when it moves nothing (never null). */
function target(facts: StatusFacts, obs: Observation): SessionStatus {
  switch (obs.kind) {
    case 'set':
      return obs.to;
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
  }
}

/** What the observation sets, whether it moves the status or not. */
function observe(facts: StatusFacts, obs: Observation): StatusFacts {
  switch (obs.kind) {
    case 'set':
    case 'loaded':
      return { ...facts };
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
        pending: new Set(),
        toolsDone: new Set(),
        record: facts.record && { firstPromptPending: false, resuming: null },
      };
  }
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

/** A move: what any move resets, and what a move into ended ends (F4). */
function moveTo(facts: StatusFacts, move: Move): StatusStep {
  const { to } = move;
  const next: StatusFacts = {
    ...facts,
    status: to,
    shellEnded: false,
    startup: to === 'needs-you' ? facts.startup : false,
  };
  // Ended before any hook: no resume or first prompt is awaited any more.
  if (to === 'ended' && next.record) {
    next.record = { firstPromptPending: false, resuming: null };
  }
  return { facts: next, move };
}
