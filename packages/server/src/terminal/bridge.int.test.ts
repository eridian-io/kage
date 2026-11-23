import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTmux } from '../tmux/client.ts';
import { testTmuxSocket } from '../tmux/test-sockets.ts';
import { TerminalBridge, type TermSink } from './bridge.ts';
import { ControlClient } from './control.ts';

const sock = testTmuxSocket();
const tmux = (...a: string[]): string =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' }).replace(
    /\n$/,
    '',
  );

/** Polls until `check` returns a value other than undefined (or 10 s pass). */
async function until<T>(check: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

class Sink implements TermSink {
  resets: { cols: number; rows: number; snapshot: Buffer }[] = [];
  outputs: Buffer[] = [];
  sizes: [number, number][] = [];
  closes: [number, string][] = [];
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
    return 0;
  }
  text() {
    return Buffer.concat(this.outputs).toString('utf8');
  }
}

/** Opens a window running `cmd` and gives its window and pane ids. */
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

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
});

describe.runIf(hasTmux)('TerminalBridge (real tmux, private socket)', () => {
  let bridge: TerminalBridge;
  beforeAll(() => {
    tmux('new-session', '-d', '-s', 'kage', '-x', '80', '-y', '24');
    bridge = new TerminalBridge({
      client: (o) =>
        new ControlClient({
          target: { socket: sock, configFile: '/dev/null' },
          session: 'kage',
          ...o,
        }),
    });
  });
  afterAll(() => bridge?.stop());

  it("a cat pane: rw input('héllo\\r') comes back as output", async () => {
    const w = window('cat');
    const sink = new Sink();
    const h = await bridge.open({ ...w, mode: 'rw', cols: null, rows: null, sink });
    expect(sink.resets).toHaveLength(1);
    h.input('héllo\r');
    expect(await until(() => (sink.text().includes('héllo') ? true : undefined))).toBe(true);
    h.close();
    tmux('kill-window', '-t', w.windowId);
  });

  it('the snapshot of a pane that printed 50 numbered lines holds them in order', async () => {
    const w = window('sh', '-c', 'seq -f "line %.0f" 1 50; exec cat');
    await until(() =>
      tmux('capture-pane', '-p', '-t', w.paneId).includes('line 50') ? true : undefined,
    );
    const sink = new Sink();
    const h = await bridge.open({ ...w, mode: 'ro', cols: null, rows: null, sink });
    const snap = sink.resets[0]?.snapshot.toString('utf8') ?? '';
    const numbers = [...snap.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(sink.resets[0]?.cols).toBe(80);
    expect(sink.resets[0]?.rows).toBe(24);
    h.close();
    tmux('kill-window', '-t', w.windowId);
  });

  it('resize to 100×30 sets the window width; closing restores the window option', async () => {
    const w = window('cat');
    const sink = new Sink();
    const h = await bridge.open({ ...w, mode: 'rw', cols: null, rows: null, sink });
    h.resize(100, 30);
    const width = await until(() => {
      const v = tmux('display-message', '-p', '-t', w.windowId, '#{window_width}');
      return v === '100' ? v : undefined;
    });
    expect(width).toBe('100');
    expect(tmux('show-options', '-w', '-q', '-v', '-t', w.windowId, 'window-size')).toBe('manual');
    expect(await until(() => (sink.sizes.some(([c]) => c === 100) ? true : undefined))).toBe(true);
    h.close();
    const restored = await until(() =>
      tmux('show-options', '-w', '-q', '-v', '-t', w.windowId, 'window-size') === ''
        ? true
        : undefined,
    );
    expect(restored).toBe(true);
    tmux('kill-window', '-t', w.windowId);
  });

  it('a pane printing %end 0 0 0 lines while being snapshotted does not break the snapshot', async () => {
    const w = window('sh', '-c', 'while :; do echo "%end 0 0 0"; sleep 0.005; done');
    await until(() =>
      tmux('capture-pane', '-p', '-t', w.paneId).includes('%end 0 0 0') ? true : undefined,
    );
    for (let i = 0; i < 5; i++) {
      const sink = new Sink();
      const h = await bridge.open({ ...w, mode: 'ro', cols: null, rows: null, sink });
      const snap = sink.resets[0]?.snapshot.toString('utf8') ?? '';
      expect(snap).toContain('%end 0 0 0');
      expect(sink.resets[0]?.rows).toBe(24);
      expect(await until(() => (sink.text().includes('%end 0 0 0') ? true : undefined))).toBe(true);
      h.close();
    }
    tmux('kill-window', '-t', w.windowId);
  });

  it('a killed window closes its terminal with 4409', async () => {
    const w = window('cat');
    const sink = new Sink();
    await bridge.open({ ...w, mode: 'ro', cols: null, rows: null, sink });
    tmux('kill-window', '-t', w.windowId);
    expect(await until(() => (sink.closes.length ? sink.closes[0] : undefined))).toEqual([
      4409,
      "The session's window has closed.",
    ]);
    expect(bridge.count).toBe(0);
  });

  it('a pane that has gone is refused and the client keeps working', async () => {
    const keep = window('cat');
    const sink = new Sink();
    const h = await bridge.open({ ...keep, mode: 'ro', cols: null, rows: null, sink });
    const gone = await bridge
      .open({
        windowId: keep.windowId,
        paneId: '%9999',
        mode: 'ro',
        cols: null,
        rows: null,
        sink: new Sink(),
      })
      .catch((e: unknown) => e);
    expect((gone as { code: number }).code).toBe(4409);
    const again = new Sink();
    const h2 = await bridge.open({ ...keep, mode: 'ro', cols: null, rows: null, sink: again });
    expect(again.resets).toHaveLength(1);
    h.close();
    h2.close();
    tmux('kill-window', '-t', keep.windowId);
  });

  it('stop restores a resized window and closes every terminal with 1001', async () => {
    const w = window('cat');
    const sink = new Sink();
    await bridge.open({ ...w, mode: 'rw', cols: 120, rows: 40, sink });
    expect(tmux('show-options', '-w', '-q', '-v', '-t', w.windowId, 'window-size')).toBe('manual');
    bridge.stop();
    expect(sink.closes[0]?.[0]).toBe(1001);
    const restored = await until(() =>
      tmux('show-options', '-w', '-q', '-v', '-t', w.windowId, 'window-size') === ''
        ? true
        : undefined,
    );
    expect(restored).toBe(true);
    tmux('kill-window', '-t', w.windowId);
  });
});
