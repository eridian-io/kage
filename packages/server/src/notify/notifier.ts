/**
 * The notifier (N3): when to ping the owner's phone. A session that moves into needs-you is
 * pinged after a short hold (a prompt answered at the board sends nothing), once per episode and
 * then not again for `quietMs`; with `onDone`, a session that worked for `doneAfterMs` or more
 * and stopped is pinged too, only from running (never for ended, nor for needs-you → done,
 * which is No or Esc at the board: both are the user's own act, R84). The active time counts
 * from the start of the active stretch, so a prompt inside it counts. At most
 * `maxPerWindow` pings go in any `windowMs`.
 *
 * Event driven: no polling. Its only timers are one per session (the hold, or the wait for the
 * quiet period's end of a deferred needs-you, R94) and, while the window is full, one for the
 * "skipped" line; idle, it owns none (spec §5.5, PF5 F16).
 */
import type { Session, SessionStatus } from '@kage/shared';
import type { SessionSource, SourceEvent } from '../source.ts';
import { type Ping, pingText } from './ntfy.ts';

export interface NotifierOptions {
  onDone: boolean;
  holdMs: number;
  quietMs: number;
  doneAfterMs: number;
  maxPerWindow: number;
  windowMs: number;
}

export const NOTIFY_DEFAULTS: NotifierOptions = {
  onDone: false,
  holdMs: 3000,
  quietMs: 120_000,
  doneAfterMs: 60_000,
  maxPerWindow: 10,
  windowMs: 600_000,
};

type Kind = 'needs-you' | 'done';

/**
 * A ping's content (N2): the project, the status and the task text, stripped and cut by
 * `pingText`, and the board link. It takes nothing else, so the question, a command, the
 * branch or a path can't reach it.
 */
export function pingFor(
  kind: Kind,
  s: Pick<Session, 'id' | 'project' | 'task'>,
  link: string | null,
): Ping {
  const title = pingText(kind === 'done' ? `${s.project} is done` : `${s.project} needs you`);
  const message = pingText(s.task);
  return {
    title,
    message: message === '' ? title : message,
    priority: kind === 'done' ? 3 : 4,
    click: link,
  };
}

/**
 * An external window's ping (F3b): fixed text only. Its project and task are the cwd and tmux
 * window name, which may be a command, a host name or a path.
 */
function externalPing(host: string, link: string | null): Ping {
  return {
    title: 'Claude needs you',
    message: pingText(`A Claude session needs you on ${host}`),
    priority: 4,
    click: link,
  };
}

/** `http://host:port/#s=<id>`; `host` is a name or a bracketed IPv6 address. */
export function boardLink(host: string, port: number, id: string): string {
  return `http://${host}:${port}/#s=${encodeURIComponent(id)}`;
}

interface Tracked {
  status: SessionStatus;
  /** Bumped on every status change: a hold or a retry belongs to one episode. */
  episode: number;
  /** When the current active stretch began (first sighting, or leaving done or ended); null while not active. */
  activeFrom: number | null;
  lastPingAt: number | null;
  hold: ReturnType<typeof setTimeout> | null;
  project: string;
  task: string;
  external: boolean;
}

const isActive = (s: SessionStatus) => s === 'running' || s === 'needs-you';

export class Notifier {
  readonly #source: Pick<SessionSource, 'list' | 'subscribe'>;
  readonly #send: (p: Ping, stillWanted: () => boolean) => Promise<boolean>;
  readonly #link: (id: string) => string | null;
  readonly #host: string;
  readonly #o: NotifierOptions;
  readonly #clock: () => number;
  readonly #log: (line: string) => void;
  readonly #sessions = new Map<string, Tracked>();
  /** Send times inside the current window, oldest first; at most maxPerWindow entries. */
  readonly #sentAt: number[] = [];
  #skipped = 0;
  #skipTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  /** Between listen() and seeded(): updates are recorded, never pinged. */
  #seeding = false;

  constructor(d: {
    source: Pick<SessionSource, 'list' | 'subscribe'>;
    send: (p: Ping, stillWanted: () => boolean) => Promise<boolean>;
    link: (id: string) => string | null;
    /** The name in an external session's fixed text (cfg.name). */
    hostName: string;
    options: NotifierOptions;
    /**
     * Monotonic ms (M2: default performance.now) for the hold, the quiet period, lastPingAt and
     * the rate window, so a wall clock stepped back delays no ping. Nothing here shows a time.
     */
    clock?: () => number;
    log: (line: string) => void;
  }) {
    this.#source = d.source;
    this.#send = d.send;
    this.#link = d.link;
    this.#host = d.hostName;
    this.#o = d.options;
    this.#clock = d.clock ?? (() => performance.now());
    this.#log = d.log;
  }

  /** Seeds statuses from list(): nothing already waiting is pinged. */
  start(): void {
    if (this.#unsubscribe) return;
    const now = this.#clock();
    for (const s of this.#source.list()) this.#sessions.set(s.id, this.#track(s, now));
    this.#unsubscribe = this.#source.subscribe((e) => this.#onEvent(e));
  }

  /**
   * Subscribes before the source has started, in seeding mode: updates only record each
   * session's status, so the source's first emits (sessions already waiting) ping nothing.
   * `seeded()` ends it, before the source replays hook events that came in while it loaded:
   * those are real changes and are pinged (the startup gap).
   */
  listen(): void {
    if (this.#unsubscribe) return;
    this.#seeding = true;
    this.#unsubscribe = this.#source.subscribe((e) => this.#onEvent(e));
  }

  seeded(): void {
    this.#seeding = false;
  }

  /** Clears holds; with nothing pending it owns no timer. */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const t of this.#sessions.values()) if (t.hold) clearTimeout(t.hold);
    this.#sessions.clear();
    this.#flushSkipped();
  }

  #track(s: Session, now: number): Tracked {
    return {
      status: s.status,
      episode: 0,
      activeFrom: isActive(s.status) ? now : null,
      lastPingAt: null,
      hold: null,
      project: s.project,
      task: s.task,
      external: s.external,
    };
  }

  #onEvent(e: SourceEvent): void {
    if (e.type === 'session.removed') {
      const t = this.#sessions.get(e.id);
      if (t?.hold) clearTimeout(t.hold);
      this.#sessions.delete(e.id);
      return;
    }
    if (e.type !== 'session.updated') return;
    const s = e.session;
    const now = this.#clock();
    let t = this.#sessions.get(s.id);
    if (this.#seeding) {
      // Seeding: the state as the source loaded it, with no hold.
      if (t?.hold) clearTimeout(t.hold);
      this.#sessions.set(s.id, this.#track(s, now));
      return;
    }
    if (t === undefined) {
      // A first sighting after start: needs-you is an episode of its own.
      t = this.#track(s, now);
      this.#sessions.set(s.id, t);
      if (s.status === 'needs-you') this.#hold(s.id, t, 'needs-you');
      return;
    }
    t.project = s.project;
    t.task = s.task;
    t.external = s.external;
    if (s.status === t.status) return;
    const from = t.status;
    const activeFor = t.activeFrom === null ? 0 : now - t.activeFrom;
    t.status = s.status;
    t.episode += 1;
    if (t.hold) {
      clearTimeout(t.hold);
      t.hold = null;
    }
    if (isActive(s.status)) {
      if (t.activeFrom === null) t.activeFrom = now;
    } else {
      t.activeFrom = null;
    }
    if (s.status === 'needs-you') {
      this.#hold(s.id, t, 'needs-you');
    } else if (
      s.status === 'done' &&
      this.#o.onDone &&
      from === 'running' &&
      activeFor >= this.#o.doneAfterMs &&
      !t.external
    ) {
      this.#hold(s.id, t, 'done');
    }
  }

  /**
   * Waits holdMs, then pings if the session is still in this episode (F3a for done). A
   * needs-you episode that ends its hold inside the quiet period is deferred, not dropped
   * (R94): the same timer slot waits for the quiet period's end and checks again. A done
   * ping inside the quiet period is dropped.
   */
  #hold(id: string, t: Tracked, kind: Kind): void {
    const episode = t.episode;
    const wanted = () => {
      const cur = this.#sessions.get(id);
      return cur === t && cur.episode === episode && cur.status === kind;
    };
    const fire = () => {
      t.hold = null;
      if (!wanted()) return;
      const now = this.#clock();
      if (t.lastPingAt !== null && now - t.lastPingAt < this.#o.quietMs) {
        if (kind === 'needs-you') t.hold = setTimeout(fire, t.lastPingAt + this.#o.quietMs - now);
        return;
      }
      if (!this.#windowAllows(now)) return;
      t.lastPingAt = now;
      this.#sentAt.push(now);
      const link = this.#link(id);
      const ping = t.external
        ? externalPing(this.#host, link)
        : pingFor(kind, { id, project: t.project, task: t.task }, link);
      this.#send(ping, wanted).catch(() => {});
    };
    t.hold = setTimeout(fire, this.#o.holdMs);
  }

  /** Drops send times older than the window; counts a skip and arms the line's timer if full. */
  #windowAllows(now: number): boolean {
    while (this.#sentAt.length > 0 && now - (this.#sentAt[0] ?? 0) >= this.#o.windowMs) {
      this.#sentAt.shift();
    }
    if (this.#sentAt.length < this.#o.maxPerWindow) return true;
    this.#skipped += 1;
    if (this.#skipTimer === null) {
      // One line per window: when the oldest ping leaves it, say how many were skipped.
      const wait = (this.#sentAt[0] ?? now) + this.#o.windowMs - now;
      this.#skipTimer = setTimeout(() => this.#flushSkipped(), wait);
    }
    return false;
  }

  #flushSkipped(): void {
    if (this.#skipTimer) clearTimeout(this.#skipTimer);
    this.#skipTimer = null;
    if (this.#skipped === 0) return;
    const n = this.#skipped;
    this.#skipped = 0;
    try {
      this.#log(`ntfy: too many pings; skipped ${n}.`);
    } catch {
      // a broken log must not break the notifier
    }
  }
}
