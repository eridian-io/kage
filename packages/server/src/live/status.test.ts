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
  it('set moves to its status with its cause, and never when the status is already that', () => {
    for (const cause of ['live', 'reconcile', 'act'] as const) {
      const s = step(facts({ status: 'running' }), { kind: 'set', to: 'done', cause });
      expect(s.move).toEqual({ from: 'running', to: 'done', cause });
      expect(s.facts.status).toBe('done');
    }
    const same = step(facts({ status: 'done' }), { kind: 'set', to: 'done', cause: 'live' });
    expect(same.move).toBeNull();
    expect(same.facts.status).toBe('done');
    // Off the board (null) counts as different: the first placement is a move.
    const first = step(facts({ status: null }), { kind: 'set', to: 'ended', cause: 'act' });
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
      { kind: 'set', to: 'ended', cause: 'live' },
      { kind: 'set', to: 'running', cause: 'act' },
      { kind: 'set', to: 'needs-you', cause: 'reconcile' },
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

  it('causeOf: set keeps its cause, loaded is reconcile, other kinds are reconcile while catching up and live otherwise', () => {
    for (const catchingUp of [false, true]) {
      const f = facts({ catchingUp });
      for (const cause of ['live', 'reconcile', 'act'] as const) {
        expect(causeOf(f, { kind: 'set', to: 'done', cause })).toBe(cause);
      }
      expect(causeOf(f, { kind: 'loaded' })).toBe('reconcile');
      // The other kinds arrive with Tasks 2–5; one they don't name yet stands in for them.
      const other = { kind: 'activity' } as unknown as Observation;
      expect(causeOf(f, other)).toBe(catchingUp ? 'reconcile' : 'live');
    }
  });

  it('any move clears shellEnded, and startup unless it moves into needs-you', () => {
    const f = facts({ status: 'ended', shellEnded: true, startup: true });
    const toRunning = step(f, { kind: 'set', to: 'running', cause: 'live' });
    expect(toRunning.facts).toMatchObject({ shellEnded: false, startup: false });
    const toNeedsYou = step(f, { kind: 'set', to: 'needs-you', cause: 'live' });
    expect(toNeedsYou.facts).toMatchObject({ shellEnded: false, startup: true });
    // No move: both stay as they were.
    const still = step(f, { kind: 'set', to: 'ended', cause: 'live' });
    expect(still.move).toBeNull();
    expect(still.facts).toMatchObject({ shellEnded: true, startup: true });
  });

  it('a move into ended clears the resume and the first-prompt wait (F4)', () => {
    const f = facts({ record: { firstPromptPending: true, resuming: { sessionId: 's-1' } } });
    const ended = step(f, { kind: 'set', to: 'ended', cause: 'live' });
    expect(ended.facts.record).toEqual({ firstPromptPending: false, resuming: null });
    const done = step(f, { kind: 'set', to: 'done', cause: 'live' });
    expect(done.facts.record).toEqual({ firstPromptPending: true, resuming: { sessionId: 's-1' } });
    // An external session has no record facts.
    const ext = step(facts({ record: null }), { kind: 'set', to: 'ended', cause: 'live' });
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
