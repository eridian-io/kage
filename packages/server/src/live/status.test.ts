import { describe, expect, it } from 'vitest';
import { causeOf, type Observation, type StatusFacts, step } from './status.ts';

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
