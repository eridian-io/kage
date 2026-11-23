import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { NewTaskBody } from '@kage/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type GitExec, type GitPin, gitExec, UNPINNED } from '../git/exec.ts';
import type { FinishTarget } from '../live-source.ts';
import type { SessionRecord } from '../state/store.ts';
import type { TmuxWindow } from '../tmux/format.ts';
import { ActionLock } from './actions.ts';
import {
  claudeArgv,
  LaunchError,
  type LauncherDeps,
  resolveClaude,
  resumeArgv,
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
  claim(kageId: string, windowId: string, paneId: string): void {
    this.log.push(`claim ${kageId} ${windowId} ${paneId}`);
    this.live.add(kageId);
  }
  async abandon(kageId: string): Promise<void> {
    this.log.push(`abandon ${kageId}`);
    this.records = this.records.filter((r) => r.kageId !== kageId);
  }
  branchTaken(project: string, branch: string): boolean {
    return this.records.some((r) => r.project === project && r.branch === branch);
  }
  /** Resume's view of the sessions (finishTarget), by id. */
  targets = new Map<string, FinishTarget>();
  /** Record ids with a live window (hasWindow); a claim adds one. */
  live = new Set<string>();
  finishTarget(id: string): FinishTarget | null {
    const t = this.targets.get(id);
    return t ? { ...t, record: t.record ? { ...t.record } : null } : null;
  }
  resumed(kageId: string, sessionId: string | null): void {
    this.log.push(`resumed ${kageId} ${sessionId}`);
    const t = this.targets.get(kageId);
    if (t) t.status = 'running';
  }
  resumeAborted(kageId: string): void {
    this.log.push(`resumeAborted ${kageId}`);
    const t = this.targets.get(kageId);
    if (t) t.status = 'ended';
  }
  hasWindow(kageId: string): boolean {
    return this.live.has(kageId);
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
    expect(log).toEqual(['adopt', 'newWindow', 'claim k-1 @7 %7']);
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
        baseCommit: git(path, 'rev-parse', 'HEAD').trim(),
        doneAt: null,
        archivedAt: null,
        restoredAt: null,
        unpinnedAt: null,
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

  it('the adopted record holds the worktree’s HEAD as baseCommit (the base at the cut)', async () => {
    git(repo, 'checkout', '-q', 'develop');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'on develop');
    git(repo, 'checkout', '-q', 'main');
    const cut = git(repo, 'rev-parse', 'develop').trim();
    const { launcher, source, gitCalls } = setup();
    await launcher.start(body({ base: 'develop' }));
    expect(source.records[0]?.baseCommit).toBe(cut);
    expect(cut).toMatch(/^[0-9a-f]{40}$/);
    // Read after the worktree exists, from the worktree itself.
    const add = gitCalls.findIndex((c) => c[0] === 'worktree' && c[1] === 'add');
    const rev = gitCalls.findIndex((c) => c.join(' ') === 'rev-parse HEAD');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(rev).toBeGreaterThan(add);
  });

  it('a rev-parse that gives no commit id leaves baseCommit null; the launch goes on', async () => {
    const { launcher, source } = setup({
      git: async (args, opts) =>
        args.join(' ') === 'rev-parse HEAD'
          ? { stdout: 'nonsense\n', stderr: '' }
          : gitExec(args, opts),
    });
    expect(await launcher.start(body())).toEqual({ id: 'k-1' });
    expect(source.records[0]?.baseCommit).toBeNull();
  });

  it('R131: the rev-parse in the new worktree runs pinned to its admin dir', async () => {
    const pins: (GitPin | undefined)[] = [];
    const { launcher, source } = setup({
      git: async (args, opts) => {
        if (args.join(' ') === 'rev-parse HEAD') pins.push(opts?.pin);
        return gitExec(args, opts);
      },
    });
    await launcher.start(body());
    const wt = source.records[0]?.worktree as string;
    expect(pins).toHaveLength(1);
    expect(pins[0]?.workTree).toBe(resolve(wt));
    expect(pins[0]?.gitDir).toMatch(/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/);
    expect(source.records[0]?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('R131: a new worktree whose .git does not pin runs no rev-parse there; baseCommit is null', async () => {
    const revs: string[] = [];
    const { launcher, source } = setup({
      git: async (args, opts) => {
        const r = await gitExec(args, opts);
        if (args[0] === 'worktree' && args[1] === 'add') {
          // Something rewrote the new worktree's .git before the read.
          const wt = args[args.length - 2] as string;
          await rm(join(wt, '.git'));
          await writeFile(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`);
        }
        if (args.join(' ') === 'rev-parse HEAD') revs.push(opts?.cwd ?? '');
        return r;
      },
    });
    expect(await launcher.start(body())).toEqual({ id: 'k-1' });
    expect(revs).toEqual([]);
    expect(source.records[0]?.baseCommit).toBeNull();
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

  it('when the listing before the launch failed, a leftover tagged with this launch’s id is still killed (owned only)', async () => {
    const { launcher, tmux, log } = setup();
    // An untagged window named after the slug stays: the failed listing authorises no untagged kill.
    tmux.windows = [{ windowId: '@3', name: 'fix-the-cart-total', kageId: null }];
    tmux.strayOnFail = { windowId: '@9', kageId: 'k-1' };
    tmux.fail = new Error('tmux timed out');
    let lists = 0;
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => {
      if (lists++ === 0) throw new Error('no server running');
      return list();
    };
    await launchError(launcher.start(body()));
    expect(log).toEqual(['adopt', 'newWindow', 'kill-owned @9', 'abandon k-1']);
    expect(tmux.windows.map((w) => w.windowId)).toEqual(['@3']);
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

describe('resumeArgv (B7)', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('resumes a UUID-shaped session id as its own element after --resume', () => {
    expect(resumeArgv('/c', '/s', 'acceptEdits', ID)).toEqual([
      '/c',
      '--settings',
      '/s',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      ID,
    ]);
  });
  it('falls back to --continue without an id, or with one that is not id-shaped', () => {
    for (const id of [
      null,
      '--x',
      '',
      'abc',
      '../../etc',
      `${ID} --dangerously-skip-permissions`,
    ]) {
      expect(resumeArgv('/c', '/s', 'default', id), String(id)).toEqual([
        '/c',
        '--settings',
        '/s',
        '--permission-mode',
        'default',
        '--continue',
      ]);
    }
  });
});

describe('TaskLauncher.resume (B7)', () => {
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  let wt: string;
  beforeEach(() => {
    wt = join(repo, '.worktrees', 'fix-the-cart-total');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/fix-the-cart-total', '--', wt, 'main');
  });
  const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    kageId: 'k-1',
    windowId: null,
    project: 'shop',
    task: 'Fix the cart total',
    branch: 'kage/fix-the-cart-total',
    worktree: wt,
    createdAt: 1_700_000_000_000,
    pinned: false,
    archived: false,
    sessionId: SID,
    transcriptPath: '/home/dev/.claude/projects/x/s.jsonl',
    base: 'main',
    permissionMode: 'acceptEdits',
    baseCommit: null,
    doneAt: 1_700_000_100_000,
    archivedAt: null,
    restoredAt: null,
    unpinnedAt: null,
    ...over,
  });
  function resumable(
    over: Partial<SessionRecord> = {},
    t: Partial<FinishTarget> = {},
    deps: Partial<LauncherDeps> = {},
  ) {
    const s = setup(deps);
    const r = record(over);
    s.source.targets.set(r.kageId, {
      id: r.kageId,
      record: r,
      windowId: null,
      paneId: null,
      status: 'ended',
      external: false,
      ...t,
    });
    return s;
  }

  it('resumed, then one window in the worktree with the record’s kage id and exact argv, then claim (R101)', async () => {
    const { launcher, tmux, log } = resumable();
    await launcher.resume('k-1');
    expect(tmux.calls).toEqual([
      {
        name: 'fix-the-cart-total',
        cwd: wt,
        env: { KAGE_SOCKET: '/run/kage/hook.sock', PATH: '/usr/local/bin:/usr/bin' },
        argv: [
          '/opt/claude/bin/claude',
          '--settings',
          '/state/kage/claude-settings.json',
          '--permission-mode',
          'acceptEdits',
          '--resume',
          SID,
        ],
        kageId: 'k-1',
      },
    ]);
    // resumed first (R101): a listing that attaches the window must find the resume under way.
    expect(log).toEqual([`resumed k-1 ${SID}`, 'newWindow', 'claim k-1 @7 %7']);
  });

  it('the mode comes from the record; no session id resumes with --continue', async () => {
    const { launcher, tmux } = resumable({ permissionMode: 'default', sessionId: null });
    await launcher.resume('k-1');
    expect(tmux.calls[0]?.argv.slice(3)).toEqual(['--permission-mode', 'default', '--continue']);
  });

  it('an unknown id is 404; an external session 403', async () => {
    const { launcher, tmux } = resumable();
    let err = await launchError(launcher.resume('nope'));
    expect([err.status, err.message]).toEqual([404, 'No session with id nope.']);
    const s = setup();
    s.source.targets.set('ext-@3', {
      id: 'ext-@3',
      record: null,
      windowId: '@3',
      paneId: '%3',
      status: 'ended',
      external: true,
    });
    err = await launchError(s.launcher.resume('ext-@3'));
    expect([err.status, err.message]).toEqual([403, 'Kage only resumes sessions it started.']);
    expect(tmux.calls).toEqual([]);
    expect(s.tmux.calls).toEqual([]);
  });

  it('a session that is not ended is 409, whatever its status', async () => {
    for (const status of ['running', 'needs-you', 'done'] as const) {
      const { launcher, tmux } = resumable({}, { status });
      const err = await launchError(launcher.resume('k-1'));
      expect([err.status, err.message]).toEqual([409, 'This session is still running.']);
      expect(tmux.calls).toEqual([]);
    }
  });

  it('a live window with the record’s kage id is 409', async () => {
    const { launcher, tmux, source } = resumable();
    source.live.add('k-1');
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([409, 'This session already has a window.']);
    expect(tmux.calls).toEqual([]);
  });

  it('an archived session is 409 "Restore the session before resuming it."', async () => {
    const { launcher, tmux } = resumable({ archived: true, archivedAt: 1_700_000_200_000 });
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([409, 'Restore the session before resuming it.']);
    expect(tmux.calls).toEqual([]);
  });

  it('without claude it is a 503 with phase 3’s message, and no tmux call', async () => {
    const { launcher, tmux } = resumable({}, {}, { claudeBin: null });
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      503,
      "Claude Code isn't on Kage's PATH. Install it, or set KAGE_CLAUDE_BIN.",
    ]);
    expect(tmux.calls).toEqual([]);
  });

  it('a missing worktree folder is 409, and nothing opens', async () => {
    const gone = join(repo, '.worktrees', 'gone');
    const { launcher, tmux, log } = resumable({ worktree: gone });
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      409,
      "The worktree is gone, so Kage can't resume this session.",
    ]);
    expect(tmux.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it('a file where the worktree was, or a relative path, is 409 too', async () => {
    const file = join(root, 'a-file');
    await writeFile(file, 'x');
    for (const worktree of [file, '.worktrees/fix-the-cart-total']) {
      const { launcher, tmux } = resumable({ worktree });
      const err = await launchError(launcher.resume('k-1'));
      expect(err.status, worktree).toBe(409);
      expect(tmux.calls).toEqual([]);
    }
  });

  it('a worktree on another branch, or detached, is 409 (R71) and nothing opens', async () => {
    git(wt, 'checkout', '-q', '-b', 'other');
    let s = resumable();
    let err = await launchError(s.launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      409,
      "This worktree isn't on its branch any more. Switch it back in the terminal, or remove it there.",
    ]);
    git(wt, 'checkout', '-q', '--detach');
    s = resumable();
    err = await launchError(s.launcher.resume('k-1'));
    expect(err.status).toBe(409);
    expect(s.tmux.calls).toEqual([]);
  });

  it('a redirected .git is 409 with the refusal (M4): no git in the worktree, nothing opens', async () => {
    await mkdir(join(wt, 'evil'));
    // git hides the .git file on Windows, where writing over a hidden file is refused.
    await rm(join(wt, '.git'));
    await writeFile(join(wt, '.git'), `gitdir: ${join(wt, 'evil')}\n`);
    const s = resumable();
    const err = await launchError(s.launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([409, UNPINNED]);
    expect(s.gitCalls.filter((a) => a[0] === 'symbolic-ref')).toEqual([]);
    expect(s.tmux.calls).toEqual([]);
  });

  it('a tmux failure is 422 with its first line; the resume is aborted, the session ended again, nothing claimed', async () => {
    const { launcher, tmux, source, log } = resumable();
    tmux.fail = new Error('no server running\nmore');
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      422,
      "tmux couldn't open a window: no server running",
    ]);
    expect(log).toEqual([`resumed k-1 ${SID}`, 'newWindow', 'resumeAborted k-1']);
    expect(source.finishTarget('k-1')?.status).toBe('ended');
  });

  it('two concurrent resumes open one window; the second gets 409', async () => {
    const { launcher, tmux } = resumable();
    const results = await Promise.allSettled([launcher.resume('k-1'), launcher.resume('k-1')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LaunchError);
    expect((rejected.reason as LaunchError).status).toBe(409);
    expect(tmux.calls).toHaveLength(1);
  });

  it('shares the action lock (F5, R68): while another action holds it, resume is 409 and opens nothing', async () => {
    const lock = new ActionLock();
    const release = lock.tryAcquire('k-1');
    const { launcher, tmux } = resumable({}, {}, { lock });
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      409,
      'Kage is still finishing the last action on this session.',
    ]);
    expect(tmux.calls).toEqual([]);
    release?.();
    await launcher.resume('k-1');
    expect(tmux.calls).toHaveLength(1);
    // Released after the resume: another action can take the lock again.
    expect(lock.tryAcquire('k-1')).not.toBeNull();
  });
});

describe('resume hardening (Task 7 review)', () => {
  const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('resumeArgv: only a strict UUID (any case) reaches --resume; anything else is --continue', () => {
    expect(resumeArgv('/c', '/s', 'default', SID.toUpperCase()).slice(-2)).toEqual([
      '--resume',
      SID.toUpperCase(),
    ]);
    for (const id of [
      `-${SID.slice(1)}`,
      '--------',
      'deadbeef',
      `${SID}-0`,
      `${SID.slice(0, 8)}${SID.slice(9)}-`,
      `-0f8fad5b-d9cb-469f-a165-70867728950`,
      `${SID}\n`,
      `g${SID.slice(1)}`,
    ]) {
      const argv = resumeArgv('/c', '/s', 'default', id);
      expect(argv.at(-1), JSON.stringify(id)).toBe('--continue');
      expect(argv).not.toContain(id);
    }
  });

  const record = (wt: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
    kageId: 'k-1',
    windowId: null,
    project: 'shop',
    task: 'Fix the cart total',
    branch: 'kage/fix-the-cart-total',
    worktree: wt,
    createdAt: 1_700_000_000_000,
    pinned: false,
    archived: false,
    sessionId: SID,
    transcriptPath: null,
    base: 'main',
    permissionMode: 'default',
    baseCommit: null,
    doneAt: 1,
    archivedAt: null,
    restoredAt: null,
    unpinnedAt: null,
    ...over,
  });
  function resumable(r: SessionRecord) {
    const s = setup();
    s.source.targets.set(r.kageId, {
      id: r.kageId,
      record: r,
      windowId: null,
      paneId: null,
      status: 'ended',
      external: false,
    });
    return s;
  }

  it('resumed gets the id passed to --resume, or null for --continue (a hand-edited id included)', async () => {
    const wt = join(repo, '.worktrees', 'fix-the-cart-total');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/fix-the-cart-total', '--', wt, 'main');
    for (const [sessionId, passed] of [
      [SID, SID],
      [null, null],
      ['--help-0000000', null],
    ] as const) {
      const { launcher, log, tmux } = resumable(record(wt, { sessionId }));
      await launcher.resume('k-1');
      expect(log[0]).toBe(`resumed k-1 ${passed}`);
      expect(tmux.calls[0]?.argv.at(-1)).toBe(passed ?? '--continue');
      expect(tmux.calls[0]?.argv).not.toContain('--help-0000000');
    }
  });

  const notKages = (wt: string) => `Kage won't touch ${wt}: it isn't one of Kage's worktrees.`;

  it('a worktree outside the project’s worktree root is 409 (delete’s sentence), and nothing opens', async () => {
    const wt = join(root, 'elsewhere');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/elsewhere', '--', wt, 'main');
    const { launcher, tmux, log } = resumable(record(wt, { branch: 'kage/elsewhere' }));
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([409, notKages(wt)]);
    expect(tmux.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it('a branch without the configured prefix is 409 (R74), and nothing opens', async () => {
    const wt = join(repo, '.worktrees', 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', '--', wt, 'main');
    const { launcher, tmux } = resumable(record(wt, { branch: 'feature/x' }));
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([409, notKages(wt)]);
    expect(tmux.calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'a worktree path through a symlink out of the worktree root is 409 (realpath)',
    async () => {
      const outside = join(root, 'outside');
      git(repo, 'worktree', 'add', '-q', '-b', 'kage/outside', '--', outside, 'main');
      await mkdir(join(repo, '.worktrees'), { recursive: true });
      const link = join(repo, '.worktrees', 'link');
      await symlink(outside, link);
      const { launcher, tmux } = resumable(record(link, { branch: 'kage/outside' }));
      const err = await launchError(launcher.resume('k-1'));
      expect([err.status, err.message]).toEqual([409, notKages(link)]);
      expect(tmux.calls).toEqual([]);
    },
  );

  it('a record whose project is gone is 409 "The worktree is gone…"', async () => {
    const wt = join(repo, '.worktrees', 'fix-the-cart-total');
    git(repo, 'worktree', 'add', '-q', '-b', 'kage/fix-the-cart-total', '--', wt, 'main');
    const { launcher, tmux } = resumable(record(wt, { project: 'no-such-project' }));
    const err = await launchError(launcher.resume('k-1'));
    expect([err.status, err.message]).toEqual([
      409,
      "The worktree is gone, so Kage can't resume this session.",
    ]);
    expect(tmux.calls).toEqual([]);
  });
});
