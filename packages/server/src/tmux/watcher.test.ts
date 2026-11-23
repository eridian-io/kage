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

function setup(
  throttleMs?: number,
  extra: { beforeLaunch?: () => Promise<void>; serverPid?: () => Promise<string | null> } = {},
) {
  const procs: FakeProc[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const p = new FakeProc();
    procs.push(p);
    return p;
  }) as never;
  // The server is gone unless a test says otherwise: never ask a real tmux from a unit test.
  const w = new TmuxWatcher({
    session: 'kage',
    socket: null,
    spawn,
    throttleMs,
    serverPid: async () => null,
    ...extra,
  });
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
    expect(calls[0]).toEqual({ cmd: 'tmux', args: ['-u', '-C', 'attach', '-t', '=kage'] });
    w.stop();
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return new FakeProc();
    }) as never;
    const w2 = new TmuxWatcher({ session: 's', socket: 'sock', spawn });
    w2.start();
    expect(calls[1]?.args).toEqual(['-u', '-L', 'sock', '-C', 'attach', '-t', '=s']);
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

  it('resets the backoff after a client stayed attached for 1 s', async () => {
    const { w, procs } = setup();
    w.start();
    procs[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    procs[1]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(procs).toHaveLength(3);
    procs[2]?.say('%window-add @1\n');
    await vi.advanceTimersByTimeAsync(1000);
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
      serverPid: async () => null,
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
    expect(calls[0]).toEqual(['-u', '-f', '/dev/null', '-L', 'k', '-C', 'attach', '-t', '=s']);
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

  describe('a client that exits (reliability I1)', () => {
    it('a client that exits while the same server lives re-attaches at once and emits no down', async () => {
      let asked = 0;
      const { w, procs, events } = setup(undefined, {
        serverPid: async () => {
          asked++;
          return '4242';
        },
      });
      w.start();
      procs[0]?.say('%begin 1 2 0\n');
      await flush();
      expect(events).toEqual([{ type: 'up' }]);
      // The first line also notes the server's pid.
      expect(asked).toBe(1);
      // `tmux attach -d` at the PC: tmux detaches Kage's client (%exit) and the server lives.
      procs[0]?.say('%exit\n');
      procs[0]?.emit('exit', 0);
      await flush();
      expect(asked).toBe(2);
      expect(procs).toHaveLength(2);
      expect(events).toEqual([{ type: 'up' }]);
      // The new client's first line is the resync.
      procs[1]?.say('%begin 3 4 0\n');
      await flush();
      expect(events).toEqual([{ type: 'up' }, { type: 'up' }]);
      expect(events.some((e) => e.type === 'down')).toBe(false);
      w.stop();
    });

    it('a client that exits with the server gone emits down and backs off', async () => {
      const { w, procs, events } = setup(undefined, { serverPid: async () => null });
      w.start();
      procs[0]?.say('%begin 1 2 0\n');
      await flush();
      procs[0]?.emit('exit', 1);
      await flush();
      expect(events).toEqual([{ type: 'up' }, { type: 'down' }]);
      expect(procs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(procs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(procs).toHaveLength(2);
      procs[1]?.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(procs).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(procs).toHaveLength(3);
      expect(events.filter((e) => e.type === 'down')).toHaveLength(2);
      w.stop();
    });

    it('a has-session that fails or throws counts as the server gone', async () => {
      const { w, procs, events } = setup(undefined, {
        serverPid: async () => {
          throw new Error('spawn tmux ENOENT');
        },
      });
      w.start();
      procs[0]?.emit('exit', 1);
      await flush();
      expect(events).toEqual([{ type: 'down' }]);
      expect(procs).toHaveLength(1);
      w.stop();
    });

    it('a pid not known at the first line is asked again at a later line (at most once a second)', async () => {
      // The first ask found nothing (tmux busy): without a pid, a new server would pass for the same.
      let pid: string | null = null;
      let asked = 0;
      const { w, procs, events } = setup(undefined, {
        serverPid: async () => {
          asked++;
          return pid;
        },
      });
      w.start();
      procs[0]?.say('%begin 1 2 0\n');
      await flush();
      expect(asked).toBe(1);
      pid = '4242';
      procs[0]?.say('%window-add @1\n%window-add @2\n');
      await flush();
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      procs[0]?.say('%window-add @3\n');
      await flush();
      expect(asked).toBe(2);
      // Noted now: later lines ask nothing.
      await vi.advanceTimersByTimeAsync(5000);
      procs[0]?.say('%window-add @4\n');
      await flush();
      expect(asked).toBe(2);
      // kill-server and a new server at once: another pid, so a down.
      pid = '5151';
      procs[0]?.emit('exit', 1);
      await flush();
      expect(events.filter((e) => e.type === 'down')).toHaveLength(1);
      w.stop();
    });

    it('a new server under the same name (another pid) counts as down', async () => {
      let pid = '4242';
      const { w, procs, events } = setup(undefined, { serverPid: async () => pid });
      w.start();
      procs[0]?.say('%begin 1 2 0\n');
      await flush();
      // kill-server, and something starts a new server with the session at once.
      pid = '5151';
      procs[0]?.emit('exit', 1);
      await flush();
      expect(events).toEqual([{ type: 'up' }, { type: 'down' }]);
      expect(procs).toHaveLength(1);
      // The backoff's client attaches to the new server and notes its pid.
      await vi.advanceTimersByTimeAsync(1000);
      procs[1]?.say('%begin 1 2 0\n');
      await flush();
      procs[1]?.emit('exit', 0);
      await flush();
      // Same server now: a plain re-attach.
      expect(procs).toHaveLength(3);
      expect(events.filter((e) => e.type === 'down')).toHaveLength(1);
      w.stop();
    });

    it('three re-attaches in 10 s without a line emit down', async () => {
      const { w, procs, events } = setup(undefined, { serverPid: async () => '4242' });
      w.start();
      procs[0]?.say('%begin 1 2 0\n');
      await flush();
      // tmux keeps refusing the client: each one exits before it prints a line.
      for (let i = 0; i < 3; i++) {
        procs[i]?.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(500);
        expect(procs).toHaveLength(i + 2);
      }
      expect(events.filter((e) => e.type === 'down')).toHaveLength(0);
      procs[3]?.emit('exit', 1);
      await flush();
      expect(events.filter((e) => e.type === 'down')).toHaveLength(1);
      expect(procs).toHaveLength(4);
      // …and backs off as today.
      await vi.advanceTimersByTimeAsync(999);
      expect(procs).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(procs).toHaveLength(5);
      w.stop();
    });

    it('clients refused after a few lines (%begin, %exit) count toward the cap too', async () => {
      const { w, procs, events } = setup(undefined, { serverPid: async () => '4242' });
      w.start();
      for (let i = 0; i < 4; i++) {
        procs[i]?.say('%begin 1 2 0\n%end 1 2 0\n%exit\n');
        await flush();
        procs[i]?.emit('exit', 0);
        await flush();
      }
      expect(events.filter((e) => e.type === 'down')).toHaveLength(1);
      expect(procs).toHaveLength(4);
      w.stop();
    });

    it('a client attached for 1 s starts the count over, and so do 10 s', async () => {
      const { w, procs, events } = setup(undefined, { serverPid: async () => '4242' });
      w.start();
      for (let i = 0; i < 6; i++) {
        procs[i]?.say('%begin 1 2 0\n');
        await vi.advanceTimersByTimeAsync(1000);
        procs[i]?.emit('exit', 0);
        await flush();
      }
      expect(procs).toHaveLength(7);
      // Without lines, but spread over more than 10 s.
      for (let i = 6; i < 12; i++) {
        procs[i]?.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(6000);
      }
      expect(procs).toHaveLength(13);
      expect(events.some((e) => e.type === 'down')).toBe(false);
      w.stop();
    });

    it('stop() and start() start the re-attach count over', async () => {
      const { w, procs, events } = setup(undefined, { serverPid: async () => '4242' });
      w.start();
      for (let i = 0; i < 3; i++) {
        procs[i]?.emit('exit', 1);
        await flush();
      }
      expect(procs).toHaveLength(4);
      w.stop();
      w.start();
      procs[4]?.emit('exit', 1);
      await flush();
      expect(procs).toHaveLength(6);
      expect(events.some((e) => e.type === 'down')).toBe(false);
      w.stop();
    });

    it('stop() while has-session is asked spawns nothing and emits nothing', async () => {
      let answer: (v: string | null) => void = () => {};
      const { w, procs, events } = setup(undefined, {
        serverPid: () => new Promise<string | null>((r) => (answer = r)),
      });
      w.start();
      procs[0]?.emit('exit', 1);
      await flush();
      w.stop();
      answer(null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(procs).toHaveLength(1);
      expect(events).toEqual([]);
    });
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
