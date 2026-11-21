import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { NewTaskBody } from '@kage/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type GitExec, gitExec } from '../git/exec.ts';
import type { SessionRecord } from '../state/store.ts';
import type { TmuxWindow } from '../tmux/format.ts';
import {
  claudeArgv,
  LaunchError,
  type LauncherDeps,
  resolveClaude,
  TaskLauncher,
} from './launcher.ts';

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
const hasBranch = (repo: string, branch: string): boolean => {
  try {
    git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
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
  await rm(home, { recursive: true, force: true });
});

let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kage-launch-'));
  repo = join(root, 'shop');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'branch', 'develop');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class FakeTmux {
  calls: Parameters<LauncherDeps['tmux']['newWindow']>[0][] = [];
  fail: Error | null = null;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  /** The kage session's windows, as listWindows shows them. */
  windows: { windowId: string; name: string; kageId: string | null }[] = [];
  /** A window that new-window leaves behind before it fails (a timeout after tmux opened it). */
  strayOnFail: { windowId: string; kageId: string | null } | null = null;
  /** Whether the worktree folder still existed when each kill ran. */
  worktreeAtKill: boolean[] = [];
  async newWindow(o: Parameters<LauncherDeps['tmux']['newWindow']>[0]) {
    this.log.push('newWindow');
    this.calls.push(o);
    if (this.fail) {
      if (this.strayOnFail) this.windows.push({ ...this.strayOnFail, name: o.name });
      throw this.fail;
    }
    return { windowId: `@${6 + this.calls.length}`, paneId: `%${6 + this.calls.length}` };
  }
  async listWindows() {
    return this.windows.map((w) => ({ ...w })) as unknown as TmuxWindow[];
  }
  async killUntaggedWindow(windowId: string) {
    this.log.push(`kill-untagged ${windowId}`);
    this.worktreeAtKill.push(existsSync(this.calls.at(-1)?.cwd ?? ''));
    const w = this.windows.find((x) => x.windowId === windowId);
    if (!w || w.kageId !== null) return false;
    this.windows = this.windows.filter((x) => x !== w);
    return true;
  }
  async killOwnedWindow(windowId: string, kageId: string) {
    this.log.push(`kill-owned ${windowId}`);
    this.worktreeAtKill.push(existsSync(this.calls.at(-1)?.cwd ?? ''));
    const w = this.windows.find((x) => x.windowId === windowId);
    if (!w || w.kageId !== kageId) return false;
    this.windows = this.windows.filter((x) => x !== w);
    return true;
  }
}

class FakeSource {
  records: SessionRecord[] = [];
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  async adopt(r: SessionRecord): Promise<void> {
    this.log.push('adopt');
    this.records.push(r);
  }
  claim(kageId: string, windowId: string): void {
    this.log.push(`claim ${kageId} ${windowId}`);
  }
  async abandon(kageId: string): Promise<void> {
    this.log.push(`abandon ${kageId}`);
    this.records = this.records.filter((r) => r.kageId !== kageId);
  }
  branchTaken(project: string, branch: string): boolean {
    return this.records.some((r) => r.project === project && r.branch === branch);
  }
}

function setup(over: Partial<LauncherDeps> = {}) {
  const log: string[] = [];
  const tmux = new FakeTmux(log);
  const source = new FakeSource(log);
  const gitCalls: string[][] = [];
  const spy: GitExec = (args, opts) => {
    gitCalls.push(args);
    return gitExec(args, opts);
  };
  let n = 0;
  const launcher = new TaskLauncher({
    projectsRoot: root,
    worktreeDir: '.worktrees',
    branchPrefix: 'kage/',
    git: spy,
    tmux,
    source,
    claudeBin: '/opt/claude/bin/claude',
    settingsPath: '/state/kage/claude-settings.json',
    hookSocket: '/run/kage/hook.sock',
    windowPath: '/usr/local/bin:/usr/bin',
    newId: () => `k-${++n}`,
    now: () => 1_800_000_000_000,
    ...over,
  });
  return { launcher, tmux, source, log, gitCalls };
}

const body = (over: Partial<NewTaskBody> = {}): NewTaskBody => ({
  project: 'shop',
  base: 'main',
  task: 'Fix the cart total',
  acceptEdits: false,
  ...over,
});

async function launchError(p: Promise<unknown>): Promise<LaunchError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LaunchError);
    return e as LaunchError;
  }
  throw new Error('expected a LaunchError');
}

describe('claudeArgv', () => {
  it('runs claude with the settings, the permission mode and the task after --', () => {
    expect(claudeArgv('/c', '/s', true, 'x')).toEqual([
      '/c',
      '--settings',
      '/s',
      '--permission-mode',
      'acceptEdits',
      '--',
      'x',
    ]);
    expect(claudeArgv('/c', '/s', false, 'x')).toEqual([
      '/c',
      '--settings',
      '/s',
      '--permission-mode',
      'default',
      '--',
      'x',
    ]);
  });
});

describe('resolveClaude', () => {
  let bin: string;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), 'kage-bin-'));
  });
  afterEach(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  it('prefers KAGE_CLAUDE_BIN', async () => {
    const exe = join(bin, 'my-claude');
    await writeFile(exe, '#!/bin/sh\n');
    await chmod(exe, 0o755);
    expect(await resolveClaude({ KAGE_CLAUDE_BIN: exe, PATH: '' })).toBe(exe);
  });

  it('finds the first claude on PATH, skipping relative entries and folders', async () => {
    const a = join(bin, 'a');
    const b = join(bin, 'b');
    await mkdir(join(a, 'claude'), { recursive: true }); // a folder, not a program
    await mkdir(b);
    await writeFile(join(b, 'claude'), '#!/bin/sh\n');
    await chmod(join(b, 'claude'), 0o755);
    expect(await resolveClaude({ PATH: ['.', a, b].join(delimiter) })).toBe(join(b, 'claude'));
  });

  it('is null when there is none', async () => {
    expect(await resolveClaude({ PATH: bin })).toBeNull();
    expect(await resolveClaude({})).toBeNull();
    expect(await resolveClaude({ KAGE_CLAUDE_BIN: join(bin, 'missing'), PATH: '' })).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('skips a claude that is not executable', async () => {
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n');
    await chmod(join(bin, 'claude'), 0o644);
    expect(await resolveClaude({ PATH: bin })).toBeNull();
  });
});

describe('TaskLauncher', () => {
  it('creates the worktree and branch, adopts the record, opens the window and claims it', async () => {
    const { launcher, tmux, source, log } = setup();
    expect(await launcher.start(body({ acceptEdits: true }))).toEqual({ id: 'k-1' });
    const path = join(repo, '.worktrees', 'fix-the-cart-total');
    expect(existsSync(path)).toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('kage/fix-the-cart-total');
    expect(log).toEqual(['adopt', 'newWindow', 'claim k-1 @7']);
    expect(source.records).toEqual([
      {
        kageId: 'k-1',
        windowId: null,
        project: 'shop',
        task: 'Fix the cart total',
        branch: 'kage/fix-the-cart-total',
        worktree: path,
        createdAt: 1_800_000_000_000,
        pinned: false,
        archived: false,
        sessionId: null,
        transcriptPath: null,
        base: 'main',
        permissionMode: 'acceptEdits',
        baseCommit: null,
        doneAt: null,
        archivedAt: null,
        restoredAt: null,
      },
    ]);
    expect(tmux.calls).toEqual([
      {
        name: 'fix-the-cart-total',
        cwd: path,
        env: { KAGE_SOCKET: '/run/kage/hook.sock', PATH: '/usr/local/bin:/usr/bin' },
        argv: [
          '/opt/claude/bin/claude',
          '--settings',
          '/state/kage/claude-settings.json',
          '--permission-mode',
          'acceptEdits',
          '--',
          'Fix the cart total',
        ],
        kageId: 'k-1',
      },
    ]);
  });

  it('starts from the chosen base branch', async () => {
    git(repo, 'checkout', '-q', 'develop');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'on develop');
    git(repo, 'checkout', '-q', 'main');
    const { launcher, source } = setup();
    await launcher.start(body({ base: 'develop' }));
    const path = join(repo, '.worktrees', 'fix-the-cart-total');
    expect(git(path, 'log', '-1', '--format=%s').trim()).toBe('on develop');
    expect(source.records[0]).toMatchObject({ base: 'develop', permissionMode: 'default' });
  });

  it('adds /.worktrees/ to info/exclude once', async () => {
    const { launcher } = setup();
    await launcher.start(body());
    await launcher.start(body({ task: 'Second task' }));
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === '/.worktrees/')).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('creates info/ when the repo has none, and keeps the last line apart', async () => {
    await rm(join(repo, '.git', 'info'), { recursive: true, force: true });
    const { launcher } = setup();
    await launcher.start(body());
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('/.worktrees/\n');
    await writeFile(join(repo, '.git', 'info', 'exclude'), '*.log');
    await launcher.start(body({ task: 'Again' }));
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '*.log\n/.worktrees/\n',
    );
  });

  it('the worktree exists when the window opens, after the record was adopted', async () => {
    const { launcher, tmux, log } = setup();
    let seen = false;
    const orig = tmux.newWindow.bind(tmux);
    tmux.newWindow = async (o) => {
      seen = existsSync(o.cwd) && log.includes('adopt');
      return orig(o);
    };
    await launcher.start(body());
    expect(seen).toBe(true);
  });

  it('gives two concurrent starts of the same task distinct slugs', async () => {
    const { launcher, tmux } = setup();
    const [a, b] = await Promise.all([launcher.start(body()), launcher.start(body())]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(tmux.calls.map((c) => c.name).sort()).toEqual([
      'fix-the-cart-total',
      'fix-the-cart-total-2',
    ]);
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(true);
    expect(hasBranch(repo, 'kage/fix-the-cart-total-2')).toBe(true);
  });

  it('a branch Kage did not create makes the slug taken, and is never touched', async () => {
    git(repo, 'branch', 'kage/fix-the-cart-total');
    const before = git(repo, 'rev-parse', 'kage/fix-the-cart-total');
    const { launcher, tmux } = setup();
    tmux.fail = new Error('boom');
    await launchError(launcher.start(body()));
    expect(tmux.calls[0]?.name).toBe('fix-the-cart-total-2');
    expect(git(repo, 'rev-parse', 'kage/fix-the-cart-total')).toBe(before);
    expect(hasBranch(repo, 'kage/fix-the-cart-total-2')).toBe(false);
  });

  it('a folder already in the worktree dir, or a record using the branch, makes the slug taken', async () => {
    await mkdir(join(repo, '.worktrees', 'fix-the-cart-total'), { recursive: true });
    const { launcher, source, tmux } = setup();
    source.records.push({
      ...({} as SessionRecord),
      project: 'shop',
      branch: 'kage/fix-the-cart-total-2',
    });
    await launcher.start(body());
    expect(tmux.calls[0]?.name).toBe('fix-the-cart-total-3');
  });

  it('a failed window rolls back the worktree, the branch and the record: 422', async () => {
    const { launcher, tmux, log } = setup();
    tmux.fail = new Error("can't find session: kage\nmore");
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(422);
    expect(err.message).toBe("tmux couldn't open a window: can't find session: kage");
    expect(existsSync(join(repo, '.worktrees', 'fix-the-cart-total'))).toBe(false);
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(false);
    expect(log).toEqual(['adopt', 'newWindow', 'abandon k-1']);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('fix-the-cart-total');
  });

  it('a failed worktree add is a 422 with git’s first line, and nothing is adopted', async () => {
    const failing: GitExec = (args, opts) =>
      args[0] === 'worktree' && args[1] === 'add'
        ? Promise.reject(Object.assign(new Error('x'), { stderr: 'fatal: boom\nmore\n' }))
        : gitExec(args, opts);
    const { launcher, log } = setup({ git: failing });
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(422);
    expect(err.message).toBe("git couldn't create the worktree: fatal: boom");
    expect(log).toEqual([]);
  });

  it('K2: when worktree add created the branch and then failed, that branch is deleted', async () => {
    const failing: GitExec = async (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        // git creates the branch before it finds the path in use (host §1).
        const b = args[args.indexOf('-b') + 1] as string;
        await gitExec(['branch', b, 'main'], opts);
        throw Object.assign(new Error('x'), { stderr: "fatal: '/x' already exists\n" });
      }
      return gitExec(args, opts);
    };
    const { launcher } = setup({ git: failing });
    const err = await launchError(launcher.start(body()));
    expect(err.message).toBe("git couldn't create the worktree: fatal: '/x' already exists");
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(false);
  });

  it('an unknown project or base is a 404, hostile names included', async () => {
    const { launcher, tmux } = setup();
    for (const project of ['nope', '../../etc', 'a/../../b', '$(rm -rf ~)', '..', '']) {
      const err = await launchError(launcher.start(body({ project })));
      expect(err.status).toBe(404);
      expect(err.message).toBe(`No project named "${project}" in ${root}.`);
    }
    for (const base of ['nope', '../../etc', 'a/../../b', '$(rm -rf ~)', '-x', 'HEAD']) {
      const err = await launchError(launcher.start(body({ base })));
      expect(err.status).toBe(404);
      expect(err.message).toBe(`No branch named "${base}" in shop.`);
    }
    expect(tmux.calls).toEqual([]);
  });

  it('an invalid body is a 400 with the validation message', async () => {
    const { launcher } = setup();
    const err = await launchError(launcher.start({ ...body(), task: '-p hi' }));
    expect(err.status).toBe(400);
    expect(err.message).toBe('The task can\'t start with "-".');
    const err2 = await launchError(launcher.start({ ...body(), extra: 1 } as NewTaskBody));
    expect(err2.message).toBe('Unexpected field "extra"');
  });

  it('without claude it is a 503 and runs no git', async () => {
    const { launcher, gitCalls } = setup({ claudeBin: null });
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(503);
    expect(err.message).toBe(
      "Claude Code isn't on Kage's PATH. Install it, or set KAGE_CLAUDE_BIN.",
    );
    expect(gitCalls).toEqual([]);
  });

  it('a worktreeDir that leads outside the repo is refused before git runs worktree add', async () => {
    const { launcher, gitCalls, tmux } = setup({ worktreeDir: '../out' });
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(422);
    expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(false);
    expect(tmux.calls).toEqual([]);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a worktree folder that is a symlink out of the repo is refused',
    async () => {
      const outside = join(root, 'elsewhere');
      await mkdir(outside);
      await symlink(outside, join(repo, '.worktrees'));
      const { launcher, gitCalls } = setup();
      const err = await launchError(launcher.start(body()));
      expect(err.status).toBe(422);
      expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(false);
    },
  );

  it('a hostile task becomes a plain slug and one argv element after --', async () => {
    const { launcher, tmux } = setup();
    await launcher.start(body({ task: '$(rm -rf ~); ../../etc' }));
    const call = tmux.calls[0];
    expect(call?.name).toBe('rm-rf-etc');
    expect(call?.argv.slice(-2)).toEqual(['--', '$(rm -rf ~); ../../etc']);
    expect(call?.argv).not.toContain('--dangerously-skip-permissions');
  });
});

describe('TaskLauncher: hardening (Task 6 review)', () => {
  // Case-insensitive filesystems only (Windows, macOS by default).
  const tmp = tmpdir();
  const caseInsensitive = tmp !== tmp.toUpperCase() && existsSync(tmp.toUpperCase());
  it.runIf(caseInsensitive)(
    'a project named in another case is the same project: one lock, its real name',
    async () => {
      const { launcher, tmux, source } = setup();
      await Promise.all([launcher.start(body()), launcher.start(body({ project: 'SHOP' }))]);
      expect(tmux.calls.map((c) => c.name).sort()).toEqual([
        'fix-the-cart-total',
        'fix-the-cart-total-2',
      ]);
      expect(source.records.map((r) => r.project)).toEqual(['shop', 'shop']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a symlink to the same repo shares its lock',
    async () => {
      await symlink(repo, join(root, 'alias'));
      const { launcher, tmux } = setup();
      const results = await Promise.allSettled([
        launcher.start(body()),
        launcher.start(body({ project: 'alias' })),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(tmux.calls.map((c) => c.name).sort()).toEqual([
        'fix-the-cart-total',
        'fix-the-cart-total-2',
      ]);
    },
  );

  it('K2: a branch git says already existed is never deleted', async () => {
    const racing: GitExec = async (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        // Someone outside Kage made the branch between the slug check and worktree add.
        const b = args[args.indexOf('-b') + 1] as string;
        await gitExec(['branch', b, 'main'], opts);
        throw Object.assign(new Error('x'), {
          stderr: `fatal: a branch named '${b}' already exists\n`,
        });
      }
      return gitExec(args, opts);
    };
    const { launcher } = setup({ git: racing });
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      "git couldn't create the worktree: fatal: a branch named 'kage/fix-the-cart-total' already exists",
    );
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(true);
  });

  it('a failing adopt rolls back the worktree and branch, opens no window, never abandons: 422', async () => {
    const { launcher, source, tmux, log } = setup();
    source.adopt = async () => {
      log.push('adopt');
      throw new Error('disk full');
    };
    const err = await launchError(launcher.start(body()));
    expect(err.status).toBe(422);
    expect(err.message).toBe("Kage couldn't save the session: disk full");
    expect(log).toEqual(['adopt']);
    expect(tmux.calls).toEqual([]);
    expect(existsSync(join(repo, '.worktrees', 'fix-the-cart-total'))).toBe(false);
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(false);
  });

  it('a worktree folder gone before the launch: 422 "The worktree folder is missing.", rolled back', async () => {
    const wt = join(repo, '.worktrees', 'fix-the-cart-total');
    const { launcher, log } = setup({
      git: async (args, opts) => {
        const r = await gitExec(args, opts);
        if (args[0] === 'worktree' && args[1] === 'add') await rm(wt, { recursive: true });
        return r;
      },
    });
    const err = await launchError(launcher.start(body()));
    expect([err.status, err.message]).toEqual([422, 'The worktree folder is missing.']);
    expect(log).toEqual([]);
    expect(hasBranch(repo, 'kage/fix-the-cart-total')).toBe(false);
  });

  it('new-window failing after tmux opened the window (a timeout): the untagged window named after the slug is killed before the worktree goes', async () => {
    const { launcher, tmux, log } = setup();
    // Someone else's untagged window with the same name, there before the launch, stays.
    tmux.windows = [{ windowId: '@3', name: 'fix-the-cart-total', kageId: null }];
    tmux.strayOnFail = { windowId: '@9', kageId: null };
    tmux.fail = new Error('tmux timed out');
    const err = await launchError(launcher.start(body()));
    expect([err.status, err.message]).toEqual([422, "tmux couldn't open a window: tmux timed out"]);
    expect(log).toEqual(['adopt', 'newWindow', 'kill-untagged @9', 'abandon k-1']);
    expect(tmux.worktreeAtKill).toEqual([true]);
    expect(tmux.windows.map((w) => w.windowId)).toEqual(['@3']);
    expect(existsSync(join(repo, '.worktrees', 'fix-the-cart-total'))).toBe(false);
  });

  it('a leftover window tagged with this launch’s id is killed through killOwnedWindow', async () => {
    const { launcher, tmux, log } = setup();
    tmux.strayOnFail = { windowId: '@9', kageId: 'k-1' };
    tmux.fail = new Error('tmux timed out');
    await launchError(launcher.start(body()));
    expect(log).toEqual(['adopt', 'newWindow', 'kill-owned @9', 'abandon k-1']);
    expect(tmux.windows).toEqual([]);
  });

  it('when the listing before the launch failed, a failed new-window kills nothing', async () => {
    const { launcher, tmux, log } = setup();
    // Someone else's window named after the slug: the failed listing never saw it.
    tmux.windows = [{ windowId: '@3', name: 'fix-the-cart-total', kageId: null }];
    tmux.strayOnFail = { windowId: '@9', kageId: null };
    tmux.fail = new Error('tmux timed out');
    let lists = 0;
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => {
      if (lists++ === 0) throw new Error('no server running');
      return list();
    };
    const err = await launchError(launcher.start(body()));
    expect([err.status, err.message]).toEqual([422, "tmux couldn't open a window: tmux timed out"]);
    expect(log).toEqual(['adopt', 'newWindow', 'abandon k-1']);
    expect(tmux.windows.map((w) => w.windowId)).toEqual(['@3', '@9']);
    expect(existsSync(join(repo, '.worktrees', 'fix-the-cart-total'))).toBe(false);
  });

  it('without a PATH in serve, the window env leaves PATH out', async () => {
    const { launcher, tmux } = setup({ windowPath: null });
    await launcher.start(body());
    expect(tmux.calls[0]?.env).toEqual({ KAGE_SOCKET: '/run/kage/hook.sock' });
  });

  it('a nested worktreeDir works when every folder is inside the repo', async () => {
    const { launcher, tmux } = setup({ worktreeDir: 'tmp/trees' });
    await launcher.start(body());
    expect(tmux.calls[0]?.cwd).toBe(join(repo, 'tmp', 'trees', 'fix-the-cart-total'));
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/tmp/trees/\n');
  });

  it.skipIf(process.platform === 'win32')(
    'a nested worktreeDir whose first folder is a symlink out of the repo is refused',
    async () => {
      const outside = join(root, 'elsewhere');
      await mkdir(outside);
      await symlink(outside, join(repo, 'tmp'));
      const { launcher, gitCalls, tmux } = setup({ worktreeDir: 'tmp/trees' });
      const err = await launchError(launcher.start(body()));
      expect(err.status).toBe(422);
      expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(false);
      expect(tmux.calls).toEqual([]);
      expect(existsSync(join(outside, 'trees'))).toBe(false);
    },
  );
});
