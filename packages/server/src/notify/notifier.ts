/**
 * The notifier (N3): when to ping the owner's phone. It follows the source's transitions and
 * their cause (ADR 0001): only a live transition pings. A live move into needs-you is pinged
 * after a short hold (a prompt answered at the board sends nothing), once per episode and then
 * not again for `quietMs`; with `onDone`, a live move into done from running is pinged too when
 * the stretch began `doneAfterMs` or more ago (never for ended, nor for needs-you → done, which
 * is No or Esc at the board: both are the user's own act, R84). The stretch begins at a live or
 * act move from off the board, done or ended into running or needs-you, so a prompt inside it
 * counts; a reconcile move never begins one, so a restart or a reattach pings nothing (R141,
 * Q17). At most `maxPerWindow` pings go in any `windowMs`.
 *
 * Event driven: no polling. Its only timers are one per session (the hold, or the wait for the
 * quiet period's end of a deferred needs-you, R94) and, while the window is full, one for the
 * "skipped" line; idle, it owns none (spec §5.5, PF5 F16).
 */
import type { Session, SessionStatus, Transition } from '@kage/shared';
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
  /** Bumped on every transition: a hold or a retry belongs to one episode. */
  episode: number;
  /**
   * When the stretch began: a live or act move from off the board, done or ended into running
   * or needs-you. Kept between running and needs-you; null after done or ended, and after a
   * reconcile move that would have begun one.
   */
  activeFrom: number | null;
  lastPingAt: number | null;
  hold: ReturnType<typeof setTimeout> | null;
}

const isActive = (s: SessionStatus | null) => s === 'running' || s === 'needs-you';

export class Notifier {
  readonly #source: Pick<SessionSource, 'get' | 'subscribe'>;
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

  constructor(d: {
    source: Pick<SessionSource, 'get' | 'subscribe'>;
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

  /**
   * Subscribes; serve calls it before `source.start()`. The start's moves are reconcile, so
   * sessions already waiting ping nothing, while hook events replayed once the source is ready
   * are live and ping (the startup gap).
   */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#source.subscribe((e) => this.#onEvent(e));
  }

  /** Clears holds; with nothing pending it owns no timer. */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const t of this.#sessions.values()) if (t.hold) clearTimeout(t.hold);
    this.#sessions.clear();
    this.#flushSkipped();
  }

  #onEvent(e: SourceEvent): void {
    if (e.type === 'session.removed') {
      const t = this.#sessions.get(e.id);
      if (t?.hold) clearTimeout(t.hold);
      this.#sessions.delete(e.id);
      return;
    }
    if (e.type === 'session.transition') this.#onTransition(e.transition);
  }

  /**
   * Every transition is a new episode (a pending hold is dropped); only a live one may hold.
   * It reads nothing but the transition and, for a done, whether the session is external (a
   * stable field); the ping text is read when the hold ends.
   */
  #onTransition({ id, from, to, cause }: Transition): void {
    const now = this.#clock();
    let t = this.#sessions.get(id);
    if (t === undefined) {
      t = { status: to, episode: 0, activeFrom: null, lastPingAt: null, hold: null };
      this.#sessions.set(id, t);
    } else {
      t.status = to;
      t.episode += 1;
      if (t.hold) {
        clearTimeout(t.hold);
        t.hold = null;
      }
    }
    const activeFor = t.activeFrom === null ? null : now - t.activeFrom;
    if (!isActive(to)) t.activeFrom = null;
    else if (!isActive(from)) t.activeFrom = cause === 'reconcile' ? null : now;
    if (cause !== 'live') return;
    if (to === 'needs-you') {
      this.#hold(id, t, 'needs-you');
    } else if (
      to === 'done' &&
      this.#o.onDone &&
      from === 'running' &&
      activeFor !== null &&
      activeFor >= this.#o.doneAfterMs &&
      this.#source.get(id)?.external === false
    ) {
      this.#hold(id, t, 'done');
    }
  }

  /**
   * Waits holdMs, then pings if the session is still in this episode (F3a for done). A
   * needs-you episode that ends its hold inside the quiet period is deferred, not dropped
   * (R94): the same timer slot waits for the quiet period's end and checks again. A done
   * ping inside the quiet period is dropped. The text comes from the session as it is then
   * (its project and task, or the fixed text if external); a session that is gone sends nothing.
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
      const s = this.#source.get(id);
      if (s === undefined) return;
      const now = this.#clock();
      if (t.lastPingAt !== null && now - t.lastPingAt < this.#o.quietMs) {
        if (kind === 'needs-you') t.hold = setTimeout(fire, t.lastPingAt + this.#o.quietMs - now);
        return;
      }
      if (!this.#windowAllows(now)) return;
      t.lastPingAt = now;
      this.#sentAt.push(now);
      const link = this.#link(id);
      const ping = s.external ? externalPing(this.#host, link) : pingFor(kind, s, link);
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
