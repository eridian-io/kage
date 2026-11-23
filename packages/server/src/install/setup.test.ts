import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import type { Prompter } from './prompt.ts';
import type { Run, RunResult } from './run.ts';
import { KAGE_VERSION, type RunMode, serviceArgv, serviceEnv } from './runtime.ts';
import type { ServiceManager, ServiceSpec } from './service.ts';
import {
  CLAUDE_LINE,
  LINGER_ON,
  NEEDS_TTY,
  type SetupDeps,
  servicePath,
  setupCommand,
  suggestProjectsRoot,
} from './setup.ts';
import { systemdManager } from './systemd.ts';

const isWin = process.platform === 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

const GOOD: Record<string, Partial<RunResult>> = {
  'tmux -V': { stdout: 'tmux 3.4\n' },
  'git --version': { stdout: 'git version 2.43.0\n' },
  'claude --version': { stdout: '2.1.330 (Claude Code)\n' },
  'tailscale status --json': {
    stdout: JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'box.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] },
    }),
  },
  'apt-get --version': { stdout: 'apt 2.7.14 (amd64)\n' },
  'systemctl --user is-active kage.service': { code: 4, stdout: 'inactive\n' },
  'systemctl --user daemon-reload': {},
  'systemctl --user enable --now kage.service': {},
  'systemctl --user enable kage.service': {},
  'systemctl --user restart kage.service': {},
  'loginctl show-user 1000 -p Linger --value': { stdout: 'yes\n' },
};

function tableRun(table: Record<string, Partial<RunResult>>) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const hit = table[key];
    if (!hit) return { code: -1, stdout: '', stderr: `${cmd}: not found`, missing: true };
    return { code: 0, stdout: '', stderr: '', missing: false, ...hit };
  };
  return { run, calls };
}

const BUNDLE: RunMode = {
  kind: 'bundle',
  node: '/opt/node/bin/node',
  script: '/opt/kage/dist/kage.mjs',
};
const PATH = '/home/tester/.local/bin:/usr/local/bin:/usr/bin:/bin';
const UP: ServerStatus = {
  version: KAGE_VERSION,
  url: 'http://box:8080',
  sessions: 0,
  needsYou: 0,
  pid: 4242,
};

let dir: string;
let home: string;
let cfgFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-setup-'));
  home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '');
  cfgFile = join(home, '.config', 'kage', 'config.json');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function fakeManager(over: Partial<ServiceManager> = {}) {
  const installs: ServiceSpec[] = [];
  const linger = { asked: 0, enabled: 0 };
  const m: ServiceManager = {
    kind: 'systemd',
    file: join(home, '.config', 'systemd', 'user', 'kage.service'),
    name: 'systemd user unit kage.service',
    unavailable: async () => null,
    install: async (spec) => {
      installs.push(spec);
    },
    restart: async () => {},
    remove: async () => {},
    state: async () => (installs.length > 0 ? 'active' : 'missing'),
    pathOfInstalled: async () => null,
    lingerEnabled: async () => {
      linger.asked++;
      return true;
    },
    enableLinger: async () => {
      linger.enabled++;
      return true;
    },
    ...over,
  };
  return { m, installs, linger };
}

/** A Prompter answering from a script, recording each question. */
function scripted(answers: (string | boolean)[]) {
  const asked: string[] = [];
  const next = (q: string) => {
    asked.push(q);
    if (answers.length === 0) throw new Error(`unexpected question: ${q}`);
    return answers.shift() as string | boolean;
  };
  const p: Prompter = {
    ask: async (q, def) => {
      const a = next(`${q} [${def}]:`);
      return a === '' ? def : String(a);
    },
    confirm: async (q, def) => {
      const a = next(`${q} ${def ? '[Y/n]' : '[y/N]'}`);
      return typeof a === 'boolean' ? a : def;
    },
  };
  return { p, asked };
}

function harness(over: Partial<SetupDeps> = {}, table = GOOD) {
  const t = tableRun(table);
  const fm = fakeManager();
  const settings: NodeJS.ProcessEnv[] = [];
  const urls: string[] = [];
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    PATH,
    USER: 'tester',
  };
  const deps: SetupDeps = {
    run: t.run,
    env,
    platform: 'linux',
    uid: 1000,
    home,
    mode: BUNDLE,
    manager: fm.m,
    // The unit answers on the port the config now holds.
    status: async () => ({
      ...UP,
      url: `http://box:${existsSync(cfgFile) ? readCfg().port : 8080}`,
    }),
    fetch: (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(null, { status: 401 });
    }) as typeof fetch,
    prompt: null,
    isTty: false,
    writeSettings: async (e) => {
      settings.push(e);
      return join(home, '.local', 'state', 'kage', 'claude-settings.json');
    },
    waitMs: 1000,
    lookup: async () => {
      throw new Error('no DNS in tests');
    },
    ...over,
  };
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env,
    stdin: Readable.from([]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, io, out, err, calls: t.calls, fm, settings, urls };
}

/**
 * A server that never answers. Fake timers start at its first poll: setup does real file I/O
 * before that, which fake timers would not wait for.
 */
function slowServer() {
  let polled = 0;
  let first: () => void = () => {};
  const started = new Promise<void>((r) => {
    first = r;
  });
  const status = async (): Promise<ServerStatus | null> => {
    if (polled++ === 0) {
      vi.useFakeTimers();
      first();
    }
    return null;
  };
  return { status, started, count: () => polled };
}

const readCfg = () => JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;

describe('kage setup: who may run it', () => {
  it('Review Focus 1: no terminal and no --yes exits 1 with the sentence, and nothing is written', async () => {
    const h = harness();
    expect(await setupCommand([], h.io, h.deps)).toBe(1);
    expect(h.err).toEqual([NEEDS_TTY]);
    expect(existsSync(cfgFile)).toBe(false);
    expect(h.fm.installs).toEqual([]);
    expect(h.settings).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('root (uid 0) is refused before anything runs', async () => {
    const h = harness({ uid: 0 });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(1);
    expect(h.err).toEqual(['Run Kage as your own user, not root.']);
    expect(h.calls).toEqual([]);
    expect(existsSync(cfgFile)).toBe(false);
  });

  it('an unknown option or a missing value is named', async () => {
    const h = harness();
    expect(await setupCommand(['--yes', '--colour'], h.io, h.deps)).toBe(1);
    expect(h.err).toEqual([
      'kage setup has no option "--colour". Run kage --help to see its options.',
    ]);
    const g = harness();
    expect(await setupCommand(['--yes', '--port'], g.io, g.deps)).toBe(1);
    expect(g.err).toEqual(['--port needs a value.']);
  });

  it('a requirement fail stops before any question', async () => {
    const { 'tmux -V': _, ...noTmux } = GOOD;
    const s = scripted([]);
    const h = harness({ prompt: s.p, isTty: true }, noTmux);
    expect(await setupCommand([], h.io, h.deps)).toBe(1);
    expect(h.out).toContain("✗ tmux isn't installed.");
    expect(h.out.at(-1)).toBe('Fix the items above, then run kage setup again.');
    expect(s.asked).toEqual([]);
    expect(existsSync(cfgFile)).toBe(false);
    expect(h.fm.installs).toEqual([]);
  });
});

describe('kage setup --yes on a fresh home', () => {
  it('writes the config, installs the service with the bundle argv and env, and ends with the address and the claude line', async () => {
    const h = harness();
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    const cfg = readCfg();
    expect(cfg.projectsRoot).toBe('~/projects');
    expect(cfg.port).toBe(8080);
    expect(cfg.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // F8: taking the default host (the MagicDNS name) leaves host unset: the Tailscale address.
    expect('host' in cfg).toBe(false);
    expect(Object.keys(cfg).sort()).toEqual(['port', 'projectsRoot', 'token']);
    if (!isWin) {
      expect(mode(cfgFile)).toBe(0o600);
      expect(mode(join(home, '.config', 'kage'))).toBe(0o700);
    }
    expect(statSync(join(home, 'projects')).isDirectory()).toBe(true);

    expect(h.fm.installs).toEqual([
      {
        argv: serviceArgv(BUNDLE),
        env: serviceEnv(BUNDLE, `${PATH}:/opt/node/bin`, h.deps.env),
      },
    ]);
    expect(h.settings).toHaveLength(1);
    expect(h.out.slice(-2)).toEqual(['Kage is running at http://box:8080', CLAUDE_LINE]);
    // The token is shown once, with where it lives.
    const tokenLines = h.out.filter((l) => l.includes(cfg.token as string));
    expect(tokenLines).toEqual([
      `Your token: ${cfg.token}. Kage asks for it once per browser. It's saved in ~/.config/kage/config.json.`,
    ]);
    expect(h.out).toContain('Created ~/projects.');
    expect(h.out).toContain('Installed the systemd user unit kage.service.');
    expect(h.out).toContain('Saved your settings in ~/.config/kage/config.json.');
    // One request to Kage's own address (R105).
    expect(h.urls).toEqual(['http://box:8080/']);
    expect(h.err).toEqual([]);
  });

  it("R25: nothing of Claude's is written", async () => {
    const h = harness();
    await setupCommand(['--yes'], h.io, h.deps);
    expect(readdirSync(join(home, '.claude'))).toEqual(['.credentials.json']);
    expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('');
    expect(h.calls.some((c) => c.startsWith('claude ') && c !== 'claude --version')).toBe(false);
  });

  it('the unit and the service env hold no secret', async () => {
    const h = harness();
    await setupCommand(['--yes'], h.io, h.deps);
    const token = readCfg().token as string;
    expect(JSON.stringify(h.fm.installs)).not.toContain(token);
  });

  it("R124: the service gets setup's claude, folders and tmux socket, never an API key", async () => {
    const h = harness();
    Object.assign(h.deps.env, {
      KAGE_CLAUDE_BIN: '/opt/claude/bin/claude',
      CLAUDE_CONFIG_DIR: '/home/tester/.claude-work',
      // A real folder: the config moves with it. (On Windows it isn't a POSIX absolute path.)
      XDG_CONFIG_HOME: join(dir, 'conf'),
      XDG_STATE_HOME: '/home/tester/state',
      KAGE_TMUX_SOCKET: 'agents',
      ANTHROPIC_API_KEY: 'sk-ant-invented-key',
    });
    cfgFile = join(dir, 'conf', 'kage', 'config.json');
    const run = h.deps.run;
    h.deps.run = (cmd, args, o) => run(cmd === '/opt/claude/bin/claude' ? 'claude' : cmd, args, o);
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    const env = h.fm.installs[0]?.env ?? {};
    expect(env.KAGE_CLAUDE_BIN).toBe('/opt/claude/bin/claude');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/tester/.claude-work');
    expect(env.XDG_STATE_HOME).toBe('/home/tester/state');
    expect(env.KAGE_TMUX_SOCKET).toBe('agents');
    if (!isWin) expect(env.XDG_CONFIG_HOME).toBe(join(dir, 'conf'));
    expect(JSON.stringify(h.fm.installs)).not.toContain('sk-ant-invented-key');
    expect(Object.keys(env).sort()).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('kage setup, Review Focus 4: running it again', () => {
  const EXISTING = {
    projectsRoot: '~/projects',
    port: 8080,
    token: 'existing-token-0123456789abcdef',
    ntfyTopic: 'invented-topic-0123456789',
    ntfyToken: 'tk_invented0123',
    autoArchive: { onMerge: false, afterDays: 3 },
    x: 1,
  };
  const seed = (fileMode = 0o600) => {
    mkdirSync(join(home, '.config', 'kage'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'projects'), { recursive: true });
    writeFileSync(cfgFile, JSON.stringify(EXISTING, null, 2));
    if (!isWin) chmodSync(cfgFile, fileMode);
  };

  it('--port 9090 changes the port only: every other key byte-equal, the token kept, still 0600', async () => {
    seed();
    const h = harness();
    expect(await setupCommand(['--yes', '--port', '9090'], h.io, h.deps)).toBe(0);
    const cfg = readCfg();
    expect(cfg.port).toBe(9090);
    for (const k of [
      'projectsRoot',
      'token',
      'ntfyTopic',
      'ntfyToken',
      'autoArchive',
      'x',
    ] as const) {
      expect(JSON.stringify(cfg[k]), k).toBe(JSON.stringify(EXISTING[k]));
    }
    expect('host' in cfg).toBe(false);
    if (!isWin) expect(mode(cfgFile)).toBe(0o600);
    expect(h.out).toContain('Saved the port in ~/.config/kage/config.json.');
    // The kept token isn't printed again.
    expect(h.out.join('\n')).not.toContain(EXISTING.token);
  });

  it('a 0644 file becomes 0600', async () => {
    if (isWin) return;
    seed(0o644);
    const h = harness();
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    expect(mode(cfgFile)).toBe(0o600);
  });

  it('nothing to change: the file is untouched and setup says the settings are already set', async () => {
    seed();
    const before = readFileSync(cfgFile, 'utf8');
    const h = harness();
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    expect(readFileSync(cfgFile, 'utf8')).toBe(before);
    expect(h.out).toContain('Your settings in ~/.config/kage/config.json are already set.');
  });

  it('a config holding {bad: exit 1 with the sentence, the file unchanged, nothing installed', async () => {
    mkdirSync(join(home, '.config', 'kage'), { recursive: true });
    writeFileSync(cfgFile, '{bad');
    const h = harness();
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(1);
    expect(h.err).toEqual([
      `${cfgFile} isn't valid JSON. Fix it or move it away, then run kage setup again.`,
    ]);
    expect(readFileSync(cfgFile, 'utf8')).toBe('{bad');
    expect(h.fm.installs).toEqual([]);
    expect(h.settings).toEqual([]);
  });

  it('R116(4): a key setup did not ask about that serve would refuse: nothing is written, no token shown, exit 1', async () => {
    mkdirSync(join(home, '.config', 'kage'), { recursive: true });
    const text = JSON.stringify({ worktreeDir: '../out' });
    writeFileSync(cfgFile, text);
    if (!isWin) chmodSync(cfgFile, 0o644);
    const h = harness();
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/^Config error: worktreeDir must be/);
    expect(h.err[1]).toBe('Fix ~/.config/kage/config.json, then run kage setup again.');
    // Nothing changed: the file (even its mode), no projects folder, no hooks file, no service.
    expect(readFileSync(cfgFile, 'utf8')).toBe(text);
    if (!isWin) expect(mode(cfgFile)).toBe(0o644);
    expect(existsSync(join(home, 'projects'))).toBe(false);
    expect(h.settings).toEqual([]);
    expect(h.fm.installs).toEqual([]);
    // The generated token was never shown.
    expect([...h.out, ...h.err].some((l) => l.startsWith('Your token:'))).toBe(false);
  });

  it('the second run installs again, which restarts the one unit (the real systemd manager, a fake systemctl)', async () => {
    let installed = false;
    const t = tableRun(GOOD);
    const run: Run = async (cmd, args, o) => {
      const key = [cmd, ...args].join(' ');
      if (key === 'systemctl --user is-active kage.service') {
        t.calls.push(key);
        return installed
          ? { code: 0, stdout: 'active\n', stderr: '', missing: false }
          : { code: 4, stdout: 'inactive\n', stderr: '', missing: false };
      }
      if (key.startsWith('systemctl --user enable')) installed = true;
      return t.run(cmd, args, o);
    };
    const env = harness().deps.env;
    const m = systemdManager({ run, home, env, uid: 1000 });
    const first = harness({ run, manager: m });
    expect(await setupCommand(['--yes'], first.io, first.deps)).toBe(0);
    expect(first.out).toContain('Installed the systemd user unit kage.service.');
    const second = harness({ run, manager: m });
    expect(await setupCommand(['--yes', '--port', '9090'], second.io, second.deps)).toBe(0);
    expect(second.out).toContain('Updated and restarted the systemd user unit kage.service.');
    expect(t.calls.filter((c) => c === 'systemctl --user enable --now kage.service')).toHaveLength(
      1,
    );
    expect(t.calls.filter((c) => c === 'systemctl --user restart kage.service')).toHaveLength(1);
    expect(readdirSync(join(home, '.config', 'systemd', 'user'))).toEqual(['kage.service']);
    const unit = readFileSync(m.file, 'utf8');
    expect(unit).not.toContain(readCfg().token as string);
  });
});

describe('kage setup: the questions', () => {
  it('asks each question with the current value as its default, in order', async () => {
    mkdirSync(join(home, 'code', 'a', '.git'), { recursive: true });
    const s = scripted(['', '', '9000', true, true]);
    const h = harness({
      prompt: s.p,
      isTty: true,
      manager: fakeManager({ lingerEnabled: async () => false }).m,
    });
    expect(await setupCommand([], h.io, h.deps)).toBe(0);
    expect(s.asked).toEqual([
      'Projects folder [~/code]:',
      'Host name [box]:',
      'Port [8080]:',
      'Set an access token? Anyone on your tailnet can reach Kage. [Y/n]',
      "Keep Kage running when you're logged out? [Y/n]",
    ]);
    const cfg = readCfg();
    expect(cfg.projectsRoot).toBe('~/code');
    expect(cfg.port).toBe(9000);
  });

  it('a projects folder that is missing: Create <dir>? and it is made; No asks for the folder again', async () => {
    mkdirSync(join(home, 'projects'));
    const s = scripted(['~/work', false, '~/work2', true, '', '', true]);
    const h = harness({ prompt: s.p, isTty: true });
    expect(await setupCommand([], h.io, h.deps)).toBe(0);
    expect(s.asked.slice(0, 4)).toEqual([
      'Projects folder [~/projects]:',
      'Create ~/work? [Y/n]',
      'Projects folder [~/projects]:',
      'Create ~/work2? [Y/n]',
    ]);
    expect(existsSync(join(home, 'work'))).toBe(false);
    expect(statSync(join(home, 'work2')).isDirectory()).toBe(true);
    expect(readCfg().projectsRoot).toBe('~/work2');
  });

  it('a typed host Kage can listen on is written; one it cannot is explained and asked again', async () => {
    mkdirSync(join(home, 'projects'));
    const s = scripted(['', 'nowhere', '10.0.0.5', '127.0.0.1', '', true]);
    const h = harness({ prompt: s.p, isTty: true });
    expect(await setupCommand([], h.io, h.deps)).toBe(0);
    expect(h.out).toContain("Kage can't find the address of nowhere.");
    expect(h.out).toContain(
      "10.0.0.5 isn't a Tailscale or loopback address, so Kage won't listen there.",
    );
    expect(h.out).toContain('Press Enter for the Tailscale address, or type another name or IP.');
    expect(readCfg().host).toBe('127.0.0.1');
  });

  it('a host name that resolves to a Tailscale address is written as typed', async () => {
    const h = harness({
      lookup: async (n) =>
        n === 'box.tail1234.ts.net' ? [{ address: '100.101.102.103', family: 4 }] : [],
    });
    expect(await setupCommand(['--yes', '--host', 'box.tail1234.ts.net'], h.io, h.deps)).toBe(0);
    expect(readCfg().host).toBe('box.tail1234.ts.net');
  });

  it('the MagicDNS short name is never written (it may not resolve, and the service would loop); typing it unsets a host', async () => {
    mkdirSync(join(home, '.config', 'kage'), { recursive: true });
    mkdirSync(join(home, 'projects'));
    writeFileSync(cfgFile, JSON.stringify({ host: '127.0.0.1' }));
    const h = harness();
    expect(await setupCommand(['--yes', '--host', 'box'], h.io, h.deps)).toBe(0);
    expect(readCfg().host).toBeNull();
  });

  it('--host that Kage cannot use, with --yes: exit 1, nothing written', async () => {
    const h = harness();
    expect(await setupCommand(['--yes', '--host', 'nowhere'], h.io, h.deps)).toBe(1);
    expect(h.out).toContain("Kage can't find the address of nowhere.");
    expect(existsSync(cfgFile)).toBe(false);
  });

  it('a bad port is explained; with --port it stops setup', async () => {
    const h = harness();
    expect(await setupCommand(['--yes', '--port', '70000'], h.io, h.deps)).toBe(1);
    expect(h.out).toContain('The port must be a whole number from 1 to 65535.');
    expect(existsSync(cfgFile)).toBe(false);
  });

  it('--no-token turns a token off; the question then defaults to No', async () => {
    mkdirSync(join(home, '.config', 'kage'), { recursive: true });
    mkdirSync(join(home, 'projects'));
    writeFileSync(cfgFile, JSON.stringify({ token: 'existing-token-0123456789abcdef' }));
    const h = harness();
    expect(await setupCommand(['--yes', '--no-token'], h.io, h.deps)).toBe(0);
    expect(readCfg().token).toBe('');
    const s = scripted(['', '', '', '']);
    const g = harness({ prompt: s.p, isTty: true });
    expect(await setupCommand([], g.io, g.deps)).toBe(0);
    expect(s.asked[3]).toBe('Set an access token? Anyone on your tailnet can reach Kage. [y/N]');
    expect(readCfg().token).toBe('');
  });
});

describe('kage setup: the service', () => {
  it('unavailable(): its sentence, the config still written, Start Kage with: kage serve, exit 0', async () => {
    const why = "systemd isn't running in this WSL distribution.";
    let polled = 0;
    const fm = fakeManager({ unavailable: async () => why });
    const h = harness({
      manager: fm.m,
      status: async () => {
        polled++;
        return null;
      },
    });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    expect(existsSync(cfgFile)).toBe(true);
    expect(h.out).toContain(why);
    expect(h.out.slice(-2)).toEqual(['Start Kage with: kage serve', CLAUDE_LINE]);
    expect(fm.installs).toEqual([]);
    expect(polled).toBe(0);
  });

  it('--no-service skips it the same way', async () => {
    const h = harness();
    expect(await setupCommand(['--yes', '--no-service'], h.io, h.deps)).toBe(0);
    expect(h.fm.installs).toEqual([]);
    expect(h.out.slice(-2)).toEqual(['Start Kage with: kage serve', CLAUDE_LINE]);
  });

  it('source mode can not be a service: the reason, then kage serve', async () => {
    const h = harness({ mode: { kind: 'source', node: '/n/node', script: '/k/src/main.ts' } });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    expect(h.out.some((l) => l.startsWith('Install Kage from a release'))).toBe(true);
    expect(h.fm.installs).toEqual([]);
    expect(h.out.at(-2)).toBe('Start Kage with: kage serve');
  });

  it('an install that fails: the reason and exit 1', async () => {
    const fm = fakeManager({
      install: async () => {
        throw new Error("kage.service wasn't written by kage setup, so Kage leaves it alone.");
      },
    });
    const h = harness({ manager: fm.m });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(1);
    expect(h.err[0]).toBe(
      "Couldn't install the systemd user unit kage.service: kage.service wasn't written by kage setup, so Kage leaves it alone.",
    );
  });

  it('linger: skipped when it is on, and the sudo loginctl line when enableLinger() fails', async () => {
    const on = harness();
    await setupCommand(['--yes'], on.io, on.deps);
    expect(on.fm.linger).toEqual({ asked: 1, enabled: 0 });

    const fm = fakeManager({ lingerEnabled: async () => false, enableLinger: async () => false });
    const s = scripted(['', '', '', true, true]);
    const off = harness({ manager: fm.m, prompt: s.p, isTty: true });
    mkdirSync(join(home, 'projects'), { recursive: true });
    expect(await setupCommand([], off.io, off.deps)).toBe(0);
    expect(s.asked.at(-1)).toBe("Keep Kage running when you're logged out? [Y/n]");
    expect(off.out).toContain('Run this to allow it: sudo loginctl enable-linger tester');
  });

  it('--no-linger: never asked, never enabled (R106)', async () => {
    let enabled = 0;
    const fm = fakeManager({
      lingerEnabled: async () => false,
      enableLinger: async () => {
        enabled++;
        return true;
      },
    });
    const h = harness({ manager: fm.m });
    expect(await setupCommand(['--yes', '--no-linger'], h.io, h.deps)).toBe(0);
    expect(enabled).toBe(0);
  });

  it('launchd has no linger question', async () => {
    const fm = fakeManager({ kind: 'launchd', name: 'launchd agent io.eridian.kage' });
    delete fm.m.lingerEnabled;
    delete fm.m.enableLinger;
    mkdirSync(join(home, 'projects'));
    const s = scripted(['', '', '', true]);
    const h = harness({ manager: fm.m, prompt: s.p, isTty: true, platform: 'darwin' });
    expect(await setupCommand([], h.io, h.deps)).toBe(0);
    expect(s.asked).toHaveLength(4);
  });

  it('Kage not answering in time: the journalctl line after waitMs, exit 1', async () => {
    const poll = slowServer();
    const h = harness({ waitMs: 1000, status: poll.status });
    const done = setupCommand(['--yes'], h.io, h.deps);
    await poll.started;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toBe(1);
    expect(h.out.at(-1)).toBe(
      "Kage didn't answer at http://box:8080. See: journalctl --user -u kage -e",
    );
    expect(poll.count()).toBeGreaterThanOrEqual(4);
    expect(poll.count()).toBeLessThanOrEqual(6);
  });

  it('without a MagicDNS name the line names the Tailscale IP, never os.hostname() (security I2)', async () => {
    const poll = slowServer();
    const noDns = {
      ...GOOD,
      'tailscale status --json': {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { TailscaleIPs: ['fd7a:115c:a1e0::9', '100.101.102.103'] },
        }),
      },
    };
    const h = harness({ waitMs: 1000, status: poll.status }, noDns);
    const done = setupCommand(['--yes'], h.io, h.deps);
    await poll.started;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toBe(1);
    expect(h.out.at(-1)).toBe(
      "Kage didn't answer at http://100.101.102.103:8080. See: journalctl --user -u kage -e",
    );
  });

  it('launchd: the log file instead of journalctl', async () => {
    const poll = slowServer();
    const fm = fakeManager({ kind: 'launchd', name: 'launchd agent io.eridian.kage' });
    delete fm.m.lingerEnabled;
    const h = harness({ manager: fm.m, platform: 'darwin', status: poll.status, waitMs: 500 });
    const done = setupCommand(['--yes'], h.io, h.deps);
    await poll.started;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toBe(1);
    expect(h.out.at(-1)).toBe(
      "Kage didn't answer at http://box:8080. See: ~/Library/Logs/kage.log",
    );
  });

  it('Kage answers on its socket but its address answers another code: exit 1 with the log', async () => {
    const h = harness({
      fetch: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(1);
    expect(h.out.at(-1)).toBe(
      'Kage is running, but http://box:8080 answers HTTP 500. See: journalctl --user -u kage -e',
    );
  });
});

describe('kage setup, fix round 1', () => {
  it('R116(2): --yes turns linger on and says so, with how to undo it', async () => {
    const fm = fakeManager({ lingerEnabled: async () => false });
    const h = harness({ manager: fm.m });
    expect(await setupCommand(['--yes'], h.io, h.deps)).toBe(0);
    expect(h.out).toContain(LINGER_ON);
    expect(LINGER_ON).toBe(
      "Turned on linger, so Kage keeps running when you're logged out. To undo it: loginctl disable-linger",
    );
    expect(fm.linger.enabled).toBe(1);
  });

  it('the linger question comes before install, and the prompter is closed after the last question', async () => {
    mkdirSync(join(home, 'projects'));
    const events: string[] = [];
    const s = scripted(['', '', '', true, false]);
    const p: Prompter = {
      ask: async (q, d) => {
        events.push(`ask ${q}`);
        return s.p.ask(q, d);
      },
      confirm: async (q, d) => {
        events.push(`confirm ${q}`);
        return s.p.confirm(q, d);
      },
      close: () => events.push('close'),
    };
    const fm = fakeManager({
      lingerEnabled: async () => false,
      install: async () => {
        events.push('install');
      },
    });
    const h = harness({ manager: fm.m, prompt: p, isTty: true });
    expect(await setupCommand([], h.io, h.deps)).toBe(0);
    expect(events.slice(-3)).toEqual([
      "confirm Keep Kage running when you're logged out?",
      'close',
      'install',
    ]);
    expect(fm.linger.enabled).toBe(0);
    expect(h.out).not.toContain(LINGER_ON);
  });

  it('Ctrl+C at a question: Setup stopped., exit 130, and nothing written or installed', async () => {
    const p: Prompter = {
      ask: async (q, d) => {
        if (q === 'Port') throw new DOMException('Setup stopped.', 'AbortError');
        return d;
      },
      confirm: async (_q, d) => d,
    };
    const h = harness({ prompt: p, isTty: true });
    expect(await setupCommand([], h.io, h.deps)).toBe(130);
    expect(h.err).toEqual(['Setup stopped.']);
    expect(existsSync(cfgFile)).toBe(false);
    expect(existsSync(join(home, 'projects'))).toBe(false);
    expect(h.settings).toEqual([]);
    expect(h.fm.installs).toEqual([]);
  });

  it("a tailnet address that isn't this machine's is refused at the question", async () => {
    const h = harness();
    expect(await setupCommand(['--yes', '--host', '100.101.102.200'], h.io, h.deps)).toBe(1);
    expect(h.out).toContain(
      '100.101.102.200 is another machine on your tailnet (100.101.102.200), not this one.',
    );
    expect(existsSync(cfgFile)).toBe(false);

    mkdirSync(join(home, 'projects'));
    const s = scripted(['', 'other.tail1234.ts.net', '100.101.102.103', '', true]);
    const g = harness({
      prompt: s.p,
      isTty: true,
      lookup: async () => [{ address: '100.101.102.200', family: 4 }],
    });
    expect(await setupCommand([], g.io, g.deps)).toBe(0);
    expect(g.out).toContain(
      'other.tail1234.ts.net is another machine on your tailnet (100.101.102.200), not this one.',
    );
    expect(readCfg().host).toBe('100.101.102.103');
  });

  it('a Kage answering on another port (an old kage serve) is not taken for the new unit', async () => {
    let first: () => void = () => {};
    const started = new Promise<void>((r) => {
      first = r;
    });
    let polled = 0;
    const h = harness({
      waitMs: 1000,
      status: async () => {
        if (polled++ === 0) {
          vi.useFakeTimers();
          first();
        }
        return UP; // http://box:8080
      },
    });
    const done = setupCommand(['--yes', '--port', '9090'], h.io, h.deps);
    await started;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toBe(1);
    expect(h.out.at(-1)).toBe(
      'A Kage at http://box:8080 answers instead, not on port 9090. Another kage serve may be running: stop it, then run kage setup again.',
    );
    expect(h.urls).toEqual([]);
    expect(polled).toBeGreaterThan(2);
  });
});

describe('suggestProjectsRoot', () => {
  it('~/projects when it exists', async () => {
    mkdirSync(join(home, 'projects'));
    mkdirSync(join(home, 'code', 'a', '.git'), { recursive: true });
    expect(await suggestProjectsRoot(home)).toBe('~/projects');
  });

  it('the folder with the most git repos one level down', async () => {
    for (const r of ['a', 'b', 'c']) mkdirSync(join(home, 'code', r, '.git'), { recursive: true });
    mkdirSync(join(home, 'misc', 'd', '.git'), { recursive: true });
    mkdirSync(join(home, '.cache', 'e', '.git'), { recursive: true });
    mkdirSync(join(home, '.cache', 'f', '.git'), { recursive: true });
    mkdirSync(join(home, '.cache', 'g', '.git'), { recursive: true });
    mkdirSync(join(home, '.cache', 'h', '.git'), { recursive: true });
    expect(await suggestProjectsRoot(home)).toBe('~/code');
  });

  it('~/projects when no folder holds a repo', async () => {
    mkdirSync(join(home, 'Documents'));
    expect(await suggestProjectsRoot(home)).toBe('~/projects');
  });
});

describe('servicePath (R110-8, F23)', () => {
  it('the PATH as it is (absolute folders, each once), then node in bundle mode and an absolute KAGE_CLAUDE_BIN', () => {
    expect(
      servicePath(
        {
          PATH: '/home/u/.local/bin:.:relative/bin:/usr/bin:/mnt/c/Program Files/x:/usr/bin',
          KAGE_CLAUDE_BIN: '/opt/claude/bin/claude',
        },
        BUNDLE,
      ),
    ).toBe('/home/u/.local/bin:/usr/bin:/mnt/c/Program Files/x:/opt/node/bin:/opt/claude/bin');
  });

  it('a SEA adds no node; no PATH gives the usual folders', () => {
    expect(servicePath({}, { kind: 'sea', exe: '/home/u/.local/bin/kage' })).toBe(
      '/usr/local/bin:/usr/bin:/bin',
    );
  });
});
