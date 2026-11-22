import { LIMITS } from '@kage/shared';
import {
  type ControlClient,
  type ControlLine,
  PANE_INFO_FORMAT,
  sendKeysLines,
} from './control.ts';

export { PANE_INFO_FORMAT } from './control.ts';

const MiB = 1024 * 1024;
/** A snapshot is at most this many bytes; the oldest history rows go first. */
const SNAPSHOT_MAX = MiB;
/** Rows of history a snapshot asks for (`capture-pane -S -1000`). */
const HISTORY_ROWS = 1000;
/** A sink holding more than this stops getting output… */
const HOLD_ABOVE = MiB;
/** …until it is below this; it then gets a fresh snapshot. */
const RESUME_BELOW = 256 * 1024;
const HOLD_CHECK_MS = 100;
const RESIZE_DEBOUNCE_MS = 100;
/** The control client outlives the last terminal by this much, so a reload reuses it. */
const CLIENT_GRACE_MS = 1000;
/** Keys arriving while tmux has more than this unread on its stdin close the terminal (1009). */
const INPUT_BACKLOG_MAX = MiB;

const PANE_ID = /^%\d+$/;
const WINDOW_ID = /^@\d+$/;
const DIGITS = /^\d+$/;

const TOO_MANY = 'Too many terminals are open. Close one and try again.';
const WINDOW_CLOSED = "The session's window has closed.";
const TMUX_STOPPED = 'tmux stopped.';
const TOO_MUCH = 'That was too much at once.';
const STOPPING = 'Kage is stopping.';
/** R61: Claude sets bracketed paste, focus and colour-scheme reports, which tmux can't report back. */
const CLAUDE_MODES = '\x1b[?2004h\x1b[?1004h\x1b[?2031h';

export class BridgeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface PaneInfo {
  paneId: string;
  windowId: string;
  width: number;
  height: number;
  history: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternate: boolean;
  command: string;
  /** DECSET bytes to replay. */
  modes: string;
}

/** Reads one PANE_INFO_FORMAT row; null when it isn't one. */
export function parsePaneInfo(row: string): PaneInfo | null {
  const f = row.split(' ');
  if (f.length < 16) return null;
  const [paneId, windowId] = f as [string, string];
  const n = f.slice(2, 15);
  if (!PANE_ID.test(paneId) || !WINDOW_ID.test(windowId) || !n.every((x) => DIGITS.test(x))) {
    return null;
  }
  const [width, height, history, cursorX, cursorY, cursor, alt, kc, kp, ms, mb, ma, sgr] = n.map(
    Number,
  ) as number[] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const command = f.slice(15).join(' ');
  let modes = '';
  if (kc) modes += '\x1b[?1h';
  if (kp) modes += '\x1b=';
  if (ms) modes += '\x1b[?1000h';
  if (mb) modes += '\x1b[?1002h';
  if (ma) modes += '\x1b[?1003h';
  if (sgr) modes += '\x1b[?1006h';
  if (command === 'claude') modes += CLAUDE_MODES;
  return {
    paneId,
    windowId,
    width,
    height,
    history,
    cursorX,
    cursorY,
    cursorVisible: cursor === 1,
    alternate: alt === 1,
    command,
    modes,
  };
}

const CRLF = Buffer.from('\r\n');

/** Alternate screen on (if set), the rows joined by \r\n with no trailing newline, the modes, then the cursor position and visibility. */
export function snapshotBytes(info: PaneInfo, rows: Buffer[]): Buffer {
  const head = Buffer.from(info.alternate ? '\x1b[?1049h' : '');
  const tail = Buffer.from(
    `\x1b[0m${info.modes}\x1b[${info.cursorY + 1};${info.cursorX + 1}H\x1b[?25${info.cursorVisible ? 'h' : 'l'}`,
  );
  const budget = SNAPSHOT_MAX - head.length - tail.length;
  let size = rows.reduce((s, r) => s + r.length, 0) + 2 * Math.max(0, rows.length - 1);
  // History first, oldest row first; the visible rows (the last `height`) stay.
  const firstVisible = Math.max(0, rows.length - info.height);
  let start = 0;
  while (size > budget && start < firstVisible) {
    size -= (rows[start] as Buffer).length + 2;
    start++;
  }
  const kept = rows.slice(start);
  // Still over (a huge screen): blank visible rows from the top, keeping the screen's geometry.
  for (let i = 0; size > budget && i < kept.length; i++) {
    size -= (kept[i] as Buffer).length;
    kept[i] = Buffer.alloc(0);
  }
  const parts: Buffer[] = [head];
  kept.forEach((r, i) => {
    if (i > 0) parts.push(CRLF);
    parts.push(r);
  });
  parts.push(tail);
  return Buffer.concat(parts);
}

export interface TermSink {
  reset(cols: number, rows: number, snapshot: Buffer): void;
  output(data: Buffer): void;
  size(cols: number, rows: number): void;
  close(code: number, reason: string): void;
  /** Bytes queued and not yet sent (ws.bufferedAmount). */
  buffered(): number;
}

export interface TermHandle {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

type Client = Pick<ControlClient, 'start' | 'run' | 'write' | 'close' | 'pendingInput'>;

interface Term {
  windowId: string;
  paneId: string;
  mode: 'rw' | 'ro';
  sink: TermSink;
  /** snap: a snapshot is in flight (output dropped); held: the sink is too full (output dropped). */
  state: 'snap' | 'live' | 'held' | 'closed';
  /** reset() has been sent: from now on the sink is closed by code, not by a rejected open. */
  opened: boolean;
  /** Why the term closed before open() returned; open() throws it. */
  failure: BridgeError | null;
  keyErrorLogged: boolean;
  resizeTimer: NodeJS.Timeout | null;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.trunc(v)));
const display = (paneId: string): string => `display-message -p -t ${paneId} '${PANE_INFO_FORMAT}'`;
const capture = (paneId: string): string =>
  `capture-pane -p -e -N -S -${HISTORY_ROWS} -t ${paneId}`;
const resizeLine = (windowId: string, cols: number, rows: number): string =>
  `resize-window -t ${windowId} -x ${clamp(cols, LIMITS.termMinCols, LIMITS.termMaxCols)} -y ${clamp(rows, LIMITS.termMinRows, LIMITS.termMaxRows)}`;
/** R61: the only restore; `resize-window -A` would set window-size back to manual. */
const restoreLine = (windowId: string): string => `set-option -w -u -t ${windowId} window-size`;
const firstRow = (blocks: Buffer[][], i: number): string => blocks[i]?.[0]?.toString('utf8') ?? '';

/** The capture's row count from the display-message block: min(history, 1000) + height. */
function snapshotCount(i: number, earlier: Buffer[][]): number | null {
  if (i === 0) return 1;
  const info = parsePaneInfo(firstRow(earlier, 0));
  return info ? Math.min(info.history, HISTORY_ROWS) + info.height : null;
}

/**
 * Browser terminals on tmux panes, through one control-mode client that exists only while a
 * terminal is open. Output is bytes end to end; keys go as hex; nothing is queued here, so a
 * slow browser is held back and then re-synced with a fresh snapshot.
 */
export class TerminalBridge {
  readonly #factory: (o: { onLine: (l: ControlLine) => void; onExit: () => void }) => Client;
  readonly #log: (line: string) => void;
  readonly #onWindowIdle: ((windowId: string) => void) | undefined;
  readonly #terms = new Set<Term>();
  /** Windows this bridge resized and hasn't restored: only these get R61's restore line. */
  readonly #resized = new Set<string>();
  #client: Client | null = null;
  #starting: Promise<Client> | null = null;
  #gen = 0;
  #graceTimer: NodeJS.Timeout | null = null;
  #holdTimer: NodeJS.Timeout | null = null;

  constructor(d: {
    client: (o: { onLine: (l: ControlLine) => void; onExit: () => void }) => Client;
    /** One line for Kage's log (a refused key line). */
    log?: (line: string) => void;
    /** The last terminal on a window closed (F11: auto-archive may look at its session again). */
    onWindowIdle?: (windowId: string) => void;
  }) {
    this.#factory = d.client;
    this.#log = d.log ?? (() => {});
    this.#onWindowIdle = d.onWindowIdle;
  }

  get count(): number {
    return this.#terms.size;
  }

  /** F11/R70: true while a terminal is open (or opening) on the window. */
  isWindowOpen(windowId: string): boolean {
    for (const t of this.#terms) if (t.windowId === windowId) return true;
    return false;
  }

  /** mode 'ro' ignores input() and resize(). Throws BridgeError(4429) over the limits. */
  async open(o: {
    windowId: string;
    paneId: string;
    mode: 'rw' | 'ro';
    cols: number | null;
    rows: number | null;
    sink: TermSink;
  }): Promise<TermHandle> {
    if (!WINDOW_ID.test(o.windowId))
      throw new TypeError(`not a tmux window id: ${JSON.stringify(o.windowId)}`);
    if (!PANE_ID.test(o.paneId))
      throw new TypeError(`not a tmux pane id: ${JSON.stringify(o.paneId)}`);
    let onPane = 0;
    for (const t of this.#terms) if (t.paneId === o.paneId) onPane++;
    if (this.#terms.size >= LIMITS.terminals || onPane >= LIMITS.terminalsPerPane) {
      throw new BridgeError(4429, TOO_MANY);
    }
    const t: Term = {
      windowId: o.windowId,
      paneId: o.paneId,
      mode: o.mode,
      sink: o.sink,
      state: 'snap',
      opened: false,
      failure: null,
      keyErrorLogged: false,
      resizeTimer: null,
    };
    this.#terms.add(t);
    this.#cancelGrace();
    let client: Client;
    try {
      client = await this.#ensureClient();
    } catch {
      this.#close(t, 1011, TMUX_STOPPED);
      this.#afterClose();
      throw t.failure ?? new BridgeError(1011, TMUX_STOPPED);
    }
    if (t.failure) throw t.failure;
    if (o.mode === 'rw' && Number.isFinite(o.cols) && Number.isFinite(o.rows)) {
      this.#resized.add(o.windowId);
      client.write(resizeLine(o.windowId, o.cols as number, o.rows as number));
    }
    try {
      await this.#snapshot(t, client);
    } catch {
      this.#close(t, 4409, WINDOW_CLOSED);
      this.#afterClose();
    }
    if (t.failure) throw t.failure;
    return {
      input: (data) => this.#input(t, data),
      resize: (cols, rows) => this.#resize(t, cols, rows),
      close: () => {
        if (t.state === 'closed') return;
        this.#close(t, null, '');
        this.#afterClose();
      },
    };
  }

  /** Closes every sink with 1001, restores the windows it resized, and closes the client. */
  stop(): void {
    const c = this.#client;
    if (c) for (const w of this.#resized) c.write(restoreLine(w));
    this.#resized.clear();
    for (const t of [...this.#terms]) this.#close(t, 1001, STOPPING, false);
    this.#dropClient();
  }

  #ensureClient(): Promise<Client> {
    if (this.#client) return Promise.resolve(this.#client);
    if (this.#starting) return this.#starting;
    const gen = ++this.#gen;
    const c = this.#factory({
      onLine: (l) => {
        if (gen === this.#gen) this.#line(l);
      },
      onExit: () => {
        if (gen === this.#gen) this.#clientGone();
      },
    });
    const starting = c.start().then(
      () => {
        if (this.#starting === starting) this.#starting = null;
        if (gen !== this.#gen) {
          c.close();
          throw new Error(TMUX_STOPPED);
        }
        this.#client = c;
        return c;
      },
      (e: unknown) => {
        if (this.#starting === starting) this.#starting = null;
        if (gen === this.#gen) this.#gen++;
        c.close();
        throw e;
      },
    );
    this.#starting = starting;
    return starting;
  }

  async #snapshot(t: Term, client: Client): Promise<void> {
    t.state = 'snap';
    const blocks = await client.run([display(t.paneId), capture(t.paneId)], snapshotCount);
    if (t.state !== 'snap') return;
    const info = parsePaneInfo(firstRow(blocks, 0));
    if (!info || info.paneId !== t.paneId || info.windowId !== t.windowId) {
      throw new BridgeError(4409, WINDOW_CLOSED);
    }
    t.opened = true;
    t.sink.reset(info.width, info.height, snapshotBytes(info, blocks[1] ?? []));
    t.state = 'live';
  }

  #line(l: ControlLine): void {
    switch (l.kind) {
      case 'output':
        for (const t of this.#terms) {
          if (t.paneId !== l.paneId || t.state !== 'live') continue;
          if (t.sink.buffered() > HOLD_ABOVE) {
            t.state = 'held';
            this.#scheduleHoldCheck();
          } else {
            t.sink.output(l.data);
          }
        }
        return;
      case 'layout':
        this.#layout(l.windowId);
        return;
      case 'window-close': {
        this.#resized.delete(l.windowId);
        let closed = false;
        for (const t of [...this.#terms]) {
          if (t.windowId !== l.windowId) continue;
          this.#close(t, 4409, WINDOW_CLOSED, false);
          closed = true;
        }
        if (closed) this.#afterClose();
        return;
      }
      case 'exit':
        this.#clientGone();
        return;
      default:
        return;
    }
  }

  /**
   * Every sink on a pane of the window gets its size from a fresh display-message. A pane that
   * has gone (one pane of a multi-pane window exited) makes tmux describe another pane: its
   * sinks close with 4409.
   */
  #layout(windowId: string): void {
    const c = this.#client;
    if (!c) return;
    const panes = new Set<string>();
    for (const t of this.#terms) if (t.windowId === windowId && t.opened) panes.add(t.paneId);
    for (const paneId of panes) {
      c.run([display(paneId)], () => 1).then(
        (blocks) => {
          const info = parsePaneInfo(firstRow(blocks, 0));
          if (!info) return;
          if (info.paneId !== paneId) {
            let closed = false;
            for (const t of [...this.#terms]) {
              if (t.paneId !== paneId || t.state === 'closed') continue;
              this.#close(t, 4409, WINDOW_CLOSED);
              closed = true;
            }
            if (closed) this.#afterClose();
            return;
          }
          for (const t of this.#terms) {
            if (t.paneId === paneId && t.opened && (t.state === 'live' || t.state === 'held')) {
              t.sink.size(info.width, info.height);
            }
          }
        },
        () => {},
      );
    }
  }

  #input(t: Term, data: string): void {
    if (t.mode !== 'rw' || t.state === 'closed' || !t.opened) return;
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length > LIMITS.termInputBytes) {
      this.#close(t, 1009, TOO_MUCH);
      this.#afterClose();
      return;
    }
    const c = this.#client;
    if (!c) return;
    // tmux isn't reading its stdin fast enough: refuse rather than queue without end.
    if (c.pendingInput() > INPUT_BACKLOG_MAX) {
      this.#close(t, 1009, TOO_MUCH);
      this.#afterClose();
      return;
    }
    const onError = (rows: Buffer[]) => {
      if (t.keyErrorLogged) return;
      t.keyErrorLogged = true;
      const why = rows
        .map((r) => r.toString('utf8'))
        .join(' ')
        .slice(0, 200);
      this.#log(`tmux refused keys for ${t.paneId}: ${why}`);
    };
    for (const line of sendKeysLines(t.paneId, bytes)) c.write(line, onError);
  }

  #resize(t: Term, cols: number, rows: number): void {
    if (t.mode !== 'rw' || t.state === 'closed') return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.resizeTimer = setTimeout(() => {
      t.resizeTimer = null;
      const c = this.#client;
      if (t.state === 'closed' || !c) return;
      this.#resized.add(t.windowId);
      c.write(resizeLine(t.windowId, cols, rows));
    }, RESIZE_DEBOUNCE_MS);
  }

  /** While a sink is held: every 100 ms, re-sync the ones that drained with a fresh snapshot. */
  #scheduleHoldCheck(): void {
    if (this.#holdTimer) return;
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      const c = this.#client;
      let stillHeld = false;
      for (const t of this.#terms) {
        if (t.state !== 'held') continue;
        if (c && t.sink.buffered() < RESUME_BELOW) {
          this.#snapshot(t, c).catch(() => {
            if (t.state === 'closed') return;
            this.#close(t, 4409, WINDOW_CLOSED);
            this.#afterClose();
          });
        } else {
          stillHeld = true;
        }
      }
      if (stillHeld) this.#scheduleHoldCheck();
    }, HOLD_CHECK_MS);
  }

  /**
   * Removes a term. A code closes its sink (or, before open() returned, becomes open()'s error).
   * With `restore`, the last rw term of a window writes R61's restore line.
   */
  #close(t: Term, code: number | null, reason: string, restore = true): void {
    if (t.state === 'closed') return;
    t.state = 'closed';
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.resizeTimer = null;
    this.#terms.delete(t);
    if (code !== null) {
      if (t.opened) t.sink.close(code, reason);
      else t.failure = new BridgeError(code, reason);
    }
    let windowOpen = false;
    let rwLeft = false;
    for (const o of this.#terms) {
      if (o.windowId !== t.windowId) continue;
      windowOpen = true;
      if (o.mode === 'rw') rwLeft = true;
    }
    if (restore && t.mode === 'rw' && !rwLeft && this.#resized.has(t.windowId)) {
      this.#resized.delete(t.windowId);
      this.#client?.write(restoreLine(t.windowId));
    }
    if (t.opened && !windowOpen) this.#onWindowIdle?.(t.windowId);
  }

  /** With no terminal left: no hold timer, and the client goes after the grace period. */
  #afterClose(): void {
    if (this.#terms.size > 0) return;
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    if (!this.#client || this.#graceTimer) return;
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = null;
      if (this.#terms.size === 0) this.#dropClient();
    }, CLIENT_GRACE_MS);
  }

  #cancelGrace(): void {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
  }

  /** The client exited (or printed %exit): every sink closes with 1011; the next open starts anew. */
  #clientGone(): void {
    for (const t of [...this.#terms]) this.#close(t, 1011, TMUX_STOPPED, false);
    this.#dropClient();
  }

  #dropClient(): void {
    this.#gen++;
    this.#cancelGrace();
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    const c = this.#client;
    this.#client = null;
    this.#starting = null;
    c?.close();
  }
}
