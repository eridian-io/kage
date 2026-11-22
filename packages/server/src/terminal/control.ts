import { type TmuxTarget, tmuxArgs } from '../tmux/client.ts';
import { defaultSpawn, type SpawnFn, type WatchedProcess } from '../tmux/watcher.ts';

/** One line from a tmux control-mode client (host-integration §4.1). */
export type ControlLine =
  /** %output or %extended-output, unescaped: raw pane bytes (a UTF-8 character may be split). */
  | { kind: 'output'; paneId: string; data: Buffer }
  | { kind: 'begin' | 'end' | 'error'; time: string; num: string; flags: string }
  | { kind: 'layout'; windowId: string }
  /** %window-close or %unlinked-window-close: tmux 3.4 sends the latter for its own session (R61). */
  | { kind: 'window-close'; windowId: string }
  | { kind: 'exit' }
  | { kind: 'other' };

const PANE_ID = /^%\d+$/;
const WINDOW_ID = /^@\d+$/;
const DIGITS = /^\d+$/;
const SPACE = 0x20;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

/**
 * The pane facts a snapshot needs, in one `display-message` row. Constant tmux variables (host
 * §4.3), `#{pane_id}` and `#{window_id}` first (display-message on a pane that has gone still
 * prints, so the ids prove the row is the pane's), the free-text command last.
 */
export const PANE_INFO_FORMAT =
  '#{pane_id} #{window_id} #{pane_width} #{pane_height} #{history_size} #{cursor_x} #{cursor_y} ' +
  '#{cursor_flag} #{alternate_on} #{keypad_cursor_flag} #{keypad_flag} #{mouse_standard_flag} ' +
  '#{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{pane_current_command}';

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const N = '\\d{1,9}';
/** Every command the terminal bridge writes. No user text: keys travel as hex words. */
const COMMAND = [
  `send-keys -t %${N} -H(?: [0-9a-f]{2})+`,
  `resize-window -t @${N} -x ${N} -y ${N}`,
  `set-option -w -u -t @${N} window-size`,
  `display-message -p -t %${N} '${reEscape(PANE_INFO_FORMAT)}'`,
  `capture-pane -p -e -N -S -${N} -t %${N}`,
].join('|');
const SAFE_COMMAND = new RegExp(`^(?:${COMMAND})$`);
/** Every line written to the client matches this: known commands joined by " ; ", nothing else. */
export const SAFE_LINE = new RegExp(`^(?:${COMMAND})(?: ; (?:${COMMAND}))*$`);

const OCTAL = (b: number | undefined): boolean => b !== undefined && b >= 0x30 && b <= 0x37;

/** `\ooo` → one byte; every other byte (also a lone backslash) stays as it is. Always a copy. */
export function unescapeOutput(escaped: Buffer): Buffer {
  const out = Buffer.allocUnsafe(escaped.length);
  let o = 0;
  let from = 0;
  for (let i = escaped.indexOf(BACKSLASH); i >= 0; i = escaped.indexOf(BACKSLASH, from)) {
    o += escaped.copy(out, o, from, i);
    const a = escaped[i + 1];
    const b = escaped[i + 2];
    const c = escaped[i + 3];
    if (OCTAL(a) && OCTAL(b) && OCTAL(c)) {
      const v = ((a as number) - 0x30) * 64 + ((b as number) - 0x30) * 8 + ((c as number) - 0x30);
      if (v <= 0xff) {
        out[o++] = v;
        from = i + 4;
        continue;
      }
    }
    out[o++] = BACKSLASH;
    from = i + 1;
  }
  o += escaped.copy(out, o, from);
  return out.subarray(0, o);
}

const OTHER: ControlLine = Object.freeze({ kind: 'other' });

/** The word after `%kind ` and the byte offset just past it (or past the line's end). */
function secondWord(line: Buffer, sp: number): { word: string; next: number } {
  const end = line.indexOf(SPACE, sp + 1);
  const stop = end < 0 ? line.length : end;
  return { word: line.subarray(sp + 1, stop).toString('latin1'), next: stop + 1 };
}

/** Parses one control-mode line (without its \n). Rows of command output are not lines. */
export function parseControlLine(raw: Buffer): ControlLine {
  const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
  if (line[0] !== 0x25) return OTHER;
  const sp = line.indexOf(SPACE);
  const kind = (sp < 0 ? line : line.subarray(0, sp)).toString('latin1');
  switch (kind) {
    case '%output': {
      if (sp < 0) return OTHER;
      const { word, next } = secondWord(line, sp);
      if (!PANE_ID.test(word)) return OTHER;
      return { kind: 'output', paneId: word, data: unescapeOutput(line.subarray(next)) };
    }
    case '%extended-output': {
      if (sp < 0) return OTHER;
      const { word, next } = secondWord(line, sp);
      const colon = line.indexOf(' : ', next - 1);
      if (!PANE_ID.test(word) || colon < 0) return OTHER;
      return { kind: 'output', paneId: word, data: unescapeOutput(line.subarray(colon + 3)) };
    }
    case '%begin':
    case '%end':
    case '%error': {
      const f = line.toString('latin1').split(' ');
      if (f.length !== 4 || !f.slice(1).every((x) => DIGITS.test(x))) return OTHER;
      const k = kind.slice(1) as 'begin' | 'end' | 'error';
      return { kind: k, time: f[1] as string, num: f[2] as string, flags: f[3] as string };
    }
    case '%layout-change':
    case '%window-close':
    case '%unlinked-window-close': {
      if (sp < 0) return OTHER;
      const { word } = secondWord(line, sp);
      if (!WINDOW_ID.test(word)) return OTHER;
      return kind === '%layout-change'
        ? { kind: 'layout', windowId: word }
        : { kind: 'window-close', windowId: word };
    }
    case '%exit':
      return { kind: 'exit' };
    default:
      return OTHER;
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** tmux takes up to 8,000 words in one `send-keys -H` line (host §4.2); stay below it. */
const MAX_PER_LINE = 8000;

/** `send-keys -t %N -H 1b 5b 41` lines of at most `perLine` bytes (default 256). Throws on a bad pane id. */
export function sendKeysLines(paneId: string, bytes: Uint8Array, perLine = 256): string[] {
  if (!PANE_ID.test(paneId)) throw new TypeError(`not a tmux pane id: ${JSON.stringify(paneId)}`);
  if (!Number.isInteger(perLine) || perLine < 1 || perLine >= MAX_PER_LINE) {
    throw new RangeError(`perLine must be 1..${MAX_PER_LINE - 1}`);
  }
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const words: string[] = [];
    const end = Math.min(bytes.length, i + perLine);
    for (let j = i; j < end; j++) words.push(HEX[bytes[j] as number] as string);
    lines.push(`send-keys -t ${paneId} -H ${words.join(' ')}`);
  }
  return lines;
}

interface Entry {
  /** How many %begin/%end blocks the line produces (one per command). */
  blocks: number;
  countFor?: (i: number, earlier: Buffer[][]) => number | null;
  results: Buffer[][];
  /** The attach block (flags 0) answers this entry; every other entry needs flags 1. */
  attach?: boolean;
  /** A fire-and-forget line: its answer doesn't pause reading. */
  quiet?: boolean;
  resolve: (v: Buffer[][]) => void;
  reject: (e: Error & { rows?: Buffer[] }) => void;
}

interface Block {
  time: string;
  num: string;
  flags: string;
  rows: Buffer[];
  count: number | null;
  entry: Entry | null;
}

/** Unread bytes past this mean a broken client: no tmux line is anywhere near it. */
const MAX_PENDING = 16 * 1024 * 1024;
/** After close() ends stdin, tmux exits on its own; kill it if it hasn't by then. */
const KILL_AFTER_MS = 2000;

const stopped = (): Error => new Error('tmux stopped.');

/**
 * One tmux control-mode client (`tmux -C attach`) that writes commands and reads their answers.
 * stdout is read as bytes and split on \n. Answers are matched to commands in order; a block
 * with a count is read by count, so a pane that prints `%end …` can't end it early.
 */
export class ControlClient {
  readonly #target: TmuxTarget;
  readonly #session: string;
  readonly #spawn: SpawnFn;
  readonly #onLine: (l: ControlLine) => void;
  readonly #onExit: () => void;
  #proc: WatchedProcess | null = null;
  #state: 'new' | 'up' | 'done' = 'new';
  #closedByUs = false;
  #rest: Buffer = Buffer.alloc(0);
  #paused = false;
  readonly #queue: Entry[] = [];
  #block: Block | null = null;
  #killTimer: NodeJS.Timeout | null = null;

  constructor(o: {
    target: TmuxTarget;
    session: string;
    spawn?: SpawnFn;
    onLine: (l: ControlLine) => void;
    onExit: () => void;
  }) {
    this.#target = o.target;
    this.#session = o.session;
    this.#spawn = o.spawn ?? defaultSpawn;
    this.#onLine = o.onLine;
    this.#onExit = o.onExit;
  }

  /** `tmux [-f cfg] [-L s] -C attach -t =<session>`; resolves after the attach's own %begin/%end. */
  start(): Promise<void> {
    if (this.#state !== 'new')
      return Promise.reject(new Error('The control client was started already.'));
    this.#state = 'up';
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ blocks: 1, results: [], attach: true, resolve: () => resolve(), reject });
      const args = tmuxArgs(this.#target, ['-C', 'attach', '-t', `=${this.#session}`]);
      const proc = this.#spawn('tmux', args);
      this.#proc = proc;
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        if (this.#proc !== proc) return;
        this.#data(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      proc.stderr?.on('data', () => {});
      // Writing after tmux exited is EPIPE; the exit handler reports it.
      proc.stdin?.on('error', () => {});
      const ended = () => this.#ended(proc);
      proc.on('exit', ended);
      proc.on('error', ended);
    });
  }

  /**
   * Writes `cmds` joined by " ; " as one line and resolves with each command's output rows.
   * countFor(i, earlier) gives how many rows command i prints (count framing), or null to read
   * until its matching %end. A %error rejects (tmux skips the rest of the line's commands).
   */
  run(
    cmds: string[],
    countFor?: (i: number, earlier: Buffer[][]) => number | null,
  ): Promise<Buffer[][]> {
    if (cmds.length === 0) return Promise.resolve([]);
    const line = cmds.join(' ; ');
    if (!cmds.every((c) => SAFE_COMMAND.test(c)) || !SAFE_LINE.test(line)) {
      return Promise.reject(new TypeError(`Kage won't send this to tmux: ${JSON.stringify(line)}`));
    }
    if (this.#state !== 'up' || !this.#proc) return Promise.reject(stopped());
    return new Promise((resolve, reject) => {
      this.#queue.push({ blocks: cmds.length, countFor, results: [], resolve, reject });
      this.#proc?.stdin?.write(`${line}\n`);
    });
  }

  /** Fire-and-forget (keys, sizes); throws TypeError when SAFE_LINE refuses the line. */
  write(line: string, onError?: (rows: Buffer[]) => void): void {
    if (!SAFE_COMMAND.test(line)) {
      throw new TypeError(`Kage won't send this to tmux: ${JSON.stringify(line)}`);
    }
    if (this.#state !== 'up' || !this.#proc) return;
    this.#queue.push({
      blocks: 1,
      results: [],
      quiet: true,
      resolve: () => {},
      reject: (e) => {
        if (e.rows) onError?.(e.rows);
      },
    });
    this.#proc.stdin?.write(`${line}\n`);
  }

  /** Ends stdin (tmux runs what it has read, then exits); onExit is not called. */
  close(): void {
    if (this.#state === 'done') return;
    this.#closedByUs = true;
    this.#finishAll();
    const proc = this.#proc;
    if (!proc) return;
    proc.stdin?.end();
    this.#killTimer = setTimeout(() => {
      this.#killTimer = null;
      proc.kill();
    }, KILL_AFTER_MS);
    this.#killTimer.unref?.();
  }

  #finishAll(): void {
    this.#state = 'done';
    this.#block = null;
    for (const e of this.#queue.splice(0)) e.reject(stopped());
  }

  #ended(proc: WatchedProcess): void {
    if (this.#proc !== proc) return;
    this.#proc = null;
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#killTimer = null;
    if (this.#state === 'done') return;
    this.#finishAll();
    if (!this.#closedByUs) this.#onExit();
  }

  #data(chunk: Buffer): void {
    this.#rest = this.#rest.length === 0 ? chunk : Buffer.concat([this.#rest, chunk]);
    if (this.#rest.length > MAX_PENDING) {
      const proc = this.#proc;
      proc?.kill();
      if (proc) this.#ended(proc);
      return;
    }
    this.#drain();
  }

  #drain(): void {
    const rest = this.#rest;
    let from = 0;
    while (!this.#paused && this.#state !== 'done') {
      const nl = rest.indexOf(NEWLINE, from);
      if (nl < 0) break;
      const line = rest.subarray(from, nl);
      from = nl + 1;
      this.#line(line);
    }
    this.#rest = this.#state === 'done' ? Buffer.alloc(0) : rest.subarray(from);
  }

  /**
   * After a command's answer, read no further line until its promise's callers have run, so a
   * caller sees exactly the notifications that came after the answer (snapshot ordering).
   */
  #pause(): void {
    this.#paused = true;
    setImmediate(() => {
      this.#paused = false;
      this.#drain();
    });
  }

  #line(line: Buffer): void {
    const b = this.#block;
    if (b) {
      // While a count is open, every line is a row: a pane can print "%end …".
      if (b.count !== null && b.rows.length < b.count) {
        b.rows.push(line);
        return;
      }
      const l = line[0] === 0x25 ? parseControlLine(line) : OTHER;
      if (
        (l.kind === 'end' || l.kind === 'error') &&
        l.time === b.time &&
        l.num === b.num &&
        l.flags === b.flags
      ) {
        this.#endBlock(b, l.kind === 'error');
      } else {
        b.rows.push(line);
      }
      return;
    }
    const l = parseControlLine(line);
    if (l.kind === 'begin') {
      const head = this.#queue[0];
      const entry = head && (head.attach || l.flags === '1') ? head : null;
      let count: number | null = null;
      if (entry?.countFor) {
        try {
          count = entry.countFor(entry.results.length, entry.results);
        } catch {
          count = null;
        }
        if (count !== null && !(Number.isInteger(count) && count >= 0)) count = null;
      }
      this.#block = { time: l.time, num: l.num, flags: l.flags, rows: [], count, entry };
      return;
    }
    // A stray %end or %error (no open block) is dropped.
    if (l.kind === 'end' || l.kind === 'error') return;
    this.#onLine(l);
  }

  #endBlock(b: Block, error: boolean): void {
    this.#block = null;
    const e = b.entry;
    if (!e) return;
    if (error) {
      this.#queue.shift();
      const text = b.rows.map((r) => r.toString('utf8')).join('\n') || 'tmux refused the command';
      e.reject(Object.assign(new Error(text), { rows: b.rows }));
      if (!e.quiet) this.#pause();
      return;
    }
    e.results.push(b.rows);
    if (e.results.length < e.blocks) return;
    this.#queue.shift();
    e.resolve(e.results);
    if (!e.quiet) this.#pause();
  }
}
