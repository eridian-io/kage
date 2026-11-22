import { spawn as nodeSpawn } from 'node:child_process';
import { type TmuxTarget, tmuxArgs } from './client.ts';

export type WatchEvent =
  | { type: 'windows-changed' }
  | { type: 'activity'; paneId: string }
  | { type: 'up' }
  | { type: 'down' };

export interface WatchedProcess {
  /** Present with the default spawn; the watcher never writes to it (the terminal client does). */
  stdin?: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(): boolean;
  on(event: 'exit' | 'error', fn: () => void): unknown;
}

export type SpawnFn = (cmd: string, args: string[]) => WatchedProcess;

export const defaultSpawn: SpawnFn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

/** A tmux pane id as `%output` prints it. */
const PANE_ID = /^%\d+$/;
const WINDOW_EVENTS = new Set(['%window-add', '%window-close', '%unlinked-window-close']);
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Listens to one tmux control-mode client (`tmux -C attach`) and reports window changes and pane
 * output. It only reads: nothing is ever written to the client's stdin.
 */
export class TmuxWatcher {
  readonly #session: string;
  readonly #target: TmuxTarget;
  readonly #beforeLaunch: (() => Promise<void>) | undefined;
  #gen = 0;
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
    configFile?: string;
    beforeLaunch?: () => Promise<void>;
    spawn?: SpawnFn;
    throttleMs?: number;
  }) {
    this.#session = opts.session;
    this.#target = { socket: opts.socket, configFile: opts.configFile };
    this.#beforeLaunch = opts.beforeLaunch;
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
    this.#gen++;
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

  #retryLater(): void {
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#running) this.#launch();
    }, delay);
  }

  #launch(): void {
    if (!this.#beforeLaunch) {
      this.#spawnClient();
      return;
    }
    const gen = this.#gen;
    this.#beforeLaunch().then(
      () => {
        if (this.#running && gen === this.#gen) this.#spawnClient();
      },
      () => {
        if (!this.#running || gen !== this.#gen) return;
        this.#emit({ type: 'down' });
        this.#retryLater();
      },
    );
  }

  #spawnClient(): void {
    let first = true;
    const args = tmuxArgs(this.#target, ['-C', 'attach', '-t', `=${this.#session}`]);
    const proc = this.#spawn('tmux', args);
    this.#proc = proc;
    let buf = '';
    let ended = false;
    // Decode as UTF-8 across chunks: a character split between two reads must stay whole.
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      // A client that outlives stop() (or a replaced one) must not report anything.
      if (!this.#running || this.#proc !== proc) return;
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        if (first) {
          first = false;
          this.#emit({ type: 'up' });
        }
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
      this.#retryLater();
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
      if (!PANE_ID.test(paneId)) return;
      const now = performance.now();
      const last = this.#lastActivity.get(paneId);
      if (last !== undefined && now - last < this.#throttleMs) return;
      this.#lastActivity.set(paneId, now);
      this.#emit({ type: 'activity', paneId });
    }
  }
}
