import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import type { CheckDeps } from './checks.ts';
import { KAGE_VERSION } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';
import { statusCommand } from './status.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-status-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(state: ServiceState, over: Partial<ServiceManager> = {}): ServiceManager {
  return {
    kind: 'systemd',
    file: join(dir, 'kage.service'),
    name: 'systemd user unit kage.service',
    unavailable: async () => null,
    install: async () => {},
    restart: async () => {},
    remove: async () => {},
    state: async () => state,
    pathOfInstalled: async () => null,
    ...over,
  };
}

const UP: ServerStatus = {
  version: KAGE_VERSION,
  url: 'http://my-pc:8080',
  sessions: 4,
  needsYou: 1,
  pid: 4242,
};

function deps(m: ServiceManager | null, status: ServerStatus | null): CheckDeps {
  return {
    run: async () => ({ code: -1, stdout: '', stderr: '', missing: true }),
    env: { HOME: dir, XDG_RUNTIME_DIR: join(dir, 'run') },
    platform: 'linux',
    uid: 1000,
    home: dir,
    mode: { kind: 'sea', exe: join(dir, 'kage') },
    manager: m,
    status: async () => status,
    fetch: (async () => {
      throw new Error('status makes no request');
    }) as unknown as typeof fetch,
  };
}

function io() {
  const out: string[] = [];
  const value: Io = { env: {}, stdin: Readable.from([]), out: (l) => out.push(l), err: () => {} };
  return { io: value, out };
}

describe('kage status', () => {
  it('running: the service, the address and the sessions; exit 0', async () => {
    const o = io();
    expect(await statusCommand(o.io, deps(manager('active'), UP))).toBe(0);
    expect(o.out).toEqual([
      `Kage ${KAGE_VERSION}`,
      'Service: running (systemd user unit kage.service)',
      'Address: http://my-pc:8080',
      'Sessions: 4 (1 needs you)',
    ]);
  });

  it('counts read naturally: none needing you, and two', async () => {
    const o = io();
    await statusCommand(o.io, deps(manager('active'), { ...UP, sessions: 1, needsYou: 0 }));
    expect(o.out.at(-1)).toBe('Sessions: 1');
    const p = io();
    await statusCommand(p.io, deps(manager('active'), { ...UP, needsYou: 2 }));
    expect(p.out.at(-1)).toBe('Sessions: 4 (2 need you)');
  });

  it('stopped, failed, starting and not installed', async () => {
    const line = async (s: ServiceState) => {
      const o = io();
      await statusCommand(o.io, deps(manager(s), UP));
      return o.out[1];
    };
    expect(await line('inactive')).toBe('Service: stopped');
    expect(await line('failed')).toBe('Service: failed');
    expect(await line('starting')).toBe('Service: starting (waiting for Tailscale?)');
    expect(await line('missing')).toBe('Service: not installed');
  });

  it('the server not answering: a line naming the socket and what to do, exit 1', async () => {
    const o = io();
    expect(await statusCommand(o.io, deps(manager('missing'), null))).toBe(1);
    expect(o.out).toEqual([
      `Kage ${KAGE_VERSION}`,
      'Service: not installed',
      `Kage isn't answering on ${join(dir, 'run')}/kage.sock.`,
      'Run kage setup.',
    ]);
  });

  it('not answering with the service installed (or no service here): kage doctor says why', async () => {
    for (const s of ['active', 'starting', 'inactive', 'failed'] as const) {
      const o = io();
      expect(await statusCommand(o.io, deps(manager(s), null))).toBe(1);
      expect(o.out.at(-1)).toBe('Run kage doctor to see why.');
    }
    const cant = manager('missing', { unavailable: async () => 'No user manager.' });
    for (const m of [null, cant]) {
      const o = io();
      expect(await statusCommand(o.io, deps(m, null))).toBe(1);
      expect(o.out.at(-1)).toBe('Run kage doctor to see why.');
    }
  });

  it('no user service manager: unavailable() is asked first and state() never (R112)', async () => {
    const o = io();
    const m = manager('active', {
      unavailable: async () => "systemd isn't running in this WSL distribution.",
      state: async () => {
        throw new Error('no user manager');
      },
    });
    expect(await statusCommand(o.io, deps(m, UP))).toBe(0);
    expect(o.out[1]).toBe(
      "Service: can't run here. systemd isn't running in this WSL distribution.",
    );
  });

  it('no service manager at all, or a state that cannot be read', async () => {
    const o = io();
    await statusCommand(o.io, deps(null, UP));
    expect(o.out[1]).toBe('Service: not installed');
    const p = io();
    await statusCommand(
      p.io,
      deps(
        manager('active', {
          state: async () => {
            throw new Error('boom');
          },
        }),
        UP,
      ),
    );
    expect(p.out[1]).toBe("Service: unknown (Kage couldn't read its state)");
  });
});
