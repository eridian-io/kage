import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionStatus } from '@kage/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { hasTmux, TmuxClient } from '../tmux/client.ts';
import { TerminalBridge } from './bridge.ts';
import { ControlClient } from './control.ts';
import { TerminalServer } from './server.ts';

const sock = `kage-test-${randomBytes(4).toString('hex')}`;
const tmux = (...a: string[]): string =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' }).replace(
    /\n$/,
    '',
  );

async function until<T>(check: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

function window(...cmd: string[]): { windowId: string; paneId: string } {
  const [windowId, paneId] = tmux(
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{window_id} #{pane_id}',
    '-t',
    '=kage:',
    '--',
    ...cmd,
  ).split(' ');
  return { windowId: windowId as string, paneId: paneId as string };
}

type Target = {
  windowId: string | null;
  paneId: string | null;
  kageId: string | null;
  external: boolean;
  status: SessionStatus;
};

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
});

describe.runIf(hasTmux)('terminal WebSocket (real tmux, private socket, real bridge)', () => {
  const targets = new Map<string, Target>();
  let server: Server;
  let terms: TerminalServer;
  let bridge: TerminalBridge;
  let port = 0;

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'kage', '-x', '80', '-y', '24');
    bridge = new TerminalBridge({
      client: (o) =>
        new ControlClient({
          target: { socket: sock, configFile: '/dev/null' },
          session: 'kage',
          ...o,
        }),
    });
    server = createServer((_q, r) => r.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    terms = new TerminalServer({
      allowed: { hostNames: ['127.0.0.1'], port },
      token: '',
      source: { terminalTarget: (id) => targets.get(id) ?? null },
      bridge,
      tmux: new TmuxClient({ session: 'kage', socket: sock, configFile: '/dev/null' }),
    });
    server.on('upgrade', (q, s, h) => terms.handleUpgrade(q, s, h));
  });
  afterAll(async () => {
    terms?.close();
    bridge?.stop();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const connect = (id: string, query = '') => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/sessions/${encodeURIComponent(id)}/terminal${query}`,
      ['kage.term.v1'],
      { origin: `http://127.0.0.1:${port}` },
    );
    ws.on('error', () => {});
    const text: unknown[] = [];
    const bytes: Buffer[] = [];
    ws.on('message', (d, binary) => {
      if (binary) bytes.push(d as Buffer);
      else text.push(JSON.parse(String(d)));
    });
    const closed = new Promise<[number, string]>((r) =>
      ws.on('close', (c, why) => r([c, why.toString()])),
    );
    const out = () => Buffer.concat(bytes).toString('utf8');
    return { ws, text, bytes, closed, out };
  };

  it('a Kage window (rw): typing in the browser reaches the pane and its echo comes back', async () => {
    const w = window('cat');
    tmux('set-option', '-w', '-t', w.windowId, '@kage_id', 'k-int');
    targets.set('k-int', { ...w, kageId: 'k-int', external: false, status: 'done' });
    const c = connect('k-int', '?cols=100&rows=30');
    await until(() => (c.bytes.length > 0 ? true : undefined));
    expect(c.text[0]).toMatchObject({ t: 'reset', mode: 'rw' });
    expect(tmux('display-message', '-p', '-t', w.paneId, '#{window_width}x#{window_height}')).toBe(
      '100x30',
    );
    c.ws.send(JSON.stringify({ t: 'in', d: 'héllo kage\r' }));
    expect(await until(() => (c.out().includes('héllo kage') ? true : undefined))).toBe(true);
    expect(tmux('capture-pane', '-p', '-t', w.paneId)).toContain('héllo kage');
    c.ws.close();
    await c.closed;
    // The window this bridge resized gets its size option back (R61).
    expect(
      await until(() =>
        tmux('show-options', '-w', '-v', '-t', w.windowId, 'window-size') === '' ? true : undefined,
      ),
    ).toBe(true);
    tmux('kill-window', '-t', w.windowId);
  });

  it('an external window (ro, R54): the pane shows output but never gets the keys', async () => {
    const w = window('cat');
    const id = `ext-${w.windowId}`;
    targets.set(id, { ...w, kageId: null, external: true, status: 'running' });
    const c = connect(id, '?cols=100&rows=30');
    await until(() => (c.bytes.length > 0 ? true : undefined));
    expect(c.text[0]).toMatchObject({ t: 'reset', mode: 'ro' });
    // ro never resizes the window.
    expect(tmux('display-message', '-p', '-t', w.paneId, '#{window_width}')).not.toBe('100');
    c.ws.send(JSON.stringify({ t: 'in', d: 'typed from the board\r' }));
    tmux('send-keys', '-t', w.paneId, '-l', 'typed in tmux');
    tmux('send-keys', '-t', w.paneId, 'Enter');
    expect(await until(() => (c.out().includes('typed in tmux') ? true : undefined))).toBe(true);
    expect(tmux('capture-pane', '-p', '-t', w.paneId)).not.toContain('typed from the board');
    expect(c.out()).not.toContain('typed from the board');
    c.ws.close();
    await c.closed;
    tmux('kill-window', '-t', w.windowId);
  });

  it("a window whose @kage_id is another session's → 4403 before the bridge opens", async () => {
    const w = window('cat');
    tmux('set-option', '-w', '-t', w.windowId, '@kage_id', 'k-someone-else');
    targets.set('k-mine', { ...w, kageId: 'k-mine', external: false, status: 'done' });
    const c = connect('k-mine');
    expect(await c.closed).toEqual([4403, "That window isn't Kage's any more."]);
    expect(bridge.isWindowOpen(w.windowId)).toBe(false);
    tmux('kill-window', '-t', w.windowId);
  });

  it('one pane of a two-pane window exiting closes its terminal with 4409; the window lives on', async () => {
    const w = window('cat');
    const second = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', w.windowId, 'cat');
    const id = `ext-${w.windowId}`;
    targets.set(id, {
      windowId: w.windowId,
      paneId: second,
      kageId: null,
      external: true,
      status: 'running',
    });
    const c = connect(id);
    await until(() => (c.bytes.length > 0 ? true : undefined));
    tmux('kill-pane', '-t', second);
    expect(await c.closed).toEqual([4409, "The session's window has closed."]);
    expect(tmux('list-panes', '-t', w.windowId, '-F', '#{pane_id}')).toBe(w.paneId);
    tmux('kill-window', '-t', w.windowId);
  });

  it('the window closing closes the socket with 4409', async () => {
    const w = window('cat');
    tmux('set-option', '-w', '-t', w.windowId, '@kage_id', 'k-gone');
    targets.set('k-gone', { ...w, kageId: 'k-gone', external: false, status: 'done' });
    const c = connect('k-gone');
    await until(() => (c.bytes.length > 0 ? true : undefined));
    tmux('kill-window', '-t', w.windowId);
    expect(await c.closed).toEqual([4409, "The session's window has closed."]);
  });
});
