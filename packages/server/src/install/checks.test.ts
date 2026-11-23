import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerStatus } from '../hooks/server.ts';
import { writeHooksSettings } from '../hooks/settings.ts';
import { stateDir } from '../state/store.ts';
import {
  type Check,
  type CheckDeps,
  detectPackageManager,
  formatChecks,
  installChecks,
  installHint,
  mayNotLast,
  parseVersion,
  requirementChecks,
} from './checks.ts';
import type { Run, RunResult } from './run.ts';
import { hookArgv } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';

const isWin = process.platform === 'win32';

/** A table-driven Run: "cmd args…" → its result; anything else is a missing program. */
function tableRun(table: Record<string, Partial<RunResult>>) {
  const calls: string[] = [];
  const timeouts: Record<string, number | undefined> = {};
  const run: Run = async (cmd, args, opts) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    timeouts[key] = opts?.timeoutMs;
    const hit = table[key];
    if (!hit) return { code: -1, stdout: '', stderr: `${cmd}: not found`, missing: true };
    return { code: 0, stdout: '', stderr: '', missing: false, ...hit };
  };
  return { run, calls, timeouts };
}

const TAILSCALE_UP = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'box.tail1234.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  },
});

/** Every requirement met on Linux with apt. */
const GOOD: Record<string, Partial<RunResult>> = {
  'tmux -V': { stdout: 'tmux 3.4\n' },
  'git --version': { stdout: 'git version 2.43.0\n' },
  'claude --version': { stdout: '2.1.330 (Claude Code)\n' },
  'tailscale status --json': { stdout: TAILSCALE_UP },
  'apt-get --version': { stdout: 'apt 2.7.14 (amd64)\n' },
};

/** A fake service manager in a given state, with a PATH in its "file". */
function fakeManager(
  state: ServiceState,
  path: string | null,
  extra: Partial<ServiceManager> = {},
): ServiceManager {
  return {
    kind: 'systemd',
    file: '/home/u/.config/systemd/user/kage.service',
    name: 'systemd user unit kage.service',
    unavailable: async () => null,
    install: async () => {},
    restart: async () => {},
    remove: async () => {},
    state: async () => state,
    pathOfInstalled: async () => path,
    lingerEnabled: async () => true,
    ...extra,
  };
}

/** An executable file (a shell script that does nothing). */
function fakeTool(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-checks-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(run: Run, extra: Partial<CheckDeps> = {}): CheckDeps {
  return {
    run,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: '' },
    platform: 'linux',
    uid: 1000,
    home,
    mode: { kind: 'bundle', node: '/usr/bin/node', script: '/opt/kage/dist/kage.mjs' },
    manager: null,
    status: async () => null,
    fetch: async () => {
      throw new Error('no fetch in this test');
    },
    ...extra,
  };
}

const byId = (checks: Check[], id: Check['id']) => checks.filter((c) => c.id === id);
const one = (checks: Check[], id: Check['id']): Check => {
  const found = byId(checks, id);
  expect(found, `one ${id} check`).toHaveLength(1);
  return found[0] as Check;
};

describe('parseVersion', () => {
  it.each([
    ['git version 2.43.0', [2, 43]],
    ['git version 2.39.3 (Apple Git-145)', [2, 39]],
    ['tmux next-3.5', [3, 5]],
    ['tmux 3.2a', [3, 2]],
    ['2.1.330 (Claude Code)', [2, 1]],
    ['no digits here', null],
    ['', null],
  ])('%s', (text, want) => {
    expect(parseVersion(text)).toEqual(want);
  });
});

describe('detectPackageManager', () => {
  it('finds apt, dnf or pacman on Linux, in that order', async () => {
    expect(await detectPackageManager(tableRun(GOOD).run, 'linux')).toBe('apt');
    expect(await detectPackageManager(tableRun({ 'dnf --version': {} }).run, 'linux')).toBe('dnf');
    expect(await detectPackageManager(tableRun({ 'pacman --version': {} }).run, 'linux')).toBe(
      'pacman',
    );
    expect(await detectPackageManager(tableRun({}).run, 'linux')).toBeNull();
  });

  it('finds brew on macOS, and nothing on Windows', async () => {
    expect(await detectPackageManager(tableRun({ 'brew --version': {} }).run, 'darwin')).toBe(
      'brew',
    );
    expect(await detectPackageManager(tableRun({}).run, 'darwin')).toBeNull();
    const t = tableRun({ 'brew --version': {} });
    expect(await detectPackageManager(t.run, 'win32')).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it('gives each probe the same 5 s limit as the other probes', async () => {
    const linux = tableRun({});
    await detectPackageManager(linux.run, 'linux');
    expect(linux.timeouts).toEqual({
      'apt-get --version': 5000,
      'dnf --version': 5000,
      'pacman --version': 5000,
    });
    const mac = tableRun({});
    await detectPackageManager(mac.run, 'darwin');
    expect(mac.timeouts).toEqual({ 'brew --version': 5000 });
  });
});

describe('installHint', () => {
  it.each([
    ['tmux', 'apt', 'sudo apt install tmux'],
    ['tmux', 'dnf', 'sudo dnf install tmux'],
    ['tmux', 'pacman', 'sudo pacman -S tmux'],
    ['tmux', 'brew', 'brew install tmux'],
    ['git', 'apt', 'sudo apt install git'],
    ['git', 'dnf', 'sudo dnf install git'],
    ['git', 'pacman', 'sudo pacman -S git'],
    ['git', 'brew', 'brew install git'],
    ['tmux', null, 'Install tmux 3.2 or newer.'],
    ['git', null, 'Install git 2.40 or newer.'],
  ] as const)('%s with %s', (tool, pm, want) => {
    expect(installHint(tool, 'linux', pm)).toBe(want);
  });

  it('Claude Code and Tailscale', () => {
    expect(installHint('claude', 'linux', 'apt')).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
    expect(installHint('claude', 'darwin', null)).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
    expect(installHint('tailscale', 'linux', 'apt')).toBe(
      'curl -fsSL https://tailscale.com/install.sh | sh\nThen: sudo tailscale up',
    );
    expect(installHint('tailscale', 'darwin', 'brew')).toBe('brew install --cask tailscale');
  });
});

describe('requirementChecks', () => {
  it('all met on Linux: every label', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '');
    const checks = await requirementChecks(deps(tableRun(GOOD).run));
    expect(checks.map((c) => [c.id, c.level, c.label])).toEqual([
      ['platform', 'ok', 'Linux'],
      ['user', 'ok', 'Running as your own user (uid 1000)'],
      ['tmux', 'ok', 'tmux 3.4'],
      ['git', 'ok', 'git 2.43.0'],
      ['claude', 'ok', 'Claude Code 2.1.330'],
      ['claude-login', 'ok', 'Claude Code is signed in.'],
      ['tailscale', 'ok', 'Tailscale is up (box.tail1234.ts.net).'],
    ]);
    expect(checks.every((c) => c.fix === null)).toBe(true);
  });

  it('Windows fails at once and runs nothing', async () => {
    const t = tableRun(GOOD);
    const checks = await requirementChecks(deps(t.run, { platform: 'win32', uid: undefined }));
    expect(checks).toEqual([
      {
        id: 'platform',
        level: 'fail',
        label: 'Kage runs on Linux or macOS. On Windows, install it inside WSL.',
        fix: null,
      },
    ]);
    expect(t.calls).toEqual([]);
  });

  it('root fails', async () => {
    const c = one(await requirementChecks(deps(tableRun(GOOD).run, { uid: 0 })), 'user');
    expect(c).toMatchObject({ level: 'fail', label: 'Run Kage as your own user, not root.' });
  });

  it('tmux: next-3.5 is ok, 3.1 is too old, missing is not installed', async () => {
    const check = async (r: Partial<RunResult> | undefined) =>
      one(
        await requirementChecks(deps(tableRun({ ...GOOD, 'tmux -V': r as RunResult }).run)),
        'tmux',
      );
    expect(await check({ stdout: 'tmux next-3.5\n' })).toMatchObject({
      level: 'ok',
      label: 'tmux next-3.5',
    });
    expect(await check({ stdout: 'tmux 3.1c\n' })).toEqual({
      id: 'tmux',
      level: 'fail',
      label: 'tmux 3.1c is too old: Kage needs 3.2 or newer.',
      fix: 'sudo apt install tmux',
    });
    expect(await check(undefined)).toEqual({
      id: 'tmux',
      level: 'fail',
      label: "tmux isn't installed.",
      fix: 'sudo apt install tmux',
    });
  });

  it('git: 2.39.5 fails, missing is not installed; with no package manager the hint names the version', async () => {
    const { 'apt-get --version': _, ...noApt } = GOOD;
    const check = async (r: Partial<RunResult> | undefined) =>
      one(
        await requirementChecks(deps(tableRun({ ...noApt, 'git --version': r as RunResult }).run)),
        'git',
      );
    expect(await check({ stdout: 'git version 2.39.5\n' })).toEqual({
      id: 'git',
      level: 'fail',
      label: 'git 2.39.5 is too old: Kage needs 2.40 or newer.',
      fix: 'Install git 2.40 or newer.',
    });
    expect(await check(undefined)).toEqual({
      id: 'git',
      level: 'fail',
      label: "git isn't installed.",
      fix: 'Install git 2.40 or newer.',
    });
    expect(await check({ stdout: 'git version 2.40.0\n' })).toMatchObject({ level: 'ok' });
  });

  it('claude: KAGE_CLAUDE_BIN first; missing is not installed', async () => {
    const t = tableRun({ ...GOOD, '/opt/claude --version': { stdout: '2.2.0 (Claude Code)' } });
    const d = deps(t.run);
    d.env.KAGE_CLAUDE_BIN = '/opt/claude';
    expect(one(await requirementChecks(d), 'claude')).toMatchObject({
      level: 'ok',
      label: 'Claude Code 2.2.0',
    });
    expect(t.calls).not.toContain('claude --version');

    const { 'claude --version': _, ...noClaude } = GOOD;
    expect(one(await requirementChecks(deps(tableRun(noClaude).run)), 'claude')).toEqual({
      id: 'claude',
      level: 'fail',
      label: "Claude Code isn't installed.",
      fix: 'curl -fsSL https://claude.ai/install.sh | bash',
    });
  });

  it('claude-login: the credentials file or ANTHROPIC_API_KEY on Linux, else a warning', async () => {
    const warn = one(await requirementChecks(deps(tableRun(GOOD).run)), 'claude-login');
    expect(warn).toMatchObject({
      level: 'warn',
      label: 'Claude Code may not be signed in. Run claude once and sign in.',
    });

    const d = deps(tableRun(GOOD).run);
    d.env.ANTHROPIC_API_KEY = 'invented-key';
    expect(one(await requirementChecks(d), 'claude-login')).toMatchObject({
      level: 'ok',
      label: 'Claude Code is signed in.',
    });

    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '');
    expect(one(await requirementChecks(deps(tableRun(GOOD).run)), 'claude-login')).toMatchObject({
      level: 'ok',
    });
  });

  it("claude-login: an ANTHROPIC_API_KEY in the shell with a service installed warns it won't reach the service (R124)", async () => {
    const unit = join(home, '.config', 'systemd', 'user', 'kage.service');
    const manager = fakeManager('active', '/usr/bin', { file: unit });
    const d = deps(tableRun(GOOD).run, { manager });
    d.env.ANTHROPIC_API_KEY = 'sk-ant-invented-key';
    // No service file yet (setup's own check): the key signs Claude in.
    expect(one(await requirementChecks(d), 'claude-login').level).toBe('ok');
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, '# Written by kage setup\n');
    for (const platform of ['linux', 'darwin'] as const) {
      const c = one(await requirementChecks({ ...d, platform }), 'claude-login');
      expect(c).toEqual({
        id: 'claude-login',
        level: 'warn',
        label: "ANTHROPIC_API_KEY is set in this shell, but Kage's service doesn't get it.",
        fix: "Claude in Kage's windows needs its own sign-in. Run claude once and sign in.",
      });
      expect(JSON.stringify(c)).not.toContain('sk-ant-invented-key');
    }
    expect(readFileSync(unit, 'utf8')).toBe('# Written by kage setup\n');
  });

  it('claude-login: CLAUDE_CONFIG_DIR, when set, is the only folder looked at', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '');
    const other = join(dir, 'claude-config');
    mkdirSync(other, { recursive: true });
    const d = deps(tableRun(GOOD).run);
    d.env.CLAUDE_CONFIG_DIR = other;
    expect(one(await requirementChecks(d), 'claude-login').level).toBe('warn');
    writeFileSync(join(other, '.credentials.json'), '');
    expect(one(await requirementChecks(d), 'claude-login').level).toBe('ok');
  });

  it('claude-login on macOS is always a warning', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '');
    const c = one(
      await requirementChecks(deps(tableRun(GOOD).run, { platform: 'darwin' })),
      'claude-login',
    );
    expect(c).toMatchObject({
      level: 'warn',
      label: "Kage can't tell whether Claude Code is signed in on macOS. Run claude once to check.",
    });
  });

  it('tailscale: Stopped fails, no IPv4 fails, missing is not installed', async () => {
    const check = async (r: Partial<RunResult> | undefined) =>
      one(
        await requirementChecks(
          deps(tableRun({ ...GOOD, 'tailscale status --json': r as RunResult }).run),
        ),
        'tailscale',
      );
    const stopped = await check({
      code: 1,
      stdout: JSON.stringify({ BackendState: 'Stopped', Self: { TailscaleIPs: [] } }),
    });
    expect(stopped).toEqual({
      id: 'tailscale',
      level: 'fail',
      label: "Tailscale isn't up.",
      fix: 'sudo tailscale up',
    });
    expect(
      await check({
        stdout: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['fd7a::1'] } }),
      }),
    ).toMatchObject({ level: 'fail', label: "Tailscale isn't up." });
    // Not JSON (tailscaled not running, a timeout): it didn't answer, it isn't "not installed".
    expect(await check({ code: 1, stdout: '', stderr: 'failed to connect' })).toEqual({
      id: 'tailscale',
      level: 'fail',
      label: "tailscale status didn't answer.",
      fix: "Run tailscale status yourself to see what's wrong.",
    });
    expect(await check({ code: -1, stdout: 'not json' })).toMatchObject({
      label: "tailscale status didn't answer.",
    });
    expect(await check(undefined)).toEqual({
      id: 'tailscale',
      level: 'fail',
      label: "Tailscale isn't installed.",
      fix: 'curl -fsSL https://tailscale.com/install.sh | sh\nThen: sudo tailscale up',
    });
    // No MagicDNS name: the address stands in.
    expect(
      await check({
        stdout: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.9'] } }),
      }),
    ).toMatchObject({ level: 'ok', label: 'Tailscale is up (100.64.0.9).' });
  });

  it('tmux, git and claude that are there but fail or time out: "didn\'t answer", not "isn\'t installed"', async () => {
    const t = tableRun({
      ...GOOD,
      'tmux -V': { code: 1, stderr: 'tmux: broken' },
      'git --version': { code: -1, stderr: 'timed out' },
      '/opt/claude --version': { code: 2 },
    });
    const d = deps(t.run);
    d.env.KAGE_CLAUDE_BIN = '/opt/claude';
    const checks = await requirementChecks(d);
    expect(one(checks, 'tmux')).toEqual({
      id: 'tmux',
      level: 'fail',
      label: "tmux -V didn't answer.",
      fix: "Run tmux -V yourself to see what's wrong.",
    });
    expect(one(checks, 'git')).toEqual({
      id: 'git',
      level: 'fail',
      label: "git --version didn't answer.",
      fix: "Run git --version yourself to see what's wrong.",
    });
    expect(one(checks, 'claude')).toEqual({
      id: 'claude',
      level: 'fail',
      label: "/opt/claude --version didn't answer.",
      fix: "Run /opt/claude --version yourself to see what's wrong.",
    });
  });

  it('the version probes and tailscale status have a 5 s timeout', async () => {
    const t = tableRun(GOOD);
    await requirementChecks(deps(t.run));
    for (const key of ['tmux -V', 'git --version', 'claude --version', 'tailscale status --json']) {
      expect(t.timeouts[key], key).toBe(5000);
    }
  });

  it.runIf(!isWin)(
    'macOS: tailscale on PATH is run by name (R115; the app fallback is in tailscale.test.ts)',
    async () => {
      const bin = join(dir, 'bin');
      fakeTool(bin, 'tailscale');
      const t = tableRun(GOOD);
      const d = deps(t.run, { platform: 'darwin' });
      d.env.PATH = bin;
      expect(one(await requirementChecks(d), 'tailscale').level).toBe('ok');
      expect(t.calls).toContain('tailscale status --json');
    },
  );

  it('runs no install command, only version probes', async () => {
    const t = tableRun({});
    await requirementChecks(deps(t.run));
    for (const call of t.calls) {
      expect(call).toMatch(
        /^(tmux -V|git --version|claude --version|tailscale status --json|apt-get --version|dnf --version|pacman --version)$/,
      );
    }
  });
});

describe('installChecks', () => {
  const cfgDir = () => join(home, '.config', 'kage');
  const writeConfig = (cfg: object, mode = 0o600) => {
    mkdirSync(cfgDir(), { recursive: true, mode: 0o700 });
    const p = join(cfgDir(), 'config.json');
    writeFileSync(p, JSON.stringify(cfg), { mode });
    chmodSync(p, mode);
    return p;
  };

  it('no config yet: a warning, and no projects check (setup asks for the folder)', async () => {
    const checks = await installChecks(deps(tableRun({}).run));
    expect(one(checks, 'config')).toEqual({
      id: 'config',
      level: 'warn',
      label: 'No config yet. Run kage setup.',
      fix: null,
    });
    expect(byId(checks, 'projects')).toEqual([]);
  });

  it('a config that parses; the projects folder exists', async () => {
    const projects = join(dir, 'projects');
    mkdirSync(projects);
    writeConfig({ projectsRoot: projects });
    const checks = await installChecks(deps(tableRun({}).run));
    expect(one(checks, 'config')).toMatchObject({
      level: 'ok',
      label: 'Config at ~/.config/kage/config.json',
    });
    expect(one(checks, 'projects')).toMatchObject({
      level: 'ok',
      label: `Projects in ${projects}`,
    });
  });

  it("a broken config fails, naming the file but not its contents; projects isn't checked", async () => {
    mkdirSync(cfgDir(), { recursive: true });
    writeFileSync(join(cfgDir(), 'config.json'), '{"token": "invented-secret"');
    const checks = await installChecks(deps(tableRun({}).run));
    const c = one(checks, 'config');
    expect(c.level).toBe('fail');
    expect(c.label).toMatch(/^Config error: invalid JSON in config file /);
    expect(c.fix).toBe('Fix ~/.config/kage/config.json, then run kage doctor again.');
    expect(JSON.stringify(c)).not.toContain('invented-secret');
    expect(byId(checks, 'projects')).toEqual([]);
  });

  it('a missing projects folder fails with the fix', async () => {
    const projects = join(dir, 'nope');
    writeConfig({ projectsRoot: projects });
    expect(one(await installChecks(deps(tableRun({}).run)), 'projects')).toEqual({
      id: 'projects',
      level: 'fail',
      label: `The projects folder ${projects} doesn't exist.`,
      fix: `Create it, or set projectsRoot in ~/.config/kage/config.json.`,
    });
  });

  describe('token (security I3)', () => {
    it('a tokenless config without the opt-out fails doctor\'s token check with "Run kage setup to set one."', async () => {
      writeConfig({ projectsRoot: dir, token: '' });
      expect(one(await installChecks(deps(tableRun({}).run)), 'token')).toEqual({
        id: 'token',
        level: 'fail',
        label: "No access token is set, so Kage won't start.",
        fix: 'Run kage setup to set one.',
      });
      // An old config without the key at all reads the same.
      writeConfig({ projectsRoot: dir });
      expect(one(await installChecks(deps(tableRun({}).run)), 'token').level).toBe('fail');
    });

    it('allowNoToken: a warning with the same fix', async () => {
      writeConfig({ projectsRoot: dir, token: '', allowNoToken: true });
      expect(one(await installChecks(deps(tableRun({}).run)), 'token')).toEqual({
        id: 'token',
        level: 'warn',
        label: 'No access token: anyone on your tailnet can start and approve tasks.',
        fix: 'Run kage setup to set one.',
      });
    });

    it('a token set: ok, and the token is never shown', async () => {
      writeConfig({ projectsRoot: dir, token: 'invented-token-0123456789' });
      const checks = await installChecks(deps(tableRun({}).run));
      expect(one(checks, 'token')).toEqual({
        id: 'token',
        level: 'ok',
        label: 'An access token is set.',
        fix: null,
      });
      expect(JSON.stringify(checks)).not.toContain('invented-token-0123456789');
    });

    it('comes right after the config check; none without a config or with a broken one', async () => {
      writeConfig({ projectsRoot: dir, token: 'invented-token-0123456789' });
      const ids = (await installChecks(deps(tableRun({}).run))).map((c) => c.id);
      expect(ids.indexOf('token')).toBe(ids.indexOf('config') + 1);
      rmSync(join(cfgDir(), 'config.json'));
      expect(byId(await installChecks(deps(tableRun({}).run)), 'token')).toEqual([]);
      writeFileSync(join(cfgDir(), 'config.json'), '{');
      expect(byId(await installChecks(deps(tableRun({}).run)), 'token')).toEqual([]);
    });
  });

  describe.runIf(!isWin)('file modes', () => {
    it('a config with a token readable by others fails', async () => {
      writeConfig({ projectsRoot: dir, token: 'invented-token-0123456789' }, 0o644);
      expect(one(await installChecks(deps(tableRun({}).run)), 'config')).toEqual({
        id: 'config',
        level: 'fail',
        label:
          '~/.config/kage/config.json can be read by other users. Run chmod 600 ~/.config/kage/config.json.',
        fix: null,
      });
    });

    it('a config with an ntfy token readable by others fails too; one without a secret is fine', async () => {
      writeConfig({ projectsRoot: dir, ntfyToken: 'tk_invented' }, 0o640);
      expect(one(await installChecks(deps(tableRun({}).run)), 'config').level).toBe('fail');
      writeConfig({ projectsRoot: dir }, 0o644);
      expect(one(await installChecks(deps(tableRun({}).run)), 'config').level).toBe('ok');
    });
  });

  describe('service', () => {
    it('no manager (another platform): no service checks', async () => {
      const checks = await installChecks(deps(tableRun({}).run));
      expect(byId(checks, 'service')).toEqual([]);
      expect(byId(checks, 'service-path')).toEqual([]);
    });

    it('active, with linger: ok', async () => {
      const c = one(
        await installChecks(deps(tableRun({}).run, { manager: fakeManager('active', null) })),
        'service',
      );
      expect(c).toEqual({
        id: 'service',
        level: 'ok',
        label: 'The service is running (systemd user unit kage.service).',
        fix: null,
      });
    });

    it('active without linger: a warning that it stops at logout', async () => {
      const m = fakeManager('active', null, { lingerEnabled: async () => false });
      expect(one(await installChecks(deps(tableRun({}).run, { manager: m })), 'service')).toEqual({
        id: 'service',
        level: 'warn',
        label: 'The service is running, but it stops when you log out.',
        fix: 'To keep it running, run: loginctl enable-linger',
      });
    });

    it.each([
      ['missing', "The service isn't installed.", 'Run kage setup to install the service.'],
      ['inactive', "The service is installed but isn't running.", 'Start it with: kage restart'],
      [
        'failed',
        'The service has stopped after an error.',
        'See its log: journalctl --user -u kage -e',
      ],
      [
        'starting',
        'The service is starting (waiting for Tailscale?).',
        'See its log: journalctl --user -u kage -e',
      ],
    ] as const)('%s: a warning', async (state, label, fix) => {
      const c = one(
        await installChecks(deps(tableRun({}).run, { manager: fakeManager(state, null) })),
        'service',
      );
      expect(c).toEqual({ id: 'service', level: 'warn', label, fix });
    });

    it("launchd's log is the file", async () => {
      const m = fakeManager('failed', null, {
        kind: 'launchd',
        name: 'launchd agent io.eridian.kage',
      });
      const c = one(
        await installChecks(deps(tableRun({}).run, { manager: m, platform: 'darwin' })),
        'service',
      );
      expect(c.fix).toBe('See its log: ~/Library/Logs/kage.log');
    });

    it("a state that can't be read: the error's first line on the label, an action as the fix", async () => {
      const m = fakeManager('active', null, {
        state: async () => {
          throw new Error('"systemctl --user is-active kage.service" exited 1: Failed\nmore');
        },
      });
      expect(one(await installChecks(deps(tableRun({}).run, { manager: m })), 'service')).toEqual({
        id: 'service',
        level: 'warn',
        label:
          'Kage couldn\'t read the service\'s state ("systemctl --user is-active kage.service" exited 1: Failed).',
        fix: 'Run kage doctor again. If it keeps happening, run kage setup again.',
      });
    });

    it('unavailable (R112): a warning with the reason, and state() is never called', async () => {
      const m = fakeManager('active', null, {
        unavailable: async () =>
          "systemctl --user doesn't answer, so Kage can't install its service.",
        state: async () => {
          throw new Error('state() without a user manager');
        },
      });
      const checks = await installChecks(deps(tableRun({}).run, { manager: m }));
      expect(one(checks, 'service')).toEqual({
        id: 'service',
        level: 'warn',
        label: "Kage's service can't run here.",
        fix: "systemctl --user doesn't answer, so Kage can't install its service.",
      });
      expect(byId(checks, 'service-path')).toEqual([]);
    });

    it('service-path: every tool on the PATH written in the unit, naming the claude it found', async () => {
      const bin = join(dir, 'bin');
      const other = join(dir, 'other');
      for (const t of ['tmux', 'git', 'tailscale']) fakeTool(bin, t);
      const claude = fakeTool(other, 'claude');
      const m = fakeManager('active', [bin, other].join(delimiter));
      expect(
        one(await installChecks(deps(tableRun({}).run, { manager: m })), 'service-path'),
      ).toEqual({
        id: 'service-path',
        level: 'ok',
        label: `The service finds tmux, git, claude and tailscale (claude is ${claude}).`,
        fix: null,
      });
    });

    it('service-path: a tool missing from that PATH fails, one line per tool', async () => {
      const bin = join(dir, 'bin');
      for (const t of ['tmux', 'git']) fakeTool(bin, t);
      const m = fakeManager('active', bin);
      const checks = byId(
        await installChecks(deps(tableRun({}).run, { manager: m })),
        'service-path',
      );
      expect(checks).toEqual([
        {
          id: 'service-path',
          level: 'fail',
          label: "The service can't find claude on its PATH. Run kage setup again to update it.",
          fix: null,
        },
        {
          id: 'service-path',
          level: 'fail',
          label: "The service can't find tailscale on its PATH. Run kage setup again to update it.",
          fix: null,
        },
      ]);
    });

    it('service-path: an installed unit with no PATH fails for every tool; no file, no check', async () => {
      const checks = await installChecks(
        deps(tableRun({}).run, { manager: fakeManager('active', null) }),
      );
      expect(byId(checks, 'service-path')).toHaveLength(4);
      const missing = await installChecks(
        deps(tableRun({}).run, { manager: fakeManager('missing', null) }),
      );
      expect(byId(missing, 'service-path')).toEqual([]);
    });
  });

  describe('server', () => {
    const STATUS: ServerStatus = {
      version: '9.8.7',
      url: 'http://127.0.0.1:8080',
      sessions: 3,
      needsYou: 1,
      pid: 4242,
    };
    const recordingFetch = (status: number | Error) => {
      const urls: string[] = [];
      const fetch = (async (input: string | URL | Request) => {
        urls.push(String(input));
        if (status instanceof Error) throw status;
        return new Response(null, { status });
      }) as typeof globalThis.fetch;
      return { fetch, urls };
    };

    it('the socket answers and the address answers 401: ok, one request to the address', async () => {
      const f = recordingFetch(401);
      const asked: string[] = [];
      const d = deps(tableRun({}).run, {
        fetch: f.fetch,
        status: async (s) => {
          asked.push(s);
          return STATUS;
        },
      });
      d.env.KAGE_SOCKET = join(dir, 'kage.sock');
      expect(one(await installChecks(d), 'server')).toEqual({
        id: 'server',
        level: 'ok',
        label:
          'Kage 9.8.7 is running at http://127.0.0.1:8080 (pid 4242): 3 sessions, 1 needs you.',
        fix: null,
      });
      expect(asked).toEqual([join(dir, 'kage.sock')]);
      expect(f.urls).toEqual(['http://127.0.0.1:8080/']);
    });

    it('200 is ok too; counts read naturally', async () => {
      const f = recordingFetch(200);
      const d = deps(tableRun({}).run, {
        fetch: f.fetch,
        status: async () => ({ ...STATUS, sessions: 1, needsYou: 0 }),
      });
      expect(one(await installChecks(d), 'server').label).toBe(
        'Kage 9.8.7 is running at http://127.0.0.1:8080 (pid 4242): 1 session, 0 need you.',
      );
    });

    it('no answer on the socket fails, pointing at the log; nothing is fetched', async () => {
      const f = recordingFetch(200);
      const d = deps(tableRun({}).run, { fetch: f.fetch, manager: fakeManager('starting', null) });
      expect(one(await installChecks(d), 'server')).toEqual({
        id: 'server',
        level: 'fail',
        label: "Kage isn't running.",
        fix: 'Start it with kage restart, or see the service log: journalctl --user -u kage -e',
      });
      expect(f.urls).toEqual([]);
    });

    it('no answer, no config and no service (a fresh machine): a warning that points at setup (U8)', async () => {
      const notSetUp = {
        id: 'server',
        level: 'warn',
        label: "Kage isn't running.",
        fix: 'Run kage setup.',
      };
      expect(one(await installChecks(deps(tableRun({}).run)), 'server')).toEqual(notSetUp);
      const m = fakeManager('missing', null);
      expect(one(await installChecks(deps(tableRun({}).run, { manager: m })), 'server')).toEqual(
        notSetUp,
      );
    });

    it('no answer with a config but no service (--no-service): fails, the fix is kage serve', async () => {
      writeConfig({ projectsRoot: dir, token: 'invented-token-0123456789' });
      for (const manager of [null, fakeManager('missing', null)]) {
        expect(one(await installChecks(deps(tableRun({}).run, { manager })), 'server')).toEqual({
          id: 'server',
          level: 'fail',
          label: "Kage isn't running.",
          fix: 'Start it with kage serve.',
        });
      }
    });

    it('the address answers something else: fail with the status', async () => {
      const d = deps(tableRun({}).run, {
        fetch: recordingFetch(500).fetch,
        status: async () => STATUS,
      });
      expect(one(await installChecks(d), 'server')).toEqual({
        id: 'server',
        level: 'fail',
        label: 'Kage is running, but http://127.0.0.1:8080 answers HTTP 500.',
        fix: 'Restart Kage (kage serve) and run kage doctor again.',
      });
      // With the service installed, its log comes first.
      const withService = deps(tableRun({}).run, {
        fetch: recordingFetch(500).fetch,
        status: async () => STATUS,
        manager: fakeManager('active', null),
      });
      expect(one(await installChecks(withService), 'server').fix).toBe(
        'See the service log: journalctl --user -u kage -e',
      );
    });

    it("the address doesn't answer here: a warning (it may still open on the phone)", async () => {
      const d = deps(tableRun({}).run, {
        fetch: recordingFetch(new Error('ENOTFOUND')).fetch,
        status: async () => ({ ...STATUS, url: 'http://box.tail1234.ts.net:8080' }),
      });
      expect(one(await installChecks(d), 'server')).toEqual({
        id: 'server',
        level: 'warn',
        label: "Kage is running, but http://box.tail1234.ts.net:8080 doesn't answer from here.",
        fix: "If the board opens on your phone, all is well. If it doesn't, check Tailscale on both devices.",
      });
    });

    it('a status url that is not http is not fetched', async () => {
      const f = recordingFetch(200);
      const d = deps(tableRun({}).run, {
        fetch: f.fetch,
        status: async () => ({ ...STATUS, url: 'file:///etc/passwd' }),
      });
      expect(one(await installChecks(d), 'server')).toEqual({
        id: 'server',
        level: 'fail',
        label: "Kage answers, but its address file:///etc/passwd isn't one Kage can serve.",
        fix: 'Restart Kage (kage serve) and run kage doctor again.',
      });
      expect(f.urls).toEqual([]);
    });

    it('the restart advice names the service when one is installed', async () => {
      const status = async () => ({ ...STATUS, url: 'ftp://x' });
      const systemd = deps(tableRun({}).run, { status, manager: fakeManager('active', null) });
      expect(one(await installChecks(systemd), 'server').fix).toBe(
        'Restart it with kage restart, then run kage doctor again.',
      );
      const launchd = deps(tableRun({}).run, {
        status,
        platform: 'darwin',
        uid: 501,
        manager: fakeManager('active', null, { kind: 'launchd', name: 'launchd agent' }),
      });
      expect(one(await installChecks(launchd), 'server').fix).toBe(
        'Restart it with kage restart, then run kage doctor again.',
      );
    });

    it('every failing check has an action (a fix, or a label that says what to do)', async () => {
      // An instruction, or a command to run (an install hint).
      const says = /\b(Run|Install|Fix|Create|Start|Restart|See|Add|Open|curl|sudo|brew)\b/;
      const bad = deps(tableRun({}).run, {
        uid: 0,
        status: async () => ({ ...STATUS, url: 'ftp://x' }),
        manager: fakeManager('failed', join(dir, 'empty')),
      });
      const checks = [...(await requirementChecks(bad)), ...(await installChecks(bad))];
      const fails = checks.filter((c) => c.level !== 'ok');
      expect(fails.length).toBeGreaterThan(6);
      for (const c of fails) expect(`${c.label} ${c.fix ?? ''}`, c.id).toMatch(says);
    });
  });

  describe('install-path', () => {
    it('SEA: the folder on PATH is ok; off PATH warns with the line to add', async () => {
      const bin = join(dir, 'bin');
      const exe = fakeTool(bin, 'kage');
      const on = deps(tableRun({}).run, { mode: { kind: 'sea', exe } });
      on.env.PATH = ['/usr/bin', bin].join(delimiter);
      expect(one(await installChecks(on), 'install-path')).toEqual({
        id: 'install-path',
        level: 'ok',
        label: `${bin} is on your PATH.`,
        fix: null,
      });
      const off = deps(tableRun({}).run, { mode: { kind: 'sea', exe } });
      off.env.PATH = '/usr/bin';
      expect(one(await installChecks(off), 'install-path')).toEqual({
        id: 'install-path',
        level: 'warn',
        label: `${bin} isn't on your PATH.`,
        fix: `Add ${bin} to your PATH: echo 'export PATH="${bin}:$PATH"' >> ~/.profile`,
      });
    });

    it('R114: the advice names the rc files install.sh writes, by $SHELL', async () => {
      const bin = join(dir, 'bin');
      const exe = fakeTool(bin, 'kage');
      const fix = async (env: NodeJS.ProcessEnv) => {
        const d = deps(tableRun({}).run, { mode: { kind: 'sea', exe } });
        Object.assign(d.env, { PATH: '/usr/bin' }, env);
        return one(await installChecks(d), 'install-path').fix;
      };
      const line = `'export PATH="${bin}:$PATH"'`;
      expect(await fix({ SHELL: '/bin/zsh' })).toBe(
        `Add ${bin} to your PATH: echo ${line} >> ~/.zshrc`,
      );
      expect(await fix({ SHELL: '/usr/bin/fish' })).toBe(
        `Add ${bin} to your PATH: echo ${line} >> ~/.profile`,
      );
      expect(await fix({ SHELL: '/bin/bash' })).toBe(
        `Add ${bin} to your PATH: echo ${line} | tee -a ~/.bashrc ~/.profile`,
      );
      writeFileSync(join(home, '.bash_profile'), '');
      expect(await fix({ SHELL: '/bin/bash' })).toBe(
        `Add ${bin} to your PATH: echo ${line} | tee -a ~/.bashrc ~/.bash_profile`,
      );
    });

    it('bundle mode: no PATH check', async () => {
      expect(byId(await installChecks(deps(tableRun({}).run)), 'install-path')).toEqual([]);
    });

    it.each([
      ['/home/u/.local/share/kage/versions/0.6.0/kage', true],
      ['/tmp/kage-x/kage', true],
      ['/private/var/folders/ab/T/kage', true],
      ['/home/u/.npm/_npx/1a2b/node_modules/kage/dist/kage.mjs', true],
      ['/home/u/.local/share/pnpm/.pnpm/kage@0.6.0/node_modules/kage/dist/kage.mjs', true],
      ['/scratch/me/kage', true, '/scratch/me'],
      ['/home/u/.local/bin/kage', false],
      ['/home/u/kage/packages/server/dist/kage.mjs', false],
      ['/opt/kage-2/kage', false],
    ] as [string, boolean, string?][])('mayNotLast(%s) is %s (R110-5)', (p, want, tmp) => {
      expect(mayNotLast(p, tmp)).toBe(want);
    });

    it("the hooks settings file naming a versioned path warns; the bundle's script is the one judged", async () => {
      const script = fakeTool(join(dir, 'pnpm', 'kage@0.6.0', 'dist'), 'kage.mjs');
      const d = deps(tableRun({}).run);
      await writeHooksSettings(
        stateDir(d.env),
        hookArgv({ kind: 'bundle', node: '/usr/bin/node', script }),
      );
      expect(byId(await installChecks(d), 'install-path')).toEqual([
        {
          id: 'install-path',
          level: 'warn',
          label: `Claude's hooks run ${script}, which may not stay there.`,
          fix: 'Install Kage with its install script, so the hooks name a path that lasts.',
        },
      ]);
    });

    it("the bundle's hooks name kage-hook.mjs (performance P2): that is the file judged", async () => {
      const dist = join(dir, 'pnpm', 'kage@0.7.0', 'dist');
      const script = fakeTool(dist, 'kage.mjs');
      const light = fakeTool(dist, 'kage-hook.mjs');
      const d = deps(tableRun({}).run);
      await writeHooksSettings(
        stateDir(d.env),
        hookArgv({ kind: 'bundle', node: '/usr/bin/node', script }),
      );
      expect(byId(await installChecks(d), 'install-path')).toEqual([
        {
          id: 'install-path',
          level: 'warn',
          label: `Claude's hooks run ${light}, which may not stay there.`,
          fix: 'Install Kage with its install script, so the hooks name a path that lasts.',
        },
      ]);
      rmSync(light);
      expect(byId(await installChecks(d), 'install-path')).toEqual([
        {
          id: 'install-path',
          level: 'warn',
          label: `Claude's hooks run ${light}, which isn't there anymore.`,
          fix: 'Restart Kage so it writes them again: run kage serve, or kage setup for the service.',
        },
      ]);
    });

    it.each([
      ['kage-hook.mjs beside kage.mjs (F17)', true],
      ['kage.mjs (an older build)', false],
    ])(
      "a checkout's build: ✓, with what to do if the checkout moves (U4): %s",
      async (_n, light) => {
        // A versioned folder name, which would otherwise read as "may not stay there".
        const checkout = join(dir, 'v1.2.3', 'kage');
        mkdirSync(join(checkout, '.git'), { recursive: true });
        const dist = join(checkout, 'packages', 'server', 'dist');
        const script = fakeTool(dist, 'kage.mjs');
        if (light) fakeTool(dist, 'kage-hook.mjs');
        const d = deps(tableRun({}).run);
        await writeHooksSettings(
          stateDir(d.env),
          hookArgv({ kind: 'bundle', node: '/usr/bin/node', script }),
        );
        const program = light ? join(dist, 'kage-hook.mjs') : script;
        expect(byId(await installChecks(d), 'install-path')).toEqual([
          {
            id: 'install-path',
            level: 'ok',
            label: `Claude's hooks run this checkout's build (${program}). If you move the checkout, run kage setup again.`,
            fix: null,
          },
        ]);
      },
    );

    it('the hooks settings file naming a program that is gone warns', async () => {
      const exe = join(dir, "it's gone", 'kage');
      const d = deps(tableRun({}).run);
      await writeHooksSettings(stateDir(d.env), hookArgv({ kind: 'sea', exe }));
      expect(byId(await installChecks(d), 'install-path')).toEqual([
        {
          id: 'install-path',
          level: 'warn',
          label: `Claude's hooks run ${exe}, which isn't there anymore.`,
          fix: 'Restart Kage so it writes them again: run kage serve, or kage setup for the service.',
        },
      ]);
    });
  });
});

describe('formatChecks', () => {
  it('marks each level and indents the fix, one line per fix line', () => {
    expect(
      formatChecks([
        { id: 'tmux', level: 'ok', label: 'tmux 3.4', fix: null },
        {
          id: 'claude-login',
          level: 'warn',
          label: 'Claude Code may not be signed in.',
          fix: null,
        },
        {
          id: 'tailscale',
          level: 'fail',
          label: "Tailscale isn't installed.",
          fix: 'curl -fsSL https://tailscale.com/install.sh | sh\nThen: sudo tailscale up',
        },
      ]),
    ).toEqual([
      '✓ tmux 3.4',
      '! Claude Code may not be signed in.',
      "✗ Tailscale isn't installed.",
      '  curl -fsSL https://tailscale.com/install.sh | sh',
      '  Then: sudo tailscale up',
    ]);
  });
});
