import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LIMITS, type SessionStatus } from '@kage/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { authCookieValue } from '../auth.ts';
import { BridgeError, type TermHandle, type TermSink } from './bridge.ts';
import { TerminalServer } from './server.ts';

type Target = {
  windowId: string | null;
  paneId: string | null;
  kageId: string | null;
  external: boolean;
  status: SessionStatus;
};

class FakeHandle implements TermHandle {
  inputs: string[] = [];
  sizes: [number, number][] = [];
  closed = 0;
  input(d: string) {
    this.inputs.push(d);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  close() {
    this.closed++;
  }
}

interface OpenArgs {
  windowId: string;
  paneId: string;
  mode: 'rw' | 'ro';
  cols: number | null;
  rows: number | null;
  sink: TermSink;
}

class FakeBridge {
  opens: { o: OpenArgs; handle: FakeHandle }[] = [];
  fail: Error | null = null;
  gate: Promise<void> | null = null;
  async open(o: OpenArgs): Promise<TermHandle> {
    const handle = new FakeHandle();
    this.opens.push({ o, handle });
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return handle;
  }
}

const RECORD: Target = {
  windowId: '@2',
  paneId: '%3',
  kageId: 'k-1',
  external: false,
  status: 'done',
};
const EXTERNAL: Target = {
  windowId: '@7',
  paneId: '%9',
  kageId: null,
  external: true,
  status: 'running',
};

let server: Server | null = null;
let terms: TerminalServer | null = null;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  terms?.close();
  terms = null;
  if (server) {
    const s = server;
    server = null;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function setup(
  o: {
    demo?: boolean;
    token?: string;
    targets?: Record<string, Target>;
    held?: Record<string, string | null>;
    pingMs?: number;
  } = {},
) {
  const bridge = new FakeBridge();
  const targets = new Map(Object.entries(o.targets ?? { 'k-1': RECORD, 'ext-@7': EXTERNAL }));
  const held = new Map(Object.entries(o.held ?? { '@2': 'k-1' }));
  const reads: string[] = [];
  const s = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server = s;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  const t = new TerminalServer({
    allowed: { hostNames: ['127.0.0.1'], port },
    token: o.token ?? '',
    source: o.demo ? null : { terminalTarget: (id: string) => targets.get(id) ?? null },
    bridge: o.demo ? null : bridge,
    tmux: o.demo
      ? null
      : {
          windowKageId: async (w: string) => {
            reads.push(w);
            if (!held.has(w))
              throw Object.assign(new Error('gone'), { stderr: `can't find window: ${w}` });
            return held.get(w) ?? null;
          },
        },
    ...(o.pingMs ? { pingMs: o.pingMs } : {}),
  });
  terms = t;
  s.on('upgrade', (req, socket, head) => t.handleUpgrade(req, socket, head));
  const origin = `http://127.0.0.1:${port}`;
  const connect = (
    path = '/api/sessions/k-1/terminal?cols=80&rows=24',
    c: {
      origin?: string | null;
      protocol?: string | null;
      headers?: Record<string, string>;
      autoPong?: boolean;
    } = {},
  ) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${path}`,
      c.protocol === null ? [] : [c.protocol ?? 'kage.term.v1'],
      {
        ...(c.origin === null ? {} : { origin: c.origin ?? origin }),
        headers: c.headers ?? {},
        autoPong: c.autoPong ?? true,
      },
    );
    ws.on('error', () => {});
    clients.push(ws);
    const messages: { data: Buffer; binary: boolean }[] = [];
    ws.on('message', (data, binary) => messages.push({ data: data as Buffer, binary }));
    const closed = new Promise<[number, string]>((r) =>
      ws.on('close', (code, reason) => r([code, reason.toString()])),
    );
    const refused = new Promise<[number, string]>((r) =>
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString();
        });
        res.on('end', () => r([res.statusCode ?? 0, body]));
      }),
    );
    const opened = new Promise<void>((r) => ws.on('open', () => r()));
    return { ws, messages, closed, refused, opened };
  };
  return { t, bridge, connect, reads, port, targets, held };
}

describe('TerminalServer: refusals before the upgrade', () => {
  it('a bad Origin is a plain HTTP 403 and bridge.open is never called', async () => {
    const { connect, bridge } = await setup();
    const c = connect(undefined, { origin: 'http://evil.example' });
    expect(await c.refused).toEqual([403, 'Bad origin\n']);
    expect(bridge.opens).toHaveLength(0);
  });

  it('a missing Origin → 403; a missing protocol → 400; no cookie with a token → 401', async () => {
    const { connect, bridge } = await setup({ token: 'tok' });
    const good = { headers: { Cookie: `kage_auth=${authCookieValue('tok')}` } };
    expect((await connect(undefined, { ...good, origin: null }).refused)[0]).toBe(403);
    expect((await connect(undefined, { ...good, protocol: null }).refused)[0]).toBe(400);
    expect(await connect().refused).toEqual([401, 'Sign in to Kage\n']);
    expect((await connect('/api/sessions/a/b/terminal', good).refused)[0]).toBe(404);
    expect((await connect('/api/sessions/k-1/terminal?cols=0', good).refused)[0]).toBe(400);
    expect(bridge.opens).toHaveLength(0);
    // With the cookie it upgrades.
    const ok = connect(undefined, good);
    await ok.opened;
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
  });
});

describe('TerminalServer: sessions', () => {
  it('a record session opens rw on the pane terminalTarget gives (never the URL), after the @kage_id read', async () => {
    const { connect, bridge, reads } = await setup();
    const c = connect('/api/sessions/k-1/terminal?cols=100&rows=30');
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    const { o } = bridge.opens[0] as { o: OpenArgs };
    expect([o.windowId, o.paneId, o.mode, o.cols, o.rows]).toEqual(['@2', '%3', 'rw', 100, 30]);
    expect(reads).toEqual(['@2']);
    await c.opened;
  });

  it('frames: reset as text then the snapshot as binary; output binary; size text', async () => {
    const { connect, bridge } = await setup();
    const c = connect();
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    const { o } = bridge.opens[0] as { o: OpenArgs };
    o.sink.reset(80, 24, Buffer.from('snap\x1b[0m'));
    o.sink.output(Buffer.from([0xc3]));
    o.sink.size(120, 40);
    await vi.waitFor(() => expect(c.messages).toHaveLength(4));
    const [reset, snap, out, size] = c.messages as { data: Buffer; binary: boolean }[];
    expect(reset?.binary).toBe(false);
    expect(JSON.parse(reset?.data.toString() ?? '')).toEqual({
      t: 'reset',
      cols: 80,
      rows: 24,
      mode: 'rw',
    });
    expect(snap?.binary).toBe(true);
    expect(snap?.data.toString()).toBe('snap\x1b[0m');
    expect(out?.binary).toBe(true);
    expect([...(out?.data ?? [])]).toEqual([0xc3]);
    expect(JSON.parse(size?.data.toString() ?? '')).toEqual({ t: 'size', cols: 120, rows: 40 });
    expect(o.sink.buffered()).toBeGreaterThanOrEqual(0);
  });

  it('in and size frames reach the handle of an rw terminal', async () => {
    const { connect, bridge } = await setup();
    const c = connect();
    await c.opened;
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    const { handle } = bridge.opens[0] as { handle: FakeHandle };
    // Let the server's open() resolve before sending.
    await new Promise((r) => setTimeout(r, 20));
    c.ws.send(JSON.stringify({ t: 'in', d: 'ls\r' }));
    c.ws.send(JSON.stringify({ t: 'size', cols: 90, rows: 20 }));
    await vi.waitFor(() => expect(handle.sizes).toEqual([[90, 20]]));
    expect(handle.inputs).toEqual(['ls\r']);
  });

  it('an external session opens ro, with no @kage_id read, and its in frames never reach the handle', async () => {
    const { connect, bridge, reads } = await setup();
    const c = connect('/api/sessions/ext-%407/terminal');
    await c.opened;
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    const { o, handle } = bridge.opens[0] as { o: OpenArgs; handle: FakeHandle };
    expect([o.windowId, o.paneId, o.mode]).toEqual(['@7', '%9', 'ro']);
    expect(reads).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    c.ws.send(JSON.stringify({ t: 'in', d: 'rm -rf /\r' }));
    c.ws.send(JSON.stringify({ t: 'size', cols: 90, rows: 20 }));
    o.sink.reset(80, 24, Buffer.alloc(0));
    await vi.waitFor(() => expect(c.messages.length).toBeGreaterThanOrEqual(1));
    expect(JSON.parse(c.messages[0]?.data.toString() ?? '')).toMatchObject({ mode: 'ro' });
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.inputs).toEqual([]);
    expect(handle.sizes).toEqual([]);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a window whose live @kage_id differs → 4403, no open', async () => {
    const { connect, bridge } = await setup({ held: { '@2': 'k-other' } });
    expect(await connect().closed).toEqual([4403, "That window isn't Kage's any more."]);
    expect(bridge.opens).toHaveLength(0);
  });

  it('a window gone at the @kage_id read → 4409', async () => {
    const { connect, bridge } = await setup({ held: {} });
    expect(await connect().closed).toEqual([4409, 'This session has ended.']);
    expect(bridge.opens).toHaveLength(0);
  });

  it('demo mode → 4501', async () => {
    const { connect } = await setup({ demo: true });
    expect(await connect().closed).toEqual([4501, 'Demo mode has no terminal.']);
  });

  it('an unknown id → 4404; an ended session or one with no window → 4409', async () => {
    const { connect, bridge } = await setup({
      targets: {
        'k-1': { ...RECORD, status: 'ended' },
        'k-2': { ...RECORD, windowId: null, paneId: null },
      },
    });
    expect(await connect('/api/sessions/nope/terminal').closed).toEqual([
      4404,
      'No session with id nope.',
    ]);
    expect(await connect().closed).toEqual([4409, 'This session has ended.']);
    expect(await connect('/api/sessions/k-2/terminal').closed).toEqual([
      4409,
      'This session has ended.',
    ]);
    expect(bridge.opens).toHaveLength(0);
  });

  it("bridge.open's BridgeError closes with its code and sentence", async () => {
    const { connect, bridge } = await setup();
    bridge.fail = new BridgeError(4429, 'Too many terminals are open. Close one and try again.');
    expect(await connect().closed).toEqual([
      4429,
      'Too many terminals are open. Close one and try again.',
    ]);
  });

  it('B35: past 2 × LIMITS.terminals sockets waiting for bridge.open, a new one closes with 4429', async () => {
    const { connect, bridge } = await setup();
    let release = () => {};
    bridge.gate = new Promise<void>((r) => {
      release = r;
    });
    const cap = 2 * LIMITS.terminals;
    const waiting = Array.from({ length: cap }, () => connect());
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(cap));
    const extra = connect();
    expect(await extra.closed).toEqual([
      4429,
      'Too many terminals are open. Close one and try again.',
    ]);
    expect(bridge.opens).toHaveLength(cap);
    // Clients that hang up still count until their bridge.open settles.
    for (const w of waiting) w.ws.close();
    await Promise.all(waiting.map((w) => w.closed));
    expect((await connect().closed)[0]).toBe(4429);
    release();
    await vi.waitFor(() => expect(bridge.opens.every((o) => o.handle.closed === 1)).toBe(true));
    // Once they settled, upgrades open again.
    const next = connect();
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(cap + 1));
    next.ws.close();
  });

  it('a socket that closes while bridge.open is pending closes the handle when it arrives', async () => {
    const { connect, bridge } = await setup();
    let release = () => {};
    bridge.gate = new Promise<void>((r) => {
      release = r;
    });
    const c = connect();
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    c.ws.close();
    await c.closed;
    release();
    const { handle } = bridge.opens[0] as { handle: FakeHandle };
    await vi.waitFor(() => expect(handle.closed).toBe(1));
  });

  it('the client closing closes the handle', async () => {
    const { connect, bridge } = await setup();
    const c = connect();
    await c.opened;
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    c.ws.close(1000);
    const { handle } = bridge.opens[0] as { handle: FakeHandle };
    await vi.waitFor(() => expect(handle.closed).toBe(1));
  });
});

describe('TerminalServer: client frames', () => {
  const opened = async () => {
    const s = await setup();
    const c = s.connect();
    await c.opened;
    await vi.waitFor(() => expect(s.bridge.opens).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    return { ...s, c, handle: (s.bridge.opens[0] as { handle: FakeHandle }).handle };
  };

  it('a binary client frame → 1003', async () => {
    const { c, handle } = await opened();
    c.ws.send(Buffer.from('ls'), { binary: true });
    expect(await c.closed).toEqual([1003, "Kage didn't understand that."]);
    expect(handle.inputs).toEqual([]);
    // The server's own 'close' may come a moment after the client's.
    await vi.waitFor(() => expect(handle.closed).toBe(1));
  });

  it.each([
    'not json',
    '[]',
    'null',
    '{"t":"in"}',
    '{"t":"in","d":5}',
    '{"t":"in","d":"x","extra":1}',
    '{"t":"size","cols":80}',
    '{"t":"size","cols":80.5,"rows":24}',
    '{"t":"size","cols":"80","rows":24}',
    '{"t":"size","cols":80,"rows":24,"x":0}',
    '{"t":"key","d":"x"}',
  ])('%s → 1003', async (frame) => {
    const { c, handle } = await opened();
    c.ws.send(frame);
    expect(await c.closed).toEqual([1003, "Kage didn't understand that."]);
    expect(handle.inputs).toEqual([]);
    expect(handle.sizes).toEqual([]);
  });

  it('a 70 KiB frame → 1009', async () => {
    const { c, handle } = await opened();
    c.ws.send(JSON.stringify({ t: 'in', d: 'x'.repeat(70 * 1024) }));
    expect((await c.closed)[0]).toBe(1009);
    expect(handle.inputs).toEqual([]);
  });

  it('a 64 KiB in frame (the input limit) is passed on whole', async () => {
    const { c, handle } = await opened();
    const d = 'y'.repeat(64 * 1024);
    c.ws.send(JSON.stringify({ t: 'in', d }));
    await vi.waitFor(() => expect(handle.inputs).toHaveLength(1));
    expect(handle.inputs[0]).toBe(d);
  });
});

describe('TerminalServer: lifecycle', () => {
  it('close() closes every socket with 1001, and later upgrades are refused', async () => {
    const { t, connect, bridge } = await setup();
    const a = connect();
    const b = connect('/api/sessions/ext-%407/terminal');
    await Promise.all([a.opened, b.opened]);
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(2));
    t.close();
    expect((await a.closed)[0]).toBe(1001);
    expect((await b.closed)[0]).toBe(1001);
    expect((await connect().refused)[0]).toBe(503);
  });

  it('no ping timer while no socket is open; one while a socket is', async () => {
    const { t, connect, bridge } = await setup();
    expect(t.heartbeat).toBe(false);
    const c = connect();
    await c.opened;
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(1));
    expect(t.heartbeat).toBe(true);
    c.ws.close();
    await c.closed;
    await vi.waitFor(() => expect(t.heartbeat).toBe(false));
  });

  it('a socket that answers no ping is terminated by the next ping, and its handle closed', async () => {
    const { connect, bridge } = await setup({ pingMs: 60 });
    const dead = connect(undefined, { autoPong: false });
    const alive = connect('/api/sessions/ext-%407/terminal');
    await Promise.all([dead.opened, alive.opened]);
    await vi.waitFor(() => expect(bridge.opens).toHaveLength(2));
    const [code] = await dead.closed;
    expect(code).toBe(1006);
    const deadHandle = bridge.opens.find((x) => x.o.windowId === '@2')?.handle as FakeHandle;
    await vi.waitFor(() => expect(deadHandle.closed).toBe(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
  });
});
