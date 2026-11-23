import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffPage } from '../preview/diff.ts';
import { changedFiles } from '../preview/files.ts';
import { branchCounts, branchState } from './branch.ts';
import { gitExec, UNPINNED, worktreePin } from './exec.ts';

/**
 * Security M4 against real git: a worktree's `.git` file rewritten to a gitdir inside the
 * worktree, whose config names a clean filter, runs nothing; real worktrees pin, including a
 * suffixed admin name and a repo with a separate git dir (F3). Isolated git (host-integration
 * §5): no system or global config, a temp HOME, identity through -c.
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

let n = 0;
/** A repo on main with one commit (optionally with its git dir elsewhere), and an empty base. */
async function newRepo(o: { separate?: boolean } = {}): Promise<string> {
  const dir = join(root, `r${++n}`);
  await mkdir(dir);
  const sep = o.separate ? ['--separate-git-dir', join(root, `gd${n}`)] : [];
  git(dir, 'init', '-q', '-b', 'main', ...sep);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** `<repo>/.worktrees/<name>` on kage/<branch>, with one uncommitted edit. */
async function addWorktree(repo: string, name: string, branch = name): Promise<string> {
  const wt = join(repo, '.worktrees', name);
  git(repo, 'worktree', 'add', '-q', '-b', `kage/${branch}`, wt, 'main');
  await writeFile(join(wt, 'a.txt'), 'one\ntwo\n');
  return wt;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kage-pin-int-')));
  home = await mkdtemp(join(tmpdir(), 'kage-home-'));
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
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

describe.runIf(hasGit && process.platform !== 'win32')('git pinned to the record (M4)', () => {
  it("worktreePin finds the worktree's gitdir for a real worktree", async () => {
    const repo = await newRepo();
    const wt = await addWorktree(repo, 'x');
    const pin = await worktreePin(repo, wt);
    expect(pin).toEqual({ gitDir: join(repo, '.git', 'worktrees', 'x'), workTree: wt });
    // The pinned run sees the edit, as before.
    const r = await changedFiles(wt, 'main', gitExec, { repo });
    expect(r).toEqual({ files: [{ path: 'a.txt', added: 1, removed: 0 }], total: 1 });
  });

  it('a .git file rewritten to a gitdir inside the worktree, with a clean filter, runs nothing: the pin is refused', async () => {
    const repo = await newRepo();
    const wt = await addWorktree(repo, 'evil');
    const admin = join(repo, '.git', 'worktrees', 'evil');
    const marker = join(root, 'pwned');
    const sha = git(repo, 'rev-parse', 'main').trim();
    // The crafted gitdir, written with file edits only: its own HEAD, refs and config (a clean
    // filter), the real objects through alternates, and a copy of the real index.
    const evil = join(wt, 'evil');
    await mkdir(join(evil, 'refs', 'heads', 'kage'), { recursive: true });
    await mkdir(join(evil, 'objects', 'info'), { recursive: true });
    await writeFile(join(evil, 'HEAD'), 'ref: refs/heads/kage/evil\n');
    await writeFile(join(evil, 'refs', 'heads', 'main'), `${sha}\n`);
    await writeFile(join(evil, 'refs', 'heads', 'kage', 'evil'), `${sha}\n`);
    await writeFile(
      join(evil, 'objects', 'info', 'alternates'),
      `${join(repo, '.git', 'objects')}\n`,
    );
    execFileSync('cp', [join(admin, 'index'), join(evil, 'index')]);
    await writeFile(
      join(evil, 'config'),
      `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = touch ${marker}\n`,
    );
    await writeFile(join(wt, '.gitattributes'), '* filter=x\n');
    await writeFile(join(wt, '.git'), `gitdir: ${evil}\n`);

    // Control: the unpinned list (what Kage ran before) runs the filter, so the attack is real.
    await changedFiles(wt, 'main', gitExec);
    expect(existsSync(marker)).toBe(true);
    await rm(marker);

    // As the tracker calls it: the note, no list, and no filter run.
    expect(await worktreePin(repo, wt)).toBeNull();
    expect(await changedFiles(wt, 'main', gitExec, { repo })).toEqual({
      files: [],
      total: 0,
      note: UNPINNED,
    });
    await expect(branchCounts(wt, 'kage/evil', gitExec, repo)).rejects.toThrow(UNPINNED);
    await expect(
      branchState(wt, { branch: 'kage/evil', base: 'main', baseCommit: null, repo }, gitExec),
    ).rejects.toThrow(UNPINNED);
    await expect(
      diffPage({ worktree: wt, base: 'main', branch: 'kage/evil', repo }, 0),
    ).rejects.toThrow(UNPINNED);
    expect(existsSync(marker)).toBe(false);
  });

  it('a worktree whose admin dir has a suffix (its name taken by an unpruned one) pins', async () => {
    const repo = await newRepo();
    // An older worktree named x elsewhere, whose folder went without `worktree prune`: git keeps
    // worktrees/x, so the next x gets a suffixed admin dir. (git refuses the same path again.)
    const first = join(repo, 'old', 'x');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/x-old', first, 'main');
    await rm(first, { recursive: true, force: true });
    const wt = await addWorktree(repo, 'x', 'x');
    const pin = await worktreePin(repo, wt);
    expect(pin?.gitDir).toMatch(/[/\\]worktrees[/\\]x\d+$/);
    expect(pin?.workTree).toBe(wt);
    expect((await changedFiles(wt, 'main', gitExec, { repo })).total).toBe(1);
    expect(await branchCounts(wt, 'kage/x', gitExec, repo)).toEqual({
      unpushed: 0,
      uncommitted: 1,
      ignored: 0,
    });
  });

  it('a repo with a separate git dir pins its worktrees', async () => {
    const repo = await newRepo({ separate: true });
    const wt = await addWorktree(repo, 'y');
    const pin = await worktreePin(repo, wt);
    expect(pin).toEqual({ gitDir: join(root, `gd${n}`, 'worktrees', 'y'), workTree: wt });
    expect((await changedFiles(wt, 'main', gitExec, { repo })).files).toEqual([
      { path: 'a.txt', added: 1, removed: 0 },
    ]);
    const page = await diffPage({ worktree: wt, base: 'main', branch: 'kage/y', repo }, 0);
    expect(page.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('the main checkout is no worktree of its own repo: pinning it is refused', async () => {
    const repo = await newRepo();
    expect(await worktreePin(repo, repo)).toBeNull();
  });
});
