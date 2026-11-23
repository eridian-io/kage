import { type IncomingMessage, STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  LIMITS,
  TERM_CLOSE,
  TERM_PROTOCOL,
  type TermClientMsg,
  type TermServerMsg,
} from '@kage/shared';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { DEMO } from '../app.ts';
import { type Auth, remoteAddress, SIGN_IN } from '../auth.ts';
import { GONE_RE, isExecError } from '../control/actions.ts';
import { firstLine } from '../git/exec.ts';
import type { LiveSource } from '../live-source.ts';
import type { Allowed } from '../security.ts';
import type { TmuxClient } from '../tmux/client.ts';
import { BridgeError, type TermHandle, type TerminalBridge, type TermSink } from './bridge.ts';
import { checkUpgrade } from './upgrade.ts';

const ENDED = 'This session has ended.';
const NOT_KAGES = "That window isn't Kage's any more.";
const UNCLEAR = "Kage didn't understand that.";
const STOPPING = 'Kage is stopping.';
const FAILED = "Kage couldn't open the terminal.";
const TOO_MANY = 'Too many terminals are open. Close one and try again.';
/**
 * B35: at most this many upgraded sockets wait for their session checks and bridge.open at once;
 * one more closes with 4429. A socket whose client hung up still counts until its open settles.
 */
const MAX_OPENING = 2 * LIMITS.terminals;
const unknown = (id: string) => `No session with id ${id}.`;
/** After close(), a socket that hasn't finished its closing handshake by then is cut. */
const CLOSE_GRACE_MS = 1000;

/**
 * A client frame, strictly: `{t: 'in', d: string}` or `{t: 'size', cols, rows}` with integer
 * sizes and no other keys. Anything else is null.
 */
export function parseClientMsg(text: string): TermClientMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.t === 'in' && keys === 'd,t' && typeof o.d === 'string') return { t: 'in', d: o.d };
  if (
    o.t === 'size' &&
    keys === 'cols,rows,t' &&
    Number.isInteger(o.cols) &&
    Number.isInteger(o.rows)
  ) {
    return { t: 'size', cols: o.cols as number, rows: o.rows as number };
  }
  return null;
}

/** A plain HTTP answer on the raw socket, before any upgrade, then the socket is destroyed. */
function refuse(socket: Duplex, status: number, error: string): void {
  if (socket.destroyed) return;
  const body = `${error}\n`;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

const toBuffer = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

interface Conn {
  ws: WebSocket;
  /** A pong (or the open) since the last ping. */
  alive: boolean;
  mode: 'rw' | 'ro';
  handle: TermHandle | null;
  /** The login session that opened it (its key), or null with no token. */
  owner: string | null;
}

export interface TerminalServerDeps {
  allowed: Allowed;
  /** The token and the logins: an upgrade needs a live session from the same address. */
  auth: Auth;
  /** Null in demo mode. */
  source: Pick<LiveSource, 'terminalTarget'> | null;
  bridge: Pick<TerminalBridge, 'open'> | null;
  tmux: Pick<TmuxClient, 'windowKageId'> | null;
  /** A ws ping per socket this often; no pong by the next one terminates it (default 30 s). */
  pingMs?: number;
}

/**
 * `GET /api/sessions/:id/terminal` as a WebSocket (spec §5.2, B9). Every guard of checkUpgrade
 * runs before the upgrade and refuses with a plain HTTP status. After it, the session checks
 * close with TERM_CLOSE codes, and the bridge gets a sink over the socket. External windows are
 * view-only (R54): their `in` and `size` frames are dropped here, and the bridge drops them too.
 */
export class TerminalServer {
  readonly #d: TerminalServerDeps;
  readonly #wss: WebSocketServer;
  readonly #pingMs: number;
  readonly #conns = new Set<Conn>();
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  /** Upgraded sockets whose session checks and bridge.open haven't settled yet (B35). */
  #opening = 0;

  constructor(d: TerminalServerDeps) {
    this.#d = d;
    this.#pingMs = d.pingMs ?? 30_000;
    this.#wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: LIMITS.termInputBytes + 1024,
      // checkUpgrade has made sure the client offered it.
      handleProtocols: () => TERM_PROTOCOL,
    });
  }

  /** True while the ping timer runs (only while a socket is open). */
  get heartbeat(): boolean {
    return this.#timer !== null;
  }

  /** The Node server's 'upgrade' event for any path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (this.#closed) {
      refuse(socket, 503, STOPPING);
      return;
    }
    const check = checkUpgrade(req, {
      allowed: this.#d.allowed,
      auth: this.#d.auth,
      peer: remoteAddress({ incoming: req }),
    });
    if (!check.ok) {
      refuse(socket, check.status, check.error);
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      if (this.#closed) {
        ws.close(1001, STOPPING);
        return;
      }
      const owner = check.session ?? null;
      // The session may have ended during the handshake.
      if (owner !== null && !this.#d.auth.sessions.has(owner)) {
        ws.on('error', () => {});
        ws.close(TERM_CLOSE.forbidden, SIGN_IN);
        return;
      }
      // B35: LIMITS.terminals caps open terminals in the bridge; this caps the ones still opening.
      if (this.#opening >= MAX_OPENING) {
        ws.on('error', () => {});
        ws.close(TERM_CLOSE.tooMany, TOO_MANY);
        return;
      }
      this.#attach(ws, check.id, check.cols, check.rows, owner);
    });
  }

  /**
   * Closes every terminal the login session `key` opened, with 4403 "Sign in to Kage" (sign-out,
   * eviction or expiry, F6).
   */
  closeOwner(key: string): void {
    for (const c of this.#conns) if (c.owner === key) this.#end(c, TERM_CLOSE.forbidden, SIGN_IN);
  }

  /** Every socket closes with 1001; later upgrades are refused (503). */
  close(): void {
    this.#closed = true;
    this.#stopTimer();
    const conns = [...this.#conns];
    for (const c of conns) c.ws.close(1001, STOPPING);
    if (conns.length === 0) return;
    setTimeout(() => {
      for (const c of conns) if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
    }, CLOSE_GRACE_MS).unref();
  }

  #attach(
    ws: WebSocket,
    id: string,
    cols: number | null,
    rows: number | null,
    owner: string | null,
  ): void {
    const conn: Conn = { ws, alive: true, mode: 'ro', handle: null, owner };
    this.#conns.add(conn);
    this.#startTimer();
    // ws reports a too-large frame (it closes with 1009 itself) and socket errors here.
    ws.on('error', () => {});
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, binary) => this.#message(conn, data, binary));
    ws.on('close', () => {
      this.#conns.delete(conn);
      const h = conn.handle;
      conn.handle = null;
      h?.close();
      if (this.#conns.size === 0) this.#stopTimer();
    });
    this.#opening++;
    void this.#open(conn, id, cols, rows)
      .catch(() => this.#end(conn, 1011, FAILED))
      .finally(() => {
        this.#opening--;
      });
  }

  async #open(conn: Conn, id: string, cols: number | null, rows: number | null): Promise<void> {
    const { source, bridge, tmux } = this.#d;
    if (!source || !bridge || !tmux) return this.#end(conn, TERM_CLOSE.demo, DEMO);
    const t = source.terminalTarget(id);
    if (!t) return this.#end(conn, TERM_CLOSE.gone, unknown(id));
    if (t.status === 'ended' || t.windowId === null || t.paneId === null) {
      return this.#end(conn, TERM_CLOSE.ended, ENDED);
    }
    const { windowId, paneId } = t;
    let mode: 'rw' | 'ro' = 'ro';
    if (!t.external) {
      // Only a window that still holds the record's kage id is typed into (rw).
      let held: string | null;
      try {
        held = await tmux.windowKageId(windowId);
      } catch (e) {
        if (isExecError(e) && GONE_RE.test(firstLine(e))) {
          return this.#end(conn, TERM_CLOSE.ended, ENDED);
        }
        return this.#end(conn, 1011, FAILED);
      }
      if (held === null || held !== t.kageId) {
        return this.#end(conn, TERM_CLOSE.forbidden, NOT_KAGES);
      }
      // The listing may have moved on during the read.
      const again = source.terminalTarget(id);
      if (again?.windowId !== windowId || again.paneId !== paneId) {
        return this.#end(conn, TERM_CLOSE.ended, ENDED);
      }
      mode = 'rw';
    }
    if (!this.#live(conn)) return;
    conn.mode = mode;
    let handle: TermHandle;
    try {
      handle = await bridge.open({ windowId, paneId, mode, cols, rows, sink: this.#sink(conn) });
    } catch (e) {
      if (e instanceof BridgeError) return this.#end(conn, e.code, e.message);
      return this.#end(conn, 1011, FAILED);
    }
    if (!this.#live(conn)) {
      handle.close();
      return;
    }
    conn.handle = handle;
  }

  #sink(conn: Conn): TermSink {
    const { ws } = conn;
    const text = (m: TermServerMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const bytes = (b: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(b, { binary: true });
    };
    return {
      reset: (cols, rows, snapshot) => {
        text({ t: 'reset', cols, rows, mode: conn.mode });
        bytes(snapshot);
      },
      output: bytes,
      size: (cols, rows) => text({ t: 'size', cols, rows }),
      close: (code, reason) => this.#end(conn, code, reason),
      buffered: () => ws.bufferedAmount,
    };
  }

  #message(conn: Conn, data: RawData, binary: boolean): void {
    const msg = binary ? null : parseClientMsg(toBuffer(data).toString('utf8'));
    if (!msg) {
      this.#end(conn, 1003, UNCLEAR);
      return;
    }
    // R54: a view-only terminal drops input and sizes; so does one not yet open.
    const h = conn.handle;
    if (!h || conn.mode !== 'rw') return;
    if (msg.t === 'in') h.input(msg.d);
    else h.resize(msg.cols, msg.rows);
  }

  #live(conn: Conn): boolean {
    return !this.#closed && conn.ws.readyState === WebSocket.OPEN;
  }

  #end(conn: Conn, code: number, reason: string): void {
    const { ws } = conn;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  }

  #startTimer(): void {
    if (this.#timer || this.#conns.size === 0) return;
    this.#timer = setInterval(() => {
      for (const c of this.#conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          c.ws.terminate();
        }
      }
    }, this.#pingMs);
    this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
