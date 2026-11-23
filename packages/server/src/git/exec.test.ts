import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectStream,
  type GitExec,
  gitArgs,
  gitEnv,
  gitExec,
  gitStream,
  requirePin,
  UNPINNED,
  worktreePin,
} from './exec.ts';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'kage-gitexec-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('gitExec', () => {
  it('turns fsmonitor off on every call, whatever the repo says (a repo hook can run code)', async () => {
    execFileSync('git', ['config', 'core.fsmonitor', 'touch /tmp/kage-pwned'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const { stdout } = await gitExec(['config', '--get', 'core.fsmonitor'], { cwd: repo });
    expect(stdout.trim()).toBe('false');
  });
});

describe('gitArgs and gitEnv (one copy, used by gitExec)', () => {
  it('gitArgs puts fsmonitor off before the caller’s arguments', () => {
    expect(gitArgs(['status', '-z'])).toEqual(['-c', 'core.fsmonitor=false', 'status', '-z']);
  });

  it('gitEnv drops repository pointers and sets no prompt, no optional locks, C locale', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/elsewhere/.git';
    try {
      const env = gitEnv();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe('gitEnv with a pin (security M4)', () => {
  it('gitEnv(pin) sets GIT_DIR and GIT_WORK_TREE and still drops GIT_INDEX_FILE and GIT_COMMON_DIR', () => {
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const;
    const before = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = `/elsewhere/${k}`;
    try {
      const env = gitEnv({ gitDir: '/r/.git/worktrees/x1', workTree: '/r/.worktrees/x' });
      expect(env.GIT_DIR).toBe('/r/.git/worktrees/x1');
      expect(env.GIT_WORK_TREE).toBe('/r/.worktrees/x');
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.GIT_COMMON_DIR).toBeUndefined();
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
    } finally {
      keys.forEach((k, i) => {
        const v = before[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });

  it('gitExec runs with the pin: git reports the pinned dir whatever the cwd discovers', async () => {
    // A second repo stands in for a gitdir the cwd would discover; the pin wins.
    const other = await mkdtemp(join(tmpdir(), 'kage-gitexec-other-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'pipe' });
      const { stdout } = await gitExec(['rev-parse', '--absolute-git-dir'], {
        cwd: other,
        pin: { gitDir: join(repo, '.git'), workTree: repo },
      });
      expect(await realpath(stdout.trim())).toBe(await realpath(join(repo, '.git')));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

/**
 * worktreePin's file checks against a hand-made layout (no git: the exec answers rev-parse), so
 * they run on Windows too; pin.int.test.ts runs the same against real git worktrees.
 */
describe('worktreePin (F3: by content, not by name)', () => {
  let root: string;
  let common: string;
  const execFor =
    (dir: string): GitExec =>
    async (args) => {
      if (args.join(' ') === 'rev-parse --git-common-dir')
        return { stdout: `${dir}\n`, stderr: '' };
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
  /** `<root>/repo/.git/worktrees/<admin>` naming `<root>/repo/.worktrees/<name>/.git`, and back. */
  async function layout(name: string, admin: string) {
    const wt = join(root, 'repo', '.worktrees', name);
    const adminDir = join(common, 'worktrees', admin);
    await mkdir(wt, { recursive: true });
    await mkdir(adminDir, { recursive: true });
    await writeFile(join(wt, '.git'), `gitdir: ${adminDir}\n`);
    await writeFile(join(adminDir, 'gitdir'), `${join(wt, '.git')}\n`);
    return { wt, adminDir };
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kage-pin-')));
    common = join(root, 'repo', '.git');
    await mkdir(common, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds an admin folder whose name differs from the worktree (a suffixed x1)', async () => {
    const { wt, adminDir } = await layout('x', 'x1');
    const pin = await worktreePin(join(root, 'repo'), wt, execFor(common));
    expect(pin).toEqual({ gitDir: adminDir, workTree: wt });
  });

  it('a relative gitdir line and a relative gitdir file (worktree.useRelativePaths) still pin', async () => {
    const { wt, adminDir } = await layout('rel', 'rel');
    await writeFile(join(wt, '.git'), 'gitdir: ../../.git/worktrees/rel\n');
    await writeFile(join(adminDir, 'gitdir'), '../../../.worktrees/rel/.git\n');
    expect(await worktreePin(join(root, 'repo'), wt, execFor(common))).toEqual({
      gitDir: adminDir,
      workTree: wt,
    });
  });

  it('a .git pointing inside the worktree is refused', async () => {
    const { wt } = await layout('x', 'x');
    await mkdir(join(wt, 'evil'));
    await writeFile(join(wt, 'evil', 'gitdir'), `${join(wt, '.git')}\n`);
    await writeFile(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`);
    expect(await worktreePin(join(root, 'repo'), wt, execFor(common))).toBeNull();
  });

  it("a .git pointing at another worktree's admin folder is refused (its gitdir names that one)", async () => {
    const a = await layout('a', 'a');
    const b = await layout('b', 'b');
    await writeFile(join(a.wt, '.git'), `gitdir: ${b.adminDir}\n`);
    expect(await worktreePin(join(root, 'repo'), a.wt, execFor(common))).toBeNull();
  });

  it('a gitdir under worktrees/ but deeper, or a missing .git, or a .git folder is refused', async () => {
    const { wt, adminDir } = await layout('x', 'x');
    const deep = join(adminDir, 'deeper');
    await mkdir(deep);
    await writeFile(join(deep, 'gitdir'), `${join(wt, '.git')}\n`);
    await writeFile(join(wt, '.git'), `gitdir: ${deep}\n`);
    expect(await worktreePin(join(root, 'repo'), wt, execFor(common))).toBeNull();
    await rm(join(wt, '.git'));
    expect(await worktreePin(join(root, 'repo'), wt, execFor(common))).toBeNull();
    await mkdir(join(wt, '.git'));
    expect(await worktreePin(join(root, 'repo'), wt, execFor(common))).toBeNull();
  });

  it('R131: the common dir is asked once per repo; the .git pointer is read on every call', async () => {
    const { wt } = await layout('x', 'x');
    let asked = 0;
    const exec: GitExec = async (args, opts) => {
      asked++;
      return execFor(common)(args, opts);
    };
    const repo = join(root, 'repo');
    expect(await worktreePin(repo, wt, exec)).not.toBeNull();
    expect(await worktreePin(repo, wt, exec)).not.toBeNull();
    expect(asked).toBe(1);
    // A rewrite between two calls is caught at the next one. The refusal asks for the common dir
    // once more (the repo may have moved it), and still refuses.
    await writeFile(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`);
    expect(await worktreePin(repo, wt, exec)).toBeNull();
    expect(asked).toBe(2);
  });

  it('a refusal drops the kept common dir and tries once more uncached (the git dir moved)', async () => {
    const moved = join(root, 'elsewhere.git');
    let dir = common;
    let asked = 0;
    const exec: GitExec = async (args, opts) => {
      asked++;
      return execFor(dir)(args, opts);
    };
    const repo = join(root, 'repo');
    const { wt } = await layout('x', 'x');
    expect(await worktreePin(repo, wt, exec)).not.toBeNull();
    // The git dir moved and `git worktree repair` ran: both pointers lead to the new place.
    const admin = join(moved, 'worktrees', 'x');
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'gitdir'), `${join(wt, '.git')}\n`);
    await writeFile(join(wt, '.git'), `gitdir: ${admin}\n`);
    dir = moved;
    expect(await worktreePin(repo, wt, exec)).toEqual({ gitDir: admin, workTree: wt });
    expect(asked).toBe(2);
    // Kept again: the next call asks nothing.
    expect(await worktreePin(repo, wt, exec)).not.toBeNull();
    expect(asked).toBe(2);
  });

  it('R131: a failed common-dir lookup is not kept', async () => {
    const { wt } = await layout('x', 'x');
    let fail = true;
    const exec: GitExec = async (args, opts) => {
      if (fail) throw new Error('not a git repository');
      return execFor(common)(args, opts);
    };
    const repo = join(root, 'repo');
    await expect(worktreePin(repo, wt, exec)).rejects.toThrow('not a git repository');
    fail = false;
    expect(await worktreePin(repo, wt, exec)).not.toBeNull();
  });

  it('requirePin: no repo is no pin (external); a refusal throws UNPINNED; a gone folder is ENOENT', async () => {
    const { wt } = await layout('x', 'x');
    expect(await requirePin(null, wt, execFor(common))).toBeUndefined();
    await writeFile(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`);
    await expect(requirePin(join(root, 'repo'), wt, execFor(common))).rejects.toThrow(UNPINNED);
    await expect(
      requirePin(join(root, 'repo'), join(root, 'gone'), execFor(common)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('gitStream', () => {
  it('stops at maxBytes: a 10 MiB output with maxBytes 1 MiB resolves clipped', async () => {
    await writeFile(join(repo, 'big.bin'), Buffer.alloc(10 * 1024 * 1024, 0x61));
    const hash = execFileSync('git', ['hash-object', '-w', 'big.bin'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const r = await gitStream(['cat-file', '-p', hash], { cwd: repo, maxBytes: 1024 * 1024 });
    expect(r.clipped).toBe(true);
    expect(r.stdout.length).toBe(1024 * 1024);
  });

  it('a short output resolves whole and unclipped, with gitArgs (fsmonitor off)', async () => {
    execFileSync('git', ['config', 'core.fsmonitor', 'touch /tmp/kage-pwned'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const r = await gitStream(['config', '--get', 'core.fsmonitor'], { cwd: repo, maxBytes: 1024 });
    expect(r).toEqual({ stdout: 'false\n', clipped: false });
  });

  it('rejects with stderr when git fails', async () => {
    await expect(
      gitStream(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo, maxBytes: 1024 }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('fatal') });
  });

  it('kills a child that never stops writing and resolves only once it has exited', async () => {
    // Writes forever, waiting for drain (a synchronous loop would never flush a full pipe on Linux).
    const forever =
      'const b = "x".repeat(65536); const w = () => { while (process.stdout.write(b)); process.stdout.once("drain", w); }; w();';
    const child = spawn(process.execPath, ['-e', forever]);
    const r = await collectStream(child, 256 * 1024, 10_000);
    expect(r).toEqual({ stdout: 'x'.repeat(256 * 1024), clipped: true });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('kills a child past the timeout and rejects', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    await expect(collectStream(child, 1024, 200)).rejects.toThrow(/timed out/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
