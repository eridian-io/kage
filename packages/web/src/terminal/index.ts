/**
 * The terminal chunk (spec §5.6): xterm.js over `GET /api/sessions/:id/terminal`, loaded only when
 * a terminal first opens (term-loader.ts). It must not import the board's store or api: this is a
 * separate esbuild entry, so they would be second copies. It reports to the board through
 * onMode and onEnd instead.
 */
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { LIMITS, TERM_PROTOCOL, type TermServerMsg } from '@kage/shared';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { isLeave } from '../leave.ts';
import { installStyleShim } from './shim.ts';

export interface TermOptions {
  id: string;
  /**
   * The terminal ended by itself (it disposes itself first): the server's close reason to show,
   * '' to end quietly (the tab was hidden too long), or null when the socket never opened (the
   * board then asks /api/auth whether the user must sign in).
   */
  onEnd: (reason: string | null) => void;
  /** F3: the pane's mode from each reset; 'ro' (an external window, R54) takes no input or size. */
  onMode?: (mode: 'rw' | 'ro') => void;
}
export interface TermHandle {
  focus(): void;
  dispose(): void;
}
export interface TerminalModule {
  mountTerminal(el: HTMLElement, o: TermOptions): TermHandle;
}

/** The largest encoded `in` frame (JSON, UTF-8 bytes); the server's maxPayload is above it. */
export const FRAME_MAX = LIMITS.termInputBytes;
/** 1011 (tmux restarted, or the open failed): reconnect after these delays, then give up. */
export const RETRY_MS = [1000, 3000] as const;
export const RESIZE_MS = 100;
/** A tab hidden this long closes its terminal: no socket or xterm kept for a tab nobody sees. */
export const HIDDEN_MS = 5 * 60_000;
const TOO_MUCH = 'That was too much at once.';
const CLOSED = 'The terminal closed.';

/** UTF-8 bytes of one code point inside a JSON string, as JSON.stringify escapes it. */
function cost(c: number): number {
  if (c === 0x22 || c === 0x5c) return 2;
  if (c < 0x20) return c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  // A lone surrogate is escaped as \udxxx.
  if (c >= 0xd800 && c <= 0xdfff) return 6;
  return c < 0x10000 ? 3 : 4;
}

/**
 * Typed or pasted text as `in` frames, each at most FRAME_MAX bytes once encoded. Quotes, newlines
 * and control characters grow when escaped, so the split counts encoded bytes, never characters,
 * and never cuts a character in two.
 */
export function inFrames(d: string): string[] {
  const empty = JSON.stringify({ t: 'in', d: '' }).length;
  const parts: string[] = [];
  let cur = '';
  let size = empty;
  for (const ch of d) {
    const n = cost(ch.codePointAt(0) as number);
    if (cur !== '' && size + n > FRAME_MAX) {
      parts.push(cur);
      cur = '';
      size = empty;
    }
    cur += ch;
    size += n;
  }
  if (cur !== '') parts.push(cur);
  return parts.map((p) => JSON.stringify({ t: 'in', d: p }));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));

export function mountTerminal(el: HTMLElement, o: TermOptions): TermHandle {
  installStyleShim();
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const term = new Terminal({
    fontFamily: '"Geist Mono", ui-monospace, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: token('--bg'),
      foreground: token('--fg'),
      cursor: token('--lime'),
      // The character under the block cursor stays readable.
      cursorAccent: token('--bg'),
      selectionBackground: token('--line-strong'),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // T2: Shift+Esc and Ctrl+Shift+X are the board's (they bubble to its key handler); every other
  // key, Esc included, goes to the pane.
  term.attachCustomKeyEventHandler((e) => !isLeave(e));
  term.open(el);

  let ws: WebSocket | null = null;
  let mode: 'rw' | 'ro' | null = null;
  let ended = false;
  let tries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let resize: ReturnType<typeof setTimeout> | undefined;
  let hidden: ReturnType<typeof setTimeout> | undefined;

  const send = (frame: string) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
  };
  /** The area's size in cells, within the server's limits; null before xterm has measured. */
  const dims = () => {
    const d = fit.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
    return {
      cols: clamp(d.cols, LIMITS.termMinCols, LIMITS.termMaxCols),
      rows: clamp(d.rows, LIMITS.termMinRows, LIMITS.termMaxRows),
    };
  };

  const end = (reason: string | null) => {
    if (ended) return;
    dispose();
    o.onEnd(reason);
  };

  const connect = () => {
    const d = dims();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = d ? `?cols=${d.cols}&rows=${d.rows}` : '';
    const s = new WebSocket(
      `${proto}://${location.host}/api/sessions/${encodeURIComponent(o.id)}/terminal${q}`,
      TERM_PROTOCOL,
    );
    s.binaryType = 'arraybuffer';
    let opened = false;
    s.onopen = () => {
      opened = true;
    };
    s.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') {
        term.write(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      let m: TermServerMsg;
      try {
        m = JSON.parse(e.data) as TermServerMsg;
      } catch {
        return;
      }
      if (m.t === 'reset') {
        const { cols, rows } = m;
        // Behind any output still queued in xterm: resize, clear, then the snapshot (the next
        // binary frame) writes onto the pane's size.
        term.write('', () => {
          term.resize(cols, rows);
          term.reset();
        });
        if (mode !== m.mode) {
          mode = m.mode;
          term.options.disableStdin = mode === 'ro';
          o.onMode?.(mode);
        }
        if (mode === 'rw') fitLater();
      } else if (m.t === 'size') {
        term.resize(m.cols, m.rows);
      }
    };
    s.onclose = (e: CloseEvent) => {
      if (ended || ws !== s) return;
      ws = null;
      // A count overrun restarts tmux's control client: try again, backing off, then give up.
      const wait = RETRY_MS[tries];
      if (e.code === 1011 && wait !== undefined) {
        tries++;
        retry = setTimeout(connect, wait);
        return;
      }
      end(e.reason !== '' ? e.reason : !opened ? null : e.code === 1009 ? TOO_MUCH : CLOSED);
    };
    ws = s;
  };

  const onData = term.onData((d) => {
    // R54: a view-only pane takes no input (the server drops it too).
    if (mode === 'rw') for (const f of inFrames(d)) send(f);
  });

  /**
   * Debounced: when the area's size in cells differs from xterm's, resize and send one size frame.
   * Run for every resize of the area and after every read-write reset (the pane may not have
   * taken the size the socket asked for).
   */
  function fitLater(): void {
    clearTimeout(resize);
    resize = setTimeout(() => {
      // View-only: xterm keeps the pane's size and never resizes it.
      if (mode !== 'rw') return;
      const d = dims();
      if (!d || (d.cols === term.cols && d.rows === term.rows)) return;
      term.resize(d.cols, d.rows);
      send(JSON.stringify({ t: 'size', cols: d.cols, rows: d.rows }));
    }, RESIZE_MS);
  }
  const observer = new ResizeObserver(fitLater);
  observer.observe(el);

  const onVisibility = () => {
    clearTimeout(hidden);
    if (document.visibilityState === 'hidden') hidden = setTimeout(() => end(''), HIDDEN_MS);
  };
  document.addEventListener('visibilitychange', onVisibility);

  function dispose(): void {
    if (ended) return;
    ended = true;
    clearTimeout(retry);
    clearTimeout(resize);
    clearTimeout(hidden);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      if (s.readyState === WebSocket.CONNECTING || s.readyState === WebSocket.OPEN) s.close(1000);
    }
    onData.dispose();
    term.dispose();
  }

  connect();
  return { focus: () => term.focus(), dispose };
}
