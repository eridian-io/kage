import type { Question } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, type HookEvent, type HookEventName } from '../hooks/event.ts';
import { nextStatus } from '../hooks/status.ts';
import {
  causeOf,
  holdsFirstPrompt,
  type Observation,
  permissionCounts,
  resumeFails,
  type StatusFacts,
  step,
  UNNAMED_TOOL,
} from './status.ts';

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  status: 'running',
  mode: 'hooks',
  startup: false,
  shellEnded: false,
  replying: false,
  catchingUp: false,
  pending: new Set(),
  toolsDone: new Set(),
  record: { firstPromptPending: false, resuming: null },
  hasWindow: false,
  question: null,
  promptKind: null,
  promptSeen: false,
  askMulti: new Map(),
  ...over,
});

/** Freezes the facts and everything they hold, so a write throws in strict mode. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

describe('status: step', () => {
  it('a move goes to the next status with its cause, and never when the status is already that', () => {
    // Task 6: the set shim is gone; acts stand in for any observation.
    const s = step(facts({ status: 'running' }), { kind: 'stopped' });
    expect(s.move).toEqual({ from: 'running', to: 'ended', cause: 'act' });
    expect(s.facts.status).toBe('ended');
    const same = step(facts({ status: 'running' }), { kind: 'replied' });
    expect(same.move).toBeNull();
    expect(same.facts.status).toBe('running');
    // Off the board (null) counts as different: the first placement is a move.
    const first = step(facts({ status: null }), { kind: 'restored' });
    expect(first.move).toEqual({ from: null, to: 'ended', cause: 'act' });
  });

  it('step never mutates the facts it is given', () => {
    const before = deepFreeze(
      facts({
        status: 'needs-you',
        startup: true,
        shellEnded: true,
        pending: new Set(['toolu_1']),
        toolsDone: new Set(['toolu_0']),
        record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
      }),
    );
    const observations: Observation[] = [
      { kind: 'stopped' },
      { kind: 'answered' },
      { kind: 'rebuilt', question: true, turn: false, active: false, wasDone: false },
      { kind: 'loaded' },
    ];
    for (const obs of observations) {
      const s = step(before, obs);
      expect(s.facts).not.toBe(before);
    }
    expect(before.status).toBe('needs-you');
    expect(before.startup).toBe(true);
    expect(before.shellEnded).toBe(true);
    expect([...before.pending]).toEqual(['toolu_1']);
    expect([...before.toolsDone]).toEqual(['toolu_0']);
    expect(before.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  });

  it('loaded places an unplaced session as ended with cause reconcile; a placed one moves nothing', () => {
    const unplaced = step(facts({ status: null }), { kind: 'loaded' });
    expect(unplaced.move).toEqual({ from: null, to: 'ended', cause: 'reconcile' });
    expect(unplaced.facts.status).toBe('ended');
    for (const status of ['running', 'needs-you', 'done', 'ended'] as const) {
      const placed = step(facts({ status }), { kind: 'loaded' });
      expect(placed.move).toBeNull();
      expect(placed.facts.status).toBe(status);
    }
  });

  it('causeOf: acts are act, loaded is reconcile, other kinds are reconcile while catching up and live otherwise', () => {
    for (const catchingUp of [false, true]) {
      const f = facts({ catchingUp });
      expect(causeOf(f, { kind: 'stopped' })).toBe('act');
      expect(causeOf(f, { kind: 'loaded' })).toBe('reconcile');
      expect(causeOf(f, { kind: 'activity' })).toBe(catchingUp ? 'reconcile' : 'live');
    }
  });

  it('any move clears shellEnded, and startup unless it moves into needs-you', () => {
    const f = facts({ status: 'ended', shellEnded: true, startup: true });
    const toRunning = step(f, { kind: 'resumed', sessionId: 's-1' });
    expect(toRunning.facts).toMatchObject({ shellEnded: false, startup: false });
    const toNeedsYou = step(f, {
      kind: 'rebuilt',
      question: true,
      turn: false,
      active: false,
      wasDone: false,
    });
    expect(toNeedsYou.facts).toMatchObject({ shellEnded: false, startup: true });
    // No move: both stay as they were.
    const still = step(f, { kind: 'restored' });
    expect(still.move).toBeNull();
    expect(still.facts).toMatchObject({ shellEnded: true, startup: true });
  });

  it('a move into ended clears the resume and the first-prompt wait (F4)', () => {
    const f = facts({ record: { firstPromptPending: true, resuming: { sessionId: 's-1' } } });
    const ended = step(f, { kind: 'stopped' });
    expect(ended.facts.record).toEqual({ firstPromptPending: false, resuming: null });
    const done = step(f, { kind: 'answer-denied' });
    expect(done.facts.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
    // An external session has no record facts.
    const ext = step(facts({ record: null }), { kind: 'stopped' });
    expect(ext.facts.record).toBeNull();
  });
});

const hookEvent = (event: HookEventName, over: Partial<HookEvent> = {}): HookEvent => ({
  event,
  pane: '%2',
  sessionId: 's-1',
  transcriptPath: null,
  cwd: null,
  notification: event === 'Notification' ? 'permission' : null,
  message: null,
  toolName: event === 'PreToolUse' || event === 'PermissionRequest' ? 'Bash' : null,
  toolInput: null,
  toolUseId: null,
  source: event === 'SessionStart' ? 'startup' : null,
  at: 0,
  ...over,
});
const hookObs = (event: HookEventName, over: Partial<HookEvent> = {}): Observation => ({
  kind: 'hook',
  event: hookEvent(event, over),
});
/** Runs the observations in turn from `f`, as LiveSource writes each step's facts back. */
const run = (f: StatusFacts, ...obs: Observation[]): StatusFacts =>
  obs.reduce((acc, o) => step(acc, o).facts, f);

describe('step: hooks (group 1)', () => {
  const STATUSES = ['running', 'needs-you', 'done', 'ended', null] as const;
  const rows = HOOK_EVENTS.flatMap((event) => STATUSES.map((status) => [event, status] as const));

  it.each(rows)('%s from %s moves as nextStatus says, with cause live', (event, status) => {
    for (const catchingUp of [false, true]) {
      // A tool pending, so a permission Notification counts (R12).
      const f = facts({ status, catchingUp, pending: new Set(['toolu_1']) });
      const e = hookEvent(event);
      const to = nextStatus(status ?? undefined, e) ?? status ?? 'ended';
      const s = step(f, { kind: 'hook', event: e });
      expect(s.facts.status).toBe(to);
      // F3: a hook is live, also while an attach catches up.
      expect(s.move).toEqual(to === status ? null : { from: status, to, cause: 'live' });
      expect(s.facts).toMatchObject({ mode: 'hooks', startup: false });
      expect(causeOf(f, { kind: 'hook', event: e })).toBe('live');
    }
  });

  it('a permission Notification counts only while a tool is pending (R12)', () => {
    const notification = hookEvent('Notification');
    const idle = step(facts({ status: 'running', mode: 'activity', startup: true }), {
      kind: 'hook',
      event: notification,
    });
    expect(idle.move).toBeNull();
    expect(idle.facts).toMatchObject({ status: 'running', mode: 'hooks', startup: false });
    expect(permissionCounts(facts({ status: 'running' }), notification)).toBe(false);
    const pending = facts({ status: 'running', pending: new Set(['toolu_1']) });
    expect(permissionCounts(pending, notification)).toBe(true);
    expect(step(pending, { kind: 'hook', event: notification }).move).toEqual({
      from: 'running',
      to: 'needs-you',
      cause: 'live',
    });
    // Other hooks count whatever is pending.
    expect(permissionCounts(facts(), hookEvent('Stop'))).toBe(true);
    expect(permissionCounts(facts(), hookEvent('Notification', { notification: 'idle' }))).toBe(
      true,
    );
  });

  it('a PostToolUse before its PreToolUse leaves that PreToolUse adding nothing (M11)', () => {
    const early = run(facts(), hookObs('PostToolUse', { toolUseId: 'toolu_2' }));
    expect([...early.pending]).toEqual([]);
    expect([...early.toolsDone]).toEqual(['toolu_2']);
    const pre = run(early, hookObs('PreToolUse', { toolUseId: 'toolu_2' }));
    expect([...pre.pending]).toEqual([]);
    expect([...pre.toolsDone]).toEqual([]);
    // In order: the PreToolUse adds it and its PostToolUse takes it away.
    const inOrder = run(facts(), hookObs('PreToolUse', { toolUseId: 'toolu_3' }));
    expect([...inOrder.pending]).toEqual(['toolu_3']);
    const ended = run(inOrder, hookObs('PostToolUse', { toolUseId: 'toolu_3' }));
    expect([...ended.pending, ...ended.toolsDone]).toEqual([]);
    // A PreToolUse with no id pends UNNAMED_TOOL; a PostToolUse with an id takes it away.
    const unnamed = run(facts(), hookObs('PreToolUse'));
    expect([...unnamed.pending]).toEqual([UNNAMED_TOOL]);
    const after = run(unnamed, hookObs('PostToolUseFailure', { toolUseId: 'toolu_4' }));
    expect([...after.pending]).toEqual([]);
    expect([...after.toolsDone]).toEqual(['toolu_4']);
    // A PostToolUse with no id clears every pending tool and every note.
    const both = facts({ pending: new Set(['toolu_5']), toolsDone: new Set(['toolu_6']) });
    const cleared = run(both, hookObs('PostToolUse'));
    expect([...cleared.pending, ...cleared.toolsDone]).toEqual([]);
    // The notes keep the newest 64.
    let many = facts();
    for (let i = 0; i < 65; i++) {
      many = run(many, hookObs('PostToolUse', { toolUseId: `toolu_${i}` }));
    }
    expect(many.toolsDone.size).toBe(64);
    expect(many.toolsDone.has('toolu_0')).toBe(false);
    expect(many.toolsDone.has('toolu_64')).toBe(true);
  });

  it('a PermissionRequest counts as a pending tool when none is', () => {
    const none = run(facts(), hookObs('PermissionRequest'));
    expect([...none.pending]).toEqual([UNNAMED_TOOL]);
    const some = run(facts({ pending: new Set(['toolu_1']) }), hookObs('PermissionRequest'));
    expect([...some.pending]).toEqual(['toolu_1']);
  });

  it('Stop, SessionEnd and a new session clear the pending tools; a compact SessionStart keeps them', () => {
    const busy = facts({ pending: new Set(['toolu_1']), toolsDone: new Set(['toolu_2']) });
    for (const obs of [hookObs('Stop'), hookObs('SessionEnd'), hookObs('SessionStart')]) {
      const f = run(busy, obs);
      expect([...f.pending, ...f.toolsDone]).toEqual([]);
    }
    const compact = run(busy, hookObs('SessionStart', { source: 'compact' }));
    expect([...compact.pending]).toEqual(['toolu_1']);
    expect([...compact.toolsDone]).toEqual(['toolu_2']);
    // Hooks that track no tool keep both as they are.
    for (const event of ['UserPromptSubmit', 'Notification'] as const) {
      const f = run(busy, hookObs(event));
      expect([...f.pending]).toEqual(['toolu_1']);
      expect([...f.toolsDone]).toEqual(['toolu_2']);
    }
  });

  it("a launch's SessionStart keeps it running until its first prompt (P3F1)", () => {
    const waiting = facts({
      status: 'running',
      record: { firstPromptPending: true, resuming: null },
    });
    const start = hookEvent('SessionStart');
    expect(holdsFirstPrompt(waiting, start)).toBe(true);
    const s = step(waiting, { kind: 'hook', event: start });
    expect(s.move).toBeNull();
    expect(s.facts.status).toBe('running');
    expect(s.facts.record?.firstPromptPending).toBe(true);
    // From done too (a resume the listing placed done before its SessionStart).
    expect(step({ ...waiting, status: 'done' }, { kind: 'hook', event: start }).move).toEqual({
      from: 'done',
      to: 'running',
      cause: 'live',
    });
    // Not a compaction, not an ended record, not once the first prompt came, not external.
    const compact = hookEvent('SessionStart', { source: 'compact' });
    expect(holdsFirstPrompt(waiting, compact)).toBe(false);
    const ended = { ...waiting, status: 'ended' as const };
    expect(holdsFirstPrompt(ended, start)).toBe(false);
    expect(step(ended, { kind: 'hook', event: start }).facts.status).toBe('done');
    expect(holdsFirstPrompt(facts({ status: 'running' }), start)).toBe(false);
    expect(holdsFirstPrompt(facts({ status: 'running', record: null }), start)).toBe(false);
    expect(holdsFirstPrompt(waiting, hookEvent('Stop'))).toBe(false);
  });

  it('UserPromptSubmit, PreToolUse and SessionEnd end the first-prompt wait; any hook ends the resume', () => {
    const waiting = facts({
      status: 'running',
      record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
    });
    for (const event of HOOK_EVENTS) {
      const s = step(waiting, hookObs(event));
      const ends = event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'SessionEnd';
      expect(s.facts.record).toEqual({ firstPromptPending: !ends, resuming: null });
    }
  });

  it('resumeFails: a SessionEnd naming another id while resuming; --continue never fails (R63)', () => {
    const resuming = (sessionId: string | null) =>
      facts({ status: 'running', record: { firstPromptPending: true, resuming: { sessionId } } });
    const other = hookEvent('SessionEnd', { sessionId: 's-random' });
    expect(resumeFails(resuming('s-1'), other)).toBe(true);
    expect(resumeFails(resuming('s-1'), hookEvent('SessionEnd'))).toBe(false);
    expect(resumeFails(resuming('s-1'), hookEvent('Stop', { sessionId: 's-random' }))).toBe(false);
    // --continue resumes with no id.
    expect(resumeFails(resuming(null), other)).toBe(false);
    // Not resuming, or no record.
    expect(resumeFails(facts(), other)).toBe(false);
    expect(resumeFails(facts({ record: null }), other)).toBe(false);
  });

  it('resume-failed: ended, hooks mode, nothing pending, the wait over', () => {
    const f = facts({
      status: 'running',
      mode: 'activity',
      catchingUp: true,
      pending: new Set(['toolu_1']),
      toolsDone: new Set(['toolu_2']),
      record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
    });
    const s = step(f, { kind: 'resume-failed' });
    expect(s.move).toEqual({ from: 'running', to: 'ended', cause: 'live' });
    expect(s.facts).toMatchObject({ status: 'ended', mode: 'hooks' });
    expect([...s.facts.pending, ...s.facts.toolsDone]).toEqual([]);
    expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
    // Already ended (the late SessionEnd, its window gone): no move, the rest as above.
    const late = step({ ...f, status: 'ended' }, { kind: 'resume-failed' });
    expect(late.move).toBeNull();
    expect(late.facts).toMatchObject({ status: 'ended', mode: 'hooks' });
    expect([...late.facts.pending, ...late.facts.toolsDone]).toEqual([]);
    expect(late.facts.record).toEqual({ firstPromptPending: false, resuming: null });
  });

  it('an external session takes every hook with no record facts', () => {
    for (const event of HOOK_EVENTS) {
      for (const status of STATUSES) {
        const f = facts({ status, record: null, pending: new Set(['toolu_1']) });
        const e = hookEvent(event);
        const s = step(f, { kind: 'hook', event: e });
        expect(s.facts.record).toBeNull();
        expect(s.facts.status).toBe(nextStatus(status ?? undefined, e) ?? status ?? 'ended');
        expect(holdsFirstPrompt(f, e)).toBe(false);
        expect(resumeFails(f, e)).toBe(false);
      }
    }
  });

  it("off the board with no tool pending, a hook that leaves the status as it is places it ended (F16's fallback)", () => {
    const f = facts({ status: null });
    // A permission Notification with nothing pending doesn't count (R12); a compaction keeps the
    // status.
    for (const obs of [
      hookObs('Notification', { notification: 'permission' }),
      hookObs('SessionStart', { source: 'compact' }),
    ]) {
      const s = step(f, obs);
      expect(s.move).toEqual({ from: null, to: 'ended', cause: 'live' });
      expect(s.facts.status).toBe('ended');
    }
  });

  it('SessionStart(compact) leaves the status as it is (a compaction can run mid-turn)', () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const f = facts({ status, pending: new Set(['toolu_1']) });
      const s = step(f, hookObs('SessionStart', { source: 'compact' }));
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(status);
      // Nor does it end the tool that runs across it.
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
  });

  it('hook and resume-failed steps never mutate the facts they are given', () => {
    const before = deepFreeze(
      facts({
        pending: new Set(['toolu_1']),
        toolsDone: new Set(['toolu_0']),
        record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
      }),
    );
    const observations: Observation[] = [
      ...HOOK_EVENTS.map((event) => hookObs(event, { toolUseId: 'toolu_1' })),
      hookObs('PostToolUse', { toolUseId: 'toolu_9' }),
      hookObs('PreToolUse', { toolUseId: 'toolu_0' }),
      { kind: 'resume-failed' },
    ];
    for (const obs of observations) expect(step(before, obs).facts).not.toBe(before);
    expect([...before.pending]).toEqual(['toolu_1']);
    expect([...before.toolsDone]).toEqual(['toolu_0']);
    expect(before.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  });
});

describe('step: the transcript (group 2)', () => {
  const STATUSES = [null, 'running', 'needs-you', 'done', 'ended'] as const;
  const busy = () => ({ pending: new Set(['toolu_1']), toolsDone: new Set(['toolu_0']) });

  it('an open question makes a session needs-you unless it is ended', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const f = facts({ status, catchingUp, ...busy() });
        const s = step(f, { kind: 'transcript-question' });
        // Off the board (null) the transcript places nothing (LiveSource's unplaced default is
        // ended).
        const to = status === 'ended' || status === null ? status : 'needs-you';
        expect(s.facts.status).toBe(to);
        expect(s.move).toEqual(
          to === status ? null : { from: status, to, cause: catchingUp ? 'reconcile' : 'live' },
        );
        // The question leaves the pending tools as they are (the tool waits on it).
        expect([...s.facts.pending]).toEqual(['toolu_1']);
      }
    }
    // A startup screen's flag survives a move into needs-you.
    expect(
      step(facts({ status: 'running', startup: true }), { kind: 'transcript-question' }).facts
        .startup,
    ).toBe(true);
  });

  it("an interrupt is done unless ended, and inside Kage's reply window moves nothing (R11, B26)", () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const f = facts({ status, catchingUp, ...busy() });
        const s = step(f, { kind: 'transcript-interrupt' });
        const to = status === 'ended' || status === null ? status : 'done';
        expect(s.facts.status).toBe(to);
        expect(s.move).toEqual(
          to === status ? null : { from: status, to, cause: catchingUp ? 'reconcile' : 'live' },
        );
        // R11: No or Esc ends the tool, whatever the status.
        expect(s.facts.pending.size).toBe(0);
        expect(s.facts.toolsDone.size).toBe(0);

        // B26: inside the reply window it is taken for Kage's own Escape; the pane decides later.
        const mine = step(facts({ status, replying: true, ...busy() }), {
          kind: 'transcript-interrupt',
        });
        expect(mine.move).toBeNull();
        expect(mine.facts.status).toBe(status);
        expect([...mine.facts.pending]).toEqual(['toolu_1']);
        expect([...mine.facts.toolsDone]).toEqual(['toolu_0']);
      }
    }
  });

  it.each(['live', 'act', 'reconcile'] as const)(
    'a confirmed turn end is done with the cause that armed it: %s',
    (armedBy) => {
      for (const catchingUp of [false, true]) {
        const f = facts({ status: 'running', mode: 'hooks', catchingUp, ...busy() });
        const obs: Observation = { kind: 'turn-ended', armedBy };
        expect(causeOf(f, obs)).toBe(armedBy);
        const s = step(f, obs);
        expect(s.move).toEqual({ from: 'running', to: 'done', cause: armedBy });
        expect(s.facts.status).toBe('done');
        expect(s.facts.pending.size).toBe(0);
        expect(s.facts.toolsDone.size).toBe(0);
      }
    },
  );

  it('a turn end confirmed on a session no longer running, or in activity mode, moves nothing', () => {
    const cases: Partial<StatusFacts>[] = [
      ...STATUSES.filter((s) => s !== 'running').map((status) => ({ status })),
      { status: 'running', mode: 'activity' },
    ];
    for (const over of cases) {
      const f = facts({ ...over, ...busy() });
      const s = step(f, { kind: 'turn-ended', armedBy: 'live' });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(f.status);
      expect(s.facts.mode).toBe(f.mode);
      expect([...s.facts.pending]).toEqual(['toolu_1']);
      expect([...s.facts.toolsDone]).toEqual(['toolu_0']);
    }
  });

  it('transcript steps never mutate the facts they are given', () => {
    const before = deepFreeze(
      facts({ status: 'running', record: { firstPromptPending: true, resuming: null }, ...busy() }),
    );
    const observations: Observation[] = [
      { kind: 'transcript-question' },
      { kind: 'transcript-interrupt' },
      { kind: 'turn-ended', armedBy: 'act' },
    ];
    for (const obs of observations) expect(step(before, obs).facts).not.toBe(before);
    expect(before.status).toBe('running');
    expect([...before.pending]).toEqual(['toolu_1']);
    expect([...before.toolsDone]).toEqual(['toolu_0']);
  });
});

describe('step: the screen and activity (group 3)', () => {
  const STATUSES = [null, 'running', 'needs-you', 'done', 'ended'] as const;
  const busy = () => ({ pending: new Set(['toolu_1']), toolsDone: new Set(['toolu_0']) });
  const AT = 1_700_000_000_000;
  const causeFor = (catchingUp: boolean) => (catchingUp ? 'reconcile' : 'live');

  it('activity makes an activity-mode session running unless it shows a startup screen', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const s = step(facts({ status, mode: 'activity', catchingUp }), { kind: 'activity' });
        // Off the board (null) activity places nothing: placing is the attach's.
        const to = status === null ? null : 'running';
        expect(s.facts.status).toBe(to);
        expect(s.move).toEqual(
          to === status ? null : { from: status, to, cause: causeFor(catchingUp) },
        );
      }
    }
    for (const over of [
      { mode: 'activity', startup: true, status: 'needs-you' },
      { mode: 'hooks', status: 'done' },
    ] as const) {
      const s = step(facts(over), { kind: 'activity' });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(over.status);
    }
  });

  it('idle: a quiet activity-mode running session is done and its resume is over (R104)', () => {
    for (const catchingUp of [false, true]) {
      const f = facts({
        status: 'running',
        mode: 'activity',
        catchingUp,
        record: { firstPromptPending: false, resuming: { sessionId: 's-1' } },
      });
      const s = step(f, { kind: 'idle', at: AT });
      expect(s.move).toEqual({ from: 'running', to: 'done', cause: causeFor(catchingUp) });
      expect(s.facts.record?.resuming).toBeNull();
    }
    // Hooks mode, a startup screen, or anything not running: no move, the resume kept.
    const resuming = { firstPromptPending: false, resuming: { sessionId: 's-1' } };
    const cases: Partial<StatusFacts>[] = [
      { status: 'running', mode: 'hooks' },
      { status: 'running', mode: 'activity', startup: true },
      ...STATUSES.filter((x) => x !== 'running').map((status) => ({
        status,
        mode: 'activity' as const,
      })),
    ];
    for (const over of cases) {
      const s = step(facts({ ...over, record: resuming }), { kind: 'idle', at: AT });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(over.status);
      expect(s.facts.record?.resuming).toEqual({ sessionId: 's-1' });
    }
  });

  it('answer-denied: the denial line after an answer makes a running session done with no tool pending', () => {
    for (const catchingUp of [false, true]) {
      const s = step(facts({ status: 'running', catchingUp, ...busy() }), {
        kind: 'answer-denied',
      });
      // Task 6: Kage's check after its own answer sees the No Kage sent: act, as the answer was.
      expect(s.move).toEqual({ from: 'running', to: 'done', cause: 'act' });
      expect(s.facts.pending.size).toBe(0);
      expect(s.facts.toolsDone.size).toBe(0);
    }
    for (const status of STATUSES.filter((x) => x !== 'running')) {
      const s = step(facts({ status, ...busy() }), { kind: 'answer-denied' });
      expect(s.move).toBeNull();
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
  });

  it('first-prompt-check: a startup screen is needs-you with startup; a prompt is needs-you with an unnamed tool pending (P3F1, R57)', () => {
    const waiting = { firstPromptPending: true, resuming: { sessionId: 's-1' } };
    const screen = step(facts({ status: 'running', record: waiting }), {
      kind: 'first-prompt-check',
      screen: 'startup',
      at: AT,
    });
    expect(screen.move).toEqual({ from: 'running', to: 'needs-you', cause: 'live' });
    expect(screen.facts.startup).toBe(true);
    expect(screen.facts.pending.size).toBe(0);
    expect(screen.facts.record).toEqual({ firstPromptPending: false, resuming: null });

    const prompt = step(facts({ status: 'running', record: waiting, ...busy() }), {
      kind: 'first-prompt-check',
      screen: 'prompt',
      at: AT,
    });
    expect(prompt.move).toEqual({ from: 'running', to: 'needs-you', cause: 'live' });
    expect(prompt.facts.startup).toBe(false);
    expect([...prompt.facts.pending].sort()).toEqual([UNNAMED_TOOL, 'toolu_1'].sort());
    expect(prompt.facts.record).toEqual({ firstPromptPending: false, resuming: null });
  });

  it('first-prompt-check is live also while an attach catches up: a SessionStart armed it (F3)', () => {
    const f = facts({
      status: 'running',
      catchingUp: true,
      record: { firstPromptPending: true, resuming: null },
    });
    const obs: Observation = { kind: 'first-prompt-check', screen: 'prompt', at: AT };
    expect(causeOf(f, obs)).toBe('live');
    expect(step(f, obs).move).toEqual({ from: 'running', to: 'needs-you', cause: 'live' });
  });

  it('first-prompt-check: a busy footer keeps it running; a failed capture is done (R58)', () => {
    const waiting = { firstPromptPending: true, resuming: null };
    const kept = step(facts({ status: 'running', record: waiting }), {
      kind: 'first-prompt-check',
      screen: 'busy',
      at: AT,
    });
    expect(kept.move).toBeNull();
    expect(kept.facts.status).toBe('running');
    expect(kept.facts.record?.firstPromptPending).toBe(false);
    for (const screen of ['idle', 'failed'] as const) {
      const s = step(facts({ status: 'running', record: waiting }), {
        kind: 'first-prompt-check',
        screen,
        at: AT,
      });
      expect(s.move).toEqual({ from: 'running', to: 'done', cause: 'live' });
      expect(s.facts.record?.firstPromptPending).toBe(false);
    }
  });

  it('first-prompt-check always ends the wait, and moves only a running session', () => {
    for (const status of STATUSES.filter((x) => x !== 'running')) {
      for (const screen of ['startup', 'prompt', 'busy', 'idle', 'failed'] as const) {
        const s = step(
          facts({ status, record: { firstPromptPending: true, resuming: { sessionId: 's' } } }),
          { kind: 'first-prompt-check', screen, at: AT },
        );
        expect(s.move).toBeNull();
        expect(s.facts.status).toBe(status);
        expect(s.facts.startup).toBe(false);
        expect(s.facts.pending.size).toBe(0);
        expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
      }
    }
  });

  it('startup-shown: a startup screen makes a placed session needs-you with startup (R9)', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const s = step(facts({ status, catchingUp }), { kind: 'startup-shown' });
        const to = status === null ? null : 'needs-you';
        expect(s.facts.status).toBe(to);
        expect(s.facts.startup).toBe(status !== null);
        expect(s.move).toEqual(
          to === status ? null : { from: status, to, cause: causeFor(catchingUp) },
        );
      }
    }
  });

  it('startup-gone: an answered startup screen goes running when active, else done', () => {
    for (const catchingUp of [false, true]) {
      for (const active of [true, false]) {
        const s = step(facts({ status: 'needs-you', startup: true, catchingUp }), {
          kind: 'startup-gone',
          active,
        });
        const to = active ? 'running' : 'done';
        expect(s.move).toEqual({ from: 'needs-you', to, cause: causeFor(catchingUp) });
        expect(s.facts.startup).toBe(false);
      }
    }
    // Already where it would go: startup clears, no move.
    const same = step(facts({ status: 'running', startup: true }), {
      kind: 'startup-gone',
      active: true,
    });
    expect(same.move).toBeNull();
    expect(same.facts.startup).toBe(false);
  });

  it('prompt-shown: a prompt on screen makes a placed session needs-you with an unnamed tool pending', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const s = step(facts({ status, catchingUp }), { kind: 'prompt-shown' });
        const to = status === null ? null : 'needs-you';
        expect(s.facts.status).toBe(to);
        expect(s.facts.pending.has(UNNAMED_TOOL)).toBe(status !== null);
        expect(s.move).toEqual(
          to === status ? null : { from: status, to, cause: causeFor(catchingUp) },
        );
      }
    }
  });

  it("prompt-gone: the denial line is done with no tool pending; else running, the tool kept (R11's pane fallback)", () => {
    for (const catchingUp of [false, true]) {
      const no = step(facts({ status: 'needs-you', catchingUp, ...busy() }), {
        kind: 'prompt-gone',
        denial: true,
      });
      expect(no.move).toEqual({ from: 'needs-you', to: 'done', cause: causeFor(catchingUp) });
      expect(no.facts.pending.size).toBe(0);
      expect(no.facts.toolsDone.size).toBe(0);
      const yes = step(facts({ status: 'needs-you', catchingUp, ...busy() }), {
        kind: 'prompt-gone',
        denial: false,
      });
      expect(yes.move).toEqual({ from: 'needs-you', to: 'running', cause: causeFor(catchingUp) });
      expect([...yes.facts.pending]).toEqual(['toolu_1']);
    }
    for (const status of STATUSES.filter((x) => x !== 'needs-you')) {
      const s = step(facts({ status, ...busy() }), { kind: 'prompt-gone', denial: true });
      expect(s.move).toBeNull();
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
  });

  it('prompt-gone inside the reply window moves nothing', () => {
    for (const denial of [true, false]) {
      const s = step(facts({ status: 'needs-you', replying: true, ...busy() }), {
        kind: 'prompt-gone',
        denial,
      });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe('needs-you');
      expect([...s.facts.pending]).toEqual(['toolu_1']);
      expect([...s.facts.toolsDone]).toEqual(['toolu_0']);
    }
  });

  it('an attach capture that shows a prompt is needs-you with cause reconcile', () => {
    for (const status of ['running', 'done'] as const) {
      const s = step(facts({ status, catchingUp: true }), { kind: 'prompt-shown' });
      expect(s.move).toEqual({ from: status, to: 'needs-you', cause: 'reconcile' });
    }
  });

  it('screen and activity steps never mutate the facts they are given', () => {
    const before = deepFreeze(
      facts({
        status: 'needs-you',
        mode: 'activity',
        startup: true,
        record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
        ...busy(),
      }),
    );
    const observations: Observation[] = [
      { kind: 'activity' },
      { kind: 'idle', at: AT },
      { kind: 'answer-denied' },
      { kind: 'first-prompt-check', screen: 'prompt', at: AT },
      { kind: 'startup-shown' },
      { kind: 'startup-gone', active: true },
      { kind: 'prompt-shown' },
      { kind: 'prompt-gone', denial: true },
    ];
    for (const obs of observations) expect(step(before, obs).facts).not.toBe(before);
    expect(before.status).toBe('needs-you');
    expect(before.startup).toBe(true);
    expect([...before.pending]).toEqual(['toolu_1']);
    expect([...before.toolsDone]).toEqual(['toolu_0']);
    expect(before.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  });
});

describe('step: windows and restarts (group 4)', () => {
  const STATUSES = [null, 'running', 'needs-you', 'done', 'ended'] as const;
  const busy = () => ({ pending: new Set(['toolu_1']), toolsDone: new Set(['toolu_0']) });
  const causeFor = (catchingUp: boolean) => (catchingUp ? 'reconcile' : 'live');

  it('attached: a record that was done stays done, whatever the pane drew (R141)', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        for (const active of [false, true]) {
          const s = step(facts({ status, mode: 'hooks', catchingUp, ...busy() }), {
            kind: 'attached',
            active,
            wasDone: true,
          });
          expect(s.facts.status).toBe('done');
          expect(s.move).toEqual(
            status === 'done' ? null : { from: status, to: 'done', cause: causeFor(catchingUp) },
          );
          expect(s.facts.mode).toBe('activity');
          expect(s.facts.pending.size).toBe(0);
          expect(s.facts.toolsDone.size).toBe(0);
        }
      }
    }
  });

  it('attached: running when the pane drew in the last 5 s, else done', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        for (const active of [false, true]) {
          const to = active ? 'running' : 'done';
          const s = step(
            facts({ status, catchingUp, shellEnded: status === 'ended', startup: true, ...busy() }),
            { kind: 'attached', active, wasDone: false },
          );
          expect(s.facts.status).toBe(to);
          expect(s.move).toEqual(
            status === to ? null : { from: status, to, cause: causeFor(catchingUp) },
          );
          expect(s.facts.mode).toBe('activity');
          expect(s.facts.pending.size).toBe(0);
          expect(s.facts.toolsDone.size).toBe(0);
          if (s.move) {
            expect(s.facts.shellEnded).toBe(false);
            expect(s.facts.startup).toBe(false);
          }
        }
      }
    }
    // The resume and the first-prompt wait are the hooks' and P3F1's to end, not the attach's.
    const r = { firstPromptPending: true, resuming: { sessionId: 's-1' } };
    const kept = step(facts({ status: null, record: r }), {
      kind: 'attached',
      active: true,
      wasDone: false,
    });
    expect(kept.facts.record).toEqual(r);
  });

  it('rebuilt: a question is needs-you and a turn in progress is running, also for a session that was done (B78)', () => {
    for (const catchingUp of [false, true]) {
      for (const status of ['running', 'needs-you', 'done'] as const) {
        for (const wasDone of [false, true]) {
          for (const active of [false, true]) {
            const base = facts({ status, mode: 'activity', catchingUp, ...busy() });
            const q = step(base, { kind: 'rebuilt', question: true, turn: true, active, wasDone });
            expect(q.facts.status).toBe('needs-you');
            expect(q.move).toEqual(
              status === 'needs-you'
                ? null
                : { from: status, to: 'needs-you', cause: causeFor(catchingUp) },
            );
            expect(q.facts.mode).toBe('hooks');
            // The pending tools stay: the transcript doesn't say which tool waits.
            expect([...q.facts.pending]).toEqual(['toolu_1']);
            const turn = step(base, {
              kind: 'rebuilt',
              question: false,
              turn: true,
              active,
              wasDone,
            });
            expect(turn.facts.status).toBe('running');
            expect(turn.facts.mode).toBe('hooks');
            expect(turn.move).toEqual(
              status === 'running'
                ? null
                : { from: status, to: 'running', cause: causeFor(catchingUp) },
            );
            // Neither: as attached (R141 keeps a done session done).
            const neither = step(base, {
              kind: 'rebuilt',
              question: false,
              turn: false,
              active,
              wasDone,
            });
            expect(neither.facts.status).toBe(wasDone || !active ? 'done' : 'running');
            expect(neither.facts.mode).toBe('hooks');
          }
        }
      }
    }
  });

  it('claude-exited: ended, shellEnded, hooks mode, nothing pending', () => {
    for (const catchingUp of [false, true]) {
      for (const status of STATUSES) {
        const s = step(
          facts({
            status,
            mode: 'activity',
            catchingUp,
            record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
            ...busy(),
          }),
          { kind: 'claude-exited' },
        );
        expect(s.facts.status).toBe('ended');
        expect(s.facts.shellEnded).toBe(true);
        expect(s.facts.mode).toBe('hooks');
        expect(s.facts.pending.size).toBe(0);
        expect(s.facts.toolsDone.size).toBe(0);
        if (status === 'ended') expect(s.move).toBeNull();
        else {
          expect(s.move).toEqual({ from: status, to: 'ended', cause: causeFor(catchingUp) });
          // A move into ended ends the resume and the first-prompt wait (F4).
          expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
        }
      }
    }
  });

  it('window-gone: ended, live; with the server down, reconcile', () => {
    for (const serverDown of [false, true]) {
      for (const status of STATUSES) {
        const s = step(facts({ status, mode: 'activity', ...busy() }), {
          kind: 'window-gone',
          serverDown,
        });
        expect(s.facts.status).toBe('ended');
        expect(s.facts.mode).toBe('hooks');
        expect(s.facts.pending.size).toBe(0);
        expect(s.facts.toolsDone.size).toBe(0);
        expect(s.move).toEqual(
          status === 'ended'
            ? null
            : { from: status, to: 'ended', cause: serverDown ? 'reconcile' : 'live' },
        );
      }
    }
    // A window gone while an attach catches up is reconcile too; and an ended shell window
    // (claude exited, then the window closed) keeps its shellEnded, as before.
    const catching = step(facts({ status: 'done', catchingUp: true }), {
      kind: 'window-gone',
      serverDown: false,
    });
    expect(catching.move?.cause).toBe('reconcile');
    const shell = step(facts({ status: 'ended', shellEnded: true }), {
      kind: 'window-gone',
      serverDown: true,
    });
    expect(shell.move).toBeNull();
    expect(shell.facts.shellEnded).toBe(true);
  });

  it('window and restart steps never mutate the facts they are given', () => {
    const before = deepFreeze(
      facts({
        status: 'needs-you',
        mode: 'activity',
        startup: true,
        record: { firstPromptPending: true, resuming: { sessionId: 's-1' } },
        ...busy(),
      }),
    );
    const observations: Observation[] = [
      { kind: 'attached', active: true, wasDone: false },
      { kind: 'rebuilt', question: false, turn: true, active: false, wasDone: true },
      { kind: 'claude-exited' },
      { kind: 'window-gone', serverDown: true },
    ];
    for (const obs of observations) expect(step(before, obs).facts).not.toBe(before);
    expect(before.status).toBe('needs-you');
    expect(before.mode).toBe('activity');
    expect([...before.pending]).toEqual(['toolu_1']);
    expect(before.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  });
});

describe('step: acts (group 5)', () => {
  const STATUSES = [null, 'running', 'needs-you', 'done', 'ended'] as const;
  const busy = () => ({ pending: new Set(['toolu_1']), toolsDone: new Set(['toolu_0']) });
  const waiting = () => ({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  const ACTS: Observation[] = [
    { kind: 'launched' },
    { kind: 'resumed', sessionId: 's-1' },
    { kind: 'resume-aborted' },
    { kind: 'answered' },
    { kind: 'replied' },
    { kind: 'stopped' },
    { kind: 'restored' },
  ];

  it('launched: a record off the board goes running, its first prompt awaited', () => {
    const s = step(facts({ status: null, mode: 'activity' }), { kind: 'launched' });
    expect(s.move).toEqual({ from: null, to: 'running', cause: 'act' });
    expect(s.facts.record).toEqual({ firstPromptPending: true, resuming: null });
    expect(s.facts.mode).toBe('activity');
    for (const status of STATUSES.filter((x) => x !== null)) {
      const placed = step(facts({ status }), { kind: 'launched' });
      expect(placed.move).toBeNull();
      expect(placed.facts.record).toEqual({ firstPromptPending: false, resuming: null });
    }
    // Only Kage's own sessions are launched.
    const ext = step(facts({ status: null, record: null }), { kind: 'launched' });
    expect(ext.move).toBeNull();
    expect(ext.facts.status).toBeNull();
  });

  it('resumed: an ended record goes running, resuming, its first prompt awaited, nothing pending', () => {
    for (const sessionId of ['s-1', null]) {
      const s = step(
        facts({ status: 'ended', shellEnded: true, startup: true, mode: 'hooks', ...busy() }),
        { kind: 'resumed', sessionId },
      );
      expect(s.move).toEqual({ from: 'ended', to: 'running', cause: 'act' });
      expect(s.facts.record).toEqual({ firstPromptPending: true, resuming: { sessionId } });
      expect(s.facts.pending.size).toBe(0);
      expect(s.facts.toolsDone.size).toBe(0);
      expect(s.facts).toMatchObject({ shellEnded: false, startup: false, mode: 'hooks' });
    }
  });

  it('resume-aborted: a record still resuming goes back to ended, the resume and the wait over (R101)', () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const s = step(facts({ status, ...busy(), record: waiting() }), { kind: 'resume-aborted' });
      expect(s.move).toEqual({ from: status, to: 'ended', cause: 'act' });
      expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
      // As the shim did: the tools are left as they were.
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
    // A hook ended the resume meanwhile: nothing.
    for (const status of STATUSES) {
      expect(step(facts({ status }), { kind: 'resume-aborted' }).move).toBeNull();
    }
    // Ended or off the board already: nothing either.
    for (const status of [null, 'ended'] as const) {
      const s = step(facts({ status, record: waiting() }), { kind: 'resume-aborted' });
      expect(s.move).toBeNull();
      expect(s.facts.record).toEqual(waiting());
    }
  });

  it('answered: a needs-you session goes running, its tools left as they are', () => {
    const s = step(facts({ status: 'needs-you', startup: true, ...busy() }), { kind: 'answered' });
    expect(s.move).toEqual({ from: 'needs-you', to: 'running', cause: 'act' });
    expect([...s.facts.pending]).toEqual(['toolu_1']);
    expect(s.facts.startup).toBe(false);
  });

  it('replied: a session on the board and not ended goes running with nothing pending', () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const s = step(facts({ status, ...busy() }), { kind: 'replied' });
      expect(s.move).toEqual(
        status === 'running' ? null : { from: status, to: 'running', cause: 'act' },
      );
      expect(s.facts.status).toBe('running');
      expect(s.facts.pending.size).toBe(0);
      expect(s.facts.toolsDone.size).toBe(0);
    }
    for (const status of [null, 'ended'] as const) {
      const s = step(facts({ status, ...busy() }), { kind: 'replied' });
      expect(s.move).toBeNull();
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
  });

  it('stopped: a session on the board and not ended goes ended, in hooks mode, nothing pending', () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const s = step(facts({ status, mode: 'activity', ...busy(), record: waiting() }), {
        kind: 'stopped',
      });
      expect(s.move).toEqual({ from: status, to: 'ended', cause: 'act' });
      expect(s.facts).toMatchObject({ mode: 'hooks', shellEnded: false });
      expect(s.facts.pending.size).toBe(0);
      expect(s.facts.toolsDone.size).toBe(0);
      expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
    }
    for (const status of [null, 'ended'] as const) {
      const s = step(facts({ status, mode: 'activity', ...busy() }), { kind: 'stopped' });
      expect(s.move).toBeNull();
      expect(s.facts.mode).toBe('activity');
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
  });

  it('restored: a session off the board goes on it as ended', () => {
    for (const record of [{ firstPromptPending: false, resuming: null }, null]) {
      const s = step(facts({ status: null, record }), { kind: 'restored' });
      expect(s.move).toEqual({ from: null, to: 'ended', cause: 'act' });
    }
    for (const status of STATUSES.filter((x) => x !== null)) {
      expect(step(facts({ status }), { kind: 'restored' }).move).toBeNull();
    }
  });

  it('every act is cause act', () => {
    for (const catchingUp of [false, true]) {
      for (const obs of ACTS) expect(causeOf(facts({ catchingUp }), obs)).toBe('act');
    }
    // Each act from a status it moves, also while an attach catches up.
    const from: Record<string, StatusFacts> = {
      launched: facts({ status: null, catchingUp: true }),
      resumed: facts({ status: 'ended', catchingUp: true }),
      'resume-aborted': facts({ status: 'running', catchingUp: true, record: waiting() }),
      answered: facts({ status: 'needs-you', catchingUp: true }),
      replied: facts({ status: 'done', catchingUp: true }),
      stopped: facts({ status: 'running', catchingUp: true }),
      restored: facts({ status: null, catchingUp: true }),
    };
    for (const obs of ACTS) {
      const f = from[obs.kind];
      if (!f) throw new Error(obs.kind);
      expect(step(f, obs).move?.cause).toBe('act');
    }
  });

  it('resumed moves only an ended record; answered only needs-you', () => {
    for (const status of STATUSES) {
      const ext = step(facts({ status, record: null, ...busy() }), {
        kind: 'resumed',
        sessionId: 's-1',
      });
      expect(ext.move).toBeNull();
      expect(ext.facts.record).toBeNull();
      if (status === 'ended') continue;
      const s = step(facts({ status, ...busy() }), { kind: 'resumed', sessionId: 's-1' });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(status);
      expect(s.facts.record).toEqual({ firstPromptPending: false, resuming: null });
      expect([...s.facts.pending]).toEqual(['toolu_1']);
    }
    for (const status of STATUSES.filter((x) => x !== 'needs-you')) {
      const s = step(facts({ status }), { kind: 'answered' });
      expect(s.move).toBeNull();
      expect(s.facts.status).toBe(status);
    }
  });

  it('act steps never mutate the facts they are given', () => {
    for (const status of STATUSES) {
      const before = deepFreeze(
        facts({ status, mode: 'activity', startup: true, record: waiting(), ...busy() }),
      );
      for (const obs of ACTS) expect(step(before, obs).facts).not.toBe(before);
      expect(before.status).toBe(status);
      expect(before.mode).toBe('activity');
      expect([...before.pending]).toEqual(['toolu_1']);
      expect(before.record).toEqual(waiting());
    }
  });
});

describe('step: the last rules from LiveSource (Task 6b, R155)', () => {
  const STATUSES = [null, 'running', 'needs-you', 'done', 'ended'] as const;
  const resuming = () => ({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
  const Q: Question = { text: 'Which separator?', options: ['Dash', 'Underscore'] };
  const OTHER: Question = { text: 'Add a test?', options: ['Yes', 'No'] };
  const asked = (over: Partial<StatusFacts> = {}) =>
    facts({ status: 'needs-you', question: Q, promptKind: 'ask', promptSeen: true, ...over });

  it('resume-aborted moves only a session with no window (R101)', () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const windowed = step(facts({ status, hasWindow: true, record: resuming() }), {
        kind: 'resume-aborted',
      });
      expect(windowed.move).toBeNull();
      expect(windowed.facts.record).toEqual(resuming());
      const none = step(facts({ status, hasWindow: false, record: resuming() }), {
        kind: 'resume-aborted',
      });
      expect(none.move).toEqual({ from: status, to: 'ended', cause: 'act' });
    }
  });

  it('transcript-question: while resuming, a replayed question moves nothing and sets nothing', () => {
    const prompt = { fill: { question: Q, promptKind: 'ask' as const } };
    for (const status of STATUSES) {
      const s = step(facts({ status, record: resuming() }), {
        kind: 'transcript-question',
        prompt,
      });
      expect(s.move).toBeNull();
      expect(s.facts.question).toBeNull();
      expect(s.facts.promptKind).toBeNull();
    }
    // Not resuming: needs-you with the transcript's question.
    const s = step(facts({ status: 'running' }), { kind: 'transcript-question', prompt });
    expect(s.move).toEqual({ from: 'running', to: 'needs-you', cause: 'live' });
    expect(s.facts).toMatchObject({ question: Q, promptKind: 'ask', promptSeen: false });
    // It only fills: a question already shown stays.
    const kept = step(asked({ promptKind: 'permission' }), {
      kind: 'transcript-question',
      prompt: { fill: { question: OTHER, promptKind: 'ask' } },
    });
    expect(kept.move).toBeNull();
    expect(kept.facts).toMatchObject({ question: Q, promptKind: 'permission' });
  });

  it('a move into needs-you sets the prompt its observation carries', () => {
    const shown = step(facts({ status: 'running', mode: 'activity' }), {
      kind: 'prompt-shown',
      prompt: { set: { question: Q, promptKind: 'permission', promptSeen: true } },
    });
    expect(shown.move?.to).toBe('needs-you');
    expect(shown.facts).toMatchObject({ question: Q, promptKind: 'permission', promptSeen: true });
    const startup: Question = { text: 'Trust this folder?', options: ['No', 'Yes'], startup: true };
    const screen = step(facts({ status: 'running' }), {
      kind: 'startup-shown',
      prompt: { set: { question: startup, promptKind: 'trust' } },
    });
    expect(screen.facts).toMatchObject({ question: startup, promptKind: 'trust', startup: true });
    const rebuilt = step(facts({ status: null }), {
      kind: 'rebuilt',
      question: true,
      turn: false,
      active: false,
      wasDone: false,
      prompt: { set: { question: Q, promptKind: 'ask' } },
    });
    expect(rebuilt.move).toEqual({ from: null, to: 'needs-you', cause: 'live' });
    expect(rebuilt.facts).toMatchObject({ question: Q, promptKind: 'ask' });
    const check = step(facts({ status: 'running', record: resuming() }), {
      kind: 'first-prompt-check',
      screen: 'prompt',
      at: 1,
      prompt: { set: { question: Q, promptKind: 'permission', promptSeen: true } },
    });
    expect(check.facts).toMatchObject({ question: Q, promptKind: 'permission', promptSeen: true });
  });

  it("a hook into needs-you sets its prompt: the AskUserQuestion's question, kind and multiSelect", () => {
    const askMulti = new Map([['Which separator?', true]]);
    const e = hookEvent('PreToolUse', { toolName: 'AskUserQuestion', toolUseId: 'toolu_1' });
    const s = step(facts({ status: 'running' }), {
      kind: 'hook',
      event: e,
      prompt: { set: { question: Q, promptKind: 'ask', askMulti } },
    });
    expect(s.move).toEqual({ from: 'running', to: 'needs-you', cause: 'live' });
    expect(s.facts).toMatchObject({ question: Q, promptKind: 'ask' });
    expect([...s.facts.askMulti]).toEqual([['Which separator?', true]]);
    // No question in the input: the one shown stays, else the fill (the transcript's).
    const fill = { set: { promptKind: 'ask' as const }, fill: { question: OTHER } };
    expect(step(asked(), { kind: 'hook', event: e, prompt: fill }).facts.question).toBe(Q);
    expect(step(facts(), { kind: 'hook', event: e, prompt: fill }).facts.question).toBe(OTHER);
  });

  it('a prompt is taken only where the step ends in needs-you', () => {
    // A Stop with a prompt attached never sets it.
    const s = step(facts({ status: 'running' }), {
      kind: 'hook',
      event: hookEvent('Stop'),
      prompt: { set: { question: Q, promptKind: 'ask' } },
    });
    expect(s.facts.status).toBe('done');
    expect(s.facts).toMatchObject({ question: null, promptKind: null });
    // Off the board a screen places nothing and sets nothing.
    const off = step(facts({ status: null }), {
      kind: 'startup-shown',
      prompt: { set: { question: Q, promptKind: 'trust' } },
    });
    expect(off.facts).toMatchObject({ status: null, question: null, promptKind: null });
  });

  it('any move out of needs-you clears the question, its kind and promptSeen; multiSelect stays', () => {
    const askMulti = new Map([['Which separator?', true]]);
    const out: Observation[] = [
      { kind: 'answered' },
      { kind: 'stopped' },
      { kind: 'prompt-gone', denial: true },
      { kind: 'hook', event: hookEvent('Stop') },
      { kind: 'window-gone', serverDown: false },
    ];
    for (const obs of out) {
      const s = step(asked({ askMulti }), obs);
      expect(s.move?.from).toBe('needs-you');
      expect(s.facts).toMatchObject({ question: null, promptKind: null, promptSeen: false });
      expect(s.facts.askMulti).toBe(askMulti);
    }
    // Staying in needs-you keeps them.
    const stay = step(asked(), { kind: 'hook', event: hookEvent('Notification') });
    expect(stay.move).toBeNull();
    expect(stay.facts).toMatchObject({ question: Q, promptKind: 'ask', promptSeen: true });
  });

  it('prompt-captured sets the prompt with no move, only on a needs-you session', () => {
    const set = step(facts({ status: 'needs-you', promptKind: 'permission' }), {
      kind: 'prompt-captured',
      prompt: { set: { question: Q, promptKind: 'permission', promptSeen: true } },
    });
    expect(set.move).toBeNull();
    expect(set.facts).toMatchObject({ question: Q, promptKind: 'permission', promptSeen: true });
    // A fill leaves what is there, and fills only what is null.
    const fill = step(asked({ promptKind: null, promptSeen: false }), {
      kind: 'prompt-captured',
      prompt: { set: { promptSeen: true }, fill: { question: OTHER, promptKind: 'permission' } },
    });
    expect(fill.facts).toMatchObject({ question: Q, promptKind: 'permission', promptSeen: true });
    for (const status of STATUSES.filter((x) => x !== 'needs-you')) {
      const s = step(facts({ status }), {
        kind: 'prompt-captured',
        prompt: { set: { question: Q, promptKind: 'permission', promptSeen: true } },
      });
      expect(s.move).toBeNull();
      expect(s.facts).toMatchObject({
        status,
        question: null,
        promptKind: null,
        promptSeen: false,
      });
    }
  });

  it('prompt steps never mutate the facts they are given', () => {
    const askMulti = new Map([['Which separator?', false]]);
    const before = deepFreeze(asked({ askMulti }));
    const observations: Observation[] = [
      { kind: 'prompt-captured', prompt: { set: { question: OTHER, promptKind: 'permission' } } },
      { kind: 'transcript-question', prompt: { fill: { question: OTHER } } },
      { kind: 'answered' },
      {
        kind: 'hook',
        event: hookEvent('PreToolUse', { toolName: 'AskUserQuestion' }),
        prompt: { set: { question: OTHER, askMulti: new Map([['Add a test?', true]]) } },
      },
    ];
    for (const obs of observations) expect(step(before, obs).facts).not.toBe(before);
    expect(before).toMatchObject({ question: Q, promptKind: 'ask', promptSeen: true });
    expect([...before.askMulti]).toEqual([['Which separator?', false]]);
  });
});
