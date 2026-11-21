import { type FSWatcher, type Stats, watch } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DisplayLine, Question } from '@kage/shared';
import {
  answeredIds,
  askBlock,
  endsTurn,
  interrupted,
  nowLine,
  questionFrom,
  toDisplayLines,
} from './lines.ts';

/** Lines longer than this (in UTF-16 code units, about bytes for JSON) are skipped. */
export const MAX_LINE = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;
/** Poll for the file while it doesn't exist (R10). */
const MISSING_POLL_MS = 1000;
/** Fallback size poll while following, for filesystems where fs.watch misses events. */
const FOLLOW_POLL_MS = 2000;

type Listener = (added: DisplayLine[], reset: boolean) => void;

/**
 * Follows one Claude Code transcript: reads the tail of the file at start, then appends as the
 * file grows. The file may not exist yet; a truncated or replaced file starts over.
 */
export class TranscriptTail {
  readonly #path: string;
  readonly #maxLines: number;
  readonly #fromEnd: number;

  #lines: DisplayLine[] = [];
  #question: Question | null = null;
  #questionId: string | null = null;
  #now: string | null = null;

  #listeners = new Set<Listener>();
  #interruptListeners = new Set<() => void>();

  #running = false;
  #watcher: FSWatcher | null = null;
  #watching: 'file' | 'dir' | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #timerMs = 0;

  // Read position and decoding state.
  #ino: number | undefined;
  #offset = 0;
  #decoder = new TextDecoder('utf-8');
  #partial: string[] = [];
  #partialLength = 0;
  /** Dropping input until the next newline (an over-long line, or a cut first line). */
  #skipping = false;
  #reset = false;

  // Serialises checks: one runs at a time; a request during it schedules one more.
  #busy: Promise<void> | null = null;
  #again = false;

  constructor(path: string, opts: { maxLines?: number; fromEnd?: number } = {}) {
    this.#path = path;
    this.#maxLines = opts.maxLines ?? 200;
    this.#fromEnd = opts.fromEnd ?? 256 * 1024;
  }

  /** Reads what is there now and starts following. Resolves after the first read. */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#check();
  }

  /** Stops following; closes the watcher and clears every timer. */
  stop(): void {
    this.#running = false;
    this.#unwatch();
    this.#setTimer(0);
  }

  lines(): DisplayLine[] {
    return this.#lines.slice();
  }

  question(): Question | null {
    return this.#question;
  }

  now(): string | null {
    return this.#now;
  }

  /** Called with each batch of new lines; `reset` is true when the lines started over. */
  on(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Called when the user rejects a tool or interrupts the turn (R11). */
  onInterrupt(fn: () => void): () => void {
    this.#interruptListeners.add(fn);
    return () => this.#interruptListeners.delete(fn);
  }

  /** Runs a check now, or once more after the one in progress. */
  #check(): Promise<void> {
    if (this.#busy) {
      this.#again = true;
      return this.#busy;
    }
    this.#busy = (async () => {
      try {
        do {
          this.#again = false;
          await this.#checkOnce();
        } while (this.#again && this.#running);
      } finally {
        this.#busy = null;
      }
    })();
    return this.#busy;
  }

  async #checkOnce(): Promise<void> {
    if (!this.#running) return;
    let st: Stats;
    try {
      st = await stat(this.#path);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      this.#waitForFile();
      return;
    }
    if (!this.#running) return;
    const replaced = this.#ino !== undefined && this.#ino !== 0 && st.ino !== this.#ino;
    if (replaced || st.size < this.#offset) this.#startOver();
    if (this.#ino === undefined || replaced) {
      this.#ino = st.ino;
      await this.#seekStart(st.size);
    }
    this.#follow();
    if (st.size > this.#offset) await this.#read(st.size);
    else if (this.#reset) this.#emit([]);
  }

  /** Drops all state; the next batch is flagged as a reset. */
  #startOver(): void {
    this.#lines = [];
    this.#question = null;
    this.#questionId = null;
    this.#now = null;
    this.#ino = undefined;
    this.#offset = 0;
    this.#decoder = new TextDecoder('utf-8');
    this.#partial = [];
    this.#partialLength = 0;
    this.#skipping = false;
    this.#reset = true;
  }

  /** Starts at the last fromEnd bytes; a cut first line is skipped. */
  async #seekStart(size: number): Promise<void> {
    this.#offset = Math.max(0, size - this.#fromEnd);
    if (this.#offset === 0) return;
    // Skip the first line unless the byte before the start ends a line.
    this.#skipping = true;
    try {
      const fh = await open(this.#path, 'r');
      try {
        const b = Buffer.alloc(1);
        const { bytesRead } = await fh.read(b, 0, 1, this.#offset - 1);
        if (bytesRead === 1 && b[0] === 0x0a) this.#skipping = false;
      } finally {
        await fh.close();
      }
    } catch {}
  }

  async #read(size: number): Promise<void> {
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(this.#path, 'r');
    } catch {
      return;
    }
    const added: DisplayLine[] = [];
    try {
      const buf = Buffer.alloc(CHUNK);
      while (this.#running && this.#offset < size) {
        const want = Math.min(CHUNK, size - this.#offset);
        const { bytesRead } = await fh.read(buf, 0, want, this.#offset);
        if (bytesRead === 0) break;
        this.#offset += bytesRead;
        this.#feed(this.#decoder.decode(buf.subarray(0, bytesRead), { stream: true }), added);
      }
    } catch {
      // A read error leaves the offset where it got to; the next check carries on.
    } finally {
      await fh.close().catch(() => {});
    }
    if (this.#running) this.#emit(added);
  }

  /** Splits decoded text into lines; the unfinished last line is held back. */
  #feed(text: string, added: DisplayLine[]): void {
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) {
        this.#hold(text.slice(start));
        return;
      }
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (this.#skipping) {
        this.#skipping = false;
        this.#partial = [];
        this.#partialLength = 0;
        continue;
      }
      if (this.#partialLength + piece.length > MAX_LINE) {
        this.#partial = [];
        this.#partialLength = 0;
        continue;
      }
      const line = this.#partial.length ? this.#partial.join('') + piece : piece;
      this.#partial = [];
      this.#partialLength = 0;
      this.#record(line, added);
    }
  }

  #hold(piece: string): void {
    if (this.#skipping) return;
    if (this.#partialLength + piece.length > MAX_LINE) {
      // Too long: drop what we have and everything up to the next newline.
      this.#partial = [];
      this.#partialLength = 0;
      this.#skipping = true;
      return;
    }
    this.#partial.push(piece);
    this.#partialLength += piece.length;
  }

  #record(line: string, added: DisplayLine[]): void {
    if (line.trim() === '') return;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const ask = askBlock(r);
    const q = questionFrom(r);
    if (q && ask) {
      this.#question = q;
      this.#questionId = typeof ask.id === 'string' ? ask.id : null;
    } else if (this.#questionId && answeredIds(r).includes(this.#questionId)) {
      this.#question = null;
      this.#questionId = null;
    }

    if (endsTurn(r)) this.#now = null;
    else {
      const now = nowLine(r);
      if (now !== null) this.#now = now;
    }

    const last = () => (added.length ? added.at(-1) : this.#lines.at(-1));
    for (const l of toDisplayLines(r)) {
      if (l.kind === 'think' && last()?.kind === 'think') continue;
      added.push(l);
    }

    if (interrupted(r)) {
      this.#question = null;
      this.#questionId = null;
      this.#now = null;
      for (const fn of [...this.#interruptListeners]) {
        try {
          fn();
        } catch {}
      }
    }
  }

  #emit(added: DisplayLine[]): void {
    const reset = this.#reset;
    if (added.length === 0 && !reset) return;
    this.#reset = false;
    this.#lines.push(...added);
    if (this.#lines.length > this.#maxLines)
      this.#lines.splice(0, this.#lines.length - this.#maxLines);
    const batch = added.length > this.#maxLines ? added.slice(-this.#maxLines) : added;
    for (const fn of [...this.#listeners]) {
      try {
        fn(batch, reset);
      } catch {}
    }
  }

  /** The file exists: watch it and poll its size as a fallback. */
  #follow(): void {
    if (this.#watching !== 'file') {
      this.#unwatch();
      this.#watcher = this.#tryWatch(this.#path, (event) => {
        // A rename may mean the file was replaced; watch it afresh after the check.
        if (event === 'rename') this.#unwatch();
        void this.#check();
      });
      if (this.#watcher) this.#watching = 'file';
    }
    this.#setTimer(FOLLOW_POLL_MS);
  }

  /** The file is missing (R10): watch its directory if there is one, and poll every second. */
  #waitForFile(): void {
    if (this.#watching === 'file') this.#unwatch();
    if (this.#watching !== 'dir') {
      const name = basename(this.#path);
      this.#watcher = this.#tryWatch(dirname(this.#path), (_event, file) => {
        if (file === null || file === name) void this.#check();
      });
      if (this.#watcher) this.#watching = 'dir';
    }
    this.#setTimer(MISSING_POLL_MS);
  }

  #tryWatch(target: string, fn: (event: string, file: string | null) => void): FSWatcher | null {
    try {
      const w = watch(target, { persistent: false }, (event, file) => {
        if (this.#running) fn(event, typeof file === 'string' ? file : null);
      });
      w.on('error', () => {
        if (this.#watcher === w) this.#unwatch();
        if (this.#running) void this.#check();
      });
      return w;
    } catch {
      return null;
    }
  }

  #unwatch(): void {
    const w = this.#watcher;
    this.#watcher = null;
    this.#watching = null;
    try {
      w?.close();
    } catch {}
  }

  #setTimer(ms: number): void {
    if (ms === this.#timerMs) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#timerMs = ms;
    if (ms > 0) {
      this.#timer = setInterval(() => void this.#check(), ms);
      this.#timer.unref();
    }
  }
}
