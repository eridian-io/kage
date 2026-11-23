import {
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.ts';
import { LAUNCHD_LABEL, launchdManager, plistEnvValue, renderPlist, xmlEscape } from './launchd.ts';
import type { Run, RunResult } from './run.ts';
import { serviceArgv, serviceEnv } from './runtime.ts';
import type { ServiceDeps, ServiceSpec } from './service.ts';

const isWin = process.platform === 'win32';
const SEA = { kind: 'sea', exe: '/Users/u/.local/bin/kage' } as const;
const SPEC: ServiceSpec = {
  argv: serviceArgv(SEA),
  env: serviceEnv(SEA, '/opt/homebrew/bin:/usr/bin:/bin'),
};

function fakeRun(answer: (cmd: string, args: string[]) => Partial<RunResult> = () => ({})) {
  const calls: string[] = [];
  const opts: { cmd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }[] = [];
  const run: Run = async (cmd, args, o = {}) => {
    calls.push([cmd, ...args].join(' '));
    opts.push({ cmd: [cmd, ...args].join(' '), ...o });
    return { code: 0, stdout: '', stderr: '', missing: false, ...answer(cmd, args) };
  };
  return { run, calls, opts };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-launchd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const home = () => join(dir, 'home');
const plistPath = () => join(home(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const logPath = () => join(home(), 'Library', 'Logs', 'kage.log');
const sleeps: number[] = [];
const deps = (run: Run, extra: Partial<ServiceDeps> = {}): ServiceDeps => ({
  run,
  home: home(),
  env: {},
  uid: 501,
  sleep: async (ms) => {
    sleeps.push(ms);
  },
  ...extra,
});
beforeEach(() => {
  sleeps.length = 0;
});

describe('xmlEscape', () => {
  it('Review Focus 2: escapes & < > " \'', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('refuses control characters XML 1.0 cannot hold', () => {
    expect(() => xmlEscape('a\u0001b')).toThrow();
    expect(() => xmlEscape('a\nb')).toThrow();
  });
});

describe('renderPlist', () => {
  it('the SEA spec gives the agent', () => {
    expect(renderPlist(SPEC, '/Users/u/Library/Logs/kage.log')).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<!-- Written by kage setup -->',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>io.eridian.kage</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/Users/u/.local/bin/kage</string>',
        '    <string>serve</string>',
        '  </array>',
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>PATH</key>',
        '    <string>/opt/homebrew/bin:/usr/bin:/bin</string>',
        '    <key>MALLOC_ARENA_MAX</key>',
        '    <string>2</string>',
        '    <key>KAGE_SERVICE</key>',
        '    <string>1</string>',
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <dict>',
        '    <key>SuccessfulExit</key>',
        '    <false/>',
        '  </dict>',
        '  <key>ThrottleInterval</key>',
        '  <integer>10</integer>',
        // R122: a stop never takes the tmux server's process group along.
        '  <key>AbandonProcessGroup</key>',
        '  <true/>',
        '  <key>StandardOutPath</key>',
        '  <string>/Users/u/Library/Logs/kage.log</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>/Users/u/Library/Logs/kage.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  it('the bundle spec carries --v8-pool-size=1 (R91)', () => {
    const m = { kind: 'bundle', node: '/opt/homebrew/bin/node', script: '/k/kage.mjs' } as const;
    const xml = renderPlist({ argv: serviceArgv(m), env: serviceEnv(m, '/usr/bin') }, '/l');
    expect(xml).toContain('<string>--v8-pool-size=1</string>');
  });

  it("R124: setup's folder settings reach EnvironmentVariables escaped, never an API key", () => {
    const env = serviceEnv(SEA, '/usr/bin', {
      CLAUDE_CONFIG_DIR: '/Users/u/A & B <claude>',
      XDG_STATE_HOME: '/Users/u/state',
      KAGE_TMUX_SOCKET: 'agents',
      ANTHROPIC_API_KEY: 'sk-ant-invented',
    });
    const xml = renderPlist({ argv: serviceArgv(SEA), env }, '/l');
    expect(xml).not.toContain('sk-ant-invented');
    expect(xml).not.toContain('ANTHROPIC_API_KEY');
    expect(plistEnvValue(xml, 'CLAUDE_CONFIG_DIR')).toBe('/Users/u/A & B <claude>');
    expect(plistEnvValue(xml, 'XDG_STATE_HOME')).toBe('/Users/u/state');
    expect(plistEnvValue(xml, 'KAGE_TMUX_SOCKET')).toBe('agents');
  });

  it('escapes every value: arguments, env keys and values, the log path', () => {
    const xml = renderPlist(
      { argv: [`/a b/<&>"'/kage`, 'serve'], env: { PATH: `/x&y:/p q/<z>` } },
      `/L "o"/k&g.log`,
    );
    expect(xml).toContain('<string>/a b/&lt;&amp;&gt;&quot;&apos;/kage</string>');
    expect(xml).toContain('<string>/x&amp;y:/p q/&lt;z&gt;</string>');
    expect(xml).toContain('<string>/L &quot;o&quot;/k&amp;g.log</string>');
    expect(plistEnvValue(xml, 'PATH')).toBe('/x&y:/p q/<z>');
  });

  it('no secrets: no config value appears', () => {
    const cfg = { ...DEFAULT_CONFIG, token: 'tok-1234567890abcdef', ntfyToken: 'tk_ntfysecret99' };
    const xml = renderPlist(SPEC, '/l');
    for (const v of [cfg.token, cfg.ntfyToken, cfg.ntfyServer]) expect(xml).not.toContain(v);
    expect(Object.keys(SPEC.env).sort()).toEqual(['KAGE_SERVICE', 'MALLOC_ARENA_MAX', 'PATH']);
  });
});

describe('launchdManager', () => {
  it('names its agent and file', () => {
    const m = launchdManager(deps(fakeRun().run));
    expect(m.kind).toBe('launchd');
    expect(m.name).toBe('launchd agent io.eridian.kage');
    expect(m.file).toBe(plistPath());
  });

  it('install: writes the plist and the log folder, boots out (ignored), enables, bootstraps', async () => {
    const { run, calls } = fakeRun((_c, args) =>
      args[0] === 'bootout' ? { code: 113, stderr: 'Boot-out failed: 3: No such process' } : {},
    );
    const m = launchdManager(deps(run));
    await m.install(SPEC);
    expect(readFileSync(plistPath(), 'utf8')).toBe(renderPlist(SPEC, logPath()));
    expect(existsSync(join(home(), 'Library', 'Logs'))).toBe(true);
    expect(calls).toEqual([
      'launchctl bootout gui/501/io.eridian.kage',
      'launchctl enable gui/501/io.eridian.kage',
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
  });

  it('installing again runs the same sequence', async () => {
    const { run, calls } = fakeRun();
    const m = launchdManager(deps(run));
    await m.install(SPEC);
    calls.length = 0;
    await m.install(SPEC);
    expect(calls).toEqual([
      'launchctl bootout gui/501/io.eridian.kage',
      'launchctl enable gui/501/io.eridian.kage',
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
  });

  it('bootstrap is retried on "5: Input/output error" after a bootout, then succeeds', async () => {
    let fails = 2;
    const { run, calls } = fakeRun((_c, args) =>
      args[0] === 'bootstrap' && fails-- > 0
        ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }
        : {},
    );
    await launchdManager(deps(run)).install(SPEC);
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(3);
    expect(sleeps).toEqual([500, 500]);
  });

  it('bootstrap is not retried on another error', async () => {
    const { run, calls } = fakeRun((_c, args) =>
      args[0] === 'bootstrap'
        ? { code: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' }
        : {},
    );
    await expect(launchdManager(deps(run)).install(SPEC)).rejects.toThrow(/exited 37/);
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('no retry starts once 90 s have passed since the first bootstrap', async () => {
    let clock = 0;
    const { run, calls } = fakeRun((_c, args) => {
      if (args[0] !== 'bootstrap') return {};
      clock += 60_000; // each attempt hangs until its 60 s timeout
      return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    });
    await expect(launchdManager(deps(run, { now: () => clock })).install(SPEC)).rejects.toThrow(
      /Input\/output/,
    );
    // 60 s after the first: one retry; 120 s after the second: no more.
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(2);
  });

  describe('fix round 2: the marker line, and read errors', () => {
    const agents = () => join(home(), 'Library', 'LaunchAgents');
    const head =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
    const foreign: [string, string][] = [
      [
        'the marker on a later line',
        `${head}<plist version="1.0">\n<!-- Written by kage setup -->\n</plist>\n`,
      ],
      [
        'the marker text inside a string',
        `${head}<plist version="1.0"><dict><key>X</key><string>&lt;!-- Written by kage setup --&gt;</string></dict></plist>\n`,
      ],
      [
        'the marker comment with trailing text',
        `${head}<!-- Written by kage setup --> extra\n<plist version="1.0"/>\n`,
      ],
      ['the marker as the first line', `<!-- Written by kage setup -->\n<plist version="1.0"/>\n`],
    ];
    for (const [label, text] of foreign) {
      it(`a foreign plist with ${label} is refused by install and remove`, async () => {
        mkdirSync(agents(), { recursive: true });
        writeFileSync(plistPath(), text);
        const { run, calls } = fakeRun();
        const m = launchdManager(deps(run));
        await expect(m.install(SPEC)).rejects.toThrow(
          `${plistPath()} wasn't written by kage setup`,
        );
        await expect(m.remove()).rejects.toThrow(`${plistPath()} wasn't written by kage setup`);
        expect(readFileSync(plistPath(), 'utf8')).toBe(text);
        expect(calls).toEqual([]);
      });
    }

    it('a directory at the plist path (EISDIR) is refused, naming it, and nothing runs', async () => {
      mkdirSync(plistPath(), { recursive: true });
      const { run, calls } = fakeRun();
      const m = launchdManager(deps(run));
      await expect(m.install(SPEC)).rejects.toThrow(`Kage can't read ${plistPath()}`);
      await expect(m.remove()).rejects.toThrow(`Kage can't read ${plistPath()}`);
      expect(calls).toEqual([]);
    });
  });

  it.runIf(!isWin)('the plist is 0644', async () => {
    await launchdManager(deps(fakeRun().run)).install(SPEC);
    expect(statSync(plistPath()).mode & 0o777).toBe(0o644);
  });

  it('a bootstrap that keeps failing fails the install with its stderr, after 3 retries', async () => {
    const { run, calls } = fakeRun((_c, args) =>
      args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : {},
    );
    await expect(launchdManager(deps(run)).install(SPEC)).rejects.toThrow(/Input\/output/);
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(4);
  });

  it('install and remove refuse a plist kage setup did not write, and run nothing', async () => {
    const foreign = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n';
    mkdirSync(join(home(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath(), foreign);
    const { run, calls } = fakeRun();
    const m = launchdManager(deps(run));
    await expect(m.install(SPEC)).rejects.toThrow(`${plistPath()} wasn't written by kage setup`);
    await expect(m.remove()).rejects.toThrow(plistPath());
    expect(readFileSync(plistPath(), 'utf8')).toBe(foreign);
    expect(calls).toEqual([]);
  });

  it('writes atomically: no temp file is left behind', async () => {
    const m = launchdManager(deps(fakeRun().run));
    await m.install(SPEC);
    await m.install(SPEC);
    expect(readdirSync(join(home(), 'Library', 'LaunchAgents'))).toEqual([
      `${LAUNCHD_LABEL}.plist`,
    ]);
  });

  it('bootstrap and kickstart -k get 60 s; every run gets ServiceDeps.env', async () => {
    const env = { HOME: '/Users/u' };
    const { run, opts } = fakeRun();
    const m = launchdManager(deps(run, { env }));
    await m.install(SPEC);
    await m.restart();
    await m.state();
    await m.unavailable();
    await m.remove();
    const t = (prefix: string) =>
      opts.filter((o) => o.cmd.startsWith(prefix)).map((o) => o.timeoutMs);
    expect(t('launchctl kickstart')).toEqual([60_000]);
    expect(t('launchctl bootstrap')).toEqual([60_000]);
    expect(t('launchctl bootout')).toEqual([undefined, undefined]);
    expect(opts.every((o) => o.env === env)).toBe(true);
  });

  it('a missing launchctl is named: "launchctl" is not installed.', async () => {
    const { run } = fakeRun(() => ({ code: -1, missing: true }));
    await expect(launchdManager(deps(run)).install(SPEC)).rejects.toThrow(
      /^"launchctl" is not installed\.$/,
    );
    await expect(launchdManager(deps(run)).restart()).rejects.toThrow(
      /^"launchctl" is not installed\.$/,
    );
  });

  it("ProgramArguments' program must be absolute", () => {
    expect(() => renderPlist({ argv: ['kage', 'serve'], env: {} }, '/l')).toThrow(/absolute/);
  });

  it('lone surrogates are refused; a whole pair is fine', () => {
    expect(() => xmlEscape('a\uD800b')).toThrow(/lone surrogate/);
    expect(() => xmlEscape('a\uDFFF')).toThrow(/lone surrogate/);
    expect(() => xmlEscape('a￾')).toThrow();
    expect(xmlEscape('a😀')).toBe('a😀');
  });

  it('restart is kickstart -k', async () => {
    const { run, calls } = fakeRun();
    await launchdManager(deps(run)).restart();
    expect(calls).toEqual(['launchctl kickstart -k gui/501/io.eridian.kage']);
  });

  it('remove: bootout, delete the plist; fine when missing', async () => {
    const { run, calls } = fakeRun();
    const m = launchdManager(deps(run));
    await m.install(SPEC);
    calls.length = 0;
    await m.remove();
    expect(calls).toEqual(['launchctl bootout gui/501/io.eridian.kage']);
    expect(existsSync(plistPath())).toBe(false);
    const gone = fakeRun(() => ({ code: 113, stderr: 'Could not find service' }));
    await expect(launchdManager(deps(gone.run)).remove()).resolves.toBeUndefined();
  });

  describe('state (print: "state = running", else not running)', () => {
    const printOut = (state: string, lastExit: string) =>
      `gui/501/io.eridian.kage = {\n\tactive count = 1\n\tstate = ${state}\n\tlast exit code = ${lastExit}\n}\n`;

    it('state = running → active', async () => {
      const { run, calls } = fakeRun(() => ({ stdout: printOut('running', '(never exited)') }));
      expect(await launchdManager(deps(run)).state()).toBe('active');
      expect(calls).toEqual(['launchctl print gui/501/io.eridian.kage']);
    });

    it('not running after a non-zero exit → starting: KeepAlive restarts it (the Tailscale wait, R111)', async () => {
      for (const [state, exit] of [
        ['not running', '1'],
        ['waiting', '1'],
        ['not running', '-15'],
      ] as const) {
        const { run } = fakeRun(() => ({ stdout: printOut(state, exit) }));
        expect(await launchdManager(deps(run)).state()).toBe('starting');
      }
    });

    it('not running after exit 0 → inactive', async () => {
      const { run } = fakeRun(() => ({ stdout: printOut('not running', '0') }));
      expect(await launchdManager(deps(run)).state()).toBe('inactive');
    });

    it('not loaded (exit 113): inactive with the plist, missing without', async () => {
      const { run } = fakeRun((_c, args) =>
        args[0] === 'print' ? { code: 113, stderr: 'Could not find service' } : {},
      );
      const m = launchdManager(deps(run));
      expect(await m.state()).toBe('missing');
      await m.install(SPEC);
      expect(await m.state()).toBe('inactive');
    });
  });

  it('unavailable: null with launchctl, a sentence without', async () => {
    expect(await launchdManager(deps(fakeRun().run)).unavailable()).toBeNull();
    const none = fakeRun(() => ({ code: -1, missing: true }));
    expect(await launchdManager(deps(none.run)).unavailable()).toMatch(/launchctl/);
  });

  it('pathOfInstalled reads the PATH back, or null', async () => {
    const m = launchdManager(deps(fakeRun().run));
    expect(await m.pathOfInstalled()).toBeNull();
    const path = `/opt/homebrew/bin:/Users/u/my "tools" & more:/usr/bin`;
    await m.install({ ...SPEC, env: { ...SPEC.env, PATH: path } });
    expect(await m.pathOfInstalled()).toBe(path);
  });
});
