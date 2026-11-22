import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** xterm can't run in happy-dom: a fake at the module boundary records what the chunk asks of it. */
const fx = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const terms: FakeTerm[] = [];
  const fit = { dims: { cols: 100, rows: 30 } as { cols: number; rows: number } | undefined };
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    keys: ((e: KeyboardEvent) => boolean) | null = null;
    data: ((d: string) => void) | null = null;
    el: HTMLElement | null = null;
    dataSub = { dispose: vi.fn() };
    dispose = vi.fn();
    focus = vi.fn();
    constructor(o: Record<string, unknown>) {
      this.options = { ...o };
      terms.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      this.keys = h;
    }
    open(el: HTMLElement) {
      this.el = el;
    }
    write(d: unknown, cb?: () => void) {
      calls.push(['write', d]);
      cb?.();
    }
    resize(c: number, r: number) {
      calls.push(['resize', c, r]);
      this.cols = c;
      this.rows = r;
    }
    reset() {
      calls.push(['reset']);
    }
    onData(cb: (d: string) => void) {
      this.data = cb;
      return this.dataSub;
    }
  }
  class FakeFit {
    proposeDimensions() {
      return fit.dims;
    }
  }
  return { calls, terms, fit, FakeTerm, FakeFit };
});
vi.mock('@xterm/xterm', () => ({ Terminal: fx.FakeTerm }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fx.FakeFit }));

import { FRAME_MAX, HIDDEN_MS, inFrames, mountTerminal, RESIZE_MS } from './index.ts';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closed: number[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  readonly url: string;
  readonly protocol: string;
  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    FakeSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close(code: number) {
    this.closed.push(code);
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  bytes(b: number[]) {
    this.onmessage?.({ data: new Uint8Array(b).buffer });
  }
  end(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

let observed: (() => void) | null;
let disconnected: number;
class FakeObserver {
  constructor(cb: () => void) {
    observed = cb;
  }
  observe() {}
  disconnect() {
    disconnected++;
  }
}

const last = () => FakeSocket.all.at(-1) as FakeSocket;
const term = () => fx.terms.at(-1) as InstanceType<typeof fx.FakeTerm>;
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

let ends: (string | null)[];
const handles: { dispose(): void }[] = [];
let modes: string[];
function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const h = mountTerminal(el, {
    id: 'web',
    onEnd: (r) => ends.push(r),
    onMode: (m) => modes.push(m),
  });
  handles.push(h);
  return { el, h };
}
/** Mounted and attached in this mode, with the first reset and snapshot through. */
function attached(mode: 'rw' | 'ro') {
  const m = mount();
  last().open();
  last().text({ t: 'reset', cols: 120, rows: 40, mode });
  last().bytes([0x68, 0x69]);
  return m;
}

beforeEach(() => {
  fx.calls.length = 0;
  fx.terms.length = 0;
  fx.fit.dims = { cols: 100, rows: 30 };
  FakeSocket.all = [];
  observed = null;
  disconnected = 0;
  ends = [];
  modes = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', FakeObserver);
});
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('mountTerminal', () => {
  it('opens xterm in the area with the theme from the tokens, Geist Mono 13 px, 5,000 lines', () => {
    document.documentElement.style.setProperty('--lime', '#cdf35a');
    document.documentElement.style.setProperty('--bg', '#0f1114');
    const { el } = mount();
    expect(term().el).toBe(el);
    expect(term().options.fontSize).toBe(13);
    expect(term().options.scrollback).toBe(5000);
    expect(String(term().options.fontFamily)).toMatch(/^"Geist Mono"/);
    const theme = term().options.theme as Record<string, string>;
    expect(theme.cursor).toBe('#cdf35a');
    expect(theme.background).toBe('#0f1114');
  });

  it('connects to the session with the fitted size, the protocol and binary frames', () => {
    mount();
    expect(last().url).toBe(`ws://${location.host}/api/sessions/web/terminal?cols=100&rows=30`);
    expect(last().protocol).toBe('kage.term.v1');
    expect(last().binaryType).toBe('arraybuffer');
  });

  it('clamps the fitted size to the limits, and leaves it out before xterm has measured', () => {
    fx.fit.dims = { cols: 900, rows: 2 };
    mount();
    expect(last().url).toMatch(/\?cols=500&rows=5$/);
    fx.fit.dims = undefined;
    mount();
    expect(last().url).toMatch(/\/terminal$/);
  });

  it('reset resizes and clears before it writes the snapshot; output frames are bytes', () => {
    attached('rw');
    last().bytes([0x1b, 0x5b, 0x41]);
    expect(fx.calls).toEqual([
      ['write', ''],
      ['resize', 120, 40],
      ['reset'],
      ['write', new Uint8Array([0x68, 0x69])],
      ['write', new Uint8Array([0x1b, 0x5b, 0x41])],
    ]);
    expect(modes).toEqual(['rw']);
  });

  it('a size message resizes xterm', () => {
    attached('rw');
    last().text({ t: 'size', cols: 90, rows: 20 });
    expect(fx.calls.at(-1)).toEqual(['resize', 90, 20]);
  });

  it('onData sends an in frame once attached read-write', () => {
    mount();
    last().open();
    term().data?.('x');
    expect(last().sent).toEqual([]);
    last().text({ t: 'reset', cols: 120, rows: 40, mode: 'rw' });
    term().data?.('x');
    expect(last().sent).toEqual(['{"t":"in","d":"x"}']);
  });

  it('read-only reports ro, sends no input and no size frames, and keeps the pane size', () => {
    vi.useFakeTimers();
    attached('ro');
    expect(modes).toEqual(['ro']);
    expect(term().options.disableStdin).toBe(true);
    term().data?.('x');
    fx.fit.dims = { cols: 60, rows: 20 };
    observed?.();
    vi.advanceTimersByTime(RESIZE_MS * 2);
    expect(last().sent).toEqual([]);
    expect(fx.calls.filter((c) => c[0] === 'resize')).toEqual([['resize', 120, 40]]);
  });

  it('read-write: a resize of the area sends one size frame, debounced, within the limits', () => {
    vi.useFakeTimers();
    attached('rw');
    fx.fit.dims = { cols: 60, rows: 20 };
    observed?.();
    vi.advanceTimersByTime(RESIZE_MS / 2);
    fx.fit.dims = { cols: 1000, rows: 21 };
    observed?.();
    vi.advanceTimersByTime(RESIZE_MS - 1);
    expect(last().sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(last().sent).toEqual(['{"t":"size","cols":500,"rows":21}']);
    expect(fx.calls.at(-1)).toEqual(['resize', 500, 21]);
    // The same size again sends nothing.
    observed?.();
    vi.advanceTimersByTime(RESIZE_MS);
    expect(last().sent).toHaveLength(1);
  });

  it('after a read-write reset the area is fitted: a size that differs sends one size frame', () => {
    vi.useFakeTimers();
    attached('rw');
    // The fit addon proposes 100x30; the pane came back at 120x40.
    vi.advanceTimersByTime(RESIZE_MS - 1);
    expect(last().sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(last().sent).toEqual(['{"t":"size","cols":100,"rows":30}']);
    expect(fx.calls.at(-1)).toEqual(['resize', 100, 30]);
    // A reset at the area's size sends nothing more.
    last().text({ t: 'reset', cols: 100, rows: 30, mode: 'rw' });
    vi.advanceTimersByTime(RESIZE_MS);
    expect(last().sent).toHaveLength(1);
  });

  it('Shift+Escape and Ctrl+Shift+X are not sent to the pane; Escape and Ctrl+X are', () => {
    mount();
    const keys = term().keys as (e: KeyboardEvent) => boolean;
    expect(keys(key({ key: 'Escape', shiftKey: true }))).toBe(false);
    expect(keys(key({ key: 'X', ctrlKey: true, shiftKey: true }))).toBe(false);
    // A non-Latin layout: the physical X key.
    expect(keys(key({ key: 'Ч', code: 'KeyX', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(keys(key({ key: 'Escape' }))).toBe(true);
    expect(keys(key({ key: 'x', ctrlKey: true }))).toBe(true);
    expect(keys(key({ key: 'Escape', shiftKey: true, altKey: true }))).toBe(true);
  });

  it("a server close ends it with the server's reason, disposed, with no retry", () => {
    vi.useFakeTimers();
    attached('rw');
    last().end(4409, "The session's window has closed.");
    expect(ends).toEqual(["The session's window has closed."]);
    expect(term().dispose).toHaveBeenCalledTimes(1);
    expect(disconnected).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('the demo answer (4501) ends it with its sentence', () => {
    mount();
    last().open();
    last().end(4501, 'Demo mode has no terminal.');
    expect(ends).toEqual(['Demo mode has no terminal.']);
  });

  it('a socket that never opened ends with null (the board asks /api/auth)', () => {
    mount();
    last().end(1006);
    expect(ends).toEqual([null]);
  });

  it('1009 with no reason says the input was too much; another reasonless close says so', () => {
    attached('rw');
    last().end(1009);
    attached('rw');
    last().end(1006);
    expect(ends).toEqual(['That was too much at once.', 'The terminal closed.']);
  });

  it('1011 reconnects after 1 s, then after 3 s, then gives up with the reason', () => {
    vi.useFakeTimers();
    attached('rw');
    last().end(1011, 'tmux stopped.');
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    last().text({ t: 'reset', cols: 120, rows: 40, mode: 'rw' });
    last().end(1011, 'tmux stopped.');
    vi.advanceTimersByTime(2999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().end(1011, "Kage couldn't open the terminal.");
    expect(ends).toEqual(["Kage couldn't open the terminal."]);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('dispose closes the socket (1000) and xterm, stops every timer and never calls onEnd', () => {
    vi.useFakeTimers();
    const { h } = attached('rw');
    const s = last();
    observed?.();
    document.dispatchEvent(new Event('visibilitychange'));
    h.dispose();
    h.dispose();
    expect(s.closed).toEqual([1000]);
    expect(term().dispose).toHaveBeenCalledTimes(1);
    expect(term().dataSub.dispose).toHaveBeenCalledTimes(1);
    expect(disconnected).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    s.end(1000);
    expect(ends).toEqual([]);
  });

  it('dispose while a 1011 retry waits cancels it', () => {
    vi.useFakeTimers();
    const { h } = attached('rw');
    last().end(1011, 'tmux stopped.');
    h.dispose();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a tab hidden for 5 minutes ends it quietly; shown again in time, it stays', () => {
    vi.useFakeTimers();
    let state = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => state as DocumentVisibilityState,
    );
    attached('rw');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HIDDEN_MS - 1);
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HIDDEN_MS);
    expect(ends).toEqual([]);
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(HIDDEN_MS);
    expect(ends).toEqual(['']);
    expect(last().closed).toEqual([1000]);
  });
});

describe('inFrames', () => {
  const bytes = (f: string) => new TextEncoder().encode(f).length;
  const joined = (fs: string[]) => fs.map((f) => (JSON.parse(f) as { d: string }).d).join('');

  it('sends short input as one frame', () => {
    expect(inFrames('ls\r')).toEqual(['{"t":"in","d":"ls\\r"}']);
  });

  it('splits a 64 KiB paste of quotes by encoded size: several frames, none over the limit', () => {
    const paste = '"'.repeat(64 * 1024);
    const fs = inFrames(paste);
    expect(fs.length).toBeGreaterThan(1);
    for (const f of fs) expect(bytes(f)).toBeLessThanOrEqual(FRAME_MAX);
    expect(joined(fs)).toBe(paste);
  });

  it('counts escapes, control bytes and multi-byte characters exactly, never cutting one', () => {
    const paste = '\x01\n\\é😀 '.repeat(20_000) + '\ud800';
    const fs = inFrames(paste);
    for (const f of fs) {
      expect(bytes(f)).toBeLessThanOrEqual(FRAME_MAX);
      expect((JSON.parse(f) as { d: string }).d.at(-1)).not.toBe('\ud83d');
    }
    // Each frame but the last is close to full: the count isn't over-cautious.
    for (const f of fs.slice(0, -1)) expect(bytes(f)).toBeGreaterThan(FRAME_MAX - 16);
    expect(joined(fs)).toBe(paste);
  });
});
