import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '', missing: false, ...answer(cmd, args) };
  };
  return { run, calls };
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
const deps = (run: Run): ServiceDeps => ({ run, home: home(), env: {}, uid: 501 });

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

  it('install: writes the plist and the log folder, boots out (ignored), bootstraps', async () => {
    const { run, calls } = fakeRun((_c, args) =>
      args[0] === 'bootout' ? { code: 113, stderr: 'Boot-out failed: 3: No such process' } : {},
    );
    const m = launchdManager(deps(run));
    await m.install(SPEC);
    expect(readFileSync(plistPath(), 'utf8')).toBe(renderPlist(SPEC, logPath()));
    expect(existsSync(join(home(), 'Library', 'Logs'))).toBe(true);
    expect(calls).toEqual([
      'launchctl bootout gui/501/io.eridian.kage',
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
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
  });

  it.runIf(!isWin)('the plist is 0644', async () => {
    await launchdManager(deps(fakeRun().run)).install(SPEC);
    expect(statSync(plistPath()).mode & 0o777).toBe(0o644);
  });

  it('a failing bootstrap fails the install with its stderr', async () => {
    const { run } = fakeRun((_c, args) =>
      args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : {},
    );
    await expect(launchdManager(deps(run)).install(SPEC)).rejects.toThrow(/Input\/output/);
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

    it('not running after a non-zero exit → failed', async () => {
      const { run } = fakeRun(() => ({ stdout: printOut('not running', '1') }));
      expect(await launchdManager(deps(run)).state()).toBe('failed');
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
