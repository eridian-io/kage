import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOOK_DEADLINE_MS, netPost, type PostFn, runHookCli, socketPath } from './cli.ts';
import type { HookEvent } from './event.ts';
import { HookServer } from './server.ts';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/hooks');
const raw = (file: string) => readFileSync(join(FIXTURES, file), 'utf8');

function stdinOf(text: string | null): PassThrough {
  const s = new PassThrough();
  if (text !== null) s.end(text);
  return s;
}

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, 'write');
  errSpy = vi.spyOn(process.stderr, 'write');
});
afterEach(() => {
  vi.restoreAllMocks();
});
const silent = () => {
  expect(outSpy).not.toHaveBeenCalled();
  expect(errSpy).not.toHaveBeenCalled();
};

describe('runHookCli', () => {
  it('sends the stdin JSON, the pane from TMUX_PANE and the event name', async () => {
    const calls: { socket: string; body: string }[] = [];
    const post: PostFn = async (socket, body) => {
      calls.push({ socket, body });
    };
    const code = await runHookCli('Stop', {
      stdin: stdinOf(raw('stop.json')),
      env: { TMUX_PANE: '%4', KAGE_SOCKET: '/tmp/k.sock' },
      post,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.socket).toBe('/tmp/k.sock');
    expect(JSON.parse(calls[0]?.body as string)).toEqual({
      event: 'Stop',
      pane: '%4',
      payload: JSON.parse(raw('stop.json')),
    });
    silent();
  });

  it('sends pane null when TMUX_PANE is unset', async () => {
    let body = '';
    await runHookCli('Stop', {
      stdin: stdinOf(raw('stop.json')),
      env: { KAGE_SOCKET: '/tmp/k.sock' },
      post: async (_s, b) => {
        body = b;
      },
    });
    expect(JSON.parse(body).pane).toBeNull();
  });

  it('resolves 0 within 1.6 s when post hangs, silently', async () => {
    let signal: AbortSignal | undefined;
    const t0 = performance.now();
    const code = await runHookCli('Stop', {
      stdin: stdinOf(raw('stop.json')),
      env: { KAGE_SOCKET: '/tmp/k.sock' },
      post: (_s, _b, sig) => {
        signal = sig;
        return new Promise(() => {});
      },
    });
    const ms = performance.now() - t0;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1600);
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(signal?.aborted).toBe(true);
    silent();
  });

  it('resolves 0 within 1.6 s when stdin never ends', async () => {
    const post = vi.fn<PostFn>(async () => {});
    const t0 = performance.now();
    expect(await runHookCli('Stop', { stdin: stdinOf(null), env: {}, post })).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1600);
    expect(post).not.toHaveBeenCalled();
    silent();
  });

  it('malformed stdin resolves 0 and posts nothing', async () => {
    for (const text of ['{nope', '', '[1,2]', '"str"', 'null']) {
      const post = vi.fn<PostFn>(async () => {});
      expect(await runHookCli('Stop', { stdin: stdinOf(text), env: {}, post })).toBe(0);
      expect(post).not.toHaveBeenCalled();
    }
    silent();
  });

  it('a post that rejects or throws resolves 0, silently', async () => {
    const env = { KAGE_SOCKET: '/tmp/k.sock' };
    expect(
      await runHookCli('Stop', {
        stdin: stdinOf(raw('stop.json')),
        env,
        post: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).toBe(0);
    expect(
      await runHookCli('Stop', {
        stdin: stdinOf(raw('stop.json')),
        env,
        post: () => {
          throw new Error('sync');
        },
      }),
    ).toBe(0);
    silent();
  });

  it('a stdin error resolves 0, silently', async () => {
    const stdin = new PassThrough();
    const post = vi.fn<PostFn>(async () => {});
    const p = runHookCli('Stop', { stdin, env: {}, post });
    stdin.destroy(new Error('EIO'));
    expect(await p).toBe(0);
    expect(post).not.toHaveBeenCalled();
    silent();
  });

  it('stdin over 1 MB is dropped', async () => {
    const post = vi.fn<PostFn>(async () => {});
    const big = JSON.stringify({ session_id: 's', pad: 'x'.repeat(1024 * 1024) });
    expect(await runHookCli('Stop', { stdin: stdinOf(big), env: {}, post })).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('runHookCli with the default post, end to end', () => {
  let dir: string;
  let path: string;
  let server: HookServer;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kage-cli-'));
    path =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kage-test-${randomBytes(4).toString('hex')}`
        : join(dir, 'kage.sock');
    server = new HookServer(path);
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the event to a HookServer over the socket', async () => {
    const got: HookEvent[] = [];
    server.on((e) => got.push(e));
    const code = await runHookCli('PermissionRequest', {
      stdin: stdinOf(raw('permission-request.json')),
      env: { KAGE_SOCKET: path, TMUX_PANE: '%2' },
    });
    expect(code).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ event: 'PermissionRequest', pane: '%2', toolName: 'Write' });
    silent();
  });

  it('an unreachable socket resolves 0 quickly and silently', async () => {
    const t0 = performance.now();
    const missing =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kage-missing-${randomBytes(4).toString('hex')}`
        : join(dir, 'missing.sock');
    expect(
      await runHookCli('Stop', { stdin: stdinOf(raw('stop.json')), env: { KAGE_SOCKET: missing } }),
    ).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1000);
    silent();
  });

  it('a server that never answers still resolves 0 within 1.6 s', async () => {
    const { createServer } = await import('node:net');
    const conns = new Set<import('node:net').Socket>();
    const hang = createServer((s) => {
      conns.add(s);
      s.on('error', () => {});
    });
    const hangPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kage-hang-${randomBytes(4).toString('hex')}`
        : join(dir, 'hang.sock');
    await new Promise<void>((r) => hang.listen(hangPath, r));
    const t0 = performance.now();
    expect(
      await runHookCli('Stop', {
        stdin: stdinOf(raw('stop.json')),
        env: { KAGE_SOCKET: hangPath },
      }),
    ).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1600);
    for (const s of conns) s.destroy();
    await new Promise<void>((r) => hang.close(() => r()));
    silent();
  });
});

const pipeOr = (dir: string, name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\kage-${name}-${randomBytes(4).toString('hex')}`
    : join(dir, `${name}.sock`);

describe('netPost (node:net, no node:http)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kage-net-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'netPost sends one POST /hook with the body and resolves on the status line',
    async () => {
      const path = join(dir, 'kage.sock');
      const server = new HookServer(path);
      await server.listen();
      try {
        const got: HookEvent[] = [];
        server.on((e) => got.push(e));
        const envelope = {
          event: 'Stop',
          pane: '%7',
          payload: { ...JSON.parse(raw('stop.json')), note: 'grüße ✓' },
        };
        await netPost(path, JSON.stringify(envelope), new AbortController().signal);
        // The server answers after it parsed and emitted the event.
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ event: 'Stop', pane: '%7' });
      } finally {
        await server.close();
      }
    },
  );

  it('writes exactly one HTTP/1.1 request: Host, Content-Type, byte Content-Length, Connection: close', async () => {
    const path = pipeOr(dir, 'raw');
    let received = Buffer.alloc(0);
    let connections = 0;
    const fake = createServer((s) => {
      connections++;
      s.on('data', (d: Buffer) => {
        received = Buffer.concat([received, d]);
        const head = received.indexOf('\r\n\r\n');
        if (head < 0) return;
        const len = Number(
          /content-length: (\d+)/i.exec(received.subarray(0, head).toString())?.[1],
        );
        if (received.length >= head + 4 + len) s.end('HTTP/1.1 204 No Content\r\n\r\n');
      });
    });
    await new Promise<void>((r) => fake.listen(path, r));
    try {
      const body = JSON.stringify({ event: 'Stop', pane: null, payload: { t: 'ä✓' } });
      await netPost(path, body, new AbortController().signal);
      const bytes = Buffer.byteLength(body);
      expect(received.toString('utf8')).toBe(
        'POST /hook HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
          `Content-Length: ${bytes}\r\nConnection: close\r\n\r\n${body}`,
      );
      expect(bytes).toBeGreaterThan(body.length);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });

  it('netPost rejects on a closed socket well within the deadline', async () => {
    const t0 = performance.now();
    await expect(
      netPost(pipeOr(dir, 'missing'), '{}', new AbortController().signal),
    ).rejects.toThrow();
    expect(performance.now() - t0).toBeLessThan(HOOK_DEADLINE_MS / 3);
  });

  it('rejects when the server closes before a status line, or sends 4 KB without one', async () => {
    for (const reply of ['', 'HTTP/1.1 204', 'x'.repeat(5000)]) {
      const path = pipeOr(dir, 'bad');
      const conns = new Set<Socket>();
      const bad = createServer((s) => {
        conns.add(s);
        s.on('error', () => {});
        s.once('data', () => {
          if (reply.length > 4096) s.write(reply);
          else s.end(reply);
        });
      });
      await new Promise<void>((r) => bad.listen(path, r));
      try {
        await expect(netPost(path, '{}', new AbortController().signal)).rejects.toThrow();
      } finally {
        for (const s of conns) s.destroy();
        await new Promise<void>((r) => bad.close(() => r()));
      }
    }
  });

  it('an abort rejects a request the server never answers, and closes the connection', async () => {
    const path = pipeOr(dir, 'hang');
    let closed = false;
    const hang = createServer((s) => {
      // Reading is what lets this side see the client's close.
      s.resume();
      s.on('error', () => {});
      s.on('close', () => {
        closed = true;
      });
    });
    await new Promise<void>((r) => hang.listen(path, r));
    try {
      const ac = new AbortController();
      const p = netPost(path, '{}', ac.signal);
      setTimeout(() => ac.abort(), 50);
      await expect(p).rejects.toThrow();
      await vi.waitFor(() => expect(closed).toBe(true));
      const pre = new AbortController();
      pre.abort();
      await expect(netPost(path, '{}', pre.signal)).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });
});

describe('socketPath', () => {
  it('KAGE_SOCKET wins', () => {
    expect(socketPath({ KAGE_SOCKET: '/x/k.sock', XDG_RUNTIME_DIR: '/run/user/1' }, 'linux')).toBe(
      '/x/k.sock',
    );
  });
  it('then $XDG_RUNTIME_DIR/kage.sock', () => {
    expect(socketPath({ XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/d' }, 'linux')).toBe(
      '/run/user/1000/kage.sock',
    );
  });
  it('then $XDG_STATE_HOME/kage/kage.sock (R13)', () => {
    expect(socketPath({ XDG_STATE_HOME: '/s', HOME: '/home/d' }, 'linux')).toBe(
      '/s/kage/kage.sock',
    );
    expect(
      socketPath({ XDG_RUNTIME_DIR: '/run/user/1', XDG_STATE_HOME: '/s', HOME: '/h' }, 'linux'),
    ).toBe('/run/user/1/kage.sock');
  });
  it('then ~/.local/state/kage/kage.sock', () => {
    expect(socketPath({ HOME: '/home/d' }, 'linux')).toBe('/home/d/.local/state/kage/kage.sock');
  });
  it('on Windows, a named pipe per user', () => {
    expect(socketPath({ USERNAME: 'dev' }, 'win32')).toBe('\\\\.\\pipe\\kage-dev');
    expect(socketPath({ KAGE_SOCKET: '\\\\.\\pipe\\x', USERNAME: 'dev' }, 'win32')).toBe(
      '\\\\.\\pipe\\x',
    );
  });
});
