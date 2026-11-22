import { LIMITS } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  PANE_INFO_FORMAT,
  type PaneInfo,
  parsePaneInfo,
  snapshotBytes,
  TerminalBridge,
  type TermSink,
} from './bridge.ts';
import type { ControlLine } from './control.ts';

const MiB = 1024 * 1024;

interface Run {
  line: string;
  countFor?: (i: number, earlier: Buffer[][]) => number | null;
  resolve: (v: Buffer[][]) => void;
  reject: (e: Error) => void;
}

class FakeClient {
  started = 0;
  closed = false;
  /** Bytes written to tmux's stdin and not yet taken (pendingInput). */
  pending = 0;
  written: string[] = [];
  runs: Run[] = [];
  writeErrors: ((rows: Buffer[]) => void)[] = [];
  startResult: Promise<void> = Promise.resolve();
  readonly onLine: (l: ControlLine) => void;
  readonly onExit: () => void;
  constructor(onLine: (l: ControlLine) => void, onExit: () => void) {
    this.onLine = onLine;
    this.onExit = onExit;
  }
  start() {
    this.started++;
    return this.startResult;
  }
  run(cmds: string[], countFor?: Run['countFor']): Promise<Buffer[][]> {
    const line = cmds.join(' ; ');
    this.written.push(line);
    return new Promise((resolve, reject) => this.runs.push({ line, countFor, resolve, reject }));
  }
  write(line: string, onError?: (rows: Buffer[]) => void) {
    this.written.push(line);
    if (onError) this.writeErrors.push(onError);
  }
  close() {
    this.closed = true;
  }
  pendingInput() {
    return this.pending;
  }
}

interface Info {
  pane?: string;
  win?: string;
  w?: number;
  h?: number;
  hist?: number;
  cx?: number;
  cy?: number;
  cur?: number;
  alt?: number;
  cmd?: string;
}
const infoRow = (i: Info = {}): string =>
  [
    i.pane ?? '%3',
    i.win ?? '@2',
    i.w ?? 80,
    i.h ?? 24,
    i.hist ?? 0,
    i.cx ?? 2,
    i.cy ?? 4,
    i.cur ?? 1,
    i.alt ?? 0,
    0,
    0,
    0,
    0,
    0,
    0,
    i.cmd ?? 'sh',
  ].join(' ');

class FakeSink implements TermSink {
  resets: { cols: number; rows: number; snapshot: Buffer }[] = [];
  outputs: Buffer[] = [];
  sizes: [number, number][] = [];
  closes: [number, string][] = [];
  queued = 0;
  reset(cols: number, rows: number, snapshot: Buffer) {
    this.resets.push({ cols, rows, snapshot });
  }
  output(data: Buffer) {
    this.outputs.push(data);
  }
  size(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  close(code: number, reason: string) {
    this.closes.push([code, reason]);
  }
  buffered() {
    return this.queued;
  }
  text() {
    return Buffer.concat(this.outputs).toString();
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup() {
  const clients: FakeClient[] = [];
  const idle: string[] = [];
  const logs: string[] = [];
  const bridge = new TerminalBridge({
    client: ({ onLine, onExit }) => {
      const c = new FakeClient(onLine, onExit);
      clients.push(c);
      return c as never;
    },
    onWindowIdle: (w) => idle.push(w),
    log: (l) => logs.push(l),
  });
  const last = () => clients.at(-1) as FakeClient;
  /** Answers the oldest pending snapshot run. */
  const answer = async (info: Info = {}, rows?: string[]) => {
    await flush();
    const c = last();
    const run = c.runs.shift();
    if (!run) throw new Error('no pending run');
    const h = info.h ?? 24;
    const body = rows ?? Array.from({ length: h }, (_, i) => `row ${i}`);
    run.resolve([[Buffer.from(infoRow(info))], body.map((r) => Buffer.from(r))]);
    await flush();
  };
  const open = async (
    o: Partial<{
      windowId: string;
      paneId: string;
      mode: 'rw' | 'ro';
      cols: number | null;
      rows: number | null;
    }> = {},
    info: Info = {},
  ) => {
    const sink = new FakeSink();
    const p = bridge.open({
      windowId: o.windowId ?? '@2',
      paneId: o.paneId ?? '%3',
      mode: o.mode ?? 'rw',
      cols: o.cols ?? null,
      rows: o.rows ?? null,
      sink,
    });
    await answer({ pane: o.paneId ?? '%3', win: o.windowId ?? '@2', ...info });
    const handle = await p;
    return { sink, handle };
  };
  return { bridge, clients, last, answer, open, idle, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('parsePaneInfo', () => {
  it('reads the format, with a command that has spaces', () => {
    expect(parsePaneInfo('%3 @2 80 24 51 2 4 1 0 1 1 0 0 1 1 my tool')).toEqual({
      paneId: '%3',
      windowId: '@2',
      width: 80,
      height: 24,
      history: 51,
      cursorX: 2,
      cursorY: 4,
      cursorVisible: true,
      alternate: false,
      command: 'my tool',
      modes: '\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h',
    } satisfies PaneInfo);
  });
  it("replays Claude's private modes for a claude pane (R61)", () => {
    expect(parsePaneInfo(infoRow({ cmd: 'claude' }))?.modes).toBe(
      '\x1b[?2004h\x1b[?1004h\x1b[?2031h',
    );
  });
  it('refuses a short or malformed row', () => {
    expect(parsePaneInfo('40 6 0 2 4 1 0 0 0 0 0 0 0 sh')).toBeNull();
    expect(parsePaneInfo(infoRow({ pane: 'x' }))).toBeNull();
    expect(parsePaneInfo('%3 @2 80 x 0 0 0 1 0 0 0 0 0 0 0 sh')).toBeNull();
    expect(parsePaneInfo('')).toBeNull();
  });
  it('the format is constant tmux variables, the command last', () => {
    expect(
      PANE_INFO_FORMAT.startsWith('#{pane_id} #{window_id} #{pane_width} #{pane_height}'),
    ).toBe(true);
    expect(PANE_INFO_FORMAT.endsWith('#{pane_current_command}')).toBe(true);
  });
});

describe('snapshotBytes', () => {
  const info = parsePaneInfo(infoRow({ cx: 2, cy: 1, cur: 1 })) as PaneInfo;
  it('joins rows by \\r\\n, then modes, then the cursor', () => {
    const s = snapshotBytes(info, [Buffer.from('a'), Buffer.from('b')]).toString();
    expect(s).toBe('a\r\nb\x1b[0m\x1b[2;3H\x1b[?25h');
  });
  it('turns the alternate screen on first and hides a hidden cursor', () => {
    const alt = parsePaneInfo(infoRow({ alt: 1, cur: 0, cmd: 'claude' })) as PaneInfo;
    const s = snapshotBytes(alt, [Buffer.from('x')]).toString();
    expect(s).toBe('\x1b[?1049hx\x1b[0m\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[5;3H\x1b[?25l');
  });
  it('is capped at 1 MiB, the oldest rows going first', () => {
    const rows = Array.from({ length: 30 }, (_, i) => Buffer.alloc(64 * 1024, 0x41 + (i % 26)));
    const s = snapshotBytes({ ...info, height: 4 }, rows);
    expect(s.length).toBeLessThanOrEqual(MiB);
    // The last (visible) row is kept.
    expect(s.includes(rows[29] as Buffer)).toBe(true);
    expect(s.subarray(0, 64 * 1024).equals(rows[0] as Buffer)).toBe(false);
  });
});

describe('TerminalBridge', () => {
  it('the first open starts the client; closing the last stops it, leaving no timers', async () => {
    const t = setup();
    expect(t.clients).toHaveLength(0);
    const a = await t.open();
    const b = await t.open({ mode: 'ro' });
    expect(t.clients).toHaveLength(1);
    expect(t.last().started).toBe(1);
    expect(t.bridge.count).toBe(2);
    a.handle.close();
    b.handle.close();
    expect(t.bridge.count).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.last().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an open during the grace period reuses the client', async () => {
    const t = setup();
    (await t.open()).handle.close();
    await vi.advanceTimersByTimeAsync(100);
    await t.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.clients).toHaveLength(1);
    expect(t.last().closed).toBe(false);
  });

  it('snapshots with display-message then capture-pane, counted from the first block', async () => {
    const t = setup();
    const sink = new FakeSink();
    const p = t.bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'ro',
      cols: null,
      rows: null,
      sink,
    });
    await flush();
    const run = t.last().runs[0] as Run;
    expect(run.line).toBe(
      `display-message -p -t %3 '${PANE_INFO_FORMAT}' ; capture-pane -p -e -N -S -1000 -t %3`,
    );
    expect(run.countFor?.(0, [])).toBe(1);
    expect(run.countFor?.(1, [[Buffer.from(infoRow({ hist: 51, h: 24 }))]])).toBe(75);
    expect(run.countFor?.(1, [[Buffer.from(infoRow({ hist: 1801, h: 24 }))]])).toBe(1024);
    expect(run.countFor?.(1, [[Buffer.from('junk')]])).toBeNull();
    t.last().runs.shift();
    run.resolve([
      [Buffer.from(infoRow({ w: 100, h: 2, cx: 1, cy: 0 }))],
      [Buffer.from('a'), Buffer.from('b')],
    ]);
    await p;
    expect(sink.resets).toHaveLength(1);
    expect(sink.resets[0]?.cols).toBe(100);
    expect(sink.resets[0]?.rows).toBe(2);
    expect(sink.resets[0]?.snapshot.toString().endsWith('\x1b[1;2H\x1b[?25h')).toBe(true);
  });

  it('output for another pane never reaches the sink', async () => {
    const t = setup();
    const { sink } = await t.open();
    t.last().onLine({ kind: 'output', paneId: '%4', data: Buffer.from('other') });
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('mine') });
    expect(sink.text()).toBe('mine');
  });

  it('output before the snapshot answer is dropped; output after it is forwarded', async () => {
    const t = setup();
    const sink = new FakeSink();
    const p = t.bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'rw',
      cols: null,
      rows: null,
      sink,
    });
    await flush();
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('before') });
    await t.answer();
    await p;
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('after') });
    expect(sink.text()).toBe('after');
  });

  it('ro: input and resize write nothing', async () => {
    const t = setup();
    const { handle } = await t.open({ mode: 'ro', cols: 100, rows: 30 });
    const before = t.last().written.length;
    handle.input('é');
    handle.resize(100, 30);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.last().written.length).toBe(before);
    expect(t.last().written.some((l) => l.startsWith('resize-window'))).toBe(false);
  });

  it("rw: input('é') writes the -H c3 a9 line, in order across lines", async () => {
    const t = setup();
    const { handle } = await t.open();
    handle.input('é');
    expect(t.last().written.at(-1)).toBe('send-keys -t %3 -H c3 a9');
    handle.input('x'.repeat(600));
    expect(
      t
        .last()
        .written.slice(-3)
        .every((l) => l.startsWith('send-keys -t %3 -H 78')),
    ).toBe(true);
  });

  it('a key line error is logged once per sink', async () => {
    const t = setup();
    const { handle } = await t.open();
    handle.input('a');
    handle.input('b');
    for (const e of t.last().writeErrors) e([Buffer.from('no such pane')]);
    expect(t.logs.filter((l) => l.includes('no such pane'))).toHaveLength(1);
  });

  it('input over the limit closes the sink with 1009', async () => {
    const t = setup();
    const { sink, handle } = await t.open();
    handle.input('é'.repeat(LIMITS.termInputBytes / 2 + 1));
    expect(sink.closes).toEqual([[1009, 'That was too much at once.']]);
    expect(t.bridge.count).toBe(0);
    expect(t.last().written.some((l) => l.startsWith('send-keys'))).toBe(false);
  });

  it('five resizes in 50 ms → one resize-window, clamped', async () => {
    const t = setup();
    const { handle } = await t.open();
    for (let i = 0; i < 4; i++) {
      handle.resize(100 + i, 30);
      await vi.advanceTimersByTimeAsync(10);
    }
    handle.resize(9999, 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.last().written.filter((l) => l.startsWith('resize-window'))).toEqual([
      'resize-window -t @2 -x 500 -y 5',
    ]);
  });

  it('an rw open with a size resizes the window before the snapshot', async () => {
    const t = setup();
    await t.open({ cols: 10, rows: 300 });
    const lines = t.last().written;
    expect(lines[0]).toBe('resize-window -t @2 -x 20 -y 200');
    expect(lines[1]?.startsWith('display-message')).toBe(true);
  });

  it('a size that is not a number is ignored at open (no resize, no leaked slot)', async () => {
    const t = setup();
    const { handle } = await t.open({ cols: Number.NaN, rows: 30 });
    expect(t.last().written.some((l) => l.startsWith('resize-window'))).toBe(false);
    handle.resize(Number.NaN, 30);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.last().written.some((l) => l.startsWith('resize-window'))).toBe(false);
    expect(t.bridge.count).toBe(1);
  });

  it('the last rw close of a window writes the restore line; a ro close does not', async () => {
    const t = setup();
    const ro = await t.open({ mode: 'ro' });
    const rw1 = await t.open({ cols: 100, rows: 30 });
    const rw2 = await t.open({ paneId: '%5' });
    const restore = 'set-option -w -u -t @2 window-size';
    ro.handle.close();
    rw1.handle.close();
    expect(t.last().written).not.toContain(restore);
    rw2.handle.close();
    expect(t.last().written.filter((l) => l === restore)).toHaveLength(1);
    expect(t.idle).toEqual(['@2']);
  });

  it('restores only windows it resized (Task 11 review)', async () => {
    const t = setup();
    const restore = 'set-option -w -u -t @2 window-size';
    // rw with no size and no resize: the window's size was never Kage's to restore.
    (await t.open()).handle.close();
    expect(t.last().written).not.toContain(restore);
    // A resize later in the terminal's life counts.
    const b = await t.open();
    b.handle.resize(90, 20);
    await vi.advanceTimersByTimeAsync(200);
    b.handle.close();
    expect(t.last().written.filter((l) => l === restore)).toHaveLength(1);
    // Restored once: a later rw open without a size doesn't restore again.
    (await t.open()).handle.close();
    expect(t.last().written.filter((l) => l === restore)).toHaveLength(1);
  });

  it('stop restores only the windows it resized', async () => {
    const t = setup();
    await t.open({ cols: 100, rows: 30 });
    await t.open({ windowId: '@7', paneId: '%8' });
    t.bridge.stop();
    expect(t.last().written).toContain('set-option -w -u -t @2 window-size');
    expect(t.last().written).not.toContain('set-option -w -u -t @7 window-size');
  });

  it('input while tmux has over 1 MiB of unread input closes the sink with 1009 (Task 11 review)', async () => {
    const t = setup();
    const { sink, handle } = await t.open();
    const other = await t.open({ mode: 'ro', windowId: '@7', paneId: '%8' });
    t.last().pending = MiB + 1;
    const before = t.last().written.length;
    handle.input('a');
    expect(sink.closes).toEqual([[1009, 'That was too much at once.']]);
    expect(t.last().written.length).toBe(before);
    expect(other.sink.closes).toEqual([]);
    expect(t.bridge.count).toBe(1);
  });

  it('input at up to 1 MiB unread still goes to tmux', async () => {
    const t = setup();
    const { sink, handle } = await t.open();
    t.last().pending = MiB;
    handle.input('a');
    expect(sink.closes).toEqual([]);
    expect(t.last().written.at(-1)).toBe('send-keys -t %3 -H 61');
  });

  it('a dead pane in a multi-pane window: display-message reports another pane → 4409 for its sinks only', async () => {
    const t = setup();
    const dead = await t.open({ paneId: '%3' });
    const live = await t.open({ paneId: '%5' }, { pane: '%5' });
    t.last().onLine({ kind: 'layout', windowId: '@2' });
    await flush();
    const runs = t.last().runs.splice(0);
    const forPane = (p: string) => runs.find((r) => r.line.includes(`-t ${p} `)) as Run;
    // tmux falls back to the active pane for a pane that is gone.
    forPane('%3').resolve([[Buffer.from(infoRow({ pane: '%5', w: 50, h: 20 }))]]);
    forPane('%5').resolve([[Buffer.from(infoRow({ pane: '%5', w: 50, h: 20 }))]]);
    await flush();
    expect(dead.sink.closes).toEqual([[4409, "The session's window has closed."]]);
    expect(dead.sink.sizes).toEqual([]);
    expect(live.sink.sizes).toEqual([[50, 20]]);
    expect(live.sink.closes).toEqual([]);
    expect(t.bridge.count).toBe(1);
  });

  it('isWindowOpen follows the open terminals', async () => {
    const t = setup();
    expect(t.bridge.isWindowOpen('@2')).toBe(false);
    const a = await t.open({ mode: 'ro' });
    expect(t.bridge.isWindowOpen('@2')).toBe(true);
    a.handle.close();
    a.handle.close();
    expect(t.bridge.isWindowOpen('@2')).toBe(false);
    expect(t.idle).toEqual(['@2']);
  });

  it('%layout-change sends each sink on that window its size from a fresh display-message', async () => {
    const t = setup();
    const a = await t.open();
    const other = await t.open({ windowId: '@7', paneId: '%8' });
    t.last().onLine({ kind: 'layout', windowId: '@2' });
    await flush();
    const run = t.last().runs.shift() as Run;
    expect(run.line).toBe(`display-message -p -t %3 '${PANE_INFO_FORMAT}'`);
    expect(run.countFor?.(0, [])).toBe(1);
    run.resolve([[Buffer.from(infoRow({ w: 120, h: 40 }))]]);
    await flush();
    expect(a.sink.sizes).toEqual([[120, 40]]);
    expect(other.sink.sizes).toEqual([]);
  });

  it('a window close (either notification, R61) closes its sinks with 4409', async () => {
    const t = setup();
    const a = await t.open();
    const b = await t.open({ windowId: '@7', paneId: '%8' });
    t.last().onLine({ kind: 'window-close', windowId: '@2' });
    expect(a.sink.closes).toEqual([[4409, "The session's window has closed."]]);
    expect(b.sink.closes).toEqual([]);
    expect(t.bridge.count).toBe(1);
    expect(t.last().written).not.toContain('set-option -w -u -t @2 window-size');
  });

  it('client exit → 1011, and the next open starts a new client', async () => {
    const t = setup();
    const a = await t.open();
    const b = await t.open({ mode: 'ro' });
    t.last().onExit();
    expect(a.sink.closes).toEqual([[1011, 'tmux stopped.']]);
    expect(b.sink.closes).toEqual([[1011, 'tmux stopped.']]);
    expect(t.bridge.count).toBe(0);
    await t.open();
    expect(t.clients).toHaveLength(2);
    expect(t.last().started).toBe(1);
  });

  it('a %exit line counts as the client stopping', async () => {
    const t = setup();
    const a = await t.open();
    t.last().onLine({ kind: 'exit' });
    expect(a.sink.closes).toEqual([[1011, 'tmux stopped.']]);
    expect(t.clients[0]?.closed).toBe(true);
  });

  it('a snapshot that fails rejects with 4409 (the caller closes the socket), and the slot frees', async () => {
    const t = setup();
    const sink = new FakeSink();
    const p = t.bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'rw',
      cols: null,
      rows: null,
      sink,
    });
    const caught = p.catch((e: unknown) => e);
    await flush();
    t.last().runs.shift()?.reject(new Error("can't find pane: %3"));
    const e = await caught;
    expect(e).toBeInstanceOf(BridgeError);
    expect((e as BridgeError).code).toBe(4409);
    expect(sink.closes).toEqual([]);
    expect(sink.resets).toEqual([]);
    expect(t.bridge.count).toBe(0);
  });

  it('a window that closes while its snapshot is in flight rejects that open with 4409', async () => {
    const t = setup();
    const sink = new FakeSink();
    const p = t.bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'ro',
      cols: null,
      rows: null,
      sink,
    });
    const caught = p.catch((e: unknown) => e);
    await flush();
    t.last().onLine({ kind: 'window-close', windowId: '@2' });
    await t.answer();
    expect(((await caught) as BridgeError).code).toBe(4409);
    expect(sink.resets).toEqual([]);
    expect(t.bridge.count).toBe(0);
  });

  it('a snapshot of another pane or window is refused (display-message falls back)', async () => {
    const t = setup();
    const sink = new FakeSink();
    const p = t.bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'rw',
      cols: null,
      rows: null,
      sink,
    });
    const caught = p.catch((e: unknown) => e);
    await t.answer({ pane: '%0', win: '@0' });
    expect(((await caught) as BridgeError).code).toBe(4409);
    expect(sink.resets).toEqual([]);
  });

  it('a sink over 1 MiB gets no output until it drains, then a new reset', async () => {
    const t = setup();
    const { sink } = await t.open();
    sink.queued = MiB + 1;
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('lost') });
    await vi.advanceTimersByTimeAsync(300);
    expect(sink.text()).toBe('');
    expect(t.last().runs).toHaveLength(0);
    sink.queued = 200 * 1024;
    await vi.advanceTimersByTimeAsync(100);
    expect(t.last().runs).toHaveLength(1);
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('during') });
    await t.answer();
    expect(sink.resets).toHaveLength(2);
    t.last().onLine({ kind: 'output', paneId: '%3', data: Buffer.from('back') });
    expect(sink.text()).toBe('back');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the 9th terminal → 4429, and the 4th on one pane → 4429', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.open({ mode: 'ro' });
    const tooMany = 'Too many terminals are open. Close one and try again.';
    await expect(
      t.bridge.open({
        windowId: '@2',
        paneId: '%3',
        mode: 'ro',
        cols: null,
        rows: null,
        sink: new FakeSink(),
      }),
    ).rejects.toEqual(new BridgeError(4429, tooMany));
    for (let i = 0; i < 5; i++)
      await t.open({ mode: 'ro', windowId: `@${10 + i}`, paneId: `%${10 + i}` });
    expect(t.bridge.count).toBe(LIMITS.terminals);
    const e = await t.bridge
      .open({
        windowId: '@20',
        paneId: '%20',
        mode: 'ro',
        cols: null,
        rows: null,
        sink: new FakeSink(),
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BridgeError);
    expect((e as BridgeError).code).toBe(4429);
    expect((e as BridgeError).message).toBe(tooMany);
  });

  it('refuses bad ids without starting a client', async () => {
    const t = setup();
    const sink = new FakeSink();
    await expect(
      t.bridge.open({
        windowId: '@2',
        paneId: '%3; kill-server',
        mode: 'rw',
        cols: null,
        rows: null,
        sink,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      t.bridge.open({ windowId: '2', paneId: '%3', mode: 'rw', cols: null, rows: null, sink }),
    ).rejects.toThrow(TypeError);
    expect(t.clients).toHaveLength(0);
  });

  it('a client that fails to start → 1011 for that open, and the next open tries again', async () => {
    const clients: FakeClient[] = [];
    const bridge = new TerminalBridge({
      client: ({ onLine, onExit }) => {
        const c = new FakeClient(onLine, onExit);
        if (clients.length === 0) c.startResult = Promise.reject(new Error('no session'));
        clients.push(c);
        return c as never;
      },
    });
    const e = await bridge
      .open({
        windowId: '@2',
        paneId: '%3',
        mode: 'rw',
        cols: null,
        rows: null,
        sink: new FakeSink(),
      })
      .catch((x: unknown) => x);
    expect((e as BridgeError).code).toBe(1011);
    expect(bridge.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const p = bridge.open({
      windowId: '@2',
      paneId: '%3',
      mode: 'ro',
      cols: null,
      rows: null,
      sink: new FakeSink(),
    });
    await flush();
    expect(clients).toHaveLength(2);
    clients[1]?.runs.shift()?.resolve([[Buffer.from(infoRow())], [Buffer.from('x')]]);
    await p;
  });

  it('stop closes every sink with 1001, restores sizes and closes the client', async () => {
    const t = setup();
    const a = await t.open({ cols: 100, rows: 30 });
    const b = await t.open({ mode: 'ro', windowId: '@7', paneId: '%8' });
    t.bridge.stop();
    expect(a.sink.closes).toEqual([[1001, 'Kage is stopping.']]);
    expect(b.sink.closes).toEqual([[1001, 'Kage is stopping.']]);
    expect(t.last().written).toContain('set-option -w -u -t @2 window-size');
    expect(t.last().written).not.toContain('set-option -w -u -t @7 window-size');
    expect(t.last().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
