import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  type FSWatcher,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DisplayLine } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_FLAGS, TranscriptTail, type TranscriptTailOptions } from './tail.ts';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/transcripts');
const fixture = (file: string) => readFileSync(join(FIXTURES, file), 'utf8');

const say = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
const prompt = (text: string) =>
  `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;

let dir: string;
let tails: TranscriptTail[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-tail-'));
  tails = [];
});
afterEach(() => {
  for (const t of tails) t.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function tail(path: string, opts?: TranscriptTailOptions) {
  const t = new TranscriptTail(path, opts);
  tails.push(t);
  return t;
}

/** Resolves with the next non-empty emission, or rejects after `ms`. */
function next(t: TranscriptTail, ms = 4000): Promise<DisplayLine[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('no emission'));
    }, ms);
    const off = t.on((added) => {
      if (added.length === 0) return;
      clearTimeout(timer);
      off();
      resolve(added);
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turn = () => new Promise((r) => setImmediate(r));
const think = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } })}\n`;

/** Fakes only the intervals, so fs and setTimeout stay real and vi.getTimerCount() counts them. */
const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

/** A real fs.watch that records the watchers it opens and which of them are still open. */
function watchSpy() {
  const open = new Set<FSWatcher>();
  const fn = ((target: string, options: unknown, listener: unknown) => {
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the overloaded signature as is
    const w = (watch as any)(target, options, listener) as FSWatcher;
    open.add(w);
    const close = w.close.bind(w);
    w.close = () => {
      open.delete(w);
      close();
    };
    return w;
  }) as typeof watch;
  return { fn, open };
}

describe('TranscriptTail', () => {
  it('reads an existing file at start, then emits only the newly appended lines', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, fixture('edit-and-test.jsonl'));
    const t = tail(path);
    await t.start();
    expect(t.lines()).toHaveLength(11);
    expect(t.now()).toBeNull(); // the fixture ends with turn_duration

    const got = next(t);
    appendFileSync(path, say('one more'));
    expect(await got).toEqual([{ kind: 'say', text: 'one more' }]);
    expect(t.lines()).toHaveLength(12);
  });

  it('holds a partial last line until the rest is appended (noise.jsonl)', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, fixture('noise.jsonl'));
    const t = tail(path);
    await t.start();
    expect(t.lines()).toHaveLength(4);

    const got = next(t);
    appendFileSync(
      path,
      '0000000000000000000000022","type":"message","role":"assistant","content":[{"type":"text","text":"Done."}]},"type":"assistant","cwd":"/home/dev/projects/demo"}\n',
    );
    expect(await got).toEqual([{ kind: 'say', text: 'Done.' }]);
  });

  it('keeps only the newest maxLines lines', async () => {
    const path = join(dir, 's.jsonl');
    let body = '';
    for (let i = 0; i < 250; i++) body += say(`line ${i}`);
    writeFileSync(path, body);
    const t = tail(path);
    await t.start();
    expect(t.lines()).toHaveLength(200);
    expect(t.lines()[0]).toEqual({ kind: 'say', text: 'line 50' });
    expect(t.lines()[199]).toEqual({ kind: 'say', text: 'line 249' });

    const small = tail(path, { maxLines: 5 });
    await small.start();
    expect(small.lines().map((l) => l.text)).toEqual([
      'line 245',
      'line 246',
      'line 247',
      'line 248',
      'line 249',
    ]);
  });

  it('reads only the last fromEnd bytes at start, dropping the cut first line', async () => {
    const path = join(dir, 's.jsonl');
    let body = '';
    for (let i = 0; i < 100; i++) body += say(`line ${String(i).padStart(3, '0')}`);
    writeFileSync(path, body);
    const lineBytes = say('line 000').length;
    const t = tail(path, { fromEnd: lineBytes * 3 + 5 });
    await t.start();
    expect(t.lines().map((l) => l.text)).toEqual(['line 097', 'line 098', 'line 099']);

    const exact = tail(path, { fromEnd: lineBytes * 3 });
    await exact.start();
    expect(exact.lines().map((l) => l.text)).toEqual(['line 097', 'line 098', 'line 099']);
  });

  it('picks up a file that does not exist yet when it is created (R10)', async () => {
    const path = join(dir, 'later.jsonl');
    const t = tail(path);
    await t.start();
    expect(t.lines()).toEqual([]);
    const got = next(t);
    writeFileSync(path, say('hello'));
    expect(await got).toEqual([{ kind: 'say', text: 'hello' }]);
  });

  it('opens read-only, non-blocking and without taking a controlling terminal (M1)', async () => {
    const { constants } = await import('node:fs');
    expect(OPEN_FLAGS).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0),
    );
    if (process.platform !== 'win32') {
      expect(OPEN_FLAGS & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(OPEN_FLAGS & constants.O_NOCTTY).toBe(constants.O_NOCTTY);
    }
  });

  it('a path not ending in .jsonl is treated as missing', async () => {
    const path = join(dir, 's.json');
    writeFileSync(path, say('not a transcript'));
    const t = tail(path);
    await t.start();
    expect(t.lines()).toEqual([]);
    appendFileSync(path, say('still not'));
    await wait(1200);
    expect(t.lines()).toEqual([]);
  });

  // security M1: a FIFO opened without O_NONBLOCK would park a libuv pool thread until a writer came.
  it.runIf(process.platform !== 'win32')(
    'a FIFO named like a transcript is treated as missing and blocks nothing',
    async () => {
      const path = join(dir, 'fifo.jsonl');
      await new Promise<void>((resolve, reject) =>
        execFile('mkfifo', [path], (err) => (err ? reject(err) : resolve())),
      );
      const t = tail(path);
      await t.start();
      expect(t.lines()).toEqual([]);
      // Kage's other fs work still runs: the pool isn't held by an open on the FIFO.
      const other = join(dir, 'other.jsonl');
      writeFileSync(other, say('fine'));
      const ok = tail(other);
      await ok.start();
      expect(ok.lines()).toEqual([{ kind: 'say', text: 'fine' }]);
      // A regular file swapped in where the FIFO was is read like any transcript.
      rmSync(path);
      const got = next(t);
      writeFileSync(path, say('real'));
      expect(await got).toEqual([{ kind: 'say', text: 'real' }]);
    },
  );

  it('picks up a file whose parent directory does not exist yet', async () => {
    const sub = join(dir, 'projects', '-home-dev');
    const path = join(sub, 'later.jsonl');
    const t = tail(path);
    await t.start();
    const got = next(t);
    await mkdir(sub, { recursive: true });
    writeFileSync(path, say('late'));
    expect(await got).toEqual([{ kind: 'say', text: 'late' }]);
  });

  it('stop() closes the watcher and the poll: nothing is emitted afterwards', async () => {
    fakeIntervals();
    const spy = watchSpy();
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('a'));
    const t = tail(path, { watch: spy.fn });
    await t.start();
    expect(spy.open.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const seen: DisplayLine[][] = [];
    t.on((added) => seen.push(added));
    t.stop();
    expect(spy.open.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    appendFileSync(path, say('b'));
    vi.advanceTimersByTime(5000);
    await wait(200);
    expect(seen).toEqual([]);
    expect(t.lines()).toEqual([{ kind: 'say', text: 'a' }]);
  });

  it.each([
    ['missing', false],
    ['present', true],
  ])(
    'stop() during an in-flight check leaves no watcher or interval (file %s)',
    async (_, exists) => {
      fakeIntervals();
      const path = join(dir, 's.jsonl');
      if (exists) {
        let body = '';
        for (let i = 0; i < 50; i++) body += say(`line ${i}`);
        writeFileSync(path, body);
      }
      // Stop after 0..40 turns of the event loop, so stop() lands on each await in turn.
      for (let turns = 0; turns <= 40; turns++) {
        const spy = watchSpy();
        const t = tail(path, { watch: spy.fn, fromEnd: 100 });
        const started = t.start();
        for (let i = 0; i < turns; i++) await turn();
        t.stop();
        await started;
        await turn();
        expect(spy.open.size, `after ${turns} turns`).toBe(0);
        expect(vi.getTimerCount(), `after ${turns} turns`).toBe(0);
      }
    },
  );

  it('follows the file by the 2 s poll alone when fs.watch reports nothing', async () => {
    fakeIntervals();
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('a'));
    const t = tail(path, { watch: false });
    await t.start();
    const seen: DisplayLine[][] = [];
    t.on((added) => seen.push(added));
    appendFileSync(path, say('b'));
    vi.advanceTimersByTime(1999);
    await wait(100);
    expect(seen).toEqual([]);
    const got = next(t);
    vi.advanceTimersByTime(1);
    expect(await got).toEqual([{ kind: 'say', text: 'b' }]);
  });

  it('polls every second for a missing file when fs.watch reports nothing (R10)', async () => {
    fakeIntervals();
    const path = join(dir, 'later.jsonl');
    const t = tail(path, { watch: false });
    await t.start();
    writeFileSync(path, say('hello'));
    const got = next(t);
    vi.advanceTimersByTime(1000);
    expect(await got).toEqual([{ kind: 'say', text: 'hello' }]);
  });

  it('resets when the file is replaced by a rename (a new inode), even when it is longer', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('old'));
    const t = tail(path);
    await t.start();
    const resets: boolean[] = [];
    const got = new Promise<DisplayLine[]>((resolve) => {
      t.on((added, reset) => {
        resets.push(reset);
        if (added.length) resolve(added);
      });
    });
    const tmp = join(dir, 'next.jsonl');
    writeFileSync(tmp, say('new one') + say('new two'));
    renameSync(tmp, path);
    expect(await got).toEqual([
      { kind: 'say', text: 'new one' },
      { kind: 'say', text: 'new two' },
    ]);
    expect(resets[0]).toBe(true);
    expect(t.lines().map((l) => l.text)).toEqual(['new one', 'new two']);
  });

  it('decodes invalid UTF-8 without throwing', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, '');
    const t = tail(path);
    await t.start();

    const got = next(t);
    appendFileSync(
      path,
      Buffer.concat([
        Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"bad '),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}]}}\n'),
      ]),
    );
    expect((await got)[0]?.text).toBe('bad ��');
  });

  it('decodes a character split across two reads', async () => {
    // "é" is 0xC3 0xA9; a chunk size that ends right after 0xC3 splits it between reads.
    const path = join(dir, 's.jsonl');
    const head = Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"caf',
    );
    writeFileSync(path, Buffer.concat([head, Buffer.from([0xc3, 0xa9]), Buffer.from('"}]}}\n')]));
    const t = tail(path, { chunkSize: head.length + 1 });
    await t.start();
    expect(t.lines()).toEqual([{ kind: 'say', text: 'café' }]);
  });

  it('skips a line over 8 MiB and carries on with the next one', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, '');
    const t = tail(path);
    await t.start();
    const got = next(t, 8000);
    const huge = `{"type":"assistant","message":{"content":[{"type":"text","text":"${'x'.repeat(9 * 1024 * 1024)}"}]}}\n`;
    appendFileSync(path, huge + say('after'));
    expect(await got).toEqual([{ kind: 'say', text: 'after' }]);
  });

  it('resets on truncation: lines restart from the new content, flagged as a reset', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('old 1') + say('old 2'));
    const t = tail(path);
    await t.start();
    const resets: boolean[] = [];
    const got = new Promise<DisplayLine[]>((resolve) => {
      t.on((added, reset) => {
        resets.push(reset);
        if (added.length) resolve(added);
      });
    });
    writeFileSync(path, say('new'));
    expect(await got).toEqual([{ kind: 'say', text: 'new' }]);
    expect(resets[0]).toBe(true);
    expect(t.lines()).toEqual([{ kind: 'say', text: 'new' }]);
  });

  it('never emits two think lines in a row across records', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, think + think + say('x') + think);
    const t = tail(path);
    await t.start();
    expect(t.lines().map((l) => l.kind)).toEqual(['think', 'say', 'think']);
    // A think after a think is dropped; the marker after it shows the batch it would be in.
    const got = next(t);
    appendFileSync(path, think + say('marker'));
    expect(await got).toEqual([{ kind: 'say', text: 'marker' }]);
    expect(t.lines().map((l) => l.kind)).toEqual(['think', 'say', 'think', 'say']);
  });

  it('question() comes from AskUserQuestion and clears on its tool_result', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, fixture('ask-question.jsonl'));
    const t = tail(path);
    await t.start();
    expect(t.question()).toEqual({
      text: 'Which separator should slug() use?',
      options: ['Dash', 'Underscore'],
    });
    expect(t.now()).toBe('Asking a question');

    const got = next(t);
    appendFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_00000000000000000000000009',
              content:
                'Your questions have been answered: "Which separator should slug() use?"="Dash"',
            },
          ],
        },
      })}\n`,
    );
    await got;
    expect(t.question()).toBeNull();
  });

  it('an interrupt clears the question and the now line and calls onInterrupt (R11)', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, fixture('ask-question.jsonl'));
    const t = tail(path);
    await t.start();
    expect(t.question()).not.toBeNull();
    let calls = 0;
    const fired = new Promise<void>((resolve) => {
      t.onInterrupt(() => {
        calls++;
        resolve();
      });
    });
    appendFileSync(path, prompt('[Request interrupted by user]'));
    await fired;
    expect(t.question()).toBeNull();
    expect(t.now()).toBeNull();
    expect(calls).toBe(1);
  });

  it('denied.jsonl fires onInterrupt and shows Denied', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, '');
    const t = tail(path);
    await t.start();
    let calls = 0;
    const off = t.onInterrupt(() => calls++);
    const got = next(t);
    appendFileSync(path, fixture('denied.jsonl'));
    const lines = await got;
    expect(lines.at(-1)).toEqual({ kind: 'out', text: 'Denied' });
    expect(calls).toBe(1); // the rejected tool_result and its interrupt text are one event
    expect(t.now()).toBeNull();
    off();
  });

  it('now() follows the latest activity', async () => {
    const path = join(dir, 's.jsonl');
    const lines = fixture('edit-and-test.jsonl').split('\n').filter(Boolean);
    // Up to and including the Bash tool_use: the latest activity is the test run.
    writeFileSync(path, `${lines.slice(0, 7).join('\n')}\n`);
    const t = tail(path);
    await t.start();
    expect(t.now()).toBe('Running npm test');
  });
});

describe('TranscriptTail: turn end (fix wave)', () => {
  const rec = (r: unknown) => `${JSON.stringify(r)}\n`;
  const bash = rec({
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
    },
  });

  it('real-short-turn.jsonl ends with no now line', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, fixture('real-short-turn.jsonl'));
    const t = tail(path);
    await t.start();
    expect(t.now()).toBeNull();
    expect(t.lines().at(-1)).toEqual({
      kind: 'say',
      text: 'I changed `bravo` to `BRAVO` in `notes.txt`.',
    });
  });

  it('an end_turn reply clears the now line without a turn_duration', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, bash);
    const t = tail(path);
    await t.start();
    expect(t.now()).toBe('Running npm test');
    appendFileSync(
      path,
      rec({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      }),
    );
    await next(t);
    expect(t.now()).toBeNull();
  });

  it('a stop_hook_summary clears the now line', async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, `${bash}${rec({ type: 'system', subtype: 'stop_hook_summary' })}`);
    const t = tail(path);
    await t.start();
    expect(t.now()).toBeNull();
  });
});

describe('TranscriptTail: only records read after the first read fire (M1, I2)', () => {
  const rec = (r: unknown) => `${JSON.stringify(r)}\n`;
  const ended = rec({ type: 'system', subtype: 'turn_duration', durationMs: 1200 });
  const endTurn = rec({
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  });

  it("interrupts and turn ends in the first read don't fire; ones appended later do", async () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, `${prompt('[Request interrupted by user]')}${endTurn}${ended}`);
    const t = tail(path);
    let interrupts = 0;
    let ends = 0;
    // Listeners attached before start(), as LiveSource attaches them.
    t.onInterrupt(() => interrupts++);
    const off = t.onTurnEnd(() => ends++);
    await t.start();
    expect(interrupts).toBe(0);
    expect(ends).toBe(0);
    expect(t.now()).toBeNull();

    const fired = new Promise<void>((resolve) => {
      t.onInterrupt(() => resolve());
    });
    appendFileSync(path, prompt('[Request interrupted by user]'));
    await fired;
    expect(interrupts).toBe(1);

    // A turn end with no display line (stop_hook_summary) still fires.
    const turnEnded = new Promise<void>((resolve) => {
      t.onTurnEnd(() => resolve());
    });
    appendFileSync(path, rec({ type: 'system', subtype: 'stop_hook_summary' }));
    await turnEnded;
    expect(ends).toBe(1);
    off();
    appendFileSync(path, ended);
    await wait(300);
    expect(ends).toBe(1);
  });

  it('a file created after start() is all new: its interrupt fires', async () => {
    const path = join(dir, 's.jsonl');
    const t = tail(path);
    let interrupts = 0;
    let ends = 0;
    t.onInterrupt(() => interrupts++);
    t.onTurnEnd(() => ends++);
    await t.start();
    const fired = new Promise<void>((resolve) => {
      t.onTurnEnd(() => resolve());
    });
    writeFileSync(path, `${prompt('[Request interrupted by user]')}${ended}`);
    await fired;
    expect(interrupts).toBe(1);
    expect(ends).toBe(1);
  });
});

describe('TranscriptTail: idle tails (hardening Task 9, P7)', () => {
  /** An fs.watch whose events and errors the test fires; it never sees the disk. */
  function fakeWatch() {
    const made: { w: EventEmitter; fn: (event: string, file: string | null) => void }[] = [];
    const fn = ((_target: string, _options: unknown, listener: unknown) => {
      const w = Object.assign(new EventEmitter(), { close() {} });
      made.push({ w, fn: listener as (event: string, file: string | null) => void });
      return w;
    }) as unknown as typeof watch;
    return {
      fn,
      fire: () => made.at(-1)?.fn('change', 's.jsonl'),
      fail: () => made.at(-1)?.w.emit('error', new Error('watch failed')),
    };
  }

  it('an idle tail with a working watcher polls nothing; without a watcher it polls every 2 s', async () => {
    fakeIntervals();
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('a'));
    const fw = fakeWatch();
    const t = tail(path, { watch: fw.fn });
    t.setIdle(true);
    await t.start();
    expect(vi.getTimerCount()).toBe(0);
    const seen: DisplayLine[][] = [];
    t.on((added) => seen.push(added));
    appendFileSync(path, say('b'));
    vi.advanceTimersByTime(60_000);
    await wait(100);
    // No stat poll: the append is seen only when the watcher reports it.
    expect(seen).toEqual([]);
    const got = next(t);
    fw.fire();
    expect(await got).toEqual([{ kind: 'say', text: 'b' }]);
    // Running again: the 2 s poll is back.
    t.setIdle(false);
    expect(vi.getTimerCount()).toBe(1);
    t.setIdle(true);
    expect(vi.getTimerCount()).toBe(0);
    // A watcher that failed once is not trusted: an idle tail polls again.
    fw.fail();
    await wait(100);
    expect(vi.getTimerCount()).toBe(1);

    const path2 = join(dir, 'p.jsonl');
    writeFileSync(path2, say('a'));
    const polled = tail(path2, { watch: false });
    polled.setIdle(true);
    await polled.start();
    const got2 = next(polled);
    appendFileSync(path2, say('c'));
    vi.advanceTimersByTime(2000);
    expect(await got2).toEqual([{ kind: 'say', text: 'c' }]);
  });
});

describe('TranscriptTail: Task 9 round (R138)', () => {
  /** An fs.watch that never reports anything. */
  const deafWatch = (() =>
    Object.assign(new EventEmitter(), { close() {} })) as unknown as typeof watch;

  it('poke() looks at the file once: an idle tail sees an append its watcher missed', async () => {
    fakeIntervals();
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('a'));
    const t = tail(path, { watch: deafWatch });
    t.setIdle(true);
    await t.start();
    expect(vi.getTimerCount()).toBe(0);
    const got = next(t);
    appendFileSync(path, say('b'));
    t.poke();
    expect(await got).toEqual([{ kind: 'say', text: 'b' }]);
    expect(vi.getTimerCount()).toBe(0);
    t.stop();
    t.poke();
    await wait(50);
    expect(t.lines()).toHaveLength(2);
  });

  it('an idle tail gives its read buffer back and makes a new one at the next read', async () => {
    fakeIntervals();
    const path = join(dir, 's.jsonl');
    writeFileSync(path, say('a'));
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      const t = tail(path, { watch: deafWatch, chunkSize: 4096 });
      const reads = () => alloc.mock.calls.filter(([n]) => n === 4096).length;
      await t.start();
      expect(reads()).toBe(1);
      // Running: one buffer, reused.
      let got = next(t);
      appendFileSync(path, say('b'));
      t.poke();
      await got;
      expect(reads()).toBe(1);
      // Idle: released, so each read makes one and gives it back.
      t.setIdle(true);
      for (const text of ['c', 'd']) {
        got = next(t);
        appendFileSync(path, say(text));
        t.poke();
        await got;
      }
      expect(reads()).toBe(3);
    } finally {
      alloc.mockRestore();
    }
  });
});
