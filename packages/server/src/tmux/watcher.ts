import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { EXEC_OPTIONS, type TmuxTarget, tmuxArgs } from './client.ts';

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
/** Re-attaches to a live server without a control-mode line in between: this many in… */
const REATTACH_MAX = 3;
/** …this long count as the server down, so a client tmux keeps refusing can't spin (I1). */
const REATTACH_WINDOW_MS = 10_000;
/**
 * A client that stayed attached this long was really attached: the re-attach count and the
 * backoff start over when it ends. A client tmux refuses can print a few lines (`%begin`,
 * `%exit`) first, so lines alone don't prove it (Task 10, from Task 6's review).
 */
const ATTACHED_MS = 1000;
/** While the attached server's pid isn't known, a later line asks again, at most this often. */
const PID_RETRY_MS = 1000;
const PID = /^\d+$/;

/**
 * The pid of the tmux server when it holds a session named exactly `session`, or null when
 * there is no server or no such session (within EXEC_OPTIONS' 5 s). It reads `list-sessions`:
 * `display-message -t =<session>` prints the pid, exit 0, even when the session is gone
 * (tmux 3.4, host-integration §2).
 */
export function serverPid(target: TmuxTarget, session: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      tmuxArgs(target, ['list-sessions', '-F', '#{session_name}\t#{pid}']),
      { timeout: EXEC_OPTIONS.timeout },
      (err, stdout) => {
        if (err) return resolve(null);
        for (const line of String(stdout).split('\n')) {
          const [name, pid = ''] = line.replace(/\r$/, '').split('\t');
          if (name === session && PID.test(pid)) return resolve(pid);
        }
        resolve(null);
      },
    );
  });
}

/**
 * Listens to one tmux control-mode client (`tmux -C attach`) and reports window changes and pane
 * output. It only reads: nothing is ever written to the client's stdin.
 *
 * A client can end while the server lives: `tmux attach -d` or `detach-client -a` at the PC, or
 * tmux dropping a client that fell behind (reliability I1). So an ended client first asks
 * `serverPid()`: with the session still held by the same server (the pid noted at the client's
 * first line) it re-attaches at once and says nothing until the new client's first line, which
 * emits `up` (a resync). `down` means the server or the session is gone, a new server holds the
 * name (another pid: its pane and window ids start over), or tmux refused REATTACH_MAX
 * re-attaches in a row; the next try backs off.
 */
export class TmuxWatcher {
  readonly #session: string;
  readonly #target: TmuxTarget;
  readonly #beforeLaunch: (() => Promise<void>) | undefined;
  readonly #serverPid: () => Promise<string | null>;
  /** The server pid noted at the current client's first line; null when not known. */
  #pid: string | null = null;
  /** A pid lookup is in flight, and when the last one began (monotonic ms). */
  #pidAsking = false;
  #pidAskedAt = Number.NEGATIVE_INFINITY;
  /** Monotonic times of the re-attaches since a client last stayed attached ATTACHED_MS. */
  #reattaches: number[] = [];
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
    /** The pid of the server holding the session, or null (default: serverPid()). */
    serverPid?: () => Promise<string | null>;
    spawn?: SpawnFn;
    throttleMs?: number;
  }) {
    this.#session = opts.session;
    this.#target = { socket: opts.socket, configFile: opts.configFile };
    this.#beforeLaunch = opts.beforeLaunch;
    this.#serverPid = opts.serverPid ?? (() => serverPid(this.#target, this.#session));
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
    this.#reattaches = [];
    this.#launch();
  }

  stop(): void {
    this.#running = false;
    this.#gen++;
    this.#reattaches = [];
    this.#pid = null;
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
    const since = performance.now();
    const gen = this.#gen;
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
          this.#notePid(gen);
          this.#emit({ type: 'up' });
        } else if (this.#pid === null && !this.#pidAsking) {
          // The first ask found no pid: ask again at a later line, at most once a second.
          if (performance.now() - this.#pidAskedAt >= PID_RETRY_MS) this.#notePid(gen);
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
      if (!this.#running) return;
      if (performance.now() - since >= ATTACHED_MS) {
        // It was attached: the next failure starts the count and the backoff over.
        this.#reattaches = [];
        this.#backoff = BACKOFF_START_MS;
      }
      this.#ended();
    };
    proc.on('exit', onEnd);
    proc.on('error', onEnd);
  }

  /**
   * The attached server's pid, asked at each client's first line, and again at a later line
   * (at most once per PID_RETRY_MS) while it isn't known.
   */
  #notePid(gen: number): void {
    this.#pidAsking = true;
    this.#pidAskedAt = performance.now();
    this.#serverPid().then(
      (pid) => {
        this.#pidAsking = false;
        if (this.#running && gen === this.#gen && pid !== null) this.#pid = pid;
      },
      () => {
        this.#pidAsking = false;
      },
    );
  }

  /** A client ended while running: re-attach to the same live server, else report it down. */
  #ended(): void {
    const gen = this.#gen;
    const decide = (pid: string | null) => {
      if (!this.#running || gen !== this.#gen) return;
      const now = performance.now();
      this.#reattaches = this.#reattaches.filter((t) => now - t < REATTACH_WINDOW_MS);
      // Another pid is a new server under the same name: its ids start over, so it is a down.
      const same = pid !== null && (this.#pid === null || pid === this.#pid);
      if (same && this.#reattaches.length < REATTACH_MAX) {
        this.#reattaches.push(now);
        this.#pid = pid;
        this.#spawnClient();
        return;
      }
      this.#pid = null;
      this.#emit({ type: 'down' });
      this.#retryLater();
    };
    this.#serverPid().then(decide, () => decide(null));
  }

  #line(line: string): void {
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
