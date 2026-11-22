import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStatus } from '@kage/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionError } from '../control/actions.ts';
import { branchCounts } from '../git/branch.ts';
import { gitExec } from '../git/exec.ts';
import type { FinishTarget } from '../live-source.ts';
import { type SessionRecord, StateStore } from '../state/store.ts';
import { hasTmux, TmuxClient } from '../tmux/client.ts';
import { FinishActions, type FinishTmux } from './actions.ts';

/**
 * Delete against a temp repo with real git and the real state file; with tmux (WSL, Linux) the
 * session's window is a real tagged window on a private socket.
 */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const withTmux = hasTmux && process.platform !== 'win32';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** The record's session as FinishActions sees it, saved through the real StateStore. */
class StoreSource {
  readonly store: StateStore;
  records: SessionRecord[] = [];
  windowId: string | null = null;
  paneId: string | null = null;
  status: SessionStatus = 'done';
  published: string[] = [];
  constructor(path: string) {
    this.store = new StateStore(path);
  }
  async add(r: SessionRecord): Promise<void> {
    this.records.push(r);
    await this.store.save(this.records);
  }
  finishTarget(id: string): FinishTarget | null {
    const r = this.records.find((x) => x.kageId === id);
    if (!r) return null;
    return {
      id,
      record: { ...r },
      windowId: this.windowId,
      paneId: this.paneId,
      status: this.status,
      external: false,
    };
  }
  async setFlags(): Promise<void> {}
  markStopped(): void {
    this.status = 'ended';
  }
  async forget(id: string): Promise<void> {
    this.records = this.records.filter((r) => r.kageId !== id);
    await this.store.save(this.records);
  }
}

let tmp: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kage-del-home-'));
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HOME: home,
    USERPROFILE: home,
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

describe.runIf(hasGit)('FinishActions.remove (temp repo, real git, real state file)', () => {
  let root: string;
  let repo: string;
  let wt: string;
  let keepWt: string;
  let source: StoreSource;
  let sock: string;
  let tmuxClient: TmuxClient | null = null;
  const tmux = (...a: string[]) =>
    execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kage-del-int-'));
    root = join(tmp, 'projects');
    repo = join(root, 'shop');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    // A branch and worktree made outside Kage, with work of its own: never touched.
    keepWt = join(repo, '.worktrees', 'keep');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/keep', keepWt, 'main');
    await writeFile(join(keepWt, 'keep.txt'), 'keep\n');
    git(keepWt, 'add', '.');
    git(keepWt, 'commit', '-q', '-m', 'keep');
    await writeFile(join(keepWt, 'dirty.txt'), 'not committed\n');
    // The Kage session: one unpushed commit, a modified file and an untracked file.
    wt = join(repo, '.worktrees', 'x');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/x', wt, 'main');
    await writeFile(join(wt, 'x.txt'), 'x\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'x');
    await writeFile(join(wt, 'a.txt'), 'changed\n');
    await writeFile(join(wt, 'new.txt'), 'untracked\n');

    source = new StoreSource(join(tmp, 'state', 'state.json'));
    await source.add({
      kageId: 'k-1',
      windowId: null,
      project: 'shop',
      task: 'Do x',
      branch: 'kage/x',
      worktree: wt,
      createdAt: 1,
      pinned: false,
      archived: false,
      sessionId: null,
      transcriptPath: null,
      base: 'main',
      permissionMode: 'default',
      baseCommit: null,
      doneAt: 2,
      archivedAt: null,
      restoredAt: null,
      unpinnedAt: null,
    });
    if (withTmux) {
      sock = `kage-test-${randomBytes(4).toString('hex')}`;
      tmuxClient = new TmuxClient({ session: 'kage', socket: sock, configFile: '/dev/null' });
      await tmuxClient.ensureSession();
      const out = tmux(
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_id} #{pane_id}',
        '-t',
        'kage:',
        'sleep',
        '60',
      ).trim();
      const [w, p] = out.split(' ');
      tmux('set-option', '-w', '-t', w as string, '@kage_id', 'k-1');
      source.windowId = w as string;
      source.paneId = p as string;
    }
  });
  afterEach(async () => {
    if (withTmux) {
      try {
        execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  /** A tmux that never runs: without tmux the record has no window. */
  const noTmux: FinishTmux = {
    killOwnedWindow: async () => {
      throw new Error('no window to kill');
    },
    windowKageId: async () => null,
    capturePane: async () => '',
  };

  function actions(): FinishActions {
    return new FinishActions({
      tmux: tmuxClient ?? noTmux,
      source,
      git: gitExec,
      projectsRoot: root,
      worktreeDir: '.worktrees',
      branchPrefix: 'kage/',
      counts: (w, b) => branchCounts(w, b, gitExec),
      publish: (id, p) => source.published.push(`${id} ${JSON.stringify(p)}`),
    });
  }

  const branches = () =>
    git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim().split('\n');
  const savedIds = async () =>
    (JSON.parse(await readFile(source.store.path, 'utf8')) as { records: SessionRecord[] }).records;

  it('an unconfirmed {0, 0} on the dirty worktree touches nothing: 409, and the fresh {1, 2} published', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    let err: unknown = null;
    try {
      await actions().remove('k-1', { unpushed: 0, uncommitted: 0, ignored: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionError);
    expect([(err as ActionError).status, (err as ActionError).message]).toEqual([
      409,
      'The branch changed since you looked. Look again before deleting.',
    ]);
    expect(source.published).toEqual(['k-1 {"unpushed":1,"uncommitted":2,"ignored":0}']);
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
    expect(branches()).toEqual(['feature/keep', 'kage/x', 'main']);
    expect(source.records.map((r) => r.kageId)).toEqual(['k-1']);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    if (withTmux)
      expect(tmux('list-windows', '-a', '-F', '#{window_id}')).toContain(source.windowId);
  });

  it('a confirmed {1, 2} removes the window, the folder and the branch, and the record from the state file; nothing else', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const keepHead = git(keepWt, 'rev-parse', 'HEAD');
    const status = git(repo, 'status', '--porcelain');
    const before = await readFile(source.store.path, 'utf8');
    expect(before).toContain('"k-1"');
    const windowId = source.windowId;

    await actions().remove('k-1', { unpushed: 1, uncommitted: 2, ignored: 0 });

    expect(existsSync(wt)).toBe(false);
    expect(branches()).toEqual(['feature/keep', 'main']);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('/.worktrees/x\n');
    // The main checkout and the outside branch and worktree are untouched.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(git(keepWt, 'rev-parse', 'HEAD')).toBe(keepHead);
    expect(existsSync(join(keepWt, 'dirty.txt'))).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
      'branch refs/heads/feature/keep',
    );
    // The record is gone from the state file.
    expect(await savedIds()).toEqual([]);
    expect(await readFile(source.store.path, 'utf8')).not.toContain('"k-1"');
    if (withTmux) {
      expect(tmux('list-windows', '-a', '-F', '#{window_id}')).not.toContain(`${windowId}\n`);
    }
  });

  it('R73: an ignored .env confirmed as ignored 0 → 409 and nothing removed; confirmed as 1 → deleted', async () => {
    const exclude = join(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude').trim());
    await mkdir(join(exclude, '..'), { recursive: true });
    await writeFile(exclude, '.env\n');
    await writeFile(join(wt, '.env'), 'SECRET=1\n');
    await expect(
      actions().remove('k-1', { unpushed: 1, uncommitted: 2, ignored: 0 }),
    ).rejects.toThrow('The branch changed since you looked. Look again before deleting.');
    expect(source.published).toEqual(['k-1 {"unpushed":1,"uncommitted":2,"ignored":1}']);
    expect(existsSync(join(wt, '.env'))).toBe(true);
    expect(branches()).toContain('kage/x');
    expect(source.records.map((r) => r.kageId)).toEqual(['k-1']);

    await actions().remove('k-1', { unpushed: 1, uncommitted: 2, ignored: 1 });
    expect(existsSync(wt)).toBe(false);
    expect(branches()).toEqual(['feature/keep', 'main']);
    expect(await savedIds()).toEqual([]);
  });
});
