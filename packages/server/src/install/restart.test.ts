import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import { logsArgv, logsCommand, restartCommand } from './restart.ts';
import type { ServiceManager, ServiceState } from './service.ts';

let dir: string;
let home: string;
let unit: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-restart-'));
  home = join(dir, 'home');
  unit = join(home, '.config', 'systemd', 'user', 'kage.service');
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, '# Written by kage setup\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: {},
    stdin: Readable.from([]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io: value, out, err };
}

/** A fake manager that records what was asked of it; it never runs systemctl or launchctl. */
function manager(state: ServiceState | Error = 'active', over: Partial<ServiceManager> = {}) {
  const calls: string[] = [];
  const m: ServiceManager = {
    kind: 'systemd',
    file: unit,
    name: 'systemd user unit kage.service',
    unavailable: async () => {
      calls.push('unavailable');
      return null;
    },
    install: async () => {
      calls.push('install');
    },
    restart: async () => {
      calls.push('restart');
    },
    remove: async () => {
      calls.push('remove');
    },
    state: async () => {
      calls.push('state');
      if (state instanceof Error) throw state;
      return state;
    },
    pathOfInstalled: async () => null,
    ...over,
  };
  return { m, calls };
}

const status = (pid: number): ServerStatus => ({
  version: '9.8.7',
  url: 'http://box.tail1234.ts.net:8080',
  sessions: 0,
  needsYou: 0,
  pid,
});

/** /status answers from a script: one entry per ask, the last one repeated. */
function scripted(answers: (ServerStatus | null)[]) {
  const asked: string[] = [];
  let i = 0;
  const fn = async (socket: string) => {
    asked.push(socket);
    const a = answers[Math.min(i, answers.length - 1)] ?? null;
    i += 1;
    return a;
  };
  return { fn, asked };
}

function deps(
  m: ServiceManager | null,
  st: (socket: string) => Promise<ServerStatus | null>,
  over: { uid?: number; waitMs?: number } = {},
) {
  return {
    manager: m,
    env: { HOME: home, KAGE_SOCKET: join(dir, 'kage.sock') },
    platform: 'linux' as const,
    status: st,
    uid: over.uid ?? 1000,
    waitMs: over.waitMs ?? 2000,
  };
}

const NOT_INSTALLED = "Kage's service isn't installed. Run kage setup, or run kage serve yourself.";

describe('kage restart (usability U9)', () => {
  it('restart restarts the service and waits for /status', async () => {
    const { m, calls } = manager('active');
    // The old process answers until the new one (another pid) is up.
    const s = scripted([status(100), status(100), null, status(200)]);
    const o = io();
    expect(await restartCommand([], o.io, deps(m, s.fn))).toBe(0);
    expect(calls).toEqual(['unavailable', 'state', 'restart']);
    expect(o.out).toEqual([
      'Restarted Kage.',
      'Kage is running at http://box.tail1234.ts.net:8080',
    ]);
    expect(o.err).toEqual([]);
    expect(new Set(s.asked)).toEqual(new Set([join(dir, 'kage.sock')]));
  });

  it('a stopped or failed service is started the same way', async () => {
    for (const state of ['inactive', 'failed', 'starting'] as const) {
      const { m, calls } = manager(state);
      const s = scripted([null, status(7)]);
      const o = io();
      expect(await restartCommand([], o.io, deps(m, s.fn))).toBe(0);
      expect(calls).toContain('restart');
      expect(o.out.at(-1)).toBe('Kage is running at http://box.tail1234.ts.net:8080');
    }
  });

  it('no answer after the restart: says so with the log, exit 1', async () => {
    const { m } = manager('active');
    const o = io();
    expect(await restartCommand([], o.io, deps(m, scripted([null]).fn, { waitMs: 50 }))).toBe(1);
    expect(o.out).toEqual(['Restarted Kage.']);
    expect(o.err).toEqual([
      "Kage didn't answer after the restart. See: journalctl --user -u kage -e",
    ]);
  });

  it('only the old process answering is not an answer (launchd: the log file)', async () => {
    const { m } = manager('active', { kind: 'launchd', name: 'launchd agent io.eridian.kage' });
    const o = io();
    const st = scripted([status(100)]);
    expect(await restartCommand([], o.io, deps(m, st.fn, { waitMs: 50 }))).toBe(1);
    expect(o.err).toEqual(["Kage didn't answer after the restart. See: ~/Library/Logs/kage.log"]);
  });

  it('no service installed: what to run instead, and nothing is restarted', async () => {
    const { m, calls } = manager('missing');
    const o = io();
    expect(await restartCommand([], o.io, deps(m, scripted([null]).fn))).toBe(1);
    expect(o.err).toEqual([NOT_INSTALLED]);
    expect(calls).not.toContain('restart');
    // No service manager here at all (another platform, or no uid).
    const o2 = io();
    expect(await restartCommand([], o2.io, deps(null, scripted([null]).fn))).toBe(1);
    expect(o2.err).toEqual([NOT_INSTALLED]);
  });

  it("R112: unavailable() first; its reason is the answer, and state() isn't called", async () => {
    const why =
      'systemctl --user doesn\'t answer, so Kage can\'t install its service. Run "kage serve" yourself, or log in with a full session.';
    const { m, calls } = manager('active', { unavailable: async () => why });
    const o = io();
    expect(await restartCommand([], o.io, deps(m, scripted([null]).fn))).toBe(1);
    expect(o.err).toEqual([why]);
    expect(calls).toEqual([]);
  });

  it('a restart the manager refuses: its reason and what to do, exit 1', async () => {
    const { m } = manager('active', {
      restart: async () => {
        throw new Error('systemctl --user restart kage.service failed\nmore');
      },
    });
    const o = io();
    expect(await restartCommand([], o.io, deps(m, scripted([null]).fn))).toBe(1);
    expect(o.out).toEqual([]);
    expect(o.err).toEqual([
      "Couldn't restart the systemd user unit kage.service: systemctl --user restart kage.service failed",
      'Run kage setup again, or run kage doctor to see why.',
    ]);
  });

  it("a state it can't read: tries the restart anyway", async () => {
    const { m, calls } = manager(new Error('Failed to connect to bus'));
    const o = io();
    expect(await restartCommand([], o.io, deps(m, scripted([null, status(3)]).fn))).toBe(0);
    expect(calls).toContain('restart');
  });

  it('refuses arguments and root, before asking the manager anything', async () => {
    const { m, calls } = manager('active');
    const o = io();
    expect(await restartCommand(['--now'], o.io, deps(m, scripted([null]).fn))).toBe(1);
    expect(o.err).toEqual(['kage restart takes no arguments.']);
    const r = io();
    expect(await restartCommand([], r.io, deps(m, scripted([null]).fn, { uid: 0 }))).toBe(1);
    expect(r.err).toEqual(['Run Kage as your own user, not root.']);
    expect(calls).toEqual([]);
  });
});

describe('kage logs (usability U9, R144)', () => {
  const JOURNAL = ['--user', '-u', 'kage', '-n', '100', '--no-pager'];

  it('logsArgv: the last 100 lines of the unit or the plist log file; -f only when asked', () => {
    const { m } = manager();
    expect(logsArgv(m, '/home/u')).toEqual(['journalctl', JOURNAL]);
    expect(logsArgv(m, '/home/u', true)).toEqual(['journalctl', [...JOURNAL, '-f']]);
    const l = manager('active', { kind: 'launchd' }).m;
    const file = join('/Users/u', 'Library', 'Logs', 'kage.log');
    expect(logsArgv(l, '/Users/u')).toEqual(['tail', ['-n', '100', file]]);
    expect(logsArgv(l, '/Users/u', true)).toEqual(['tail', ['-n', '100', '-f', file]]);
  });

  it('logs runs journalctl with inherited output: the last lines, then -f or --follow follows', async () => {
    const { m } = manager();
    const spawned: [string, string[]][] = [];
    const spawn = async (cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      return 0;
    };
    const o = io();
    expect(await logsCommand([], o.io, { manager: m, home, spawn })).toBe(0);
    expect(await logsCommand(['-f'], o.io, { manager: m, home, spawn })).toBe(0);
    expect(await logsCommand(['--follow'], o.io, { manager: m, home, spawn })).toBe(0);
    expect(spawned).toEqual([
      ['journalctl', JOURNAL],
      ['journalctl', [...JOURNAL, '-f']],
      ['journalctl', [...JOURNAL, '-f']],
    ]);
    expect(o.out).toEqual([]);
    expect(o.err).toEqual([]);
  });

  it("the program's exit code is kage logs' own", async () => {
    const { m } = manager();
    expect(await logsCommand([], io().io, { manager: m, home, spawn: async () => 3 })).toBe(3);
  });

  it("a program that won't run: what failed and what to do", async () => {
    const { m } = manager();
    const o = io();
    const spawn = async () => {
      throw Object.assign(new Error('spawn journalctl ENOENT'), { code: 'ENOENT' });
    };
    expect(await logsCommand(['-f'], o.io, { manager: m, home, spawn })).toBe(1);
    expect(o.err).toEqual([
      "Couldn't run journalctl --user -u kage -n 100 --no-pager -f (ENOENT).",
      'Run kage doctor to see why.',
    ]);
  });

  it('no service installed, or no manager: what to run instead, and nothing runs', async () => {
    const spawned: string[] = [];
    const spawn = async (cmd: string) => {
      spawned.push(cmd);
      return 0;
    };
    rmSync(unit);
    const o = io();
    expect(await logsCommand([], o.io, { manager: manager().m, home, spawn })).toBe(1);
    expect(o.err).toEqual([NOT_INSTALLED]);
    const o2 = io();
    expect(await logsCommand([], o2.io, { manager: null, home, spawn })).toBe(1);
    expect(o2.err).toEqual([NOT_INSTALLED]);
    expect(spawned).toEqual([]);
  });

  it('refuses any other argument, and -f given twice is still one -f', async () => {
    const spawned: string[][] = [];
    const spawn = async (_c: string, a: string[]) => {
      spawned.push(a);
      return 0;
    };
    for (const args of [['-n', '5'], ['now'], ['-f', 'x']]) {
      const o = io();
      expect(await logsCommand(args, o.io, { manager: manager().m, home, spawn })).toBe(1);
      expect(o.err).toEqual(['kage logs takes only -f (or --follow).']);
    }
    expect(spawned).toEqual([]);
    expect(
      await logsCommand(['-f', '--follow'], io().io, { manager: manager().m, home, spawn }),
    ).toBe(0);
    expect(spawned).toEqual([[...JOURNAL, '-f']]);
  });
});
