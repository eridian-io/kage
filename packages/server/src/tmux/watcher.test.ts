import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TmuxWatcher, type WatchEvent } from './watcher.ts';

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
  say(text: string) {
    this.stdout.write(text);
  }
}

function setup(throttleMs?: number, extra: { beforeLaunch?: () => Promise<void> } = {}) {
  const procs: FakeProc[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const p = new FakeProc();
    procs.push(p);
    return p;
  }) as never;
  const w = new TmuxWatcher({ session: 'kage', socket: null, spawn, throttleMs, ...extra });
  const events: WatchEvent[] = [];
  w.on((e) => events.push(e));
  return { w, procs, calls, events };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TmuxWatcher', () => {
  it('attaches in control mode, with -L when a socket is set', () => {
    const { w, calls } = setup();
    w.start();
    expect(calls[0]).toEqual({ cmd: 'tmux', args: ['-C', 'attach', '-t', '=kage'] });
    w.stop();
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return new FakeProc();
    }) as never;
    const w2 = new TmuxWatcher({ session: 's', socket: 'sock', spawn });
    w2.start();
    expect(calls[1]?.args).toEqual(['-L', 'sock', '-C', 'attach', '-t', '=s']);
    w2.stop();
  });

  it.each(['%window-add @3', '%window-close @3', '%unlinked-window-close @3'])(
    '%s emits windows-changed',
    async (line) => {
      const { w, procs, events } = setup();
      w.start();
      procs[0]?.say(`${line}\n`);
      await flush();
      expect(events).toEqual([{ type: 'up' }, { type: 'windows-changed' }]);
      w.stop();
    },
  );

  it('throttles %output to one activity per pane per 250 ms', async () => {
    const { w, procs, events } = setup();
    w.start();
    for (let i = 0; i < 50; i++) procs[0]?.say(`%output %1 hello${i}\n`);
    procs[0]?.say('%output %2 x\n');
    await flush();
    expect(events.filter((e) => e.type === 'activity')).toEqual([
      { type: 'activity', paneId: '%1' },
      { type: 'activity', paneId: '%2' },
    ]);
    await vi.advanceTimersByTimeAsync(260);
    procs[0]?.say('%output %1 again\n');
    await flush();
    expect(events.filter((e) => e.type === 'activity' && e.paneId === '%1')).toHaveLength(2);
    w.stop();
  });

  it('throttles on a monotonic clock: the wall clock stepping back does not mute a pane', async () => {
    const { w, procs, events } = setup();
    w.start();
    procs[0]?.say('%output %1 a\n');
    await flush();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(260);
    procs[0]?.say('%output %1 b\n');
    await flush();
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(2);
    w.stop();
  });

  it('handles lines split across chunks and ignores unknown lines', async () => {
    const { w, procs, events } = setup();
    w.start();
    procs[0]?.say('%window-a');
    procs[0]?.say('dd @1\n%begin 1 2 0\n%end 1 2 0\n');
    await flush();
    expect(events).toEqual([{ type: 'up' }, { type: 'windows-changed' }]);
    w.stop();
  });

  it('emits down on exit and restarts after 1 s, 2 s, ... capped at 30 s', async () => {
    const { w, procs, events } = setup();
    w.start();
    let expected = 1000;
    for (let i = 0; i < 7; i++) {
      procs[i]?.emit('exit', 1);
      await flush();
      expect(procs).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(procs).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(procs).toHaveLength(i + 2);
      expected = Math.min(expected * 2, 30000);
    }
    expect(events.filter((e) => e.type === 'down')).toHaveLength(7);
    w.stop();
  });

  it('resets the backoff after a successful start', async () => {
    const { w, procs } = setup();
    w.start();
    procs[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    procs[1]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(procs).toHaveLength(3);
    procs[2]?.say('%window-add @1\n');
    await flush();
    procs[2]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(procs).toHaveLength(4);
    w.stop();
  });

  it('stop() kills the child and cancels the restart timer', async () => {
    const { w, procs } = setup();
    w.start();
    w.stop();
    expect(procs[0]?.killed).toBe(true);
    const b = setup();
    b.w.start();
    b.procs[0]?.emit('exit', 1);
    b.w.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(b.procs).toHaveLength(1);
  });

  it('emits up on the first line of each launch', async () => {
    const { w, procs, events } = setup();
    w.start();
    await flush();
    expect(events).toEqual([]);
    procs[0]?.say('%begin 1 2 0\n%end 1 2 0\n%output %1 x\n');
    await flush();
    expect(events.filter((e) => e.type === 'up')).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'up' });
    procs[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    procs[1]?.say('%begin 1 2 0\n');
    await flush();
    expect(events.filter((e) => e.type === 'up')).toHaveLength(2);
    w.stop();
  });

  it('awaits beforeLaunch before every spawn', async () => {
    const order: string[] = [];
    const procs: FakeProc[] = [];
    const spawn = (() => {
      order.push('spawn');
      const p = new FakeProc();
      procs.push(p);
      return p;
    }) as never;
    const w = new TmuxWatcher({
      session: 'kage',
      socket: null,
      spawn,
      beforeLaunch: async () => {
        order.push('before');
      },
    });
    w.start();
    expect(order).toEqual(['before']);
    await flush();
    expect(order).toEqual(['before', 'spawn']);
    procs[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['before', 'spawn', 'before', 'spawn']);
    w.stop();
  });

  it('counts a rejecting beforeLaunch as a failed launch with backoff', async () => {
    let calls = 0;
    const { w, procs, events } = setup(undefined, {
      beforeLaunch: async () => {
        calls++;
        if (calls < 3) throw new Error('tmux down');
      },
    });
    w.start();
    await flush();
    expect(calls).toBe(1);
    expect(procs).toHaveLength(0);
    expect(events).toEqual([{ type: 'down' }]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    expect(procs).toHaveLength(1);
    w.stop();
  });

  it('adds -f and -L to the attach command', () => {
    const calls: string[][] = [];
    const spawn = ((_c: string, a: string[]) => {
      calls.push(a);
      return new FakeProc();
    }) as never;
    const w = new TmuxWatcher({ session: 's', socket: 'k', configFile: '/dev/null', spawn });
    w.start();
    expect(calls[0]).toEqual(['-f', '/dev/null', '-L', 'k', '-C', 'attach', '-t', '=s']);
    w.stop();
  });

  it('drops %output lines whose pane id is not %<digits>', async () => {
    const { w, procs, events } = setup();
    w.start();
    procs[0]?.say('%output %abc x\n%output %1x y\n%output 7 z\n%output %\n%output  %2 lead\n');
    procs[0]?.say('%output %3 ok\n');
    await flush();
    expect(events.filter((e) => e.type === 'activity')).toEqual([
      { type: 'activity', paneId: '%3' },
    ]);
    w.stop();
  });

  it('emits nothing after stop(), even for lines the old client still prints', async () => {
    const { w, procs, events } = setup();
    w.start();
    procs[0]?.say('%begin 1 2 0\n');
    await flush();
    const before = events.length;
    w.stop();
    procs[0]?.say('%window-add @1\n%output %1 x\n');
    procs[0]?.emit('exit', 0);
    await flush();
    expect(events).toHaveLength(before);
  });

  it('reads the control client as UTF-8, so a character split across chunks stays whole', async () => {
    const { w, procs, events } = setup();
    w.start();
    expect(procs[0]?.stdout.readableEncoding).toBe('utf8');
    const bytes = Buffer.from('%output %1 café\n%window-add @2\n');
    const cut = bytes.indexOf(0xc3) + 1;
    procs[0]?.stdout.write(bytes.subarray(0, cut));
    procs[0]?.stdout.write(bytes.subarray(cut));
    await flush();
    expect(events).toEqual([
      { type: 'up' },
      { type: 'activity', paneId: '%1' },
      { type: 'windows-changed' },
    ]);
    w.stop();
  });
});
