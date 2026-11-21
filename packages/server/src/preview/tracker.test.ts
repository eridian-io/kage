import type { FileChange, Port } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listener, Proc } from './ports.ts';
import { type PreviewPatch, type PreviewTarget, PreviewTracker, worktreeGone } from './tracker.ts';

interface Published {
  id: string;
  patch: PreviewPatch;
  always: boolean;
}

/** A pane 100 running a vite on 5173. */
const TREE: Proc[] = [
  { pid: 100, ppid: 1, args: 'claude' },
  { pid: 110, ppid: 100, args: 'node /w/node_modules/.bin/vite' },
];
const VITE: Listener = { port: 5173, address: '127.0.0.1', pid: 110 };
const VITE_PORT: Port = { port: 5173, process: 'vite', localOnly: true };

function setup(targets: Record<string, Partial<PreviewTarget>> = {}) {
  const all = new Map<string, PreviewTarget>();
  for (const [id, t] of Object.entries(targets)) {
    all.set(id, {
      id,
      worktree: `/w/${id}`,
      base: 'main',
      branch: null,
      baseCommit: null,
      panePid: 100,
      active: true,
      ...t,
    });
  }
  const published: Published[] = [];
  let listeners: Listener[] = [VITE];
  let scans = 0;
  /** While set, scans and file runs wait for it. */
  let gate: Promise<void> | null = null;
  const fileRuns: string[] = [];
  let fileResult: { files: FileChange[]; total: number } = { files: [], total: 0 };
  let scanError: Error | null = null;
  let filesError: Error | null = null;
  const branchRuns: {
    worktree: string;
    o: { branch: string; base: string | null; baseCommit: string | null };
  }[] = [];
  let counts = { unpushed: 0, uncommitted: 0 };
  let countsError: Error | null = null;
  const tracker = new PreviewTracker({
    target: (id) => all.get(id) ?? null,
    publish: (id, patch, always) => published.push({ id, patch, always }),
    scan: async () => {
      scans++;
      if (gate) await gate;
      if (scanError) throw scanError;
      return { listeners, procs: TREE };
    },
    files: async (worktree) => {
      fileRuns.push(worktree);
      if (gate) await gate;
      if (filesError) throw filesError;
      return fileResult;
    },
    branch: async (worktree, o) => {
      branchRuns.push({ worktree, o });
      if (gate) await gate;
      if (countsError) throw countsError;
      return counts;
    },
  });
  return {
    tracker,
    all,
    published,
    scans: () => scans,
    fileRuns,
    branchRuns,
    setCounts: (c: { unpushed: number; uncommitted: number }) => {
      counts = c;
    },
    failCounts: (e: Error | null) => {
      countsError = e;
    },
    setListeners: (l: Listener[]) => {
      listeners = l;
    },
    setFiles: (r: { files: FileChange[]; total: number }) => {
      fileResult = r;
    },
    failScan: (e: Error | null) => {
      scanError = e;
    },
    failFiles: (e: Error | null) => {
      filesError = e;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((r) => {
        release = () => {
          gate = null;
          r();
        };
      });
      return release;
    },
  };
}

const portsOf = (p: Published[], id: string) =>
  p.filter((x) => x.id === id && x.patch.ports).map((x) => x.patch.ports);
const filesOf = (p: Published[], id: string) =>
  p.filter((x) => x.id === id && x.patch.files).map((x) => x.patch);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PreviewTracker: idle cost', () => {
  it('arms no timer while nothing is viewed', async () => {
    const t = setup({ a: {} });
    expect(vi.getTimerCount()).toBe(0);
    t.tracker.setViewed(new Set());
    t.tracker.touch('a', 'edit');
    t.tracker.touch('a', 'turn-end');
    t.tracker.statusChanged('a');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.scans()).toBe(0);
    expect(t.fileRuns).toEqual([]);
  });

  it('viewing an active session scans now and every 5 s; unviewing stops the timer', async () => {
    const t = setup({ a: {} });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(1);
    expect(t.fileRuns).toEqual(['/w/a']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.scans()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.scans()).toBe(4);
    t.tracker.setViewed(new Set());
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.scans()).toBe(4);
  });

  it('viewing a done session scans once and arms no timer', async () => {
    const t = setup({ a: { active: false } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(portsOf(t.published, 'a')).toEqual([[VITE_PORT]]);
  });

  it('a session without a pane (ended) publishes no ports without scanning', async () => {
    const t = setup({ a: { active: false, panePid: null } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(0);
    expect(portsOf(t.published, 'a')).toEqual([[]]);
  });

  it('one scan serves every viewed session', async () => {
    const t = setup({ a: {}, b: { panePid: 999 } });
    t.tracker.setViewed(new Set(['a', 'b']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(1);
    expect(portsOf(t.published, 'a')).toEqual([[VITE_PORT]]);
    expect(portsOf(t.published, 'b')).toEqual([[]]);
  });

  it('a scan never overlaps another; ticks during a slow scan are skipped', async () => {
    const t = setup({ a: {} });
    const release = t.hold();
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(t.scans()).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.scans()).toBe(2);
  });

  it('no scanner (not Linux or macOS): empty ports on view and never a timer', async () => {
    const published: Published[] = [];
    const tracker = new PreviewTracker({
      target: (id) => ({
        id,
        worktree: '/w',
        base: null,
        branch: null,
        baseCommit: null,
        panePid: 5,
        active: true,
      }),
      publish: (id, patch, always) => published.push({ id, patch, always }),
      scan: null,
      files: async () => ({ files: [], total: 0 }),
      branch: async () => ({ unpushed: 0, uncommitted: 0 }),
    });
    tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(portsOf(published, 'a')).toEqual([[]]);
  });
});

describe('PreviewTracker: status changes (F6)', () => {
  it('a viewed done session that starts running arms the timer and scans; done disarms it', async () => {
    const t = setup({ a: { active: false } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(1);
    (t.all.get('a') as PreviewTarget).active = true;
    t.tracker.statusChanged('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.scans()).toBe(3);
    (t.all.get('a') as PreviewTarget).active = false;
    t.tracker.statusChanged('a');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a status change of an unviewed session does nothing', async () => {
    const t = setup({ a: {} });
    t.tracker.statusChanged('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.scans()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PreviewTracker: files', () => {
  it('five edit touches in 100 ms give one run 500 ms after the last', async () => {
    const t = setup({ a: { active: false } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.fileRuns.length = 0;
    for (let i = 0; i < 5; i++) {
      t.tracker.touch('a', 'edit');
      await vi.advanceTimersByTimeAsync(25);
    }
    // The last touch was at 100 ms; now is 125 ms.
    await vi.advanceTimersByTimeAsync(474);
    expect(t.fileRuns).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fileRuns).toEqual(['/w/a']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.fileRuns).toEqual(['/w/a']);
  });

  it('a touch during a run queues exactly one more run', async () => {
    const t = setup({ a: { active: false } });
    const release = t.hold();
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fileRuns).toHaveLength(1);
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(t.fileRuns).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fileRuns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.fileRuns).toHaveLength(2);
  });

  it('turn-end refreshes files and ports', async () => {
    const t = setup({ a: { active: false } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.tracker.touch('a', 'turn-end');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.scans()).toBe(2);
    expect(t.fileRuns).toHaveLength(2);
  });

  it('a failed git run publishes no files', async () => {
    const published: Published[] = [];
    const tracker = new PreviewTracker({
      target: (id) => ({
        id,
        worktree: '/gone',
        base: null,
        branch: null,
        baseCommit: null,
        panePid: null,
        active: false,
      }),
      publish: (id, patch, always) => published.push({ id, patch, always }),
      scan: null,
      files: async () => {
        throw new Error('not a git repository');
      },
      branch: async () => ({ unpushed: 0, uncommitted: 0 }),
    });
    tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(filesOf(published, 'a')).toEqual([{ files: [], filesTotal: 0 }]);
  });
});

describe('PreviewTracker: publishing (R32)', () => {
  it('publishes on every view, also unchanged; between views only real changes', async () => {
    const t = setup({ a: {} });
    const files = { files: [{ path: 'x.ts', added: 1, removed: 0 }], total: 1 };
    t.setFiles(files);
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published).toEqual([
      { id: 'a', patch: { files: files.files, filesTotal: 1 }, always: true },
      { id: 'a', patch: { ports: [VITE_PORT] }, always: true },
    ]);
    // Same value: nothing.
    await vi.advanceTimersByTimeAsync(5000);
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.published).toHaveLength(2);
    // A real change: published.
    t.setListeners([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.published.at(-1)).toEqual({ id: 'a', patch: { ports: [] }, always: false });
    // Viewed again (after a reconnect): both again, although unchanged.
    t.tracker.setViewed(new Set());
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.slice(-2).map((p) => p.always)).toEqual([true, true]);
    // A second tab viewing it: refresh publishes both again.
    t.tracker.refresh('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published).toHaveLength(7);
  });

  it('forget drops a session and its timers', async () => {
    const t = setup({ a: {} });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.tracker.touch('a', 'edit');
    t.tracker.forget('a');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.fileRuns).toHaveLength(1);
  });

  it('stop() clears everything and work in flight publishes nothing', async () => {
    const t = setup({ a: {} });
    const release = t.hold();
    t.tracker.setViewed(new Set(['a']));
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(0);
    t.tracker.stop();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.published).toEqual([]);
    t.tracker.setViewed(new Set(['a']));
    t.tracker.touch('a', 'edit');
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Like execFile's errors. */
const timeoutError = () =>
  Object.assign(new Error('Command failed: git diff'), { killed: true, signal: 'SIGTERM' });
const goneError = () =>
  Object.assign(new Error('Command failed: git diff'), {
    stderr: 'fatal: not a git repository (or any of the parent directories): .git',
  });
const ONE = { files: [{ path: 'x.ts', added: 1, removed: 0 }], total: 1 };

describe('PreviewTracker: review fix round 1', () => {
  it('worktreeGone: ENOENT and "not a git repository" only', () => {
    expect(worktreeGone(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))).toBe(
      true,
    );
    expect(worktreeGone(goneError())).toBe(true);
    expect(worktreeGone(timeoutError())).toBe(false);
    expect(worktreeGone(new Error('stdout maxBuffer length exceeded'))).toBe(false);
  });

  it('a failed git run after a good one keeps the list and publishes nothing', async () => {
    const t = setup({ a: { active: false } });
    t.setFiles(ONE);
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(filesOf(t.published, 'a')).toEqual([{ files: ONE.files, filesTotal: 1 }]);
    t.failFiles(timeoutError());
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.fileRuns).toHaveLength(2);
    expect(filesOf(t.published, 'a')).toHaveLength(1);
    // A second tab's view while git keeps failing: the last good list again.
    t.tracker.refresh('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.filter((p) => p.patch.files).at(-1)).toEqual({
      id: 'a',
      patch: { files: ONE.files, filesTotal: 1 },
      always: true,
    });
    // A worktree that is gone: the empty list is the truth.
    t.failFiles(goneError());
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(filesOf(t.published, 'a').at(-1)).toEqual({ files: [], filesTotal: 0 });
  });

  it('a failed git run on a first view with no good value sends [] once', async () => {
    const t = setup({ a: { active: false } });
    t.failFiles(timeoutError());
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.filter((p) => p.patch.files)).toEqual([
      { id: 'a', patch: { files: [], filesTotal: 0 }, always: true },
    ]);
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(filesOf(t.published, 'a')).toHaveLength(1);
  });

  it('a burst of edits longer than 3 s still refreshes at 3 s', async () => {
    const t = setup({ a: { active: false } });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.fileRuns.length = 0;
    for (let ms = 0; ms < 2900; ms += 100) {
      t.tracker.touch('a', 'edit');
      await vi.advanceTimersByTimeAsync(100);
    }
    // First touch at 0, now 2900: nothing yet; the max wait ends at 3000.
    expect(t.fileRuns).toEqual([]);
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(100);
    expect(t.fileRuns).toHaveLength(1);
    // The next burst starts its own 3 s.
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.fileRuns).toHaveLength(2);
  });

  it('a session that loses its pane (ended) gets ports [], viewed or not', async () => {
    const t = setup({ a: {}, b: {} });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(portsOf(t.published, 'a')).toEqual([[VITE_PORT]]);
    Object.assign(t.all.get('a') as PreviewTarget, { panePid: null, active: false });
    t.tracker.statusChanged('a');
    expect(t.published.at(-1)).toEqual({ id: 'a', patch: { ports: [] }, always: false });
    expect(vi.getTimerCount()).toBe(0);
    Object.assign(t.all.get('b') as PreviewTarget, { panePid: null, active: false });
    t.tracker.statusChanged('b');
    expect(t.published.at(-1)).toEqual({ id: 'b', patch: { ports: [] }, always: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a scan that fails on a first view sends ports [] once', async () => {
    const t = setup({ a: {} });
    t.failScan(new Error('ss timed out'));
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.filter((p) => p.patch.ports)).toEqual([
      { id: 'a', patch: { ports: [] }, always: true },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(portsOf(t.published, 'a')).toHaveLength(1);
  });

  it('unview forgets the last values: a re-view whose scan and git fail sends [], not stale data', async () => {
    const t = setup({ a: { active: false } });
    t.setFiles(ONE);
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.tracker.setViewed(new Set());
    t.failScan(new Error('ss timed out'));
    t.failFiles(timeoutError());
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.published.slice(-2)).toEqual([
      { id: 'a', patch: { files: [], filesTotal: 0 }, always: true },
      { id: 'a', patch: { ports: [] }, always: true },
    ]);
  });
});

describe('PreviewTracker: branch counts (phase 4 Task 3)', () => {
  const SHA = 'c'.repeat(40);
  const countsOf = (p: Published[], id: string) =>
    p
      .filter((x) => x.id === id && x.patch.unpushed !== undefined)
      .map((x) => ({ unpushed: x.patch.unpushed, uncommitted: x.patch.uncommitted }));

  it('a files run for a record target also publishes unpushed and uncommitted, on change', async () => {
    const t = setup({ a: { branch: 'kage/a', baseCommit: SHA } });
    t.setCounts({ unpushed: 2, uncommitted: 1 });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.branchRuns).toEqual([
      { worktree: '/w/a', o: { branch: 'kage/a', base: 'main', baseCommit: SHA } },
    ]);
    expect(countsOf(t.published, 'a')).toEqual([{ unpushed: 2, uncommitted: 1 }]);
    // An edit with the same counts publishes no new counts; a turn end with new ones does.
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(t.branchRuns).toHaveLength(2);
    expect(countsOf(t.published, 'a')).toHaveLength(1);
    t.setCounts({ unpushed: 3, uncommitted: 0 });
    t.tracker.touch('a', 'turn-end');
    await vi.advanceTimersByTimeAsync(600);
    expect(countsOf(t.published, 'a')).toEqual([
      { unpushed: 2, uncommitted: 1 },
      { unpushed: 3, uncommitted: 0 },
    ]);
    // A refresh (another tab) runs them again with the files.
    t.tracker.refresh('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.branchRuns).toHaveLength(4);
  });

  it('external targets never call branch', async () => {
    const t = setup({ e: { base: null, branch: null, baseCommit: null } });
    t.tracker.setViewed(new Set(['e']));
    await vi.advanceTimersByTimeAsync(0);
    t.tracker.touch('e', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(t.fileRuns).toHaveLength(2);
    expect(t.branchRuns).toEqual([]);
    expect(countsOf(t.published, 'e')).toEqual([]);
  });

  it('a rejected count publishes nothing (the last value stays); the files still go out', async () => {
    const t = setup({ a: { branch: 'kage/a', baseCommit: SHA } });
    t.setCounts({ unpushed: 1, uncommitted: 1 });
    t.tracker.setViewed(new Set(['a']));
    await vi.advanceTimersByTimeAsync(0);
    t.failCounts(timeoutError());
    t.setFiles({ files: [{ path: 'n.ts', added: 1, removed: 0 }], total: 1 });
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(countsOf(t.published, 'a')).toEqual([{ unpushed: 1, uncommitted: 1 }]);
    expect(filesOf(t.published, 'a').at(-1)?.filesTotal).toBe(1);
    // A gone worktree publishes no counts either (no zeroing).
    t.failCounts(goneError());
    t.tracker.touch('a', 'edit');
    await vi.advanceTimersByTimeAsync(600);
    expect(countsOf(t.published, 'a')).toHaveLength(1);
  });
});
