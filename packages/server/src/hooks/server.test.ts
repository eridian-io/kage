import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchStatus } from '../install/status.ts';
import { type HookEvent, parseHookEvent } from './event.ts';
import { HookServer, type ServerStatus } from './server.ts';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/hooks');
const payload = (file: string) => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
const isWin = process.platform === 'win32';

function send(
  socketPath: string,
  body: string | Buffer,
  opts: { path?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: opts.path ?? '/hook',
        method: opts.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

let dir: string;
let path: string;
let server: HookServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kage-hook-'));
  path = isWin
    ? `\\\\.\\pipe\\kage-test-${randomBytes(4).toString('hex')}`
    : join(dir, 'kage.sock');
  server = new HookServer(path, { now: () => 42 });
  await server.listen();
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HookServer', () => {
  it('POST /hook with a fixture delivers a parsed HookEvent', async () => {
    const got: HookEvent[] = [];
    server.on((e) => got.push(e));
    const res = await send(
      path,
      JSON.stringify({ event: 'PreToolUse', pane: '%7', payload: payload('pre-tool-use.json') }),
    );
    expect(res.status).toBe(204);
    expect(got).toEqual([
      {
        event: 'PreToolUse',
        pane: '%7',
        sessionId: '00000000-0000-4000-8000-000000000001',
        transcriptPath:
          '/home/dev/.claude/projects/-home-dev-projects-demo/00000000-0000-4000-8000-000000000001.jsonl',
        cwd: '/home/dev/projects/demo',
        notification: null,
        message: null,
        toolName: 'Edit',
        toolInput: payload('pre-tool-use.json').tool_input,
        toolUseId: 'toolu_00000000000000000000000003',
        source: null,
        at: 42,
      },
    ]);
  });

  it('unsubscribes', async () => {
    const got: HookEvent[] = [];
    const off = server.on((e) => got.push(e));
    off();
    await send(path, JSON.stringify({ event: 'Stop', pane: null, payload: payload('stop.json') }));
    expect(got).toEqual([]);
  });

  it('keeps events that arrive before the first listener and hands them to it, in order', async () => {
    const stop = JSON.stringify({ event: 'Stop', pane: '%1', payload: payload('stop.json') });
    const end = JSON.stringify({
      event: 'SessionEnd',
      pane: '%1',
      payload: payload('session-end.json'),
    });
    expect((await send(path, stop)).status).toBe(204);
    expect((await send(path, end)).status).toBe(204);
    const got: string[] = [];
    server.on((e) => got.push(e.event));
    expect(got).toEqual(['Stop', 'SessionEnd']);
    const later: string[] = [];
    server.on((e) => later.push(e.event));
    expect(later).toEqual([]);
  });

  it('keeps at most 256 early events', async () => {
    const stop = JSON.stringify({ event: 'Stop', pane: '%1', payload: payload('stop.json') });
    for (let i = 0; i < 260; i++) await send(path, stop);
    let n = 0;
    server.on(() => n++);
    expect(n).toBe(256);
  });

  it('a throwing listener does not stop the others or the response', async () => {
    const got: HookEvent[] = [];
    server.on(() => {
      throw new Error('boom');
    });
    server.on((e) => got.push(e));
    const res = await send(
      path,
      JSON.stringify({ event: 'Stop', pane: null, payload: payload('stop.json') }),
    );
    expect(res.status).toBe(204);
    expect(got).toHaveLength(1);
  });

  it('bodies over 1 MB → 413, and nothing is delivered', async () => {
    const got: HookEvent[] = [];
    server.on((e) => got.push(e));
    const big = JSON.stringify({
      event: 'Stop',
      pane: null,
      payload: { ...payload('stop.json'), pad: 'x'.repeat(1024 * 1024) },
    });
    expect((await send(path, big)).status).toBe(413);
    expect(got).toEqual([]);
  });

  it('a chunked body (no Content-Length) over 1 MB → 413', async () => {
    const got: HookEvent[] = [];
    server.on((e) => got.push(e));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: path, path: '/hook', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('x'.repeat(700 * 1024));
      req.end('x'.repeat(700 * 1024));
    });
    expect(status).toBe(413);
    expect(got).toEqual([]);
  });

  it('a declared Content-Length over 1 MB → 413 at once, before any body is sent', async () => {
    const got: HookEvent[] = [];
    server.on((e) => got.push(e));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          socketPath: path,
          path: '/hook',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', (err) => {
        if (!req.destroyed) reject(err);
      });
      // Only the headers go out: the server must answer without waiting for 2 MB.
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(got).toEqual([]);
  });

  it('a body of exactly 1 MB is accepted', async () => {
    const base = JSON.stringify({
      event: 'Stop',
      pane: null,
      payload: { ...payload('stop.json'), pad: '' },
    });
    const body = base.replace('"pad":""', `"pad":"${'x'.repeat(1024 * 1024 - base.length)}"`);
    expect(Buffer.byteLength(body)).toBe(1024 * 1024);
    expect((await send(path, body)).status).toBe(204);
  });

  it('other paths → 404', async () => {
    expect((await send(path, '{}', { path: '/nope' })).status).toBe(404);
    expect((await send(path, '{}', { path: '/hook/x' })).status).toBe(404);
  });

  it('other methods on /hook → 405', async () => {
    expect((await send(path, '', { method: 'GET' })).status).toBe(405);
  });

  describe('GET /status', () => {
    const STATUS: ServerStatus = {
      version: '9.8.7',
      url: 'http://127.0.0.1:8080',
      sessions: 3,
      needsYou: 1,
      pid: 4242,
    };

    it("answers the provider's JSON, read fresh for each request", async () => {
      let sessions = 3;
      server.onStatus(() => ({ ...STATUS, sessions }));
      const res = await send(path, '', { path: '/status', method: 'GET' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(STATUS);
      sessions = 4;
      expect(JSON.parse((await send(path, '', { path: '/status', method: 'GET' })).body)).toEqual({
        ...STATUS,
        sessions: 4,
      });
    });

    it('with no provider → 503', async () => {
      expect((await send(path, '', { path: '/status', method: 'GET' })).status).toBe(503);
    });

    it('POST /status → 405, and GET /hook stays 405', async () => {
      server.onStatus(() => STATUS);
      expect((await send(path, '{}', { path: '/status', method: 'POST' })).status).toBe(405);
      expect((await send(path, '', { path: '/hook', method: 'GET' })).status).toBe(405);
    });

    it('a throwing provider → 500 with no body', async () => {
      server.onStatus(() => {
        throw new Error('secret detail');
      });
      const res = await send(path, '', { path: '/status', method: 'GET' });
      expect(res.status).toBe(500);
      expect(res.body).toBe('');
    });

    it('fetchStatus reads it over the socket', async () => {
      server.onStatus(() => STATUS);
      expect(await fetchStatus(path)).toEqual(STATUS);
    });

    it('fetchStatus gives null with no provider, or a malformed answer', async () => {
      expect(await fetchStatus(path)).toBeNull();
      server.onStatus(() => ({ ...STATUS, sessions: 'three' }) as unknown as ServerStatus);
      expect(await fetchStatus(path)).toBeNull();
    });

    it('fetchStatus gives null when request() throws at once (no timer left behind)', async () => {
      // A number for socketPath makes http.request throw ERR_INVALID_ARG_TYPE synchronously.
      const t0 = Date.now();
      expect(await fetchStatus(5 as unknown as string, 60_000)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('fetchStatus against a closed socket gives null within its timeout', async () => {
      await server.close();
      const t0 = Date.now();
      expect(await fetchStatus(path, 500)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1500);
    });

    it('fetchStatus gives null when the socket accepts but never answers', async () => {
      const silent = isWin
        ? `\\\\.\\pipe\\kage-test-${randomBytes(4).toString('hex')}`
        : join(dir, 'silent.sock');
      const held: Socket[] = [];
      const mute = createNetServer((s) => held.push(s));
      await new Promise<void>((r) => mute.listen(silent, r));
      try {
        const t0 = Date.now();
        expect(await fetchStatus(silent, 300)).toBeNull();
        expect(Date.now() - t0).toBeLessThan(1500);
      } finally {
        for (const s of held) s.destroy();
        await new Promise<void>((r) => mute.close(() => r()));
      }
    });
  });

  it('malformed JSON or invalid fields → 400', async () => {
    expect((await send(path, '{not json')).status).toBe(400);
    expect((await send(path, JSON.stringify({ event: 'Nope', payload: {} }))).status).toBe(400);
    const bad = { ...payload('stop.json'), session_id: 7 };
    expect((await send(path, JSON.stringify({ event: 'Stop', payload: bad }))).status).toBe(400);
  });

  it('close() then listen() again on the same path works', async () => {
    await server.close();
    server = new HookServer(path);
    await server.listen();
    const res = await send(
      path,
      JSON.stringify({ event: 'Stop', pane: null, payload: payload('stop.json') }),
    );
    expect(res.status).toBe(204);
  });
});

describe.runIf(!isWin)('HookServer on a Unix socket', () => {
  it('the socket file has mode 0600', () => {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces a stale socket file left by a crashed server', async () => {
    const stale = join(dir, 'stale.sock');
    // A child listens, then is SIGKILLed: the socket file stays behind with nobody on it.
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('net').createServer().listen(process.argv[1], () => console.log('up'))`,
        stale,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((r) => child.stdout.once('data', () => r()));
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGKILL');
    await exited;
    expect(statSync(stale).isSocket()).toBe(true);
    const h = new HookServer(stale);
    await h.listen();
    expect((await send(stale, '{}', { path: '/nope' })).status).toBe(404);
    await h.close();
  });

  it('never deletes a regular file at the socket path', async () => {
    const file = join(dir, 'not-a-socket');
    writeFileSync(file, 'keep me');
    await expect(new HookServer(file).listen()).rejects.toThrow(/not a socket/);
    expect(readFileSync(file, 'utf8')).toBe('keep me');
  });

  it('refuses to take over a socket another server is listening on', async () => {
    const other = new HookServer(path);
    await expect(other.listen()).rejects.toThrow(/in use/);
  });

  it('creates the parent directory with mode 0700', async () => {
    const nested = join(dir, 'state', 'kage', 'kage.sock');
    const h = new HookServer(nested);
    await h.listen();
    expect(statSync(join(dir, 'state', 'kage')).mode & 0o777).toBe(0o700);
    await h.close();
  });

  it('tightens an existing parent directory of ours to 0700', async () => {
    const parent = join(dir, 'loose');
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const h = new HookServer(join(parent, 'kage.sock'));
    await h.listen();
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(join(parent, 'kage.sock')).mode & 0o777).toBe(0o600);
    await h.close();
  });

  it('refuses a parent directory owned by someone else', async () => {
    const parent = join(dir, 'theirs');
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const uid = (process.getuid?.() ?? 0) + 1;
    const h = new HookServer(join(parent, 'kage.sock'), { uid });
    await expect(h.listen()).rejects.toThrow(/not owned/);
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  });

  it('restores the umask after listen, and after a failed listen', async () => {
    const before = process.umask();
    const h = new HookServer(join(dir, 'u.sock'));
    await h.listen();
    expect(process.umask()).toBe(before);
    await expect(new HookServer(path).listen()).rejects.toThrow(/in use/);
    expect(process.umask()).toBe(before);
    await h.close();
  });
});

describe('parseHookEvent', () => {
  const ok = (body: unknown) => parseHookEvent(body, 1);

  it('maps notification_type', () => {
    const p = payload('notification-permission.json');
    expect(ok({ event: 'Notification', pane: null, payload: p })?.notification).toBe('permission');
    expect(
      ok({ event: 'Notification', pane: null, payload: payload('notification-idle.json') })
        ?.notification,
    ).toBe('idle');
    expect(
      ok({ event: 'Notification', pane: null, payload: { ...p, notification_type: 'auth_ok' } })
        ?.notification,
    ).toBe('other');
    const { notification_type: _, ...noType } = p;
    expect(ok({ event: 'Notification', pane: null, payload: noType })?.notification).toBe('other');
    expect(ok({ event: 'Notification', pane: null, payload: p })?.message).toBe(
      'Claude needs your permission',
    );
  });

  it('notification is null for other events', () => {
    expect(ok({ event: 'Stop', pane: null, payload: payload('stop.json') })?.notification).toBe(
      null,
    );
  });

  it('accepts all nine events and missing optional fields', () => {
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification',
      'Stop',
      'SessionEnd',
    ]) {
      expect(ok({ event, payload: { session_id: 's' } })).toEqual({
        event,
        pane: null,
        sessionId: 's',
        transcriptPath: null,
        cwd: null,
        notification: event === 'Notification' ? 'other' : null,
        message: null,
        toolName: null,
        toolInput: null,
        toolUseId: null,
        source: null,
        at: 1,
      });
    }
  });

  it('reads SessionStart source (startup, compact, resume, clear); null for other events', () => {
    expect(
      ok({ event: 'SessionStart', pane: '%1', payload: payload('session-start.json') })?.source,
    ).toBe('startup');
    for (const source of ['compact', 'resume', 'clear']) {
      expect(ok({ event: 'SessionStart', payload: { session_id: 's', source } })?.source).toBe(
        source,
      );
    }
    expect(ok({ event: 'Stop', payload: { session_id: 's', source: 'compact' } })?.source).toBe(
      null,
    );
    expect(ok({ event: 'SessionStart', payload: { session_id: 's', source: 7 } })).toBeNull();
  });

  it('keeps tool_use_id, and an odd one is null without dropping the event (M11)', () => {
    const p = payload('post-tool-use.json');
    expect(ok({ event: 'PostToolUse', pane: '%1', payload: p })?.toolUseId).toBe(p.tool_use_id);
    expect(
      ok({ event: 'PostToolUse', payload: { session_id: 's', tool_use_id: 7 } })?.toolUseId,
    ).toBeNull();
  });

  it('keeps tool_input for AskUserQuestion', () => {
    const p = payload('pre-tool-use-ask-question.json');
    expect(ok({ event: 'PreToolUse', pane: '%1', payload: p })?.toolInput).toEqual(p.tool_input);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', []],
    ['unknown event', { event: 'Bogus', payload: { session_id: 's' } }],
    ['no payload', { event: 'Stop' }],
    ['payload array', { event: 'Stop', payload: [] }],
    ['no session_id', { event: 'Stop', payload: {} }],
    ['empty session_id', { event: 'Stop', payload: { session_id: '' } }],
    ['numeric cwd', { event: 'Stop', payload: { session_id: 's', cwd: 1 } }],
    [
      'numeric transcript_path',
      { event: 'Stop', payload: { session_id: 's', transcript_path: 1 } },
    ],
    ['numeric message', { event: 'Stop', payload: { session_id: 's', message: 1 } }],
    ['numeric tool_name', { event: 'Stop', payload: { session_id: 's', tool_name: 1 } }],
    ['string tool_input', { event: 'Stop', payload: { session_id: 's', tool_input: 'x' } }],
    ['array tool_input', { event: 'Stop', payload: { session_id: 's', tool_input: [] } }],
    [
      'numeric notification_type',
      { event: 'Notification', payload: { session_id: 's', notification_type: 1 } },
    ],
    ['numeric pane', { event: 'Stop', pane: 3, payload: { session_id: 's' } }],
    ['pane not a tmux pane id', { event: 'Stop', pane: 'x; rm', payload: { session_id: 's' } }],
  ])('rejects %s', (_name, body) => {
    expect(ok(body)).toBeNull();
  });
});
