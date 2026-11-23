import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from './hooks/event.ts';
import { hookCommand } from './hooks/settings.ts';
import { KAGE_VERSION } from './install/runtime.ts';
import { fetchStatus } from './install/status.ts';
import { type Io, main, type Running, serveSignals, USAGE } from './main.ts';
import type { ExecFn } from './tmux/client.ts';
import { hasTmux } from './tmux/client.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const isWin = process.platform === 'win32';

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kage-main-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fresh HOME and XDG dirs under `root`, plus the given variables. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dirs = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return { ...dirs, ...extra };
}

function writeConfig(e: NodeJS.ProcessEnv, cfg: object): void {
  const dir = join(e.XDG_CONFIG_HOME as string, 'kage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
}

function makeDist(): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>kage</title>');
  return dist;
}

function io(e: NodeJS.ProcessEnv, over: Partial<Io> = {}): Io {
  return {
    env: e,
    stdin: Readable.from([]),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    platform: 'linux',
    tmuxVersion: 'tmux 3.4\n',
    ...over,
  };
}

const port = () => 43_000 + Math.floor(Math.random() * 2000);

describe('kage serve: live-mode checks', () => {
  it('live mode with a token goes on to the next check: the B8 refusal is gone (B13)', async () => {
    const e = env();
    writeConfig(e, { token: 'a-secret-of-16-chars', host: '127.0.0.1' });
    expect(await main(['serve'], io(e, { platform: 'win32', tmuxVersion: null }))).toBe(1);
    expect(err).toEqual([
      'Live sessions need Linux or macOS (tmux). On Windows, run Kage inside WSL, or use "kage serve --demo".',
    ]);
  });

  it('a token shorter than 16 characters is a config error', async () => {
    const e = env();
    writeConfig(e, { token: 'secret' });
    expect(await main(['serve', '--demo'], io(e, { dist: makeDist() }))).toBe(1);
    expect(err).toEqual(['Config error: token must be at least 16 characters']);
  });

  it('--demo with a token runs without a warning, and the API needs the cookie', async () => {
    const e = env({ KAGE_HOST: '127.0.0.1' });
    const p = port();
    writeConfig(e, { token: 'a-secret-of-16-chars', port: p });
    const r = await main(['serve', '--demo'], io(e, { dist: makeDist(), tmuxVersion: null }));
    expect(typeof r).toBe('object');
    const running = r as Running;
    try {
      expect(err).toEqual([]);
      expect(out).toEqual([`Kage is running at http://127.0.0.1:${p}`]);
      expect((await fetch(`http://127.0.0.1:${p}/`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${p}/api/events`)).status).toBe(401);
      // Over a real socket, the limiter keys on the peer address: 5 wrong tries, then 429.
      const base = `http://127.0.0.1:${p}`;
      const tryLogin = (token: string) =>
        fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'X-Kage': '1', Origin: base, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }).then((r) => r.status);
      for (let i = 0; i < 5; i++) expect(await tryLogin(`wrong-token-${i}-padding`)).toBe(401);
      expect(await tryLogin('a-secret-of-16-chars')).toBe(429);
    } finally {
      await running.stop();
    }
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
  });

  it('--demo without a token prints no token warning (R53 is for live mode)', async () => {
    const e = env({ KAGE_HOST: '127.0.0.1' });
    const p = port();
    writeConfig(e, { port: p });
    const r = await main(['serve', '--demo'], io(e, { dist: makeDist(), tmuxVersion: null }));
    expect(typeof r).toBe('object');
    try {
      expect(err).toEqual([]);
      expect(out).toEqual([`Kage is running at http://127.0.0.1:${p}`]);
    } finally {
      await (r as Running).stop();
    }
  });

  it('--demo: the terminal WebSocket refuses a bad Origin with 403, else closes with 4501 (Task 12)', async () => {
    const e = env({ KAGE_HOST: '127.0.0.1' });
    const p = port();
    writeConfig(e, { port: p });
    const r = await main(['serve', '--demo'], io(e, { dist: makeDist(), tmuxVersion: null }));
    expect(typeof r).toBe('object');
    const { default: WebSocket } = await import('ws');
    const url = `ws://127.0.0.1:${p}/api/sessions/docs/terminal`;
    try {
      const bad = new WebSocket(url, ['kage.term.v1'], { origin: 'http://evil.example' });
      bad.on('error', () => {});
      const status = await new Promise<number>((res) =>
        bad.on('unexpected-response', (_q, s) => res(s.statusCode ?? 0)),
      );
      expect(status).toBe(403);
      const ws = new WebSocket(url, ['kage.term.v1'], { origin: `http://127.0.0.1:${p}` });
      ws.on('error', () => {});
      const closed = await new Promise<[number, string]>((res) =>
        ws.on('close', (code, why) => res([code, why.toString()])),
      );
      expect(closed).toEqual([4501, 'Demo mode has no terminal.']);
    } finally {
      await (r as Running).stop();
    }
  });

  it('on Windows, live mode points to WSL or --demo', async () => {
    const e = env();
    expect(await main(['serve'], io(e, { platform: 'win32', tmuxVersion: null }))).toBe(1);
    expect(err).toEqual([
      'Live sessions need Linux or macOS (tmux). On Windows, run Kage inside WSL, or use "kage serve --demo".',
    ]);
  });

  it('without tmux, live mode says to install it', async () => {
    const e = env();
    expect(await main(['serve'], io(e, { tmuxVersion: null }))).toBe(1);
    expect(err).toEqual([
      `tmux isn't installed. Install tmux 3.2 or newer, or run "kage serve --demo".`,
    ]);
  });

  it('with tmux older than 3.2, live mode names the version found', async () => {
    const e = env();
    expect(await main(['serve'], io(e, { tmuxVersion: 'tmux 3.1c\n' }))).toBe(1);
    expect(err).toEqual([
      `tmux 3.1c is too old. Install tmux 3.2 or newer, or run "kage serve --demo".`,
    ]);
  });

  it('bad flags exit 1 with the usage', async () => {
    expect(await main(['serve', '--nope'], io(env()))).toBe(1);
    expect(err.join('\n')).toContain('Usage:');
  });
});

describe('kage serve: startup interrupts and late errors (B15)', () => {
  it('a signal while startup waits on ensureSession unwinds, says so and returns 130', async () => {
    const p = port();
    const e = env({ KAGE_HOST: '127.0.0.1', KAGE_PORT: String(p) });
    const ac = new AbortController();
    const calls: string[] = [];
    const tmuxExec: ExecFn = async (_cmd, args) => {
      calls.push(args.join(' '));
      // The signal arrives while tmux is still answering the first call.
      if (calls.length === 1) ac.abort();
      await new Promise((r) => setTimeout(r, 20));
      return { stdout: '', stderr: '' };
    };
    const r = await main(['serve'], io(e, { dist: makeDist(), signal: ac.signal, tmuxExec }));
    expect(r).toBe(130);
    expect(err).toEqual(['Stopped before Kage was ready.']);
    expect(out).toEqual([]);
    // Nothing after ensureSession ran: no hook socket, no settings file, no server.
    expect(calls.every((c) => /has-session|set-environment/.test(c))).toBe(true);
    if (!isWin) expect(existsSync(join(e.XDG_RUNTIME_DIR as string, 'kage.sock'))).toBe(false);
    expect(existsSync(join(e.XDG_STATE_HOME as string, 'kage', 'claude-settings.json'))).toBe(
      false,
    );
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
  });

  it('a signal that is already aborted stops before anything starts', async () => {
    const e = env({ KAGE_HOST: '127.0.0.1' });
    writeConfig(e, { port: port() });
    const ac = new AbortController();
    ac.abort();
    const r = await main(['serve', '--demo'], io(e, { dist: makeDist(), signal: ac.signal }));
    expect(r).toBe(130);
    expect(err).toEqual(['Stopped before Kage was ready.']);
    expect(out).toEqual([]);
  });

  it('a failing loadAssets prints one line with no stack trace', async () => {
    const e = env({ KAGE_HOST: '127.0.0.1' });
    writeConfig(e, { port: port() });
    const loadAssets = async () => {
      throw new Error('EACCES: permission denied, open dist/app.js\n    at readFile (x.js:1:1)');
    };
    const r = await main(['serve', '--demo'], io(e, { dist: makeDist(), loadAssets }));
    expect(r).toBe(1);
    expect(err).toEqual(["Couldn't start Kage: EACCES: permission denied, open dist/app.js"]);
    expect(out).toEqual([]);
  });
});

describe('serveSignals (B15)', () => {
  const fakeProc = () => {
    const ee = new EventEmitter();
    const exits: number[] = [];
    const proc = {
      on: (ev: string, fn: () => void) => ee.on(ev, fn),
      exit: (code?: number) => {
        exits.push(code ?? 0);
      },
    } as unknown as Pick<NodeJS.Process, 'on' | 'exit'>;
    return { ee, exits, proc };
  };

  it('the first signal during startup prints Stopping… once and aborts; a second exits 130', () => {
    const { ee, exits, proc } = fakeProc();
    const s = serveSignals(proc, (l) => err.push(l));
    expect(s.signal.aborted).toBe(false);
    ee.emit('SIGINT');
    expect(s.signal.aborted).toBe(true);
    expect(err).toEqual(['Stopping…']);
    expect(exits).toEqual([]);
    ee.emit('SIGTERM');
    expect(exits).toEqual([130]);
    expect(err).toEqual(['Stopping…']);
  });

  it('once running, the first signal stops the server and exits 0', async () => {
    const { ee, exits, proc } = fakeProc();
    const s = serveSignals(proc, (l) => err.push(l));
    let stopped = 0;
    s.started({
      stop: async () => {
        stopped++;
      },
    });
    ee.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(1);
    expect(exits).toEqual([0]);
    expect(err).toEqual(['Stopping…']);
    expect(s.signal.aborted).toBe(false);
  });

  it('a signal that came while serve was returning stops what started', async () => {
    const { ee, exits, proc } = fakeProc();
    const s = serveSignals(proc, (l) => err.push(l));
    ee.emit('SIGINT');
    let stopped = 0;
    s.started({
      stop: async () => {
        stopped++;
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(1);
    expect(exits).toEqual([0]);
  });
});

describe('kage hooks-path', () => {
  it('writes the settings under $XDG_STATE_HOME/kage and prints the path', async () => {
    const e = env();
    expect(await main(['hooks-path'], io(e))).toBe(0);
    const path = join(e.XDG_STATE_HOME as string, 'kage', 'claude-settings.json');
    expect(out).toEqual([path]);
    expect(err).toEqual([]);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    for (const event of HOOK_EVENTS) {
      expect(file.hooks[event][0].hooks[0].command).toBe(
        hookCommand([process.execPath, '--no-warnings', MAIN], event),
      );
    }
  });

  it('falls back to ~/.local/state/kage without XDG_STATE_HOME', async () => {
    const e = env();
    delete e.XDG_STATE_HOME;
    expect(await main(['hooks-path'], io(e))).toBe(0);
    expect(out).toEqual([
      join(e.HOME as string, '.local', 'state', 'kage', 'claude-settings.json'),
    ]);
  });
});

describe('kage ping (against the fake ntfy, R85)', () => {
  interface Fake {
    url: string;
    received: { path: string; headers: Record<string, string>; body: unknown }[];
    close(): Promise<void>;
  }
  const FAKE = new URL('../../../e2e/fake-ntfy.ts', import.meta.url).href;
  const startFake = async (o?: { status?: number[] }): Promise<Fake> =>
    (
      (await import(FAKE)) as { startFakeNtfy(o?: { status?: number[] }): Promise<Fake> }
    ).startFakeNtfy(o);
  const TOPIC = 'kage-ping-topic-0123456789';
  const TOKEN = 'tk_ping_secret_token_abc';
  let fake: Fake | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it('sends the test ping and prints the success line, without the topic or token', async () => {
    fake = await startFake();
    const e = env();
    // A path prefix in ntfyServer may be secret too (PF5 F15): only the host is printed.
    writeConfig(e, {
      name: 'box',
      ntfyTopic: TOPIC,
      ntfyToken: TOKEN,
      ntfyServer: `${fake.url}/secret-prefix/`,
    });
    expect(await main(['ping'], io(e))).toBe(0);
    const host = new URL(fake.url).host;
    expect(out).toEqual([`Sent a test ping to ${host}.`]);
    expect(err).toEqual([]);
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]?.path).toBe('/secret-prefix/');
    expect(fake.received[0]?.body).toEqual({
      topic: TOPIC,
      title: 'Kage test ping',
      message: 'ntfy is set up for box.',
      priority: 3,
    });
    expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const printed = [...out, ...err].join('\n');
    for (const secret of [TOPIC, TOKEN, 'secret-prefix']) expect(printed).not.toContain(secret);
  });

  it('with no topic: the exact line and exit 1', async () => {
    const e = env();
    writeConfig(e, { name: 'box' });
    expect(await main(['ping'], io(e))).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `No ntfyTopic in ${join(e.XDG_CONFIG_HOME as string, 'kage', 'config.json')}.`,
    ]);
  });

  it('a refused ping: the redacted reason and exit 1, without the topic', async () => {
    fake = await startFake({ status: [403] });
    const e = env();
    writeConfig(e, { ntfyTopic: TOPIC, ntfyServer: fake.url });
    expect(await main(['ping'], io(e))).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["Couldn't send the ping (HTTP 403)."]);
    expect(fake.received).toHaveLength(1);
  });

  it('an unreachable server: one try, the error code, exit 1', async () => {
    fake = await startFake();
    const url = fake.url;
    await fake.close();
    fake = null;
    const e = env();
    writeConfig(e, { ntfyTopic: TOPIC, ntfyServer: url });
    expect(await main(['ping'], io(e))).toBe(1);
    expect(err).toEqual(["Couldn't send the ping (ECONNREFUSED)."]);
  });

  it('a config error is one line and exit 1, without the value', async () => {
    const e = env();
    writeConfig(e, { ntfyTopic: 'secret topic' });
    expect(await main(['ping'], io(e))).toBe(1);
    expect(err).toEqual(['Config error: ntfyTopic must be up to 64 letters, digits, - or _']);
  });
});

describe('kage hook', () => {
  const missingSocket = () =>
    isWin
      ? `\\\\.\\pipe\\kage-missing-${randomBytes(4).toString('hex')}`
      : join(root, 'missing.sock');

  it('Stop with an unreachable socket exits 0 and prints nothing', async () => {
    const e = env({ KAGE_SOCKET: missingSocket(), TMUX_PANE: '%1' });
    const stdin = Readable.from([JSON.stringify({ session_id: 's-1', hook_event_name: 'Stop' })]);
    expect(await main(['hook', 'Stop'], io(e, { stdin }))).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('without an event name exits 0 and prints nothing', async () => {
    expect(await main(['hook'], io(env()))).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('as a real process: exits 0 within 2 s with empty stdout and stderr', async () => {
    const e = { ...process.env, ...env({ KAGE_SOCKET: missingSocket(), TMUX_PANE: '%1' }) };
    const t0 = performance.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, ['--no-warnings', MAIN, 'hook', 'Stop'], {
          env: e,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: 'Stop' }));
      },
    );
    const ms = performance.now() - t0;
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(ms).toBeLessThan(2000);
  });
});

describe('kage (no command, help, unknown)', () => {
  it('as a real process, serve loads its module and exits with its error (no import cycle hang)', async () => {
    const e = { ...process.env, ...env() };
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--no-warnings', MAIN, 'serve', '--port', '0'], {
        env: e,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    expect(result).toEqual({ code: 1, stderr: '--port must be an integer in 1–65535, got "0".\n' });
  });

  it('prints the usage for help, with the KAGE_SOCKET ownership rule', async () => {
    expect(await main(['--help'], io(env()))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('kage serve [--demo] [--unsafe-listen-all] [--port N]');
    expect(text).toContain('kage hooks-path');
    expect(text).toContain('kage hook <Event>');
    expect(text).toContain('KAGE_SOCKET');
    expect(text).toContain('owned by you');
    expect(text).toContain('KAGE_CLAUDE_BIN');
    expect(text).toContain('kage ping');
    expect(text).toContain('kage doctor');
    expect(text).not.toContain('KAGE_NOTIFY_DONE_AFTER_MS');
  });
  it('kage doctor is wired (its argument check, before any probe runs)', async () => {
    expect(await main(['doctor', '--fix'], io(env()))).toBe(1);
    expect(err).toEqual(['kage doctor takes no arguments.']);
    expect(out).toEqual([]);
  });
  it('kage update and kage uninstall are wired (their option checks, before anything runs)', async () => {
    expect(await main(['update', '--now'], io(env()))).toBe(1);
    expect(err).toEqual(['kage update has no option "--now". Run kage --help to see its options.']);
    err.length = 0;
    expect(await main(['uninstall', '--all'], io(env()))).toBe(1);
    expect(err).toEqual([
      'kage uninstall has no option "--all". Run kage --help to see its options.',
    ]);
    expect(out).toEqual([]);
    expect(USAGE).toContain('kage update [--force]');
    expect(USAGE).toContain('kage uninstall [--yes] [--purge]');
    expect(USAGE).toContain('KAGE_RELEASE_BASE');
  });
  it('kage update from the sources says how to update a checkout, and downloads nothing', async () => {
    expect(await main(['update'], io(env()))).toBe(1);
    expect(err).toEqual([
      'This Kage runs from a checkout. Update it with git pull and pnpm build.',
    ]);
  });
  it('an unknown command exits 1', async () => {
    expect(await main(['frobnicate'], io(env()))).toBe(1);
    expect(err[0]).toBe('Unknown command "frobnicate".');
  });
});

describe.runIf(hasTmux && !isWin)('kage serve: live, against a private tmux server', () => {
  let socket: string;
  const tmux = (...args: string[]) =>
    execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...args], { encoding: 'utf8' });

  beforeEach(() => {
    socket = `kage-test-${randomBytes(4).toString('hex')}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => execFile('tmux', ['-L', socket, 'kill-server'], () => r()));
  });

  it('starts, shows a tmux window as an external session, and shuts down cleanly', async () => {
    const p = port();
    const e = env({ KAGE_HOST: '127.0.0.1', KAGE_PORT: String(p), KAGE_TMUX_SOCKET: socket });
    const r = await main(
      ['serve'],
      io(e, {
        dist: makeDist(),
        tmuxVersion: undefined,
        platform: undefined,
        tmuxConfigFile: '/dev/null',
      }),
    );
    if (typeof r === 'number') throw new Error(`serve exited ${r}: ${err.join(' | ')}`);
    const sock = join(e.XDG_RUNTIME_DIR as string, 'kage.sock');
    try {
      expect(out).toEqual([`Kage is running at http://127.0.0.1:${p}`]);
      // R53: no token in live mode: one line says what that means.
      expect(err).toEqual(['No token set: anyone on your tailnet can start and approve tasks.']);
      // ensureSession made the session; the hook socket and the settings file exist.
      expect(tmux('has-session', '-t', '=kage')).toBe('');
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(join(e.XDG_STATE_HOME as string, 'kage', 'claude-settings.json'))).toBe(
        true,
      );
      // Hooks in the session's windows post to the socket serve listens on.
      expect(tmux('show-environment', '-t', 'kage', 'KAGE_SOCKET').trim()).toBe(
        `KAGE_SOCKET=${sock}`,
      );
      // R22: the session's first window is Kage's placeholder.
      expect(tmux('show-options', '-w', '-v', '-t', 'kage:', '@kage_placeholder').trim()).toBe('1');

      tmux('new-window', '-d', '-t', 'kage:', '-n', 'probe', 'sleep 60');
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${p}/api/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let text = '';
      let probe: { task: string; external: boolean } | undefined;
      const tasks = new Set<string>();
      const deadline = Date.now() + 5000;
      while (!probe) {
        if (Date.now() > deadline) throw new Error(`no probe session in: ${text.slice(0, 2000)}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        for (const frame of text.split('\n\n')) {
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          type S = { task: string; external: boolean };
          let ev: { sessions?: S[]; session?: S };
          try {
            ev = JSON.parse(data.slice(6));
          } catch {
            continue; // a frame still arriving
          }
          const all = [...(ev.sessions ?? []), ...(ev.session ? [ev.session] : [])];
          probe ??= all.find((s) => s.task === 'probe');
          for (const s of all) tasks.add(s.task);
        }
      }
      expect(probe).toMatchObject({ task: 'probe', external: true });
      // The placeholder window (at its shell) is not on the board.
      expect([...tasks]).toEqual(['probe']);
      // GET /status on the hook socket (Task 4): the printed address, the count, this process.
      expect(await fetchStatus(sock)).toEqual({
        version: KAGE_VERSION,
        url: `http://127.0.0.1:${p}`,
        sessions: 1,
        needsYou: 0,
        pid: process.pid,
      });
      ac.abort();
    } finally {
      await r.stop();
    }
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
    expect(existsSync(sock)).toBe(false);
    // The tmux session outlives Kage: it holds the developer's windows.
    expect(tmux('has-session', '-t', '=kage')).toBe('');
  });

  const liveIo = (e: NodeJS.ProcessEnv) =>
    io(e, {
      dist: makeDist(),
      tmuxVersion: undefined,
      platform: undefined,
      tmuxConfigFile: '/dev/null',
    });

  it('starts live mode with a token set (B13), and guards the API with it', async () => {
    const p = port();
    const e = env({ KAGE_HOST: '127.0.0.1', KAGE_PORT: String(p), KAGE_TMUX_SOCKET: socket });
    const token = 'a-secret-of-16-chars';
    writeConfig(e, { token });
    const r = await main(['serve'], liveIo(e));
    if (typeof r === 'number') throw new Error(`serve exited ${r}: ${err.join(' | ')}`);
    try {
      expect(err).toEqual([]);
      expect(out).toEqual([`Kage is running at http://127.0.0.1:${p}`]);
      const base = `http://127.0.0.1:${p}`;
      expect((await fetch(`${base}/api/events`)).status).toBe(401);
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(204);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect((await fetch(`${base}/api/auth`, { headers: { Cookie: cookie } })).status).toBe(204);
    } finally {
      await r.stop();
    }
  });

  it('POST /api/sessions: 503 without claude, then a launch with KAGE_CLAUDE_BIN', async () => {
    const projects = join(root, 'projects');
    const repo = join(projects, 'shop');
    mkdirSync(repo, { recursive: true });
    const gitEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const savedEnv = Object.fromEntries(Object.keys(gitEnv).map((k) => [k, process.env[k]]));
    Object.assign(process.env, gitEnv);
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...a], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, HOME: join(root, 'home') },
      });
    const fake = join(root, 'fake-claude');
    // The window's PATH is serve's, empty here: name sleep by its path.
    writeFileSync(fake, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
    const body = JSON.stringify({
      project: 'shop',
      base: 'main',
      task: 'Wire it',
      acceptEdits: false,
    });
    try {
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'init');
      for (const claude of [null, fake]) {
        const p = port();
        const e = env({
          KAGE_HOST: '127.0.0.1',
          KAGE_PORT: String(p),
          KAGE_TMUX_SOCKET: socket,
          // No PATH: no claude to find unless KAGE_CLAUDE_BIN names one.
          ...(claude ? { KAGE_CLAUDE_BIN: claude } : {}),
        });
        writeConfig(e, { projectsRoot: projects });
        out.length = 0;
        err.length = 0;
        const r = await main(['serve'], liveIo(e));
        if (typeof r === 'number') throw new Error(`serve exited ${r}: ${err.join(' | ')}`);
        try {
          expect(err).toEqual([
            'No token set: anyone on your tailnet can start and approve tasks.',
          ]);
          const base = `http://127.0.0.1:${p}`;
          const res = await fetch(`${base}/api/sessions`, {
            method: 'POST',
            headers: { 'X-Kage': '1', Origin: base, 'Content-Type': 'application/json' },
            body,
          });
          if (!claude) {
            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({
              error: "Claude Code isn't on Kage's PATH. Install it, or set KAGE_CLAUDE_BIN.",
            });
            continue;
          }
          expect(res.status).toBe(201);
          const { id } = (await res.json()) as { id: string };
          const windows = tmux('list-windows', '-t', '=kage', '-F', '#{@kage_id}\t#{window_name}');
          expect(windows).toContain(`${id}\twire-it`);
          expect(existsSync(join(repo, '.worktrees', 'wire-it'))).toBe(true);
          const state = JSON.parse(
            readFileSync(join(e.XDG_STATE_HOME as string, 'kage', 'state.json'), 'utf8'),
          );
          expect(state.records).toMatchObject([
            { kageId: id, branch: 'kage/wire-it', base: 'main', permissionMode: 'default' },
          ]);
        } finally {
          await r.stop();
        }
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a hook socket that cannot open: exit 1, one stderr line, nothing left running', async () => {
    const p = port();
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const e = env({
      KAGE_HOST: '127.0.0.1',
      KAGE_PORT: String(p),
      KAGE_TMUX_SOCKET: socket,
      KAGE_SOCKET: join(blocker, 'kage.sock'),
    });
    expect(await main(['serve'], liveIo(e))).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^Couldn't open the hook socket: /);
    expect(out).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
  });

  it('a port in use: exit 1, one stderr line, and the hook socket is closed again', async () => {
    const { createServer } = await import('node:net');
    const p = port();
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(p, '127.0.0.1', r));
    try {
      const e = env({ KAGE_HOST: '127.0.0.1', KAGE_PORT: String(p), KAGE_TMUX_SOCKET: socket });
      expect(await main(['serve'], liveIo(e))).toBe(1);
      expect(err).toEqual([`Port ${p} is already in use.`]);
      expect(existsSync(join(e.XDG_RUNTIME_DIR as string, 'kage.sock'))).toBe(false);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });
});

describe('kage --version (Task 2)', () => {
  it('prints KAGE_VERSION and exits 0, as --version and as version', async () => {
    const { KAGE_VERSION } = await import('./install/runtime.ts');
    expect(await main(['--version'], io(env()))).toBe(0);
    expect(await main(['version'], io(env()))).toBe(0);
    expect(out).toEqual([KAGE_VERSION, KAGE_VERSION]);
    expect(err).toEqual([]);
  });

  /** Runs a built file under a temp HOME and XDG dirs (F12); resolves its exit and output. */
  const runBuilt = (file: string, args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const e = env();
      const child = spawn(process.execPath, [file, ...args], {
        env: {
          ...e,
          PATH: process.env.PATH ?? '',
          KAGE_SOCKET: join(e.XDG_RUNTIME_DIR as string, 'k.sock'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  it("a bundle built with bundleServer prints packages/server/package.json's version, without esbuild inside", async () => {
    const { bundleServer } = await import('./bundle.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const file = join(root, 'kage.mjs');
    await bundleServer(file);
    expect(await runBuilt(file, ['--version'])).toEqual({
      code: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
    // F4: esbuild (a native binary) never reaches the shipped bundle.
    expect(readFileSync(file, 'utf8')).not.toMatch(
      /from\s*["']esbuild["']|require\(["']esbuild["']\)/,
    );
  }, 60_000);

  it('the SEA entry is CommonJS with no import.meta, and runs under plain node', async () => {
    const { bundleSeaEntry } = await import('./bundle.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const file = join(root, 'kage-sea.cjs');
    await bundleSeaEntry(file);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('import.meta');
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(await runBuilt(file, ['--version'])).toEqual({
      code: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
    // The hook path through the CommonJS entry: silent, exit 0, nothing listening.
    expect(await runBuilt(file, ['hook', 'Stop'])).toEqual({ code: 0, stdout: '', stderr: '' });
  }, 60_000);
});

describe('kage serve: the service environment (R105, F7)', () => {
  it('KAGE_SERVICE=1: MALLOC_ARENA_MAX, NODE_OPTIONS and KAGE_SERVICE are gone before the first tmux call', async () => {
    const keys = ['KAGE_SERVICE', 'MALLOC_ARENA_MAX', 'NODE_OPTIONS'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.KAGE_SERVICE = '1';
    process.env.MALLOC_ARENA_MAX = '2';
    process.env.NODE_OPTIONS = '--v8-pool-size=1';
    const p = port();
    const e = env({
      KAGE_HOST: '127.0.0.1',
      KAGE_PORT: String(p),
      KAGE_SERVICE: '1',
      MALLOC_ARENA_MAX: '2',
      NODE_OPTIONS: '--v8-pool-size=1',
    });
    const ac = new AbortController();
    let seen: { proc: NodeJS.ProcessEnv; io: NodeJS.ProcessEnv } | null = null;
    const tmuxExec: ExecFn = async () => {
      seen ??= { proc: { ...process.env }, io: { ...e } };
      ac.abort();
      return { stdout: '', stderr: '' };
    };
    try {
      const r = await main(['serve'], io(e, { dist: makeDist(), signal: ac.signal, tmuxExec }));
      expect(r).toBe(130);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    expect(seen).not.toBeNull();
    const s = seen as unknown as { proc: NodeJS.ProcessEnv; io: NodeJS.ProcessEnv };
    for (const k of keys) {
      expect(s.proc[k]).toBeUndefined();
      expect(s.io[k]).toBeUndefined();
    }
  });
});
