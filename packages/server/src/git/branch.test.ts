import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  branchCounts,
  branchState,
  isMerged,
  SAFE_REF,
  uncommittedCount,
  unpushedCount,
} from './branch.ts';
import type { GitExec } from './exec.ts';

/** Temp-repo tests run many git commands; on a loaded Windows machine that can pass 5 s. */
const REPO_TESTS = { timeout: 30_000 };

let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

let n = 0;
/**
 * A repo on main (base.txt, f.txt) with a local bare remote `origin` holding main, and branch
 * kage/x cut from main. Returns the repo and the branch's base commit.
 */
async function repo(): Promise<{ dir: string; base: string }> {
  const dir = join(root, `r${++n}`);
  const remote = join(root, `r${n}-remote.git`);
  await mkdir(dir);
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await writeFile(join(dir, 'f.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'branch', 'kage/x');
  return { dir, base: git(dir, 'rev-parse', 'main').trim() };
}

/** Two commits on kage/x (new files), back on main afterwards. */
async function twoCommits(dir: string): Promise<void> {
  git(dir, 'checkout', '-q', 'kage/x');
  await writeFile(join(dir, 'x1.txt'), 'x1\n');
  git(dir, 'add', 'x1.txt');
  git(dir, 'commit', '-q', '-m', 'x1');
  await writeFile(join(dir, 'x2.txt'), 'x2\n');
  git(dir, 'add', 'x2.txt');
  git(dir, 'commit', '-q', '-m', 'x2');
  git(dir, 'checkout', '-q', 'main');
}

/** main moves on with another file, so a merge of kage/x isn't a fast-forward. */
async function mainMoves(dir: string): Promise<void> {
  await writeFile(join(dir, 'other.txt'), 'other\n');
  git(dir, 'add', 'other.txt');
  git(dir, 'commit', '-q', '-m', 'main moves');
}

const merged = (dir: string, base: string) =>
  isMerged(dir, { branch: 'kage/x', base: 'main', baseCommit: base });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kage-branch-'));
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
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** A fake git that records every call and fails the test if it is called at all. */
function noGit(): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (args) => {
      calls.push(args);
      throw new Error('git must not run');
    },
  };
}

describe('SAFE_REF', () => {
  it('takes plain branch names and refuses option-like, range-like and malformed ones', () => {
    for (const ok of ['main', 'kage/fix-the-cart-total', 'release/1.2', 'a_b', 'v1.0']) {
      expect(SAFE_REF.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '-x',
      '--all',
      'a..b',
      'main@{1}',
      'HEAD@{u}',
      '.hidden',
      'kage/.x',
      'x.lock',
      'kage/x.lock/y',
      '/x',
      'x/',
      'a//b',
      'x.',
      'a b',
      'a:b',
      'a~1',
      'a^',
      'a*',
      'x'.repeat(201),
    ]) {
      expect(SAFE_REF.test(bad), bad).toBe(false);
    }
  });
});

describe('unpushedCount', REPO_TESTS, () => {
  it('counts commits only this branch reaches: 2, then 0 after push, 0 after a merge', async () => {
    const { dir } = await repo();
    await twoCommits(dir);
    expect(await unpushedCount(dir, 'kage/x')).toBe(2);
    git(dir, 'push', '-q', 'origin', 'kage/x');
    expect(await unpushedCount(dir, 'kage/x')).toBe(0);
    git(dir, 'push', '-q', 'origin', '--delete', 'kage/x');
    git(dir, 'fetch', '-q', '--prune', 'origin');
    expect(await unpushedCount(dir, 'kage/x')).toBe(2);
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'kage/x');
    expect(await unpushedCount(dir, 'kage/x')).toBe(0);
  });

  it('a commit also on another branch is not counted', async () => {
    const { dir } = await repo();
    await twoCommits(dir);
    git(dir, 'branch', 'other', 'kage/x~1');
    expect(await unpushedCount(dir, 'kage/x')).toBe(1);
  });

  it('a branch named -x is refused by SAFE_REF with no git call', async () => {
    const g = noGit();
    expect(await unpushedCount('/nowhere', '-x', g.exec)).toBe(0);
    expect(g.calls).toEqual([]);
  });
});

describe('uncommittedCount', REPO_TESTS, () => {
  it('one modified, one staged and one untracked file count; an ignored one does not', async () => {
    const { dir } = await repo();
    await writeFile(join(dir, '.git', 'info', 'exclude'), 'ignored.log\n');
    await writeFile(join(dir, 'f.txt'), 'changed\n');
    await writeFile(join(dir, 'staged.txt'), 'staged\n');
    git(dir, 'add', 'staged.txt');
    await writeFile(join(dir, 'untracked.txt'), 'u\n');
    await writeFile(join(dir, 'ignored.log'), 'i\n');
    expect(await uncommittedCount(dir)).toBe(3);
  });

  it('a staged rename counts once (its old path is an extra field, not a record)', async () => {
    const { dir } = await repo();
    git(dir, 'mv', 'base.txt', 'renamed.txt');
    expect(await uncommittedCount(dir)).toBe(1);
  });

  it('a clean worktree counts 0', async () => {
    const { dir } = await repo();
    expect(await uncommittedCount(dir)).toBe(0);
  });
});

describe('isMerged', REPO_TESTS, () => {
  it('false with no commits past baseCommit (the tip is trivially an ancestor)', async () => {
    const { dir, base } = await repo();
    expect(await merged(dir, base)).toBe(false);
  });

  it('false for a branch that is not merged', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    await mainMoves(dir);
    expect(await merged(dir, base)).toBe(false);
  });

  it('true after a fast-forward merge', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    git(dir, 'merge', '-q', '--ff-only', 'kage/x');
    expect(await merged(dir, base)).toBe(true);
  });

  it('true after a --no-ff merge', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    await mainMoves(dir);
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'kage/x');
    expect(await merged(dir, base)).toBe(true);
  });

  it('true after a squash merge, also when main then changes another file', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    await mainMoves(dir);
    git(dir, 'merge', '-q', '--squash', 'kage/x');
    git(dir, 'commit', '-q', '-m', 'squash');
    expect(await merged(dir, base)).toBe(true);
    await writeFile(join(dir, 'later.txt'), 'later\n');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', 'later');
    expect(await merged(dir, base)).toBe(true);
  });

  it('false when main changes the same file after a squash merge', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    git(dir, 'merge', '-q', '--squash', 'kage/x');
    git(dir, 'commit', '-q', '-m', 'squash');
    await writeFile(join(dir, 'x1.txt'), 'x1 changed on main\n');
    git(dir, 'commit', '-q', '-am', 'main edits x1');
    expect(await merged(dir, base)).toBe(false);
  });

  it('true after a rebase merge (copies of the commits on main)', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    await mainMoves(dir);
    git(dir, 'cherry-pick', 'kage/x~1', 'kage/x');
    expect(await merged(dir, base)).toBe(true);
  });

  it('true when only origin/main holds the merge (the local main is behind)', async () => {
    const { dir, base } = await repo();
    await twoCommits(dir);
    await mainMoves(dir);
    git(dir, 'merge', '-q', '--squash', 'kage/x');
    git(dir, 'commit', '-q', '-m', 'squash');
    git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await merged(dir, base)).toBe(true);
    // Without the remote ref, the local main alone doesn't hold it.
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(await merged(dir, base)).toBe(false);
  });

  it('false for a conflicting branch', async () => {
    const { dir, base } = await repo();
    git(dir, 'checkout', '-q', 'kage/x');
    await writeFile(join(dir, 'f.txt'), 'one\nBRANCH\nthree\nfour\nfive\n');
    git(dir, 'commit', '-q', '-am', 'branch edits line 2');
    git(dir, 'checkout', '-q', 'main');
    await writeFile(join(dir, 'f.txt'), 'one\nMAIN\nthree\nfour\nfive\n');
    git(dir, 'commit', '-q', '-am', 'main edits line 2');
    expect(await merged(dir, base)).toBe(false);
  });

  it('false when baseCommit or base is null, or a name fails SAFE_REF, with no git call', async () => {
    const g = noGit();
    const sha = 'a'.repeat(40);
    expect(await isMerged('/r', { branch: 'kage/x', base: 'main', baseCommit: null }, g.exec)).toBe(
      false,
    );
    expect(await isMerged('/r', { branch: 'kage/x', base: null, baseCommit: sha }, g.exec)).toBe(
      false,
    );
    expect(await isMerged('/r', { branch: '-x', base: 'main', baseCommit: sha }, g.exec)).toBe(
      false,
    );
    expect(await isMerged('/r', { branch: 'kage/x', base: 'a..b', baseCommit: sha }, g.exec)).toBe(
      false,
    );
    expect(
      await isMerged('/r', { branch: 'kage/x', base: 'main', baseCommit: '--all' }, g.exec),
    ).toBe(false);
    expect(g.calls).toEqual([]);
  });

  it('a failing git fails closed to "not merged"', async () => {
    const exec: GitExec = async () => {
      throw Object.assign(new Error('timed out'), { code: null, killed: true });
    };
    expect(
      await isMerged('/r', { branch: 'kage/x', base: 'main', baseCommit: 'a'.repeat(40) }, exec),
    ).toBe(false);
  });
});

describe(
  'F7: a hostile repo (merge driver, textconv, ext-diff) runs none of them',
  REPO_TESTS,
  () => {
    it('isMerged and branchState write no marker; the same config is live for plain git', async () => {
      const { dir } = await repo();
      const marks = join(root, `marks-${n}`);
      await mkdir(marks);
      const m = (name: string) => join(marks, name).replaceAll('\\', '/');
      git(dir, 'config', 'merge.evil.driver', `echo ran >> '${m('merge-driver')}'; false`);
      git(dir, 'config', 'diff.evil.textconv', `echo ran >> '${m('textconv')}'; cat`);
      git(dir, 'config', 'diff.evil.command', `echo ran >> '${m('ext-diff')}'; true`);
      await writeFile(join(dir, '.gitattributes'), '* merge=evil diff=evil\n');
      git(dir, 'add', '.gitattributes');
      git(dir, 'commit', '-q', '-m', 'attributes');
      git(dir, 'branch', '-f', 'kage/x', 'main');
      const cut = git(dir, 'rev-parse', 'main').trim();
      // Both sides change f.txt on different lines, so a content merge would run the driver.
      git(dir, 'checkout', '-q', 'kage/x');
      await writeFile(join(dir, 'f.txt'), 'one\nBRANCH\nthree\nfour\nfive\n');
      git(dir, 'commit', '-q', '-am', 'branch');
      git(dir, 'checkout', '-q', 'main');
      await writeFile(join(dir, 'f.txt'), 'one\ntwo\nthree\nfour\nMAIN\n');
      git(dir, 'commit', '-q', '-am', 'main');
      await writeFile(join(dir, 'f.txt'), 'one\ntwo\nthree\nfour\nMAIN dirty\n');

      expect(await merged(dir, cut)).toBe(false);
      expect(await branchState(dir, { branch: 'kage/x', base: 'main', baseCommit: cut })).toEqual({
        unpushed: 1,
        uncommitted: 1,
        merged: false,
      });
      expect(existsSync(m('merge-driver'))).toBe(false);
      expect(existsSync(m('textconv'))).toBe(false);
      expect(existsSync(m('ext-diff'))).toBe(false);

      // Controls: the configured programs are live in this repo for git without Kage's flags.
      git(dir, 'diff', 'kage/x', 'main');
      expect(existsSync(m('ext-diff'))).toBe(true);
      git(dir, 'diff', '--no-ext-diff', 'kage/x', 'main');
      expect(existsSync(m('textconv'))).toBe(true);
      try {
        git(dir, 'merge-tree', '--write-tree', 'refs/heads/main', 'kage/x');
      } catch {
        // The driver exits 1: a conflict.
      }
      expect(existsSync(m('merge-driver'))).toBe(true);
    });
  },
);

describe('branchState', () => {
  it('runs its three parts in parallel, with the exact arguments (fsmonitor is gitExec’s)', async () => {
    const sha = 'b'.repeat(40);
    const calls: { args: string[]; cwd: string | undefined }[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exec: GitExec = async (args, opts) => {
      calls.push({ args, cwd: opts?.cwd });
      await gate;
      const a = args.join(' ');
      if (a.startsWith('rev-list --count refs/heads/kage/x --not --exclude')) {
        return { stdout: '3\n', stderr: '' };
      }
      if (a.startsWith('status')) return { stdout: ' M a.txt\0?? b.txt\0', stderr: '' };
      if (a === `rev-list --count refs/heads/kage/x ^${sha}`) return { stdout: '3\n', stderr: '' };
      if (a.startsWith('diff --no-ext-diff')) return { stdout: 'a.txt\0b c.txt\0', stderr: '' };
      if (a.startsWith('merge-base')) throw Object.assign(new Error('no'), { code: 1 });
      if (a.includes('diff --quiet') && a.includes('refs/heads/main'))
        throw Object.assign(new Error('differ'), { code: 1 });
      if (a.includes('diff --quiet')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected git ${a}`);
    };
    const p = branchState('/w/x', { branch: 'kage/x', base: 'main', baseCommit: sha }, exec);
    await new Promise((r) => setTimeout(r, 0));
    // All three parts started before any finished.
    expect(calls.map((c) => c.args[0])).toEqual(['rev-list', 'status', 'rev-list']);
    release();
    expect(await p).toEqual({ unpushed: 3, uncommitted: 2, merged: true });
    expect(calls).toEqual([
      {
        args: [
          'rev-list',
          '--count',
          'refs/heads/kage/x',
          '--not',
          '--exclude=kage/x',
          '--branches',
          '--remotes',
          '--tags',
        ],
        cwd: '/w/x',
      },
      { args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], cwd: '/w/x' },
      { args: ['rev-list', '--count', 'refs/heads/kage/x', `^${sha}`], cwd: '/w/x' },
      {
        args: [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          sha,
          'refs/heads/kage/x',
        ],
        cwd: '/w/x',
      },
      {
        args: ['merge-base', '--is-ancestor', 'refs/heads/kage/x', 'refs/heads/main'],
        cwd: '/w/x',
      },
      {
        args: [
          '--literal-pathspecs',
          'diff',
          '--quiet',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          'refs/heads/kage/x',
          'refs/heads/main',
          '--',
          'a.txt',
          'b c.txt',
        ],
        cwd: '/w/x',
      },
      {
        args: ['merge-base', '--is-ancestor', 'refs/heads/kage/x', 'refs/remotes/origin/main'],
        cwd: '/w/x',
      },
      {
        args: [
          '--literal-pathspecs',
          'diff',
          '--quiet',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          'refs/heads/kage/x',
          'refs/remotes/origin/main',
          '--',
          'a.txt',
          'b c.txt',
        ],
        cwd: '/w/x',
      },
    ]);
  });

  it('a branch failing SAFE_REF gives counts 0 and merged false with no git call', async () => {
    const g = noGit();
    expect(
      await branchState('/w', { branch: '-x', base: 'main', baseCommit: 'c'.repeat(40) }, g.exec),
    ).toEqual({ unpushed: 0, uncommitted: 0, merged: false });
    expect(await branchCounts('/w', '-x', g.exec)).toEqual({ unpushed: 0, uncommitted: 0 });
    expect(g.calls).toEqual([]);
  });

  it('a failed count rejects (callers keep their last value); merged alone fails closed', async () => {
    const exec: GitExec = async (args) => {
      if (args[0] === 'status') throw new Error('timed out');
      return { stdout: '0\n', stderr: '' };
    };
    await expect(branchCounts('/w', 'kage/x', exec)).rejects.toThrow('timed out');
  });
});
