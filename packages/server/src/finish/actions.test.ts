import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { SessionStatus } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionError, ActionLock } from '../control/actions.ts';
import type { FinishTarget } from '../live-source.ts';
import type { SessionRecord } from '../state/store.ts';
import { FinishActions } from './actions.ts';

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  kageId: 'k-1',
  windowId: '@2',
  project: 'shop',
  task: 'Fix the cart total',
  branch: 'kage/fix-the-cart-total',
  worktree: '/home/dev/projects/shop/.worktrees/fix-the-cart-total',
  createdAt: 1_800_000_000_000,
  pinned: false,
  archived: false,
  sessionId: null,
  transcriptPath: null,
  base: 'main',
  permissionMode: 'default',
  baseCommit: null,
  doneAt: null,
  archivedAt: null,
  restoredAt: null,
  unpinnedAt: null,
  ...over,
});

const target = (over: Partial<FinishTarget> = {}): FinishTarget => ({
  id: 'k-1',
  record: rec(),
  windowId: '@2',
  paneId: '%2',
  status: 'done',
  external: false,
  ...over,
});

/** tmux error as execFile gives it (stderr attached). */
const execError = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });

class FakeTmux {
  log: string[] = [];
  /** The live @kage_id of each window; absent means the window is gone. */
  held = new Map<string, string | null>([['@2', 'k-1']]);
  killError: Error | null = null;
  /** Runs inside killOwnedWindow (to interleave a second action). */
  during: (() => Promise<void>) | null = null;
  /** The pane's visible screen, as capturePane gives it. */
  screen = ['Done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts', ''].join('\n');
  /** Each capture as `<pane> <lines>`, in order (kept apart from `log`). */
  captures: string[] = [];
  captureError: Error | null = null;
  /** Runs inside capturePane (to change the session's status meanwhile). */
  onCapture: (() => void) | null = null;
  async capturePane(paneId: string, lines: number): Promise<string> {
    this.captures.push(`${paneId} ${lines}`);
    this.onCapture?.();
    if (this.captureError) throw this.captureError;
    return this.screen;
  }
  async killOwnedWindow(windowId: string, kageId: string): Promise<boolean> {
    this.log.push(`kill ${windowId} ${kageId}`);
    if (this.during) await this.during();
    if (this.killError) throw this.killError;
    if (!this.held.has(windowId) || this.held.get(windowId) !== kageId) return false;
    this.held.delete(windowId);
    return true;
  }
  async windowKageId(windowId: string): Promise<string | null> {
    this.log.push(`read ${windowId}`);
    if (!this.held.has(windowId)) throw execError(`can't find window: ${windowId}`);
    return this.held.get(windowId) ?? null;
  }
}

class FakeSource {
  log: string[] = [];
  targets = new Map<string, FinishTarget>([['k-1', target()]]);
  saveError: Error | null = null;
  finishTarget(id: string): FinishTarget | null {
    const t = this.targets.get(id);
    return t ? { ...t, record: t.record ? { ...t.record } : null } : null;
  }
  async setFlags(id: string, f: { pinned?: boolean; archived?: boolean }): Promise<void> {
    this.log.push(`flags ${id} ${JSON.stringify(f)}`);
    if (this.saveError) throw this.saveError;
    const t = this.targets.get(id);
    if (t?.record) t.record = { ...t.record, ...f };
  }
  markStopped(id: string): void {
    this.log.push(`stopped ${id}`);
    const t = this.targets.get(id);
    if (t) t.status = 'ended';
  }
  async forget(id: string): Promise<void> {
    this.log.push(`forget ${id}`);
    this.targets.delete(id);
  }
}

/** Delete deps that refuse every use: pin and archive must never reach git. */
const NO_DELETE = {
  git: async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    throw new Error(`unexpected git ${args.join(' ')}`);
  },
  projectsRoot: '/home/dev/projects',
  worktreeDir: '.worktrees',
  counts: async (): Promise<{ unpushed: number; uncommitted: number }> => {
    throw new Error('unexpected count');
  },
  publish: () => {
    throw new Error('unexpected publish');
  },
};

function setup(t: FinishTarget | null = target(), lock = new ActionLock()) {
  const tmux = new FakeTmux();
  const source = new FakeSource();
  if (t) source.targets.set(t.id, t);
  else source.targets.clear();
  const finish = new FinishActions({ tmux, source, lock, ...NO_DELETE });
  return { tmux, source, finish, lock };
}

async function refusal(p: Promise<void>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    return e as ActionError;
  }
  throw new Error('expected the action to be refused');
}

describe('FinishActions.pin', () => {
  it('sets pinned on a record session, in any status', async () => {
    for (const status of ['running', 'needs-you', 'done', 'ended'] as SessionStatus[]) {
      const { finish, source, tmux } = setup(target({ status }));
      await finish.pin('k-1', true);
      await finish.pin('k-1', false);
      expect(source.log).toEqual(['flags k-1 {"pinned":true}', 'flags k-1 {"pinned":false}']);
      expect(tmux.log).toEqual([]);
    }
  });

  it('an external session → 403 with no save', async () => {
    const { finish, source } = setup(target({ id: 'ext-@3', record: null, external: true }));
    const e = await refusal(finish.pin('ext-@3', true));
    expect([e.status, e.message]).toEqual([403, 'Kage only pins sessions it started.']);
    expect(source.log).toEqual([]);
  });

  it('an unknown id → 404', async () => {
    const { finish } = setup(null);
    const e = await refusal(finish.pin('nope', true));
    expect([e.status, e.message]).toEqual([404, 'No session with id nope']);
  });
});

describe('FinishActions.archive', () => {
  it('a done session with a live window: kills it with the record kage id, markStopped, then archives', async () => {
    const { finish, source, tmux } = setup();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('while running or needs you → 409, with no kill', async () => {
    for (const status of ['running', 'needs-you'] as SessionStatus[]) {
      const { finish, source, tmux } = setup(target({ status }));
      const e = await refusal(finish.archive('k-1', true));
      expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
      expect(tmux.log).toEqual([]);
      expect(source.log).toEqual([]);
    }
  });

  it('killOwnedWindow false while the window holds another @kage_id → 403, nothing archived', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.set('@2', 'k-other');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([403, "That window isn't Kage's any more."]);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual([]);
  });

  it('killOwnedWindow false on an untagged window → 403 too', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.set('@2', null);
    expect((await refusal(finish.archive('k-1', true))).status).toBe(403);
    expect(source.log).toEqual([]);
  });

  it('killOwnedWindow false because the window is gone: archived anyway, no markStopped', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.clear();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it('an ended session with no window: archived with no tmux call', async () => {
    const { finish, source, tmux } = setup(target({ status: 'ended', windowId: null }));
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it('archiving an archived session is a no-op', async () => {
    const { finish, source, tmux } = setup(
      target({ status: 'ended', windowId: null, record: rec({ archived: true, archivedAt: 5 }) }),
    );
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('restore: setFlags({archived: false}); restoring one that is not archived is a no-op', async () => {
    const a = setup(
      target({ status: 'ended', windowId: null, record: rec({ archived: true, archivedAt: 5 }) }),
    );
    await a.finish.archive('k-1', false);
    expect(a.source.log).toEqual(['flags k-1 {"archived":false}']);
    expect(a.tmux.log).toEqual([]);
    const b = setup(target({ status: 'ended', windowId: null }));
    await b.finish.archive('k-1', false);
    expect(b.source.log).toEqual([]);
  });

  it('an external session → 403 "Kage only archives sessions it started.", no tmux call', async () => {
    const { finish, source, tmux } = setup(
      target({ id: 'ext-@3', record: null, external: true, windowId: '@3' }),
    );
    for (const archived of [true, false]) {
      const e = await refusal(finish.archive('ext-@3', archived));
      expect([e.status, e.message]).toEqual([403, 'Kage only archives sessions it started.']);
    }
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('two concurrent archive calls: the second is 409 and does nothing', async () => {
    const { finish, source, tmux } = setup();
    let second: Promise<ActionError> | null = null;
    tmux.during = async () => {
      tmux.during = null;
      second = refusal(finish.archive('k-1', true));
      await second;
    };
    await finish.archive('k-1', true);
    const e = await (second as unknown as Promise<ActionError>);
    expect([e.status, e.message]).toEqual([
      409,
      'Kage is still finishing the last action on this session.',
    ]);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('the lock is shared: held by another holder (resume, delete) → 409; released after an action, even a failed one', async () => {
    const lock = new ActionLock();
    const { finish, source } = setup(target(), lock);
    const release = lock.tryAcquire('k-1');
    expect(release).not.toBeNull();
    expect((await refusal(finish.pin('k-1', true))).status).toBe(409);
    expect((await refusal(finish.archive('k-1', true))).status).toBe(409);
    release?.();
    source.saveError = new Error('disk full');
    await expect(finish.pin('k-1', true)).rejects.toThrow('disk full');
    source.saveError = null;
    await finish.pin('k-1', true);
    expect(lock.tryAcquire('k-1')).not.toBeNull();
  });

  it('a failed tmux kill (not "gone") → 422 with tmux\'s first line, nothing archived', async () => {
    const { finish, source, tmux } = setup();
    tmux.killError = execError('server exited unexpectedly\nmore');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([
      422,
      "tmux couldn't close the window: server exited unexpectedly",
    ]);
    expect(source.log).toEqual([]);
  });

  it('an unknown id → 404', async () => {
    const { finish } = setup(null);
    expect((await refusal(finish.archive('nope', true))).status).toBe(404);
  });
});

describe('FinishActions.archive: the live re-check right before the kill (Task 4 carry)', () => {
  const BUSY = [
    '● Bash(npm test)',
    '',
    '─'.repeat(40),
    '❯ ',
    '─'.repeat(40),
    '  ⏸ manual mode on · esc to interrupt',
    '',
  ].join('\n');

  it("captures the pane's visible screen, then kills", async () => {
    const { finish, tmux, source } = setup();
    const order: string[] = [];
    tmux.onCapture = () => order.push(`capture (kills so far: ${tmux.log.length})`);
    await finish.archive('k-1', true);
    expect(tmux.captures).toEqual(['%2 0']);
    expect(order).toEqual(['capture (kills so far: 0)']);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('a busy footer ("esc to interrupt") on the pane → 409, no kill, nothing archived', async () => {
    const { finish, tmux, source } = setup();
    tmux.screen = BUSY;
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('the session turned running or needs you while the pane was captured → 409, no kill', async () => {
    for (const status of ['running', 'needs-you'] as SessionStatus[]) {
      const { finish, tmux, source } = setup();
      tmux.onCapture = () => {
        const t = source.targets.get('k-1');
        if (t) t.status = status;
      };
      const e = await refusal(finish.archive('k-1', true));
      expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
      expect(tmux.log).toEqual([]);
      expect(source.log).toEqual([]);
    }
  });

  it('the pane is gone at the capture: the kill finds it gone, archived anyway', async () => {
    const { finish, tmux, source } = setup();
    tmux.captureError = execError("can't find pane: %2");
    tmux.held.clear();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it("another capture failure → 422 with tmux's first line, no kill", async () => {
    const { finish, tmux, source } = setup();
    tmux.captureError = execError('server exited unexpectedly');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([
      422,
      "tmux couldn't read the window: server exited unexpectedly",
    ]);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('no window or no pane: no capture', async () => {
    const a = setup(target({ status: 'ended', windowId: null, paneId: null }));
    await a.finish.archive('k-1', true);
    expect(a.tmux.captures).toEqual([]);
  });
});

describe('ActionLock', () => {
  it('one holder per id; release frees it once', () => {
    const lock = new ActionLock();
    const a = lock.tryAcquire('k-1');
    expect(a).not.toBeNull();
    expect(lock.tryAcquire('k-1')).toBeNull();
    expect(lock.tryAcquire('k-2')).not.toBeNull();
    a?.();
    const b = lock.tryAcquire('k-1');
    expect(b).not.toBeNull();
    // A stale release must not free the new holder's lock.
    a?.();
    expect(lock.tryAcquire('k-1')).toBeNull();
  });
});

describe('FinishActions.remove (delete with the warning, B10)', () => {
  const NOT_OURS = (wt: string) => `Kage won't delete ${wt}: it isn't one of Kage's worktrees.`;
  const CHANGED = 'The branch changed since you looked. Look again before deleting.';
  /** git prints forward slashes on Windows too. */
  const gitPath = (p: string) => p.replace(/\\/g, '/');
  const porcelain = (entries: { path: string; branch: string | null }[]) =>
    entries
      .map(
        (e) =>
          `worktree ${gitPath(e.path)}\nHEAD ${'a'.repeat(40)}\n${e.branch ? `branch ${e.branch}` : 'detached'}\n`,
      )
      .join('\n');

  let tmp: string;
  let repo: string;
  let wt: string;
  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'kage-del-')));
    repo = join(tmp, 'projects', 'shop');
    wt = join(repo, '.worktrees', 'x');
    await mkdir(wt, { recursive: true });
    await mkdir(join(repo, '.git'));
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  /**
   * One log for tmux, git, counts and the source, in call order. git answers from `g`: the
   * listing, whether the branch exists, counts, and failures for remove and branch -D.
   */
  function del(
    o: {
      t?: Partial<FinishTarget>;
      r?: Partial<SessionRecord>;
      fresh?: { unpushed: number; uncommitted: number }[];
      project?: boolean;
      countError?: Error;
    } = {},
  ) {
    const log: string[] = [];
    const g = {
      list: null as string | null,
      branchExists: true,
      removeError: null as Error | null,
      branchError: null as Error | null,
      revList: '0\n',
      status: '',
    };
    const git = async (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => {
      const line = args.join(' ');
      log.push(`git ${line}`);
      if (line === 'worktree list --porcelain') {
        return {
          stdout:
            g.list ??
            porcelain([
              { path: repo, branch: 'refs/heads/main' },
              { path: wt, branch: 'refs/heads/kage/x' },
            ]),
          stderr: '',
        };
      }
      if (args[0] === 'show-ref') {
        if (g.branchExists) return { stdout: '', stderr: '' };
        throw Object.assign(new Error('exit 1'), { code: 1, stderr: '' });
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        expect(opts?.timeoutMs).toBe(60_000);
        if (g.removeError) throw g.removeError;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'branch') {
        if (g.branchError) throw g.branchError;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-list') return { stdout: g.revList, stderr: '' };
      if (args[0] === 'status') return { stdout: g.status, stderr: '' };
      if (line === 'worktree prune') return { stdout: '', stderr: '' };
      throw new Error(`unexpected git ${line}`);
    };
    const fresh = [...(o.fresh ?? [{ unpushed: 1, uncommitted: 0 }])];
    const published: string[] = [];
    const tmux = new FakeTmux();
    tmux.log = log;
    const source = new FakeSource();
    source.log = log;
    source.targets.set(
      'k-1',
      target({ record: rec({ branch: 'kage/x', worktree: wt, ...o.r }), ...o.t }),
    );
    const finish = new FinishActions({
      tmux,
      source,
      lock: new ActionLock(),
      git,
      projectsRoot: join(tmp, 'projects'),
      worktreeDir: '.worktrees',
      counts: async (worktree, branch) => {
        log.push(`counts ${worktree === wt ? '<wt>' : worktree} ${branch}`);
        if (o.countError) throw o.countError;
        return (fresh.length > 1 ? fresh.shift() : fresh[0]) as {
          unpushed: number;
          uncommitted: number;
        };
      },
      publish: (id, p) => published.push(`${id} ${JSON.stringify(p)}`),
      findProject: async (name) => (o.project === false || name !== 'shop' ? null : { path: repo }),
    });
    const removals = () =>
      log.filter((l) => /^git (worktree (remove|prune)|branch )|^forget/.test(l));
    const kills = () => log.filter((l) => l.startsWith('kill'));
    return { log, g, tmux, source, finish, published, removals, kills };
  }

  it('confirmed {1, 0}: recount, kill, recount, worktree remove (no --force), branch -D, forget, in order', async () => {
    const { finish, log, published } = del();
    await finish.remove('k-1', { unpushed: 1, uncommitted: 0 });
    expect(log).toEqual([
      'git worktree list --porcelain',
      'git show-ref --verify --quiet refs/heads/kage/x',
      'counts <wt> kage/x',
      'kill @2 k-1',
      'stopped k-1',
      'git worktree list --porcelain',
      'git show-ref --verify --quiet refs/heads/kage/x',
      'counts <wt> kage/x',
      `git worktree remove -- ${wt}`,
      'git branch -D -- kage/x',
      'forget k-1',
    ]);
    expect(published).toEqual([]);
  });

  it('confirmed {0, 2} that still match → worktree remove --force', async () => {
    const { finish, removals } = del({ fresh: [{ unpushed: 0, uncommitted: 2 }] });
    await finish.remove('k-1', { unpushed: 0, uncommitted: 2 });
    expect(removals()).toEqual([
      `git worktree remove --force -- ${wt}`,
      'git branch -D -- kage/x',
      'forget k-1',
    ]);
  });

  it('a stale {0, 0} when the branch has {1, 0} → 409, publish {1, 0}, no kill, removal or forget', async () => {
    const { finish, published, removals, kills } = del();
    const e = await refusal(finish.remove('k-1', { unpushed: 0, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([409, CHANGED]);
    expect(published).toEqual(['k-1 {"unpushed":1,"uncommitted":0}']);
    expect(kills()).toEqual([]);
    expect(removals()).toEqual([]);
  });

  it('F10: the counts change between the kill and the removal → 409, publish the fresh ones, nothing removed', async () => {
    const { finish, published, removals, kills } = del({
      fresh: [
        { unpushed: 1, uncommitted: 0 },
        { unpushed: 1, uncommitted: 1 },
      ],
    });
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([409, CHANGED]);
    expect(kills()).toEqual(['kill @2 k-1']);
    expect(published).toEqual(['k-1 {"unpushed":1,"uncommitted":1}']);
    expect(removals()).toEqual([]);
  });

  it('an external session → 403 with no git call', async () => {
    const { finish, log } = del({ t: { record: null, external: true } });
    const e = await refusal(finish.remove('k-1', { unpushed: 0, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([403, 'Kage only deletes sessions it started.']);
    expect(log).toEqual([]);
  });

  it('running or needs you → 409 "Stop the session before deleting it.", with no git call', async () => {
    for (const status of ['running', 'needs-you'] as SessionStatus[]) {
      const { finish, log } = del({ t: { status } });
      const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
      expect([e.status, e.message]).toEqual([409, 'Stop the session before deleting it.']);
      expect(log).toEqual([]);
    }
  });

  it('a busy footer on the pane right before the kill → 409, nothing killed or removed', async () => {
    const { finish, tmux, removals, kills } = del();
    tmux.screen = 'x\n  ⏸ manual mode on · esc to interrupt\n';
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([409, 'Stop the session before deleting it.']);
    expect(kills()).toEqual([]);
    expect(removals()).toEqual([]);
  });

  it('a branch "-x", a branch equal to the base, or a worktree outside <repo>/.worktrees/ → 409, nothing touched', async () => {
    const cases: Partial<SessionRecord>[] = [
      { branch: '-x' },
      { branch: 'main', base: 'main' },
      { worktree: `${repo}${sep}.worktrees${sep}..${sep}..${sep}home${sep}x` },
      { worktree: `${repo}/../../home/x` },
      { worktree: repo },
      { worktree: join(repo, '.worktrees') },
      { worktree: join(tmp, 'elsewhere') },
    ];
    for (const r of cases) {
      const { finish, log } = del({ r });
      const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
      const shown = r.worktree ?? wt;
      expect([e.status, e.message], JSON.stringify(r)).toEqual([409, NOT_OURS(shown)]);
      expect(log, JSON.stringify(r)).toEqual([]);
    }
  });

  it('a worktree folder that is a link to somewhere outside → 409, nothing touched', async () => {
    const outside = join(tmp, 'outside');
    await mkdir(outside);
    const link = join(repo, '.worktrees', 'y');
    await symlink(outside, link, 'junction');
    const { finish, log } = del({ r: { worktree: link } });
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([409, NOT_OURS(link)]);
    expect(log).toEqual([]);
  });

  it('a folder git does not list → 409 before the kill, nothing removed', async () => {
    const { finish, g, removals, kills } = del();
    g.list = porcelain([{ path: repo, branch: 'refs/heads/main' }]);
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([409, NOT_OURS(wt)]);
    expect(kills()).toEqual([]);
    expect(removals()).toEqual([]);
  });

  it('the path listed as the main worktree, on another branch, or detached → refused', async () => {
    for (const list of [
      porcelain([
        { path: wt, branch: 'refs/heads/kage/x' },
        { path: repo, branch: 'refs/heads/main' },
      ]),
      porcelain([
        { path: repo, branch: 'refs/heads/main' },
        { path: wt, branch: 'refs/heads/feature/keep' },
      ]),
      porcelain([
        { path: repo, branch: 'refs/heads/main' },
        { path: wt, branch: null },
      ]),
    ]) {
      const { finish, g, removals, kills } = del();
      g.list = list;
      const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
      expect([e.status, e.message]).toEqual([409, NOT_OURS(wt)]);
      expect(kills()).toEqual([]);
      expect(removals()).toEqual([]);
    }
  });

  it('killOwnedWindow false while the window holds another kage id → 403, nothing removed', async () => {
    const { finish, tmux, removals } = del();
    tmux.held.set('@2', 'k-other');
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([403, "That window isn't Kage's any more."]);
    expect(removals()).toEqual([]);
  });

  it("a failed worktree remove → 422 with git's first line; the branch and the record stay", async () => {
    const { finish, g, removals } = del();
    g.removeError = execError(
      "fatal: '.worktrees/x' contains modified or untracked files, use --force to delete it\nx",
    );
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([
      422,
      "git couldn't remove the worktree: fatal: '.worktrees/x' contains modified or untracked files, use --force to delete it",
    ]);
    expect(removals()).toEqual([`git worktree remove -- ${wt}`]);
  });

  it("a failed branch -D → 422 with git's first line; the record stays (its worktree is gone)", async () => {
    const { finish, g, removals, source } = del();
    g.branchError = execError("error: cannot delete branch 'kage/x' used by worktree at '/x'");
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([
      422,
      "git couldn't delete the branch: error: cannot delete branch 'kage/x' used by worktree at '/x'",
    ]);
    expect(removals()).toEqual([`git worktree remove -- ${wt}`, 'git branch -D -- kage/x']);
    expect(source.targets.has('k-1')).toBe(true);
  });

  it('a failed count → 422, nothing killed or removed', async () => {
    const { finish, removals, kills } = del({ countError: execError('fatal: bad object HEAD') });
    const e = await refusal(finish.remove('k-1', { unpushed: 1, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([
      422,
      "git couldn't count the work on the branch: fatal: bad object HEAD",
    ]);
    expect(kills()).toEqual([]);
    expect(removals()).toEqual([]);
  });

  it('the project folder is gone: the window is killed and the record forgotten, with no git call', async () => {
    const { finish, log } = del({ project: false });
    await finish.remove('k-1', { unpushed: 0, uncommitted: 0 });
    expect(log).toEqual(['kill @2 k-1', 'stopped k-1', 'forget k-1']);
  });

  it('a listed worktree whose folder is gone: unpushed counted in the repo, worktree remove (no --force)', async () => {
    const { finish, g, log, removals } = del();
    await rm(wt, { recursive: true });
    g.revList = '2\n';
    await finish.remove('k-1', { unpushed: 2, uncommitted: 0 });
    expect(log.filter((l) => l.startsWith('git rev-list'))[0]).toBe(
      'git rev-list --count refs/heads/kage/x --not --exclude=kage/x --branches --remotes --tags',
    );
    expect(log.some((l) => l.startsWith('counts'))).toBe(false);
    expect(removals()).toEqual([
      `git worktree remove -- ${wt}`,
      'git branch -D -- kage/x',
      'forget k-1',
    ]);
  });

  it('an unlisted worktree whose folder is gone: worktree prune, then the branch', async () => {
    const { finish, g, removals } = del();
    await rm(wt, { recursive: true });
    g.list = porcelain([{ path: repo, branch: 'refs/heads/main' }]);
    g.revList = '0\n';
    await finish.remove('k-1', { unpushed: 0, uncommitted: 0 });
    expect(removals()).toEqual(['git worktree prune', 'git branch -D -- kage/x', 'forget k-1']);
  });

  it('a branch that is gone: uncommitted counted in the folder, no branch -D', async () => {
    const { finish, g, removals, log } = del();
    g.branchExists = false;
    g.status = ' M a.txt\0?? b.txt\0';
    await finish.remove('k-1', { unpushed: 0, uncommitted: 2 });
    expect(log.some((l) => l.startsWith('git status'))).toBe(true);
    expect(removals()).toEqual([`git worktree remove --force -- ${wt}`, 'forget k-1']);
  });

  it('no window (ended): no kill, the rest as confirmed', async () => {
    const { finish, removals, kills } = del({
      t: { status: 'ended', windowId: null, paneId: null },
    });
    await finish.remove('k-1', { unpushed: 1, uncommitted: 0 });
    expect(kills()).toEqual([]);
    expect(removals()).toEqual([
      `git worktree remove -- ${wt}`,
      'git branch -D -- kage/x',
      'forget k-1',
    ]);
  });

  it('shares the action lock: held elsewhere → 409, nothing done; unknown id → 404', async () => {
    const lock = new ActionLock();
    const { finish } = setup(target(), lock);
    const release = lock.tryAcquire('k-1');
    expect((await refusal(finish.remove('k-1', { unpushed: 0, uncommitted: 0 }))).status).toBe(409);
    release?.();
    const e = await refusal(finish.remove('nope', { unpushed: 0, uncommitted: 0 }));
    expect([e.status, e.message]).toEqual([404, 'No session with id nope']);
  });
});
