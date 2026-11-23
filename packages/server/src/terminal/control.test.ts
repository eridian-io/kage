import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ControlClient,
  type ControlLine,
  PANE_INFO_FORMAT,
  parseControlLine,
  SAFE_LINE,
  sendKeysLines,
  unescapeOutput,
} from './control.ts';

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/terminal', name));

/** Splits raw bytes on \n, as the client does (the last, empty piece dropped). */
function lines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, from)) {
    out.push(buf.subarray(from, nl));
    from = nl + 1;
  }
  return out;
}

describe('unescapeOutput', () => {
  it('turns \\ooo into one byte and leaves other bytes as they are', () => {
    expect(unescapeOutput(Buffer.from('\\033[1m\\134x'))).toEqual(Buffer.from('\x1b[1m\\x'));
    expect(unescapeOutput(Buffer.from('a\\015\\012b'))).toEqual(Buffer.from('a\r\nb'));
  });
  it('keeps raw bytes 0x7f and above, and a backslash not followed by three octal digits', () => {
    const raw = Buffer.from([0x7f, 0xc3, 0xa9, 0x5c, 0x39, 0x5c, 0x30, 0x31]);
    expect(unescapeOutput(raw)).toEqual(raw);
    expect(unescapeOutput(Buffer.from('end\\'))).toEqual(Buffer.from('end\\'));
  });
});

describe('parseControlLine on burst.txt', () => {
  const parsed: ControlLine[] = lines(fixture('burst.txt')).map(parseControlLine);

  it('parses every line', () => {
    expect(parsed).toEqual([
      { kind: 'begin', time: '1700000000', num: '280', flags: '0' },
      { kind: 'end', time: '1700000000', num: '280', flags: '0' },
      { kind: 'other' },
      { kind: 'output', paneId: '%3', data: Buffer.from('\x1b[?2004h\x1b[?1004h\x1b[?25l') },
      { kind: 'output', paneId: '%3', data: Buffer.from('plain text\r\n') },
      { kind: 'output', paneId: '%3', data: Buffer.from('back\\slash, tab\tand café\r\n') },
      // A UTF-8 character split across two lines stays as raw bytes in each.
      {
        kind: 'output',
        paneId: '%3',
        data: Buffer.concat([Buffer.from('a split euro: '), Buffer.from([0xe2, 0x82])]),
      },
      {
        kind: 'output',
        paneId: '%3',
        data: Buffer.concat([Buffer.from([0xac]), Buffer.from(' joined\r\n')]),
      },
      { kind: 'output', paneId: '%4', data: Buffer.from('another pane\r\n') },
      { kind: 'begin', time: '1700000001', num: '281', flags: '1' },
      { kind: 'end', time: '1700000001', num: '281', flags: '1' },
      { kind: 'layout', windowId: '@2' },
      { kind: 'layout', windowId: '@6' },
      { kind: 'other' },
      { kind: 'begin', time: '1700000002', num: '282', flags: '1' },
      { kind: 'other' },
      { kind: 'error', time: '1700000002', num: '282', flags: '1' },
      { kind: 'other' },
      { kind: 'window-close', windowId: '@6' },
      { kind: 'window-close', windowId: '@5' },
      { kind: 'other' },
      { kind: 'exit' },
    ]);
  });

  it('the split euro sign is whole once the two lines are joined', () => {
    const a = parsed[6] as { data: Buffer };
    const b = parsed[7] as { data: Buffer };
    expect(Buffer.concat([a.data, b.data]).toString('utf8')).toBe('a split euro: € joined\r\n');
  });

  it('reads %extended-output and refuses bad ids', () => {
    expect(parseControlLine(Buffer.from('%extended-output %7 12 : hi\\012'))).toEqual({
      kind: 'output',
      paneId: '%7',
      data: Buffer.from('hi\n'),
    });
    expect(parseControlLine(Buffer.from('%output 3 x'))).toEqual({ kind: 'other' });
    expect(parseControlLine(Buffer.from('%layout-change x y'))).toEqual({ kind: 'other' });
    expect(parseControlLine(Buffer.from('%window-close @x'))).toEqual({ kind: 'other' });
    expect(parseControlLine(Buffer.from('%output %3 '))).toEqual({
      kind: 'output',
      paneId: '%3',
      data: Buffer.alloc(0),
    });
    expect(parseControlLine(Buffer.from('%exit server exited'))).toEqual({ kind: 'exit' });
  });
});

describe('sendKeysLines', () => {
  it('spells the bytes in hex on one line', () => {
    const bytes = Buffer.concat([Buffer.from('é'), Buffer.from('\x1b[A'), Buffer.from([3])]);
    expect(sendKeysLines('%3', bytes)).toEqual(['send-keys -t %3 -H c3 a9 1b 5b 41 03']);
  });
  it('splits 600 bytes into 3 lines of at most 256 bytes', () => {
    const out = sendKeysLines('%3', Buffer.alloc(600, 0x61));
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.split(' ').length - 4)).toEqual([256, 256, 88]);
  });
  it('gives no line for no bytes', () => {
    expect(sendKeysLines('%3', new Uint8Array())).toEqual([]);
  });
  it('throws on a bad pane id or line size', () => {
    expect(() => sendKeysLines('%3; kill-server', Buffer.from('a'))).toThrow(TypeError);
    expect(() => sendKeysLines('3', Buffer.from('a'))).toThrow(TypeError);
    expect(() => sendKeysLines('%3', Buffer.from('a'), 0)).toThrow(RangeError);
    expect(() => sendKeysLines('%3', Buffer.from('a'), 8000)).toThrow(RangeError);
  });
});

describe('SAFE_LINE', () => {
  const display = `display-message -p -t %3 '${PANE_INFO_FORMAT}'`;
  const capture = 'capture-pane -p -e -N -S -1000 -t %3';
  it.each([
    'send-keys -t %3 -H c3 a9 1b 5b 41 03',
    'resize-window -t @2 -x 120 -y 40',
    'set-option -w -u -t @2 window-size',
    display,
    capture,
    `${display} ; ${capture}`,
  ])('accepts %s', (line) => {
    expect(SAFE_LINE.test(line)).toBe(true);
  });
  it('accepts every send-keys line sendKeysLines builds', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    for (const l of sendKeysLines('%12', all, 100)) expect(SAFE_LINE.test(l)).toBe(true);
  });
  it.each([
    'send-keys -t %3 -l -- x',
    "run-shell 'x'",
    'send-keys -t %3 -H 61; kill-server',
    'send-keys -t %3 -H 61 ;kill-server',
    `display-message -p -t %3 '#{pane_width}'`,
    "display-message -p -t %3 '#(touch /tmp/x)'",
    'send-keys -t %3 -H 61\nkill-server',
    'send-keys -t %3 -H 61\n',
    'resize-window -t @2 -x 120 -y 40 ; ',
    ' ; resize-window -t @2 -x 120 -y 40',
    'kill-server',
  ])('refuses %j', (line) => {
    expect(SAFE_LINE.test(line)).toBe(false);
  });
});

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      for (const l of d.toString('utf8').split('\n')) if (l !== '') this.written.push(l);
    });
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit'));
    return true;
  }
  say(bytes: Buffer | string) {
    this.stdout.write(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

async function started(o: { onLine?: (l: ControlLine) => void; onExit?: () => void } = {}) {
  const procs: FakeProc[] = [];
  const calls: string[][] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const p = new FakeProc();
    procs.push(p);
    return p;
  }) as never;
  const c = new ControlClient({
    target: { socket: 'sock', configFile: '/dev/null' },
    session: 'kage',
    spawn,
    onLine: o.onLine ?? (() => {}),
    onExit: o.onExit ?? (() => {}),
  });
  const up = c.start();
  const p = procs[0] as FakeProc;
  p.say('%begin 1700000000 1 0\n%end 1700000000 1 0\n%session-changed $1 kage\n');
  await up;
  return { c, p, calls };
}

describe('ControlClient', () => {
  it('attaches in control mode and resolves after the attach block', async () => {
    const { c, calls } = await started();
    expect(calls[0]).toEqual([
      'tmux',
      '-u',
      '-f',
      '/dev/null',
      '-L',
      'sock',
      '-C',
      'attach',
      '-t',
      '=kage',
    ]);
    c.close();
  });

  it('start rejects when tmux exits first', async () => {
    const spawn = (() => {
      const p = new FakeProc();
      queueMicrotask(() => p.emit('exit'));
      return p;
    }) as never;
    const c = new ControlClient({
      target: { socket: null },
      session: 'kage',
      spawn,
      onLine: () => {},
      onExit: () => {},
    });
    await expect(c.start()).rejects.toThrow();
  });

  it('reads output as bytes across chunks and hands notifications to onLine', async () => {
    const got: ControlLine[] = [];
    const { c, p } = await started({ onLine: (l) => got.push(l) });
    const line = Buffer.concat([
      Buffer.from('%output %3 caf'),
      Buffer.from([0xc3, 0xa9]),
      Buffer.from('\n'),
    ]);
    p.say(line.subarray(0, 15));
    p.say(line.subarray(15));
    await tick();
    expect(got.at(-1)).toEqual({ kind: 'output', paneId: '%3', data: Buffer.from('café') });
    c.close();
  });

  it('run with capture.txt: count framing returns forged %end rows as data', async () => {
    const got: ControlLine[] = [];
    const { c, p } = await started({ onLine: (l) => got.push(l) });
    const display = `display-message -p -t %3 '${PANE_INFO_FORMAT}'`;
    const capture = 'capture-pane -p -e -N -S -1000 -t %3';
    const result = c.run([display, capture], (i, earlier) => {
      if (i === 0) return 1;
      const f = (earlier[0]?.[0] ?? Buffer.alloc(0)).toString().split(' ');
      return Math.min(Number(f[2]), 1000) + Number(f[1]);
    });
    expect(p.written).toEqual([`${display} ; ${capture}`]);
    p.say(fixture('capture.txt'));
    const [info, rows] = await result;
    expect(info?.map(String)).toEqual(['40 6 0 2 4 1 0 0 0 0 0 0 0 sh']);
    expect(rows).toHaveLength(6);
    expect(rows?.[0]).toEqual(
      Buffer.from('\x1b[1m\x1b[32mgreen\x1b[0m café back\\slash                   '),
    );
    expect(rows?.[1]?.toString()).toBe('%end 1700000003 291 1');
    expect(rows?.[2]?.toString()).toBe('%end 1700000000 7 1 ');
    expect(rows?.[3]?.toString()).toBe('%output %9 x        ');
    // Output outside the blocks still reaches onLine; the forged %output row doesn't.
    await tick();
    const outputs = got.filter((l) => l.kind === 'output') as { paneId: string; data: Buffer }[];
    expect(outputs.map((o) => [o.paneId, o.data.toString()])).toEqual([
      ['%3', 'before the snapshot\r\n'],
      ['%3', 'after the snapshot\r\n'],
    ]);
    c.close();
  });

  it('a %end before the count is a row; after the count the matching %end ends the block', async () => {
    const { c, p } = await started();
    const res = c.run(['capture-pane -p -e -N -S -1000 -t %3'], () => 3);
    p.say('%begin 1700000005 9 1\n%end 1700000005 9 1\n%end 1700000005 8 1\nlast\n');
    p.say('%end 1700000005 9 1\n');
    const [rows] = await res;
    expect(rows?.map(String)).toEqual(['%end 1700000005 9 1', '%end 1700000005 8 1', 'last']);
    c.close();
  });

  it('after the count, any line but the matching %end/%error kills the client (Task 11 review)', async () => {
    for (const extra of ['one row too many', '%end 1700000005 10 1', '%output %3 x']) {
      let exits = 0;
      const got: ControlLine[] = [];
      const { c, p } = await started({ onExit: () => exits++, onLine: (l) => got.push(l) });
      const res = c.run(['capture-pane -p -e -N -S -1000 -t %3'], () => 1);
      p.say(`%begin 1700000005 9 1\nrow\n${extra}\n%end 1700000005 9 1\n%output %3 later\n`);
      await expect(res).rejects.toThrow();
      await tick();
      expect(p.killed).toBe(true);
      expect(exits).toBe(1);
      expect(got.filter((l) => l.kind === 'output')).toEqual([]);
      expect(() => c.write('send-keys -t %3 -H 61')).not.toThrow();
      await expect(c.run(['set-option -w -u -t @2 window-size'])).rejects.toThrow();
    }
  });

  it('a %error after the count still rejects the run normally', async () => {
    const { c, p } = await started();
    const res = c.run(['capture-pane -p -e -N -S -1000 -t %3'], () => 1);
    p.say('%begin 1 9 1\nrow\n%error 1 9 1\n');
    await expect(res).rejects.toThrow('row');
    expect(p.killed).toBe(false);
    c.close();
  });

  it('pendingInput is the bytes written to tmux and not yet taken', async () => {
    const { c, p } = await started();
    expect(c.pendingInput()).toBe(0);
    p.stdin.pause();
    p.stdin.removeAllListeners('data');
    for (let i = 0; i < 2000; i++) c.write(`send-keys -t %3 -H ${'61 '.repeat(255)}61`);
    expect(c.pendingInput()).toBeGreaterThan(1024 * 1024);
    c.close();
    expect(c.pendingInput()).toBe(0);
  });

  it('without a count, a block ends at its matching %end', async () => {
    const { c, p } = await started();
    const res = c.run(['set-option -w -u -t @2 window-size', 'resize-window -t @2 -x 80 -y 24']);
    p.say('%begin 1 20 1\n%end 1 20 1\n%begin 1 21 1\nx\n%end 1 21 1\n');
    expect((await res).map((b) => b.map(String))).toEqual([[], ['x']]);
    c.close();
  });

  it('a %error rejects the run and the rest of its commands are skipped (tmux drops them)', async () => {
    const { c, p } = await started();
    const bad = c.run([
      'capture-pane -p -e -N -S -1000 -t %9',
      'set-option -w -u -t @2 window-size',
    ]);
    const good = c.run(['set-option -w -u -t @2 window-size']);
    p.say("%begin 1 30 1\ncan't find pane: %9\n%error 1 30 1\n%begin 1 31 1\n%end 1 31 1\n");
    await expect(bad).rejects.toThrow("can't find pane: %9");
    await expect(good).resolves.toEqual([[]]);
    c.close();
  });

  it('write reports a key line error to its callback; refuses unsafe lines', async () => {
    const { c, p } = await started();
    const errors: string[] = [];
    c.write('send-keys -t %3 -H 61', (rows) => errors.push(rows.map(String).join('\n')));
    expect(p.written).toContain('send-keys -t %3 -H 61');
    p.say('%begin 1 40 1\nno such pane\n%error 1 40 1\n');
    await tick();
    expect(errors).toEqual(['no such pane']);
    expect(() => c.write('send-keys -t %3 -l -- x')).toThrow(TypeError);
    await expect(c.run(["run-shell 'x'"])).rejects.toThrow(TypeError);
    c.close();
  });

  it('a block from someone else (flags 0) is not taken as the answer to a command', async () => {
    const { c, p } = await started();
    const res = c.run(['set-option -w -u -t @2 window-size']);
    p.say('%begin 1 50 0\nhook\n%end 1 50 0\n%begin 1 51 1\n%end 1 51 1\n');
    expect(await res).toEqual([[]]);
    c.close();
  });

  it('exit rejects pending runs and calls onExit once; close does not call onExit', async () => {
    let exits = 0;
    const { c, p } = await started({ onExit: () => exits++ });
    const res = c.run(['set-option -w -u -t @2 window-size']);
    p.emit('exit');
    p.emit('exit');
    await expect(res).rejects.toThrow();
    expect(exits).toBe(1);

    let exits2 = 0;
    const s = await started({ onExit: () => exits2++ });
    s.c.close();
    await tick();
    expect(exits2).toBe(0);
    expect(() => s.c.write('send-keys -t %3 -H 61')).not.toThrow();
  });
});
