import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../main.ts';
import type { CheckDeps } from './checks.ts';
import { doctorCommand } from './doctor.ts';
import type { Run, RunResult } from './run.ts';
import { KAGE_VERSION } from './runtime.ts';
import type { ServiceManager } from './service.ts';

const PORT = 8123;

/** A table-driven Run: "cmd args…" → its result; anything else is a missing program. */
function tableRun(table: Record<string, Partial<RunResult>>) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) return { code: -1, stdout: '', stderr: `${cmd}: not found`, missing: true };
    return { code: 0, stdout: '', stderr: '', missing: false, ...hit };
  };
  return { run, calls };
}

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
};

function tool(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

let dir: string;
let home: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-doctor-'));
  home = join(dir, 'home');
  bin = join(home, '.local', 'bin');
  for (const t of ['tmux', 'git', 'claude', 'tailscale', 'kage']) tool(bin, t);
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '');
  const cfgDir = join(home, '.config', 'kage');
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg = join(cfgDir, 'config.json');
  writeFileSync(
    cfg,
    JSON.stringify({ host: '127.0.0.1', port: PORT, projectsRoot: join(home, 'projects') }),
    { mode: 0o600 },
  );
  chmodSync(cfg, 0o600);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manager(over: Partial<ServiceManager> = {}): ServiceManager {
  return {
    kind: 'systemd',
    file: join(home, '.config', 'systemd', 'user', 'kage.service'),
    name: 'systemd user unit kage.service',
    unavailable: async () => null,
    install: async () => {},
    restart: async () => {},
    remove: async () => {},
    state: async () => 'active',
    pathOfInstalled: async () => [bin, '/usr/bin'].join(delimiter),
    lingerEnabled: async () => true,
    ...over,
  };
}

/** Every check passing: Linux, a SEA in ~/.local/bin, the service up, the server answering. */
function passing(table = GOOD, over: Partial<CheckDeps> = {}) {
  const t = tableRun(table);
  const urls: string[] = [];
  const d: CheckDeps = {
    run: t.run,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
      PATH: [bin, '/usr/bin'].join(delimiter),
    },
    platform: 'linux',
    uid: 1000,
    home,
    mode: { kind: 'sea', exe: join(bin, 'kage') },
    manager: manager(),
    status: async () => ({
      version: KAGE_VERSION,
      url: `http://127.0.0.1:${PORT}`,
      sessions: 2,
      needsYou: 1,
      pid: 999,
    }),
    fetch: (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(null, { status: 401 });
    }) as typeof fetch,
    ...over,
  };
  return { d, calls: t.calls, urls };
}

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

describe('kage doctor', () => {
  it('every check passing: exit 0, every line a ✓, and the summary', async () => {
    const { d } = passing();
    const o = io();
    expect(await doctorCommand([], o.io, d)).toBe(0);
    const lines = o.out.filter((l) => /^[✓!✗] /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(13);
    expect(lines.filter((l) => !l.startsWith('✓ '))).toEqual([]);
    expect(o.out[0]).toBe(`Kage ${KAGE_VERSION}`);
    expect(o.out.at(-1)).toBe('Everything looks good.');
    expect(o.out).toContain('✓ tmux 3.4');
    expect(o.out).toContain('✓ git 2.43.0');
    expect(o.err).toEqual([]);
  });

  it("doctor's calls: one fetch to Kage's own loopback address, and only probes of the allowed programs", async () => {
    const { d, calls, urls } = passing();
    await doctorCommand([], io().io, d);
    expect(urls).toEqual([`http://127.0.0.1:${PORT}/`]);
    const allowed = new Set([
      'tmux',
      'git',
      'claude',
      'tailscale',
      'systemctl',
      'loginctl',
      'launchctl',
      'apt-get',
      'dnf',
      'pacman',
      'brew',
    ]);
    expect(calls.length).toBeGreaterThan(0);
    for (const { cmd, args } of calls) {
      expect(allowed.has(cmd), cmd).toBe(true);
      expect(args.some((a) => /^(install|-S|enable-linger|enable|start|restart|up)$/.test(a))).toBe(
        false,
      );
    }
  });

  it('only warnings: exit 0, and the summary says so', async () => {
    const { d } = passing(GOOD, { manager: manager({ lingerEnabled: async () => false }) });
    const o = io();
    expect(await doctorCommand([], o.io, d)).toBe(0);
    expect(o.out).toContain('! The service is running, but it stops when you log out.');
    expect(o.out.at(-1)).toBe('Kage can run. The ! lines are worth a look.');
  });

  it('any fail: exit 1, with the fix under it', async () => {
    const { 'tmux -V': _, ...noTmux } = GOOD;
    const { d } = passing(noTmux);
    const o = io();
    expect(await doctorCommand([], o.io, d)).toBe(1);
    const at = o.out.indexOf("✗ tmux isn't installed.");
    expect(at).toBeGreaterThan(0);
    expect(o.out[at + 1]).toBe('  sudo apt install tmux');
    expect(o.out.at(-1)).toBe('Fix the ✗ lines, then run kage doctor again.');
  });

  it('Windows: one line, exit 1, nothing else checked', async () => {
    const { d, calls, urls } = passing(GOOD, { platform: 'win32', uid: undefined, manager: null });
    const o = io();
    expect(await doctorCommand([], o.io, d)).toBe(1);
    expect(o.out).toContain('✗ Kage runs on Linux or macOS. On Windows, install it inside WSL.');
    expect(o.out.filter((l) => /^[✓!✗] /.test(l))).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('refuses arguments', async () => {
    const o = io();
    expect(await doctorCommand(['--fix'], o.io, passing().d)).toBe(1);
    expect(o.err).toEqual(['kage doctor takes no arguments.']);
  });
});
