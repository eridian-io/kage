import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { branchState } from '../git/branch.ts';
import { AutoArchiver, type AutoCandidate, gitCommonDir } from './auto-archive.ts';

/**
 * Auto-archive against a temp repo: real git, the real branch state and the default fs.watch.
 * fs.watch on the git common dir fires on ext4 and NTFS but not on WSL's /mnt/c
 * (host-integration §5.7); the second test models that with a silent watch.
 */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};
let archiver: AutoArchiver | null = null;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

let n = 0;
/** A repo on main, and branch kage/x with one commit, checked out in its own worktree. */
async function repo(): Promise<AutoCandidate> {
  const dir = join(root, `r${++n}`);
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const baseCommit = git(dir, 'rev-parse', 'main').trim();
  const wt = join(dir, '.worktrees', 'x');
  git(dir, 'worktree', 'add', '-q', '-b', 'kage/x', wt, 'main');
  await writeFile(join(wt, 'x.txt'), 'x\n');
  git(wt, 'add', 'x.txt');
  git(wt, 'commit', '-q', '-m', 'x');
  // main moves on, so a --no-ff merge is a real merge.
  await writeFile(join(dir, 'other.txt'), 'other\n');
  git(dir, 'add', 'other.txt');
  git(dir, 'commit', '-q', '-m', 'main moves');
  return {
    id: `k-${n}`,
    repo: dir,
    worktree: wt,
    branch: 'kage/x',
    base: 'main',
    baseCommit,
    doneAt: Date.now(),
  };
}

/** Waits on the monotonic clock: WSL's wall clock can jump seconds under load. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kage-auto-'));
  home = await mkdtemp(join(tmpdir(), 'kage-home-'));
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
afterEach(() => {
  archiver?.stop();
  archiver = null;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe.runIf(hasGit)('AutoArchiver (temp repo, real git)', () => {
  it('a merge with --no-ff in the main checkout archives the done session within 10 s, by the git-dir watch alone', async () => {
    const c = await repo();
    const archived: string[] = [];
    let checks = 0;
    const logs: string[] = [];
    archiver = new AutoArchiver({
      // afterDays 0: no deadline timer at all; only the watch can find the merge.
      config: { onMerge: true, afterDays: 0 },
      candidates: () => (archived.includes(c.id) ? [] : [c]),
      state: async (x) => {
        const s = await branchState(x.worktree, x);
        checks++; // counted once the check has its answer
        return s;
      },
      archive: async (id) => {
        archived.push(id);
      },
      gitDir: (r) => gitCommonDir(r),
      log: (l) => logs.push(l),
    });
    archiver.start();
    // The start pass: not merged yet.
    expect(await until(() => checks === 1, 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(archived).toEqual([]);
    const mergedAt = performance.now();
    git(c.repo, 'merge', '-q', '--no-ff', '-m', 'merge x', 'kage/x');
    expect(await until(() => archived.length > 0, 10_000)).toBe(true);
    expect(performance.now() - mergedAt).toBeLessThan(10_000);
    expect(archived).toEqual([c.id]);
    expect(logs).toEqual([]);
  }, 30_000);

  it('a squash merge where fs.watch is silent (/mnt/c) is archived after the next touch', async () => {
    const c = await repo();
    const archived: string[] = [];
    let checks = 0;
    archiver = new AutoArchiver({
      config: { onMerge: true, afterDays: 0 },
      candidates: () => (archived.includes(c.id) ? [] : [c]),
      state: async (x) => {
        const s = await branchState(x.worktree, x);
        checks++; // counted once the check has its answer
        return s;
      },
      archive: async (id) => {
        archived.push(id);
      },
      gitDir: (r) => gitCommonDir(r),
      watch: () => ({ close() {} }),
    });
    archiver.start();
    expect(await until(() => checks === 1, 10_000)).toBe(true);
    git(c.repo, 'merge', '-q', '--squash', 'kage/x');
    git(c.repo, 'commit', '-q', '-m', 'squash x');
    await new Promise((r) => setTimeout(r, 1000));
    expect(archived).toEqual([]);
    archiver.touch(c.id);
    expect(await until(() => archived.length > 0, 10_000)).toBe(true);
    expect(archived).toEqual([c.id]);
  }, 30_000);

  it('merged, but the worktree has an uncommitted file: not archived (work continues)', async () => {
    const c = await repo();
    git(c.repo, 'merge', '-q', '--no-ff', '-m', 'merge x', 'kage/x');
    await writeFile(join(c.worktree, 'wip.txt'), 'wip\n');
    const archived: string[] = [];
    let checks = 0;
    archiver = new AutoArchiver({
      config: { onMerge: true, afterDays: 0 },
      candidates: () => [c],
      state: async (x) => {
        const s = await branchState(x.worktree, x);
        checks++; // counted once the check has its answer
        return s;
      },
      archive: async (id) => {
        archived.push(id);
      },
      gitDir: (r) => gitCommonDir(r),
      watch: () => ({ close() {} }),
    });
    archiver.start();
    expect(await until(() => checks === 1, 10_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(archived).toEqual([]);
  }, 30_000);

  it('gitCommonDir of a worktree and of the main checkout is the same absolute dir', async () => {
    const c = await repo();
    const a = await gitCommonDir(c.repo);
    const b = await gitCommonDir(c.worktree);
    expect(a).toBe(join(c.repo, '.git'));
    expect(b.replaceAll('\\', '/').toLowerCase()).toBe(a.replaceAll('\\', '/').toLowerCase());
  });
});
