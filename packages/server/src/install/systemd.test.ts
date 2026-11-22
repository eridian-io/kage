import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.ts';
import type { Run, RunResult } from './run.ts';
import { serviceArgv, serviceEnv } from './runtime.ts';
import { type ServiceDeps, type ServiceSpec, serviceManager } from './service.ts';
import {
  parseSystemdWords,
  renderUnit,
  SYSTEMD_UNIT,
  systemdManager,
  systemdQuote,
} from './systemd.ts';

const isWin = process.platform === 'win32';

const BUNDLE: ServiceSpec = {
  argv: serviceArgv({ kind: 'bundle', node: '/usr/bin/node', script: '/opt/kage/dist/kage.mjs' }),
  env: serviceEnv(
    { kind: 'bundle', node: '/usr/bin/node', script: '/opt/kage/dist/kage.mjs' },
    '/home/u/.local/node/bin:/usr/bin:/bin',
  ),
};

/** A Run that records each call and answers from a script (default: exit 0, no output). */
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
  dir = mkdtempSync(join(tmpdir(), 'kage-systemd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(run: Run, extra: Partial<ServiceDeps> = {}): ServiceDeps {
  return { run, home: join(dir, 'home'), env: {}, uid: 1000, wsl: () => false, ...extra };
}

const unitPath = () => join(dir, 'home', '.config', 'systemd', 'user', SYSTEMD_UNIT);

describe('renderUnit', () => {
  it('the bundle spec gives the unit, line for line', () => {
    expect(renderUnit(BUNDLE).split('\n')).toEqual([
      '# Written by kage setup',
      '[Unit]',
      'Description=Kage: a dashboard for your Claude Code sessions',
      "# User units can't wait for tailscaled.service; Kage exits while Tailscale has no address and systemd starts it again.",
      'StartLimitIntervalSec=0',
      '',
      '[Service]',
      'ExecStart="/usr/bin/node" "--v8-pool-size=1" "/opt/kage/dist/kage.mjs" "serve"',
      'Environment="PATH=/home/u/.local/node/bin:/usr/bin:/bin" "MALLOC_ARENA_MAX=2" "KAGE_SERVICE=1"',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ]);
  });

  it('R91: ExecStart carries --v8-pool-size=1 and Environment MALLOC_ARENA_MAX=2', () => {
    const unit = renderUnit(BUNDLE);
    expect(unit).toMatch(/^ExecStart=.*"--v8-pool-size=1"/m);
    expect(unit).toMatch(/^Environment=.*"MALLOC_ARENA_MAX=2"/m);
    expect(unit).toMatch(/^Environment=.*"KAGE_SERVICE=1"/m);
  });

  it('the SEA spec runs the exe with serve', () => {
    const exe = '/home/u/.local/bin/kage';
    const unit = renderUnit({
      argv: serviceArgv({ kind: 'sea', exe }),
      env: serviceEnv({ kind: 'sea', exe }, '/usr/bin'),
    });
    expect(unit).toContain('ExecStart="/home/u/.local/bin/kage" "serve"\n');
  });

  it('ExecStart quotes the executable as a path and the rest as arguments', () => {
    const unit = renderUnit({ argv: ['/opt/a $b%c/kage', 'x$y', 'q"z'], env: {} });
    expect(unit).toContain('ExecStart="/opt/a $b%%c/kage" "x$$y" "q\\"z"\n');
    expect(() => renderUnit({ argv: ['/opt/a"b/kage', 'serve'], env: {} })).toThrow();
  });

  it('a PATH with a space (WSL /mnt/c entries) survives quoted', () => {
    const path = '/usr/bin:/mnt/c/Program Files/Git/cmd:/bin';
    const unit = renderUnit({ argv: ['/a b/kage', 'serve'], env: { PATH: path } });
    expect(unit).toContain('ExecStart="/a b/kage" "serve"\n');
    expect(unit).toContain('Environment="PATH=/usr/bin:/mnt/c/Program Files/Git/cmd:/bin"\n');
    const line = unit.split('\n').find((l) => l.startsWith('Environment=')) ?? '';
    expect(parseSystemdWords(line.slice('Environment='.length), 'env')).toEqual([`PATH=${path}`]);
  });
});

describe('systemdQuote', () => {
  it('Review Focus 2: quotes, escapes \\ and ", doubles % and $', () => {
    expect(systemdQuote('/home/a b/%h$x"q/kage')).toBe('"/home/a b/%%h$$x\\"q/kage"');
    expect(systemdQuote('a\\b')).toBe('"a\\\\b"');
  });

  it("in Environment= a $ isn't special, so it isn't doubled (systemd.exec)", () => {
    expect(systemdQuote('PATH=/home/a b/%h$x"q', 'env')).toBe('"PATH=/home/a b/%%h$x\\"q"');
  });

  it('the executable (path) keeps $ single and refuses what systemd refuses (" \' \\)', () => {
    expect(systemdQuote('/opt/a $b%c/kage', 'path')).toBe('"/opt/a $b%%c/kage"');
    for (const bad of ['/opt/a"b/kage', "/opt/a'b/kage", '/opt/a\\b/kage']) {
      expect(() => systemdQuote(bad, 'path')).toThrow(/quote or a backslash/);
    }
  });

  it('refuses control characters, which a unit line cannot hold', () => {
    expect(() => systemdQuote('a\nb')).toThrow();
    expect(() => systemdQuote('a\rb')).toThrow();
    expect(() => systemdQuote('a\u0000b')).toThrow();
  });

  it('parseSystemdWords reverses it, for both contexts', () => {
    const words = ['/home/a b/%h$x"q/kage', 'x\\y', "it's", '$$', '%%'];
    for (const ctx of ['exec', 'env'] as const) {
      const line = words.map((w) => systemdQuote(w, ctx)).join(' ');
      expect(parseSystemdWords(line, ctx)).toEqual(words);
    }
  });
});

describe('no secrets in the unit', () => {
  it('the spec carries no config; the env has only its own keys, and no config value appears', () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      token: 'tok-1234567890abcdef',
      ntfyTopic: 'topic-secret-77',
      ntfyToken: 'tk_ntfysecret99',
      ntfyServer: 'https://ntfy.example.test',
    };
    const env = serviceEnv({ kind: 'sea', exe: '/home/u/.local/bin/kage' }, '/usr/bin:/bin');
    expect(Object.keys(env).sort()).toEqual(['KAGE_SERVICE', 'MALLOC_ARENA_MAX', 'PATH']);
    const unit = renderUnit({ argv: ['/home/u/.local/bin/kage', 'serve'], env });
    for (const v of [cfg.token, cfg.ntfyTopic, cfg.ntfyToken, cfg.ntfyServer]) {
      expect(unit).not.toContain(v);
    }
  });
});

describe('systemdManager', () => {
  it('names its unit and file', () => {
    const m = systemdManager(deps(fakeRun().run));
    expect(m.kind).toBe('systemd');
    expect(m.name).toBe('systemd user unit kage.service');
    expect(m.file).toBe(unitPath());
  });

  it('XDG_CONFIG_HOME moves the unit folder', () => {
    const xdg = join(dir, 'xdg');
    const m = systemdManager(deps(fakeRun().run, { env: { XDG_CONFIG_HOME: xdg } }));
    expect(m.file).toBe(join(xdg, 'systemd', 'user', SYSTEMD_UNIT));
  });

  it('first install: writes the file, then daemon-reload and enable --now', async () => {
    const { run, calls } = fakeRun();
    const m = systemdManager(deps(run));
    await m.install(BUNDLE);
    expect(readFileSync(unitPath(), 'utf8')).toBe(renderUnit(BUNDLE));
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now kage.service',
    ]);
  });

  it('installing again: rewrites the file, then daemon-reload, enable and restart', async () => {
    const { run, calls } = fakeRun();
    const m = systemdManager(deps(run));
    await m.install(BUNDLE);
    calls.length = 0;
    const next = { ...BUNDLE, env: { ...BUNDLE.env, PATH: '/new/bin:/usr/bin' } };
    await m.install(next);
    expect(readFileSync(unitPath(), 'utf8')).toBe(renderUnit(next));
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable kage.service',
      'systemctl --user restart kage.service',
    ]);
  });

  it.runIf(!isWin)('the unit file is 0644 and its folder is created', async () => {
    const m = systemdManager(deps(fakeRun().run));
    await m.install(BUNDLE);
    expect(statSync(unitPath()).mode & 0o777).toBe(0o644);
  });

  it('the folder is created (every platform)', async () => {
    const m = systemdManager(deps(fakeRun().run));
    expect(existsSync(join(dir, 'home', '.config'))).toBe(false);
    await m.install(BUNDLE);
    expect(existsSync(unitPath())).toBe(true);
  });

  it('a failing systemctl step fails the install with its stderr', async () => {
    const { run } = fakeRun((_c, args) =>
      args.includes('enable') ? { code: 1, stderr: 'Failed to enable unit: boom' } : {},
    );
    const m = systemdManager(deps(run));
    await expect(m.install(BUNDLE)).rejects.toThrow(/boom/);
  });

  it('restart runs restart', async () => {
    const { run, calls } = fakeRun();
    await systemdManager(deps(run)).restart();
    expect(calls).toEqual(['systemctl --user restart kage.service']);
  });

  it('remove: disable --now, delete the file and its wants link, daemon-reload', async () => {
    const { run, calls } = fakeRun();
    const m = systemdManager(deps(run));
    await m.install(BUNDLE);
    const wants = join(dir, 'home', '.config', 'systemd', 'user', 'default.target.wants');
    mkdirSync(wants, { recursive: true });
    writeFileSync(join(wants, SYSTEMD_UNIT), 'left behind');
    calls.length = 0;
    await m.remove();
    expect(calls).toEqual([
      'systemctl --user disable --now kage.service',
      'systemctl --user daemon-reload',
    ]);
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(join(wants, SYSTEMD_UNIT))).toBe(false);
  });

  it('remove on a missing service succeeds and disables nothing', async () => {
    const { run, calls } = fakeRun();
    await expect(systemdManager(deps(run)).remove()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('remove of an installed unit that fails to disable (not loaded) still succeeds', async () => {
    const m0 = systemdManager(deps(fakeRun().run));
    await m0.install(BUNDLE);
    const { run, calls } = fakeRun((_c, args) =>
      args.includes('disable')
        ? { code: 1, stderr: 'Failed to disable unit: Unit file kage.service does not exist.' }
        : {},
    );
    await expect(systemdManager(deps(run)).remove()).resolves.toBeUndefined();
    expect(calls).toEqual([
      'systemctl --user disable --now kage.service',
      'systemctl --user daemon-reload',
    ]);
    expect(existsSync(unitPath())).toBe(false);
  });

  it('remove without systemctl at all still deletes the file', async () => {
    const m = systemdManager(deps(fakeRun().run));
    await m.install(BUNDLE);
    const gone = systemdManager(deps(fakeRun(() => ({ code: -1, missing: true })).run));
    await expect(gone.remove()).resolves.toBeUndefined();
    expect(existsSync(unitPath())).toBe(false);
  });

  describe('state (R110-9: the is-active word, not its code)', () => {
    const cases: [string, number, string, boolean, string][] = [
      ['active', 0, 'active', true, 'active'],
      ['reloading', 0, 'reloading', true, 'active'],
      ['activating (R111: auto-restart, no Tailscale yet)', 3, 'activating', true, 'starting'],
      ['failed', 3, 'failed', true, 'failed'],
      ['inactive', 3, 'inactive', true, 'inactive'],
      ['deactivating', 3, 'deactivating', true, 'inactive'],
      ['inactive, but the file is gone', 3, 'inactive', false, 'missing'],
      ['missing (exit 4)', 4, 'inactive', false, 'missing'],
    ];
    for (const [label, code, word, file, want] of cases) {
      it(`${label} → ${want}`, async () => {
        const { run, calls } = fakeRun((_c, args) =>
          args.includes('is-active') ? { code, stdout: `${word}\n` } : {},
        );
        const m = systemdManager(deps(run));
        if (file) await m.install(BUNDLE);
        calls.length = 0;
        expect(await m.state()).toBe(want);
        expect(calls).toEqual(['systemctl --user is-active kage.service']);
      });
    }

    it('no user manager (exit 1, no bus) throws with systemctl’s words', async () => {
      const { run } = fakeRun(() => ({
        code: 1,
        stderr: 'Failed to connect to bus: No medium found',
      }));
      await expect(systemdManager(deps(run)).state()).rejects.toThrow(/No medium found/);
    });
  });

  describe('unavailable', () => {
    it('null when the user manager answers', async () => {
      const { run, calls } = fakeRun((_c, args) =>
        args.includes('is-active') ? { code: 4, stdout: 'inactive\n' } : {},
      );
      expect(await systemdManager(deps(run)).unavailable()).toBeNull();
      expect(calls).toEqual(['systemctl --user is-active kage.service']);
    });

    it('WSL without systemd gives the wsl.conf sentence', async () => {
      const { run } = fakeRun(() => ({
        code: 1,
        stderr: 'System has not been booted with systemd as init system (PID 1). Can’t operate.',
      }));
      expect(await systemdManager(deps(run, { wsl: () => true })).unavailable()).toBe(
        'systemd isn\'t running in this WSL distribution. Add "[boot]" and "systemd=true" to /etc/wsl.conf, then run "wsl --shutdown" in Windows and open WSL again.',
      );
    });

    it('another Linux without a user manager gives the kage serve sentence', async () => {
      const { run } = fakeRun(() => ({
        code: 1,
        stderr: 'Failed to connect to bus: No medium found',
      }));
      expect(await systemdManager(deps(run)).unavailable()).toBe(
        'systemctl --user doesn\'t answer, so Kage can\'t install its service. Run "kage serve" yourself, or log in with a full session.',
      );
    });

    it('no systemctl at all is unavailable too', async () => {
      const { run } = fakeRun(() => ({ code: -1, missing: true }));
      expect(await systemdManager(deps(run)).unavailable()).toMatch(/^systemctl --user/);
    });
  });

  it('pathOfInstalled reads the PATH back from the file, or null', async () => {
    const m = systemdManager(deps(fakeRun().run));
    expect(await m.pathOfInstalled()).toBeNull();
    const path = '/usr/bin:/mnt/c/Program Files/x%y$z"q:/bin';
    await m.install({ ...BUNDLE, env: { ...BUNDLE.env, PATH: path } });
    expect(await m.pathOfInstalled()).toBe(path);
  });

  describe('linger (never sudo)', () => {
    it('lingerEnabled reads loginctl show-user for the uid', async () => {
      const { run, calls } = fakeRun(() => ({ stdout: 'yes\n' }));
      expect(await systemdManager(deps(run)).lingerEnabled()).toBe(true);
      expect(calls).toEqual(['loginctl show-user 1000 -p Linger --value']);
      const no = fakeRun(() => ({ stdout: 'no\n' }));
      expect(await systemdManager(deps(no.run)).lingerEnabled()).toBe(false);
      const fail = fakeRun(() => ({ code: 1, stdout: '' }));
      expect(await systemdManager(deps(fail.run)).lingerEnabled()).toBe(false);
    });

    it('enableLinger runs loginctl enable-linger for oneself; true on exit 0', async () => {
      const { run, calls } = fakeRun();
      expect(await systemdManager(deps(run)).enableLinger()).toBe(true);
      expect(calls).toEqual(['loginctl enable-linger']);
    });

    it('enableLinger returns false when loginctl exits non-zero, and never runs sudo', async () => {
      const { run, calls } = fakeRun(() => ({ code: 1, stderr: 'Access denied' }));
      expect(await systemdManager(deps(run)).enableLinger()).toBe(false);
      expect(calls.every((c) => !/\bsudo\b/.test(c))).toBe(true);
      expect(calls).toEqual(['loginctl enable-linger']);
    });
  });
});

describe('systemd fix round 1', () => {
  const FOREIGN = '[Service]\nExecStart=/usr/bin/someone-else\n';

  it('install refuses a kage.service it did not write, naming the file, and runs nothing', async () => {
    mkdirSync(join(dir, 'home', '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath(), FOREIGN);
    const { run, calls } = fakeRun();
    await expect(systemdManager(deps(run)).install(BUNDLE)).rejects.toThrow(
      `${unitPath()} wasn't written by kage setup, so Kage leaves it alone.`,
    );
    expect(readFileSync(unitPath(), 'utf8')).toBe(FOREIGN);
    expect(calls).toEqual([]);
  });

  it('remove refuses a kage.service it did not write and never disables it', async () => {
    mkdirSync(join(dir, 'home', '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath(), FOREIGN);
    const { run, calls } = fakeRun();
    await expect(systemdManager(deps(run)).remove()).rejects.toThrow(unitPath());
    expect(readFileSync(unitPath(), 'utf8')).toBe(FOREIGN);
    expect(calls).toEqual([]);
  });

  it('writes atomically: no temp file is left behind', async () => {
    const m = systemdManager(deps(fakeRun().run));
    await m.install(BUNDLE);
    await m.install(BUNDLE);
    expect(readdirSync(join(dir, 'home', '.config', 'systemd', 'user'))).toEqual([SYSTEMD_UNIT]);
  });

  it.runIf(!isWin)(
    'replaces a symlink at the unit path instead of writing through it',
    async () => {
      const elsewhere = join(dir, 'elsewhere.service');
      writeFileSync(elsewhere, `# Written by kage setup\nold\n`);
      mkdirSync(join(dir, 'home', '.config', 'systemd', 'user'), { recursive: true });
      symlinkSync(elsewhere, unitPath());
      await systemdManager(deps(fakeRun().run)).install(BUNDLE);
      expect(lstatSync(unitPath()).isSymbolicLink()).toBe(false);
      expect(readFileSync(unitPath(), 'utf8')).toBe(renderUnit(BUNDLE));
      expect(readFileSync(elsewhere, 'utf8')).toBe('# Written by kage setup\nold\n');
      expect(statSync(unitPath()).mode & 0o777).toBe(0o644);
    },
  );

  it('enable --now and restart get 60 s; every run gets ServiceDeps.env', async () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' };
    const { run, opts } = fakeRun();
    const m = systemdManager(deps(run, { env }));
    await m.install(BUNDLE);
    await m.install(BUNDLE);
    await m.restart();
    await m.state();
    await m.lingerEnabled();
    await m.enableLinger();
    await m.remove();
    const t = (cmd: string) => opts.filter((o) => o.cmd === cmd).map((o) => o.timeoutMs);
    expect(t('systemctl --user enable --now kage.service')).toEqual([60_000]);
    expect(t('systemctl --user restart kage.service')).toEqual([60_000, 60_000]);
    expect(t('systemctl --user daemon-reload')).toEqual([undefined, undefined, undefined]);
    expect(opts.length).toBeGreaterThan(8);
    expect(opts.every((o) => o.env === env)).toBe(true);
  });

  it('a missing systemctl is named: "systemctl" is not installed.', async () => {
    const { run } = fakeRun(() => ({ code: -1, missing: true, stderr: 'spawn systemctl ENOENT' }));
    await expect(systemdManager(deps(run)).install(BUNDLE)).rejects.toThrow(
      /^"systemctl" is not installed\.$/,
    );
    await expect(systemdManager(deps(run)).restart()).rejects.toThrow(
      /^"systemctl" is not installed\.$/,
    );
  });

  it("ExecStart's program must be absolute", () => {
    expect(() => renderUnit({ argv: ['kage', 'serve'], env: {} })).toThrow(/absolute path/);
    expect(() => renderUnit({ argv: [], env: {} })).toThrow(/absolute path/);
    expect(() => renderUnit({ argv: ['./kage', 'serve'], env: {} })).toThrow(/absolute path/);
  });

  it('lone surrogates are refused; a whole pair is fine', () => {
    expect(() => systemdQuote('/x/\uD800/kage')).toThrow(/lone surrogate/);
    expect(() => systemdQuote('/x/\uDC00', 'env')).toThrow(/lone surrogate/);
    expect(systemdQuote('/x/😀', 'path')).toBe('"/x/😀"');
  });
});

describe('systemd fix round 2: the marker line, and read errors', () => {
  const userDir = () => join(dir, 'home', '.config', 'systemd', 'user');
  const foreign: [string, string][] = [
    ['the marker on a later line', '[Unit]\n# Written by kage setup\n[Service]\nExecStart=/x\n'],
    ['the marker inside a comment', '# Not Written by kage setup, honest\n[Service]\n'],
    ['the marker text in a Description', '[Unit]\nDescription=# Written by kage setup\n'],
    ['the marker line with trailing text', '# Written by kage setup (not)\n[Service]\n'],
    ['the marker line indented', ' # Written by kage setup\n[Service]\n'],
  ];
  for (const [label, text] of foreign) {
    it(`a foreign unit with ${label} is refused by install and remove`, async () => {
      mkdirSync(userDir(), { recursive: true });
      writeFileSync(unitPath(), text);
      const { run, calls } = fakeRun();
      const m = systemdManager(deps(run));
      await expect(m.install(BUNDLE)).rejects.toThrow(`${unitPath()} wasn't written by kage setup`);
      await expect(m.remove()).rejects.toThrow(`${unitPath()} wasn't written by kage setup`);
      expect(readFileSync(unitPath(), 'utf8')).toBe(text);
      expect(calls).toEqual([]);
    });
  }

  it('the marker as the first line passes, with CRLF too', async () => {
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(unitPath(), '# Written by kage setup\r\n[Unit]\r\n');
    const { run, calls } = fakeRun();
    await systemdManager(deps(run)).remove();
    expect(calls[0]).toBe('systemctl --user disable --now kage.service');
  });

  it('a directory at the unit path (EISDIR) is refused, naming it, and nothing runs', async () => {
    mkdirSync(unitPath(), { recursive: true });
    const { run, calls } = fakeRun();
    const m = systemdManager(deps(run));
    await expect(m.install(BUNDLE)).rejects.toThrow(`Kage can't read ${unitPath()}`);
    await expect(m.remove()).rejects.toThrow(`Kage can't read ${unitPath()}`);
    expect(calls).toEqual([]);
  });

  it.runIf(!isWin && process.getuid?.() !== 0)(
    'an unreadable unit (EACCES) is refused, naming it',
    async () => {
      mkdirSync(userDir(), { recursive: true });
      writeFileSync(unitPath(), '# Written by kage setup\n', { mode: 0o000 });
      const { run, calls } = fakeRun();
      await expect(systemdManager(deps(run)).remove()).rejects.toThrow(
        `Kage can't read ${unitPath()} (EACCES)`,
      );
      expect(calls).toEqual([]);
    },
  );
});

describe('serviceManager', () => {
  it('linux is systemd, darwin is launchd, anything else none', () => {
    const d = deps(fakeRun().run);
    expect(serviceManager('linux', d)?.kind).toBe('systemd');
    expect(serviceManager('darwin', d)?.kind).toBe('launchd');
    expect(serviceManager('win32', d)).toBeNull();
  });

  it('the systemd manager offers linger through the shared interface (F6)', () => {
    const m = serviceManager('linux', deps(fakeRun().run));
    expect(typeof m?.lingerEnabled).toBe('function');
    expect(typeof m?.enableLinger).toBe('function');
    expect(serviceManager('darwin', deps(fakeRun().run))?.enableLinger).toBeUndefined();
  });
});
