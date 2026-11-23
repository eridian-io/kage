import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../main.ts';
import type { Prompter } from './prompt.ts';
import type { Run } from './run.ts';
import type { RunMode } from './runtime.ts';
import type { ServiceManager } from './service.ts';
import { systemdManager, UNIT_MARKER_LINE } from './systemd.ts';
import { type UninstallDeps, uninstallCommand } from './uninstall.ts';

let home: string;
let env: NodeJS.ProcessEnv;
let calls: string[][];
let exe: string;
let project: string;
let unit: string;

const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  HOME: home,
  USERPROFILE: home,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });

/** A user manager that answers, and a record of every command run; never the real systemctl. */
const fakeRun: Run = async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (cmd === 'systemctl' && args.includes('is-active')) {
    return { code: existsSync(unit) ? 0 : 4, stdout: 'active\n', stderr: '', missing: false };
  }
  if (cmd === 'loginctl') return { code: 0, stdout: 'no\n', stderr: '', missing: false };
  return { code: 0, stdout: '', stderr: '', missing: false };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kage-uninstall-'));
  env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(home, 'run'),
  };
  calls = [];
  // What Kage installed: the program, the unit, the config and the state.
  exe = join(home, '.local', 'bin', 'kage');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(exe, 'kage program');
  unit = join(home, '.config', 'systemd', 'user', 'kage.service');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(unit, `${UNIT_MARKER_LINE}\n[Service]\nExecStart="${exe}" "serve"\n`);
  mkdirSync(join(home, '.config', 'kage'), { recursive: true });
  writeFileSync(join(home, '.config', 'kage', 'config.json'), '{"projectsRoot":"~/projects"}\n');
  mkdirSync(join(home, '.local', 'state', 'kage', 'records'), { recursive: true });
  writeFileSync(join(home, '.local', 'state', 'kage', 'claude-settings.json'), '{}\n');
  // What is the user's: a project with a worktree and a branch.
  project = join(home, 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'demo\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'worktree', 'add', '-q', '-b', 'kage/x', join(project, '.worktrees', 'x'));
  writeFileSync(join(project, '.worktrees', 'x', 'work.txt'), 'unsaved work\n');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env,
    stdin: Readable.from([]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    platform: 'linux',
  };
  return { io: value, out, err };
}

function manager(): ServiceManager {
  return systemdManager({ run: fakeRun, home, env, uid: 1000, wsl: () => false });
}

const sea = (): RunMode => ({ kind: 'sea', exe });

function deps(over: Partial<UninstallDeps> = {}): UninstallDeps {
  return { mode: sea(), manager: manager(), prompt: null, uid: 1000, home, env, ...over };
}

function scripted(answer: boolean) {
  const asked: string[] = [];
  const p: Prompter = {
    ask: async () => {
      throw new Error('no text questions');
    },
    confirm: async (q) => {
      asked.push(q);
      return answer;
    },
  };
  return { p, asked };
}

/** The user's work is exactly as it was, and nothing ran against tmux or the worktrees. */
function expectWorkKept(branchesBefore: string) {
  expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('demo\n');
  expect(readFileSync(join(project, '.worktrees', 'x', 'work.txt'), 'utf8')).toBe('unsaved work\n');
  expect(git(project, 'branch', '--list')).toBe(branchesBefore);
  expect(git(project, 'worktree', 'list', '--porcelain')).toContain('.worktrees/x');
  for (const c of calls) {
    expect(c[0]).not.toBe('tmux');
    expect(c[0]).not.toBe('git');
  }
}

const KEPT_WORK =
  'Kept: your projects, their worktrees and branches, and the tmux session "kage" with its windows.';

describe('kage uninstall', () => {
  it('--purge: removes the service, the program, the config and the state; keeps the work', async () => {
    const branches = git(project, 'branch', '--list');
    expect(branches).toContain('kage/x');
    const o = io();
    expect(await uninstallCommand(['--yes', '--purge'], o.io, deps())).toBe(0);
    expect(o.err).toEqual([]);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(exe)).toBe(false);
    expect(existsSync(join(home, '.config', 'kage'))).toBe(false);
    expect(existsSync(join(home, '.local', 'state', 'kage'))).toBe(false);
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'kage.service']);
    expectWorkKept(branches);
    expect(o.out).toEqual([
      'Removed: the systemd user unit kage.service (~/.config/systemd/user/kage.service).',
      'Removed: ~/.local/bin/kage.',
      'Removed: ~/.config/kage.',
      'Removed: ~/.local/state/kage.',
      KEPT_WORK,
    ]);
  });

  it('without --purge: the config and state folders stay, and Kept names them', async () => {
    const branches = git(project, 'branch', '--list');
    const o = io();
    expect(await uninstallCommand(['--yes'], o.io, deps())).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(exe)).toBe(false);
    expect(existsSync(join(home, '.config', 'kage', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.local', 'state', 'kage', 'records'))).toBe(true);
    // R119-6: Kage's own hooks file goes either way.
    expect(existsSync(join(home, '.local', 'state', 'kage', 'claude-settings.json'))).toBe(false);
    expectWorkKept(branches);
    expect(o.out).toEqual([
      'Removed: the systemd user unit kage.service (~/.config/systemd/user/kage.service).',
      'Removed: ~/.local/bin/kage.',
      'Removed: ~/.local/state/kage/claude-settings.json.',
      KEPT_WORK,
      'Kept: ~/.config/kage/config.json and ~/.local/state/kage (kage uninstall --purge removes them).',
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'the stable path is a link: removes the link and the program it leads to',
    async () => {
      const real = join(home, '.local', 'lib', 'kage', 'kage');
      mkdirSync(dirname(real), { recursive: true });
      renameSync(exe, real);
      symlinkSync(real, exe);
      writeFileSync(`${real}.previous`, 'older kage');
      const o = io();
      expect(await uninstallCommand(['--yes'], o.io, deps())).toBe(0);
      expect(existsSync(exe)).toBe(false);
      expect(existsSync(real)).toBe(false);
      expect(existsSync(`${real}.previous`)).toBe(false);
      expect(o.out).toContain('Removed: ~/.local/bin/kage.');
      expect(o.out).toContain('Removed: ~/.local/lib/kage/kage.');
    },
  );

  it("R120: names the installer's PATH lines in every start-up file and never edits one", async () => {
    const zdot = join(home, 'zdot');
    mkdirSync(zdot);
    const line = `export PATH="${join(home, '.local', 'bin')}:$PATH"`;
    const bashrc = `# mine\nalias ll='ls -l'\n\n# Added by the Kage installer.\n${line}\n`;
    const profile = `\n# Added by the Kage installer.\n${line}\n`;
    const zshrc =
      '# Added by the Kage installer.\n# a marker with no PATH line below is not ours\n';
    writeFileSync(join(home, '.bashrc'), bashrc);
    writeFileSync(join(home, '.profile'), profile);
    writeFileSync(join(zdot, '.zshrc'), zshrc);
    const o = io();
    expect(await uninstallCommand(['--yes'], o.io, deps({ env: { ...env, ZDOTDIR: zdot } }))).toBe(
      0,
    );
    expect(o.out.filter((l) => l.includes('PATH'))).toEqual([
      'Kept: lines 4-5 of ~/.bashrc, which the installer added for your PATH. Remove them by hand if you like.',
      'Kept: lines 2-3 of ~/.profile, which the installer added for your PATH. Remove them by hand if you like.',
    ]);
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe(bashrc);
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(profile);
    expect(readFileSync(join(zdot, '.zshrc'), 'utf8')).toBe(zshrc);
  });

  it('also removes the program an update kept as kage.previous', async () => {
    writeFileSync(`${exe}.previous`, 'older kage');
    const o = io();
    expect(await uninstallCommand(['--yes'], o.io, deps())).toBe(0);
    expect(existsSync(`${exe}.previous`)).toBe(false);
    expect(o.out).toContain('Removed: ~/.local/bin/kage.previous.');
  });

  it('asks first in a terminal; no keeps everything', async () => {
    const no = scripted(false);
    const o = io();
    expect(await uninstallCommand([], o.io, deps({ prompt: no.p }))).toBe(1);
    expect(no.asked).toEqual(['Remove the Kage service and program?']);
    expect(o.out).toEqual(['Nothing was removed.']);
    expect(existsSync(unit)).toBe(true);
    expect(existsSync(exe)).toBe(true);
    expect(calls).toEqual([]);
    const yes = scripted(true);
    expect(await uninstallCommand([], io().io, deps({ prompt: yes.p }))).toBe(0);
    expect(existsSync(exe)).toBe(false);
  });

  it('Ctrl+C at the question stops it', async () => {
    const p: Prompter = {
      ask: async () => '',
      confirm: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };
    const o = io();
    expect(await uninstallCommand([], o.io, deps({ prompt: p }))).toBe(130);
    expect(o.err).toEqual(['Uninstall stopped. Nothing was removed.']);
    expect(existsSync(exe)).toBe(true);
  });

  it('refuses root, and no terminal without --yes exits 1', async () => {
    const r = io();
    expect(await uninstallCommand(['--yes'], r.io, deps({ uid: 0 }))).toBe(1);
    expect(r.err).toEqual(['Run Kage as your own user, not root.']);
    const t = io();
    expect(await uninstallCommand([], t.io, deps({ prompt: null }))).toBe(1);
    expect(t.err).toEqual([
      'kage uninstall needs a terminal to ask first. Run it in one, or pass --yes to remove Kage without asking.',
    ]);
    const u = io();
    expect(await uninstallCommand(['--all'], u.io, deps())).toBe(1);
    expect(u.err).toEqual([
      'kage uninstall has no option "--all". Run kage --help to see its options.',
    ]);
    expect(calls).toEqual([]);
    expect(existsSync(exe)).toBe(true);
    expect(existsSync(unit)).toBe(true);
  });

  it("a unit that isn't Kage's: refuses it, removes nothing else", async () => {
    writeFileSync(unit, '[Service]\nExecStart=/usr/bin/something-else\n');
    const o = io();
    expect(await uninstallCommand(['--yes', '--purge'], o.io, deps())).toBe(1);
    expect(o.err[0]).toBe(
      `Couldn't remove the systemd user unit kage.service: ${unit} wasn't written by kage setup, so Kage leaves it alone. Another tool may have rewritten it. Move it away, then try again.`,
    );
    expect(o.err[1]).toBe('Kage removed nothing else.');
    expect(existsSync(unit)).toBe(true);
    expect(existsSync(exe)).toBe(true);
    expect(existsSync(join(home, '.config', 'kage'))).toBe(true);
  });

  it('bundle mode: removes the service and says how to remove the npm package', async () => {
    const o = io();
    const mode: RunMode = { kind: 'bundle', node: '/usr/bin/node', script: '/x/kage.mjs' };
    expect(await uninstallCommand(['--yes'], o.io, deps({ mode }))).toBe(0);
    expect(existsSync(exe)).toBe(true);
    expect(o.out.slice(0, 3)).toEqual([
      'Removed: the systemd user unit kage.service (~/.config/systemd/user/kage.service).',
      'Removed: ~/.local/state/kage/claude-settings.json.',
      'Remove the program with: npm uninstall -g @eridian-io/kage',
    ]);
  });

  it('nothing installed: says so, and still says what it keeps', async () => {
    rmSync(unit);
    rmSync(exe);
    rmSync(join(home, '.local', 'state', 'kage', 'claude-settings.json'));
    const o = io();
    expect(await uninstallCommand(['--yes'], o.io, deps({ manager: null }))).toBe(0);
    expect(o.out[0]).toBe("Removed: nothing. Kage's service and program weren't there.");
    expect(o.out).toContain(KEPT_WORK);
  });

  it('linger on: leaves it on and says how to turn it off', async () => {
    const m = { ...manager(), lingerEnabled: async () => true };
    const o = io();
    expect(await uninstallCommand(['--yes'], o.io, deps({ manager: m }))).toBe(0);
    expect(o.out.at(-1)).toBe(
      'Linger is still on. If nothing else needs it, turn it off with: loginctl disable-linger',
    );
    expect(calls.some((c) => c.includes('disable-linger'))).toBe(false);
  });
});
