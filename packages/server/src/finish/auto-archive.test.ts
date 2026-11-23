import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '../control/actions.ts';
import type { BranchState } from '../git/branch.ts';
import { gitCommonDir } from '../git/exec.ts';
import {
  type AutoArchiveDeps,
  AutoArchiver,
  type AutoCandidate,
  listingAgrees,
  watchFailed,
} from './auto-archive.ts';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

/** ageFrom follows doneAt unless given (no restore or unpin since). */
const cand = (over: Partial<AutoCandidate> = {}): AutoCandidate => {
  const doneAt = over.doneAt ?? T0 - 60_000;
  return {
    id: 'k-1',
    repo: '/home/dev/projects/shop',
    worktree: '/home/dev/projects/shop/.worktrees/fix-the-cart-total',
    branch: 'kage/fix-the-cart-total',
    base: 'main',
    baseCommit: 'a'.repeat(40),
    doneAt,
    ageFrom: doneAt,
    ...over,
  };
};

/** A fake fs.watch: one entry per open watcher, with its callback. */
class FakeWatch {
  calls: string[] = [];
  open = new Map<string, (name: string | null) => void>();
  closed: string[] = [];
  throwFor = new Set<string>();
  errors = new Map<string, (e: unknown) => void>();
  watch = (
    dir: string,
    onChange: (name: string | null) => void,
    onError?: (e: unknown) => void,
  ) => {
    this.calls.push(dir);
    if (this.throwFor.has(dir)) throw new Error('ENOSPC: System limit for number of file watchers');
    this.open.set(dir, onChange);
    if (onError) this.errors.set(dir, onError);
    return {
      close: () => {
        this.closed.push(dir);
        this.open.delete(dir);
      },
    };
  };
  fire(dir: string, name: string | null): void {
    const fn = this.open.get(dir);
    if (!fn) throw new Error(`no watcher on ${dir}`);
    fn(name);
  }
}

/** Lets queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setup(
  o: {
    cands?: AutoCandidate[];
    config?: { onMerge: boolean; afterDays: number };
    state?: (c: AutoCandidate) => Promise<BranchState>;
    archive?: (id: string) => Promise<void>;
    confirm?: (id: string) => Promise<boolean>;
  } = {},
) {
  let cands = o.cands ?? [];
  const confirms: string[] = [];
  const archived: string[] = [];
  const checks: string[] = [];
  const logs: string[] = [];
  const fw = new FakeWatch();
  const states = new Map<string, BranchState>();
  const deps: AutoArchiveDeps = {
    config: o.config ?? { onMerge: true, afterDays: 14 },
    candidates: () => cands.map((c) => ({ ...c })),
    state:
      o.state ??
      (async (c) => {
        checks.push(c.id);
        return states.get(c.id) ?? { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
      }),
    archive:
      o.archive ??
      (async (id) => {
        archived.push(id);
        cands = cands.filter((c) => c.id !== id);
      }),
    confirm: async (id) => {
      confirms.push(id);
      return o.confirm ? o.confirm(id) : true;
    },
    gitDir: async (repo) => `${repo}/.git`,
    watch: fw.watch,
    log: (l) => logs.push(l),
  };
  const a = new AutoArchiver(deps);
  return {
    a,
    confirms,
    fw,
    states,
    archived,
    checks,
    logs,
    set: (next: AutoCandidate[]) => {
      cands = next;
    },
    get: () => cands,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("listingAgrees (serve's confirm)", () => {
  const w = (windowId: string, kageId: string | null) => ({ windowId, kageId });
  const list = [w('@0', null), w('@2', 'k-2')];
  it('an ended session whose window is gone: true', async () => {
    expect(await listingAgrees(async () => list, 'k-1', null)).toBe(true);
  });

  it('a done session whose own window is listed: true (the archive closes its idle Claude)', async () => {
    expect(await listingAgrees(async () => [...list, w('@5', 'k-1')], 'k-1', '@5')).toBe(true);
  });

  it('a window tagged with the id that the source does not hold: false (I1)', async () => {
    expect(await listingAgrees(async () => [...list, w('@5', 'k-1')], 'k-1', null)).toBe(false);
    expect(await listingAgrees(async () => [...list, w('@9', 'k-1')], 'k-1', '@5')).toBe(false);
  });

  it('two windows tagged with the id: false unless the source holds every one (Task 10)', async () => {
    const both = async () => [...list, w('@5', 'k-1'), w('@9', 'k-1')];
    expect(await listingAgrees(both, 'k-1', '@5')).toBe(false);
    expect(await listingAgrees(both, 'k-1', '@9')).toBe(false);
    expect(await listingAgrees(both, 'k-1', null)).toBe(false);
  });

  it('an empty listing (session or server missing) is not proof: false', async () => {
    expect(await listingAgrees(async () => [], 'k-1', null)).toBe(false);
  });

  it('a failed listing throws, so the archiver skips and logs it', async () => {
    await expect(
      listingAgrees(
        async () => {
          throw new Error('tmux timed out');
        },
        'k-1',
        null,
      ),
    ).rejects.toThrow('tmux timed out');
  });
});

describe('AutoArchiver: idle cost', () => {
  it('no candidates → no timers and no watchers', async () => {
    const { a, fw, checks } = setup();
    a.start();
    a.sync();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(fw.calls).toEqual([]);
    expect(checks).toEqual([]);
    a.stop();
  });

  it('a candidate not yet due: one deadline timer and one watcher, nothing else', async () => {
    const { a, fw } = setup({ cands: [cand()] });
    a.start();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    expect(fw.calls).toEqual(['/home/dev/projects/shop/.git']);
    a.stop();
  });

  it('onMerge off and afterDays 0: nothing is watched, armed or checked', async () => {
    const { a, fw, checks, archived } = setup({
      cands: [cand({ doneAt: T0 - 100 * DAY })],
      config: { onMerge: false, afterDays: 0 },
    });
    a.start();
    a.touch('k-1');
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(fw.calls).toEqual([]);
    expect(checks).toEqual([]);
    expect(archived).toEqual([]);
  });
});

describe('AutoArchiver: the merge rule', () => {
  it('merged with a clean worktree → archived on touch', async () => {
    const { a, states, archived } = setup({ cands: [cand()] });
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.start();
    await flush();
    expect(archived).toEqual(['k-1']);
  });

  it('a candidate that has a window again at archive time is not archived', async () => {
    // A merged, clean session whose Claude still works (a follow-up after an early merge), seen
    // as ended for a moment: its window is listed again right before the archive.
    let hasWindow = true;
    const { a, states, archived, confirms } = setup({
      cands: [cand()],
      confirm: async () => !hasWindow,
    });
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.start();
    await flush();
    expect(confirms).toEqual(['k-1']);
    expect(archived).toEqual([]);
    hasWindow = false;
    a.touch('k-1');
    await flush();
    expect(archived).toEqual(['k-1']);
  });

  it('a confirm that fails skips the archive and logs once', async () => {
    const { a, states, archived, logs } = setup({
      cands: [cand()],
      confirm: async () => {
        throw new Error('tmux timed out');
      },
    });
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.start();
    await flush();
    a.touch('k-1');
    await flush();
    expect(archived).toEqual([]);
    expect(logs).toEqual(['Auto-archive skipped kage/fix-the-cart-total: tmux timed out']);
  });

  it('the age rule asks confirm too, and a refused candidate stays', async () => {
    const { a, archived, confirms } = setup({
      cands: [cand({ doneAt: T0 - 15 * DAY })],
      confirm: async () => false,
    });
    a.start();
    await flush();
    expect(confirms).toEqual(['k-1']);
    expect(archived).toEqual([]);
  });

  it('touch checks the session again', async () => {
    const { a, states, archived, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    expect(checks).toEqual(['k-1']);
    expect(archived).toEqual([]);
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.touch('k-1');
    await flush();
    expect(checks).toEqual(['k-1', 'k-1']);
    expect(archived).toEqual(['k-1']);
  });

  it('merged but 2 uncommitted entries → not archived (work continues)', async () => {
    const { a, states, archived } = setup({ cands: [cand()] });
    states.set('k-1', { unpushed: 0, uncommitted: 2, ignored: 0, merged: true });
    a.start();
    a.touch('k-1');
    await flush();
    expect(archived).toEqual([]);
  });

  it('onMerge false → merged sessions stay, and no git check runs for a session not yet due', async () => {
    const { a, states, archived, checks } = setup({
      cands: [cand()],
      config: { onMerge: false, afterDays: 14 },
    });
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.start();
    a.touch('k-1');
    await flush();
    expect(archived).toEqual([]);
    expect(checks).toEqual([]);
  });

  it('not merged → stays', async () => {
    const { a, archived } = setup({ cands: [cand()] });
    a.start();
    a.touch('k-1');
    await flush();
    expect(archived).toEqual([]);
  });

  it('touch on an id that is not a candidate does nothing', async () => {
    const { a, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    a.touch('k-9');
    await flush();
    expect(checks).toEqual(['k-1']);
  });

  it('a candidate that stopped being one before its check is skipped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const ctx = setup({
      cands: [cand(), cand({ id: 'k-2', repo: '/r2' })],
      state: async (c) => {
        seen.push(c.id);
        await gate;
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: true };
      },
    });
    ctx.a.start();
    await flush();
    // k-1 and k-2 are checking (different repos). Pin k-1 meanwhile: no archive for it.
    ctx.set(ctx.get().filter((c) => c.id !== 'k-1'));
    ctx.a.sync();
    release();
    await flush();
    expect(seen).toEqual(['k-1', 'k-2']);
    expect(ctx.archived).toEqual(['k-2']);
  });

  it('a restored session is never a candidate here: the source leaves it out (F2), so touch does nothing', async () => {
    const { a, checks } = setup({ cands: [] });
    a.start();
    a.touch('k-1');
    await flush();
    expect(checks).toEqual([]);
  });
});

describe('AutoArchiver: the age rule', () => {
  it('done 13 days ago: nothing now; archived once the clock passes 14 days, with exactly one timer', async () => {
    const { a, archived } = setup({
      cands: [cand({ doneAt: T0 - 13 * DAY })],
      config: { onMerge: false, afterDays: 14 },
    });
    a.start();
    await flush();
    expect(archived).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(archived).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(archived).toEqual(['k-1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the age rule archives a merged-but-dirty session too (the worktree and branch stay)', async () => {
    const { a, states, archived } = setup({ cands: [cand({ doneAt: T0 - 15 * DAY })] });
    states.set('k-1', { unpushed: 0, uncommitted: 3, ignored: 0, merged: true });
    a.start();
    await flush();
    expect(archived).toEqual(['k-1']);
  });

  it('afterDays 0 arms nothing, however old the session', async () => {
    const { a, archived } = setup({
      cands: [cand({ doneAt: T0 - 400 * DAY })],
      config: { onMerge: true, afterDays: 0 },
    });
    a.start();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(archived).toEqual([]);
  });

  it('several candidates: one timer, for the earliest deadline; re-armed on sync', async () => {
    const { a, set, archived } = setup({
      cands: [
        cand({ id: 'k-1', doneAt: T0 - 10 * DAY }),
        cand({ id: 'k-2', doneAt: T0 - 12 * DAY }),
      ],
      config: { onMerge: false, afterDays: 14 },
    });
    a.start();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    // k-2 is pinned: the timer moves to k-1's deadline (4 days on).
    set([cand({ id: 'k-1', doneAt: T0 - 10 * DAY })]);
    a.sync();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * DAY + 1000);
    expect(archived).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * DAY);
    await flush();
    expect(archived).toEqual(['k-1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a deadline beyond 2^31-1 ms is clamped, and the early wake-up re-arms without archiving', async () => {
    const { a, archived } = setup({
      cands: [cand({ doneAt: T0 })],
      config: { onMerge: false, afterDays: 60 },
    });
    a.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    await flush();
    expect(archived).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * DAY - 2_147_483_647);
    await flush();
    expect(archived).toEqual(['k-1']);
  });

  it('a refused due session is not retried by the timer (no busy loop) until the next trigger', async () => {
    let tries = 0;
    const { a, logs } = setup({
      cands: [cand({ doneAt: T0 - 20 * DAY })],
      config: { onMerge: false, afterDays: 14 },
      archive: async () => {
        tries++;
        throw new ActionError(409, 'Stop the session before archiving it.');
      },
    });
    a.start();
    await flush();
    expect(tries).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * DAY);
    expect(tries).toBe(1);
    a.touch('k-1');
    await flush();
    expect(tries).toBe(2);
    expect(logs).toHaveLength(1);
  });
});

describe('AutoArchiver: watchers', () => {
  it('ten watch events in 1 s → one check, 5 s after the last', async () => {
    const { a, fw, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    checks.length = 0;
    for (let i = 0; i < 10; i++) {
      fw.fire('/home/dev/projects/shop/.git', i % 2 ? 'ORIG_HEAD.lock' : 'HEAD');
      await vi.advanceTimersByTimeAsync(100);
    }
    // The last event came at 900 ms; its debounce ends at 5900 ms.
    await vi.advanceTimersByTimeAsync(4999 - 100);
    expect(checks).toEqual([]);
    await vi.advanceTimersByTimeAsync(101);
    await flush();
    expect(checks).toEqual(['k-1']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks).toEqual(['k-1']);
  });

  it('the names that matter: FETCH_HEAD, ORIG_HEAD, packed-refs, HEAD (and their .lock), and null', async () => {
    for (const name of [
      'FETCH_HEAD',
      'ORIG_HEAD',
      'ORIG_HEAD.lock',
      'packed-refs',
      'packed-refs.lock',
      'HEAD',
      'HEAD.lock',
      null,
    ]) {
      const { a, fw, checks } = setup({ cands: [cand()] });
      a.start();
      await flush();
      checks.length = 0;
      fw.fire('/home/dev/projects/shop/.git', name);
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
      expect(checks, String(name)).toEqual(['k-1']);
      a.stop();
    }
  });

  it('an unrelated name (index) → no check, and no debounce timer', async () => {
    const { a, fw, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    checks.length = 0;
    const timers = vi.getTimerCount();
    for (const name of ['index', 'index.lock', 'COMMIT_EDITMSG', 'MERGE_HEAD', 'AUTO_MERGE']) {
      fw.fire('/home/dev/projects/shop/.git', name);
    }
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checks).toEqual([]);
  });

  it("one watcher per git common dir; an event checks only that dir's candidates", async () => {
    const { a, fw, checks } = setup({
      cands: [
        cand({ id: 'k-1' }),
        cand({ id: 'k-2', worktree: '/home/dev/projects/shop/.worktrees/b' }),
        cand({ id: 'k-3', repo: '/home/dev/projects/blog' }),
      ],
    });
    a.start();
    await flush();
    expect(fw.calls.sort()).toEqual([
      '/home/dev/projects/blog/.git',
      '/home/dev/projects/shop/.git',
    ]);
    checks.length = 0;
    fw.fire('/home/dev/projects/shop/.git', 'FETCH_HEAD');
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(checks.sort()).toEqual(['k-1', 'k-2']);
  });

  it('a watcher closes when its last candidate is pinned (sync), and its pending debounce goes with it', async () => {
    const { a, fw, set, checks } = setup({
      cands: [cand({ id: 'k-1' }), cand({ id: 'k-2', repo: '/home/dev/projects/blog' })],
    });
    a.start();
    await flush();
    checks.length = 0;
    fw.fire('/home/dev/projects/shop/.git', 'HEAD');
    set([cand({ id: 'k-2', repo: '/home/dev/projects/blog' })]);
    a.sync();
    expect(fw.closed).toEqual(['/home/dev/projects/shop/.git']);
    expect([...fw.open.keys()]).toEqual(['/home/dev/projects/blog/.git']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checks).toEqual([]);
  });

  it('a watch that throws logs once, does not throw, and that dir is not watched again', async () => {
    const { a, fw, logs, set } = setup({ cands: [cand()] });
    fw.throwFor.add('/home/dev/projects/shop/.git');
    expect(() => a.start()).not.toThrow();
    await flush();
    expect(logs).toEqual([watchFailed('/home/dev/projects/shop/.git')]);
    expect(logs[0]).toBe(
      "Auto-archive can't watch /home/dev/projects/shop/.git; merges there are seen at the next turn end or restart.",
    );
    set([cand(), cand({ id: 'k-2', worktree: '/w2' })]);
    a.sync();
    a.touch('k-2');
    await flush();
    expect(fw.calls).toEqual(['/home/dev/projects/shop/.git']);
    expect(logs).toHaveLength(1);
  });

  it('a gitDir failure logs once and the candidate is still checked on touch', async () => {
    const logs: string[] = [];
    const fw = new FakeWatch();
    const checks: string[] = [];
    const a = new AutoArchiver({
      config: { onMerge: true, afterDays: 14 },
      candidates: () => [cand()],
      state: async (c) => {
        checks.push(c.id);
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
      },
      archive: async () => {},
      confirm: async () => true,
      gitDir: async () => {
        throw new Error('not a git repository');
      },
      watch: fw.watch,
      log: (l) => logs.push(l),
    });
    a.start();
    await flush();
    a.sync();
    a.touch('k-1');
    await flush();
    expect(fw.calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('/home/dev/projects/shop');
    expect(checks).toEqual(['k-1', 'k-1']);
  });
});

describe('AutoArchiver: checks', () => {
  it('start() checks 5 candidates with at most 2 checks in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const done: string[] = [];
    const cands = [1, 2, 3, 4, 5].map((i) => cand({ id: `k-${i}`, repo: `/r${i}` }));
    const { a } = setup({
      cands,
      state: async (c) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 100));
        inFlight--;
        done.push(c.id);
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
      },
    });
    a.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(done.sort()).toEqual(['k-1', 'k-2', 'k-3', 'k-4', 'k-5']);
    expect(most).toBe(2);
  });

  it('checks of one project never run at the same time', async () => {
    let inFlight = 0;
    let most = 0;
    const done: string[] = [];
    const cands = [1, 2, 3].map((i) => cand({ id: `k-${i}`, worktree: `/w${i}` }));
    const { a } = setup({
      cands,
      state: async (c) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 100));
        inFlight--;
        done.push(c.id);
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
      },
    });
    a.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toEqual(['k-1', 'k-2', 'k-3']);
    expect(most).toBe(1);
  });

  it('at most one pending check per candidate; a re-trigger during a check queues exactly one more', async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const { a } = setup({
      cands: [cand()],
      state: async (c) => {
        seen.push(c.id);
        await new Promise<void>((r) => releases.push(r));
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
      },
    });
    a.start();
    a.touch('k-1');
    a.touch('k-1');
    await flush();
    expect(seen).toEqual(['k-1']);
    a.touch('k-1');
    a.touch('k-1');
    a.touch('k-1');
    releases.shift()?.();
    await flush();
    expect(seen).toEqual(['k-1', 'k-1']);
    releases.shift()?.();
    await flush();
    expect(seen).toEqual(['k-1', 'k-1']);
  });

  it('archive rejecting with 409 logs once; the next trigger tries again', async () => {
    let tries = 0;
    const { a, states, logs } = setup({
      cands: [cand()],
      archive: async () => {
        tries++;
        throw new ActionError(409, 'Kage is still finishing the last action on this session.');
      },
    });
    states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    a.start();
    await flush();
    expect(tries).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Kage is still finishing the last action on this session.');
    expect(logs[0]).toContain('kage/fix-the-cart-total');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries).toBe(1);
    a.touch('k-1');
    await flush();
    expect(tries).toBe(2);
    expect(logs).toHaveLength(1);
  });

  it('a 403 refusal is logged once too, and a failing state() (a missing worktree) is logged once and never throws', async () => {
    const ctx = setup({
      cands: [cand()],
      state: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    ctx.a.start();
    await flush();
    ctx.a.touch('k-1');
    await flush();
    expect(ctx.logs).toHaveLength(1);
    expect(ctx.logs[0]).toContain('ENOENT');

    const c2 = setup({
      cands: [cand()],
      archive: async () => {
        throw new ActionError(403, "That window isn't Kage's any more.");
      },
    });
    c2.states.set('k-1', { unpushed: 0, uncommitted: 0, ignored: 0, merged: true });
    c2.a.start();
    await flush();
    c2.a.touch('k-1');
    await flush();
    expect(c2.logs).toHaveLength(1);
  });

  it('stop() clears the timer and closes the watchers; later triggers do nothing', async () => {
    const { a, fw, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    fw.fire('/home/dev/projects/shop/.git', 'HEAD');
    expect(vi.getTimerCount()).toBe(2);
    a.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(fw.closed).toEqual(['/home/dev/projects/shop/.git']);
    checks.length = 0;
    a.touch('k-1');
    a.sync();
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(checks).toEqual([]);
    expect(fw.calls).toHaveLength(1);
  });

  it('stop() during a check: no archive afterwards', async () => {
    let release!: () => void;
    const { a, archived } = setup({
      cands: [cand()],
      state: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: true };
      },
    });
    a.start();
    await flush();
    a.stop();
    release();
    await flush();
    expect(archived).toEqual([]);
  });
});

describe('gitCommonDir', () => {
  it('runs rev-parse --git-common-dir in the repo and makes the answer absolute', async () => {
    const calls: unknown[] = [];
    const exec = async (args: string[], opts?: { cwd?: string }) => {
      calls.push([args, opts?.cwd]);
      return { stdout: '.git\n', stderr: '' };
    };
    const dir = await gitCommonDir('/home/dev/projects/shop', exec);
    expect(calls).toEqual([[['rev-parse', '--git-common-dir'], '/home/dev/projects/shop']]);
    expect(dir.replaceAll('\\', '/')).toMatch(/\/home\/dev\/projects\/shop\/\.git$/);
  });
});

describe('AutoArchiver: fix round 1', () => {
  it('a stale merge result does not archive a session that worked again during the check; the queued re-check decides', async () => {
    const releases: (() => void)[] = [];
    const answers: BranchState[] = [
      { unpushed: 0, uncommitted: 0, ignored: 0, merged: true }, // stale: computed before the new turn
      { unpushed: 0, uncommitted: 1, ignored: 0, merged: true }, // fresh: the new turn left work
    ];
    let seen = 0;
    const ctx = setup({
      cands: [cand()],
      state: async () => {
        const answer = answers[seen++] as BranchState;
        await new Promise<void>((r) => releases.push(r));
        return answer;
      },
    });
    ctx.a.start();
    await flush();
    expect(seen).toBe(1);
    // A turn ends during the check: running, then done again with a new doneAt, and a touch.
    ctx.set([cand({ doneAt: T0 + 5000 })]);
    ctx.a.touch('k-1');
    releases.shift()?.();
    await flush();
    expect(ctx.archived).toEqual([]);
    expect(seen).toBe(2);
    releases.shift()?.();
    await flush();
    expect(ctx.archived).toEqual([]);
  });

  it('the stale check returns quietly even when the session is active right now (no candidate)', async () => {
    let release!: () => void;
    const ctx = setup({
      cands: [cand()],
      state: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { unpushed: 0, uncommitted: 0, ignored: 0, merged: true };
      },
    });
    ctx.a.start();
    await flush();
    ctx.set([]); // running again
    release();
    await flush();
    expect(ctx.archived).toEqual([]);
    expect(ctx.logs).toEqual([]);
  });

  it('R69: age counts from ageFrom (the latest of done, restore and unpin): unpinned now, done 20 days ago → archived 14 days after the unpin', async () => {
    const { a, archived } = setup({
      cands: [cand({ doneAt: T0 - 20 * DAY, ageFrom: T0 })],
      config: { onMerge: false, afterDays: 14 },
    });
    a.start();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(archived).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(14 * DAY - 1);
    expect(archived).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(archived).toEqual(['k-1']);
  });

  it("a watcher's error (the repo deleted) logs watchFailed once, drops the watcher, and the dir is not watched again", async () => {
    const { a, fw, logs, checks } = setup({ cands: [cand()] });
    a.start();
    await flush();
    const dir = '/home/dev/projects/shop/.git';
    fw.errors.get(dir)?.(new Error('ENOENT'));
    fw.errors.get(dir)?.(new Error('ENOENT'));
    expect(logs).toEqual([watchFailed(dir)]);
    expect(fw.closed).toEqual([dir]);
    expect(fw.open.size).toBe(0);
    a.sync();
    a.touch('k-1');
    await flush();
    expect(fw.calls).toEqual([dir]);
    expect(logs).toHaveLength(1);
    expect(checks).toEqual(['k-1', 'k-1']);
    // stop() has no dead watcher left to close.
    a.stop();
    expect(fw.closed).toEqual([dir]);
  });

  it('sync() recomputes the delay even when the earliest deadline is unchanged (a suspend or wall-clock jump)', async () => {
    const { a, archived } = setup({
      cands: [cand({ doneAt: T0 - 13 * DAY })],
      config: { onMerge: false, afterDays: 14 },
    });
    a.start();
    await flush();
    // The machine slept a day: the wall clock moved, the timer did not.
    vi.setSystemTime(T0 + DAY);
    a.sync();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(archived).toEqual(['k-1']);
  });
});
