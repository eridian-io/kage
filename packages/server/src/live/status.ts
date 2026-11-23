import type { Cause, SessionStatus, Transition } from '@kage/shared';

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
  | { kind: 'loaded' };

/** Why the transition an observation makes would happen (the whole rule). */
export function causeOf(facts: StatusFacts, obs: Observation): Cause {
  switch (obs.kind) {
    case 'set':
      return obs.cause;
    case 'loaded':
      return 'reconcile';
    default:
      return facts.catchingUp ? 'reconcile' : 'live';
  }
}

/** The next facts and the move, if any. Returns new objects; never mutates `facts`. */
export function step(facts: StatusFacts, obs: Observation): StatusStep {
  const to = target(facts, obs);
  return to === facts.status ? { facts: { ...facts }, move: null } : moveTo(facts, to, obs);
}

/** The status the observation leads to; `facts.status` when it moves nothing (never null). */
function target(facts: StatusFacts, obs: Observation): SessionStatus {
  switch (obs.kind) {
    case 'set':
      return obs.to;
    case 'loaded':
      return facts.status ?? 'ended';
  }
}

/** A move to `to`: what any move resets, and what a move into ended ends (F4). */
function moveTo(facts: StatusFacts, to: SessionStatus, obs: Observation): StatusStep {
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
  return { facts: next, move: { from: facts.status, to, cause: causeOf(facts, obs) } };
}
