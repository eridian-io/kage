import { spawn as nodeSpawn } from 'node:child_process';
import { tmuxArgs } from './client.ts';

export type WatchEvent =
  | { type: 'windows-changed' }
  | { type: 'activity'; paneId: string }
  | { type: 'down' };

interface WatchedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(): boolean;
  on(event: 'exit' | 'error', fn: () => void): unknown;
}

export type SpawnFn = (cmd: string, args: string[]) => WatchedProcess;

const defaultSpawn: SpawnFn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

const WINDOW_EVENTS = new Set(['%window-add', '%window-close', '%unlinked-window-close']);
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Listens to one tmux control-mode client (`tmux -C attach`) and reports window changes and pane
 * output. It only reads: nothing is ever written to the client's stdin.
 */
export class TmuxWatcher {
  readonly #session: string;
  readonly #socket: string | null;
  readonly #spawn: SpawnFn;
  readonly #throttleMs: number;
  readonly #listeners = new Set<(e: WatchEvent) => void>();
  readonly #lastActivity = new Map<string, number>();
  #proc: WatchedProcess | null = null;
  #timer: NodeJS.Timeout | null = null;
  #backoff = BACKOFF_START_MS;
  #running = false;

  constructor(opts: {
    session: string;
    socket: string | null;
    spawn?: SpawnFn;
    throttleMs?: number;
  }) {
    this.#session = opts.session;
    this.#socket = opts.socket;
    this.#spawn = opts.spawn ?? defaultSpawn;
    this.#throttleMs = opts.throttleMs ?? 250;
  }

  on(fn: (e: WatchEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#launch();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const p = this.#proc;
    this.#proc = null;
    p?.kill();
    this.#lastActivity.clear();
  }

  #emit(e: WatchEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  #launch(): void {
    const args = tmuxArgs(this.#socket, ['-C', 'attach', '-t', this.#session]);
    const proc = this.#spawn('tmux', args);
    this.#proc = proc;
    let buf = '';
    let ended = false;
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        this.#line(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    proc.stderr?.on('data', () => {});
    const onEnd = () => {
      if (ended || this.#proc !== proc) return;
      ended = true;
      this.#proc = null;
      this.#emit({ type: 'down' });
      if (!this.#running) return;
      const delay = this.#backoff;
      this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (this.#running) this.#launch();
      }, delay);
    };
    proc.on('exit', onEnd);
    proc.on('error', onEnd);
  }

  #line(line: string): void {
    // Any control-mode line proves the attach worked: the next failure starts the backoff over.
    this.#backoff = BACKOFF_START_MS;
    const sp = line.indexOf(' ');
    const kind = sp < 0 ? line : line.slice(0, sp);
    if (WINDOW_EVENTS.has(kind)) {
      this.#emit({ type: 'windows-changed' });
    } else if (kind === '%output') {
      const rest = line.slice(sp + 1);
      const paneId = rest.slice(0, rest.indexOf(' ') < 0 ? rest.length : rest.indexOf(' '));
      if (!paneId.startsWith('%')) return;
      const now = Date.now();
      const last = this.#lastActivity.get(paneId);
      if (last !== undefined && now - last < this.#throttleMs) return;
      this.#lastActivity.set(paneId, now);
      this.#emit({ type: 'activity', paneId });
    }
  }
}
