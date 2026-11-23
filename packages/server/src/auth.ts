import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { MiddlewareHandler } from 'hono';

/**
 * Token login with per-login sessions (spec §5.10; security I1, B20, B50). The token itself is
 * never logged, echoed or stored, and neither is a session id: the server keeps only its SHA-256.
 */
export const SIGN_IN = 'Sign in to Kage';

/** A session ends after 7 days without a request. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session ends 30 days after its login, however often it is used. */
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many sessions; a new login drops the least recently seen one. */
export const SESSION_MAX = 64;

const MAX_AGE_S = SESSION_MAX_MS / 1000;
const ATTRS = 'HttpOnly; SameSite=Strict; Path=/';
/** A session id as create() makes it: 32 random bytes, base64url. */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
/** setTimeout's longest delay. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The cookie's name carries the port (`kage_auth_8080`), so another port on the host can't confuse it. */
export function authCookieName(port: number): string {
  return `kage_auth_${port}`;
}

/** The TCP peer's address as sessions compare it: an IPv4-mapped IPv6 address is its IPv4. */
export function normalizePeer(address: string): string {
  const a = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? (mapped[1] as string) : a;
}

/**
 * The key the per-address limits count by (the login limiter, the stream cap, the connection
 * cap). An IPv4 address counts as it is. A Tailscale IPv6 address (fd7a:115c:a1e0::/48) counts
 * by its full /128: every tailnet node shares that prefix, and WireGuard authenticates each
 * node's source address, so a node can't pick another's. Any other IPv6 address counts by its
 * /64 (`2001:db8:1:2::/64`): a host on an ordinary network may pick any address in its /64, so
 * counting each address alone would let it multiply every limit. Sessions stay bound to the
 * exact address (normalizePeer).
 */
export function peerKey(address: string): string {
  const a = normalizePeer(address).replace(/%.*$/, '');
  if (!a.includes(':')) return a;
  const groups = ipv6Groups(a);
  if (groups === null) return a;
  const hex = groups.map((g) => g.toString(16));
  if (groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0) return hex.join(':');
  return `${hex.slice(0, 4).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (`::` and an IPv4 tail expanded), or null. */
function ipv6Groups(a: string): number[] | null {
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const split = (part: string): string[] | null => {
    if (part === '') return [];
    const out: string[] = [];
    const items = part.split(':');
    for (const [i, g] of items.entries()) {
      if (!g.includes('.')) {
        out.push(g);
        continue;
      }
      // An IPv4 tail (64:ff9b::1.2.3.4) is the last two groups.
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      if (!v4 || i !== items.length - 1) return null;
      const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
      if ([b0, b1, b2, b3].some((b) => b > 255)) return null;
      out.push(((b0 << 8) | b1).toString(16), ((b2 << 8) | b3).toString(16));
    }
    return out;
  };
  const left = split(parts[0] as string);
  const right = parts.length === 2 ? split(parts[1] as string) : [];
  if (left === null || right === null) return null;
  const fill = parts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (parts.length === 2 && fill === 0)) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Constant-time equality of two secrets of any length: both are hashed first, so
 * `timingSafeEqual` compares equal-length digests and the time says nothing about where they differ.
 */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

interface Entry {
  /** SHA-256 of the session id. */
  hash: Buffer;
  /** The address that signed in (normalised). */
  peer: string;
  /** When it signed in, on the wall clock. */
  created: number;
  /** When it was last seen, on the monotonic clock. */
  seen: number;
}

export interface SessionStoreOptions {
  idleMs?: number;
  maxAgeMs?: number;
  max?: number;
  /**
   * The idle limit's clock, monotonic (default `performance.now`): a wall-clock jump can't
   * revive or end an idle session. It stands still while the host sleeps.
   */
  clock?: () => number;
  /**
   * The 30-day limit's clock, the wall clock (default `Date.now`), so the time a host spends
   * asleep counts toward it. A clock set back (which takes root) can stretch it.
   */
  wallClock?: () => number;
}

/**
 * The logins, in memory only (ruling R127): a restart signs every browser out, because the leak
 * in I1 happens while Kage is down, and a session that survived the restart would be the one a
 * port squatter caught. Each session is bound to the address that signed in.
 *
 * Every way a session ends fires `onRevoke` (F6): sign-out, eviction of the least recently seen
 * at `max`, and expiry. Expiry is found at every `create`, `check` and `has`, and by one timer set
 * for the earliest moment a session can expire, held only while there are sessions (spec §5.5),
 * so an expired session's streams and terminals close even when no request comes.
 */
export class SessionStore {
  readonly #idleMs: number;
  readonly #maxAgeMs: number;
  readonly #max: number;
  readonly #clock: () => number;
  readonly #wallClock: () => number;
  /** By key (the id's SHA-256, base64url); Map order is least recently seen first. */
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(key: string) => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: SessionStoreOptions = {}) {
    this.#idleMs = o.idleMs ?? SESSION_IDLE_MS;
    this.#maxAgeMs = o.maxAgeMs ?? SESSION_MAX_MS;
    this.#max = o.max ?? SESSION_MAX;
    this.#clock = o.clock ?? (() => performance.now());
    this.#wallClock = o.wallClock ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** A new session for `peer`. Returns the raw id for the cookie; only its SHA-256 is kept. */
  create(peer: string): string {
    this.#sweep();
    while (this.#entries.size >= this.#max) {
      this.revoke(this.#entries.keys().next().value as string);
    }
    const id = randomBytes(32).toString('base64url');
    const hash = digest(id);
    this.#entries.set(hash.toString('base64url'), {
      hash,
      peer,
      created: this.#wallClock(),
      seen: this.#clock(),
    });
    this.#arm();
    return id;
  }

  /**
   * The session's key when `id` names a live session that signed in from `peer`, else null. A
   * live match counts as seen. The id's hash is compared with every session's in constant time.
   */
  check(id: string, peer: string): string | null {
    this.#sweep();
    if (!SESSION_ID.test(id)) return null;
    const hash = digest(id);
    let found: string | null = null;
    for (const [key, e] of this.#entries) {
      // No early exit: the time doesn't depend on which session matched.
      if (timingSafeEqual(e.hash, hash)) found = key;
    }
    if (found === null) return null;
    const e = this.#entries.get(found) as Entry;
    if (e.peer !== peer) return null;
    e.seen = this.#clock();
    // Re-inserted, so Map order stays least recently seen first.
    this.#entries.delete(found);
    this.#entries.set(found, e);
    return found;
  }

  /** True while the session `key` is live. It doesn't count as seen. */
  has(key: string): boolean {
    this.#sweep();
    return this.#entries.has(key);
  }

  /** Ends the session `key`, if it is live, and tells every onRevoke listener once. */
  revoke(key: string): void {
    if (!this.#entries.delete(key)) return;
    if (this.#entries.size === 0) this.#disarm();
    for (const fn of [...this.#listeners]) fn(key);
  }

  /** Called with the key of every session that ends, however it ends. Returns the unsubscriber. */
  onRevoke(fn: (key: string) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Milliseconds until the session expires, by the nearer of its two limits; ≤ 0 once expired. */
  #left(e: Entry, mono: number, wall: number): number {
    return Math.min(e.seen + this.#idleMs - mono, e.created + this.#maxAgeMs - wall);
  }

  /** Revokes every expired session. */
  #sweep(): void {
    const mono = this.#clock();
    const wall = this.#wallClock();
    for (const [key, e] of [...this.#entries]) if (this.#left(e, mono, wall) <= 0) this.revoke(key);
  }

  /** Sets the timer for the earliest deadline, unless one is set; a timer that fires early re-arms. */
  #arm(): void {
    if (this.#timer !== null || this.#entries.size === 0) return;
    const mono = this.#clock();
    const wall = this.#wallClock();
    let next = Number.POSITIVE_INFINITY;
    for (const e of this.#entries.values()) next = Math.min(next, this.#left(e, mono, wall));
    const delay = Math.min(Math.max(Math.ceil(next), 1), MAX_DELAY_MS);
    const t = setTimeout(() => {
      this.#timer = null;
      this.#sweep();
      this.#arm();
    }, delay);
    t.unref?.();
    this.#timer = t;
  }

  #disarm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** What the routes and the terminal need to know about logins. */
export interface Auth {
  /** The config's access token; '' means no login (spec §5.10). */
  token: string;
  sessions: SessionStore;
  /** The cookie's name: authCookieName(port). */
  cookie: string;
}

/**
 * '' (open) when no token is set; else the session key the Cookie header names for `peer`, or
 * null. Every cookie of that name is checked, so the time doesn't depend on which one matched.
 */
export function sessionOf(
  auth: Auth,
  cookieHeader: string | undefined,
  peer: string,
): string | null {
  if (auth.token === '') return '';
  if (!cookieHeader) return null;
  let key: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== auth.cookie) continue;
    const value = part.slice(eq + 1).trim();
    if (value === '') continue;
    const k = auth.sessions.check(value, peer);
    if (k !== null && key === null) key = k;
  }
  return key;
}

/** The Set-Cookie header for a new login. `secure` (the request came over https) adds Secure. */
export function setCookieHeader(name: string, id: string, secure: boolean): string {
  return `${name}=${id}; ${ATTRS}; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie header that removes the cookie (sign-out). */
export function clearCookieHeader(name: string): string {
  return `${name}=; ${ATTRS}; Max-Age=0`;
}

/**
 * The TCP peer's address, normalised, from @hono/node-server's `env.incoming` (or a Node
 * request's socket: pass `{ incoming: req }`); never from a header, which the client controls.
 * Requests without a socket (tests calling fetch directly) share one key.
 */
export function remoteAddress(env: unknown): string {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const a = incoming?.socket?.remoteAddress;
  return a ? normalizePeer(a) : 'unknown';
}

/** The routes' variables: `session` is the session key the guard found ('' when open). */
export type AuthEnv = { Variables: { session: string } };

const OPEN = new Set(['GET /api/auth', 'HEAD /api/auth', 'POST /api/login', 'POST /api/logout']);

/**
 * With a token set, every /api/* route but `GET /api/auth`, `POST /api/login` and
 * `POST /api/logout` needs a live session from the requesting address. The session's key goes to
 * the route as `c.get('session')` ('' when no token is set, or on an open route).
 */
export function authGuard(auth: Auth): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (auth.token === '' || OPEN.has(`${c.req.method} ${c.req.path}`)) {
      c.set('session', '');
      return next();
    }
    const key = sessionOf(auth, c.req.header('Cookie'), remoteAddress(c.env));
    if (key === null) return c.json({ error: SIGN_IN }, 401);
    c.set('session', key);
    await next();
  };
}

/**
 * Failed logins (ruling R31): `max` failures from one address within `windowMs` refuse that
 * address until its oldest failure leaves the window, and `globalMax` failures from all addresses
 * together refuse every address that has failed within the window. An address with no failure in
 * the window always gets its try (security M2): other peers' failures can't lock the owner out.
 * While the ceiling is full, each address that hasn't failed still gets one guess a window, so
 * the rate grows with the addresses an attacker holds; app.ts keys by peerKey. Only
 * failures count. Memory is bounded: at most `max` timestamps per
 * address, `globalMax` overall, and `maxKeys` addresses (the least recently failed goes first).
 * allow() and fail() are synchronous, so a caller that runs them with no await in between can't
 * be raced by parallel requests.
 */
export class LoginLimiter {
  readonly #max: number;
  readonly #globalMax: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #byKey = new Map<string, number[]>();
  readonly #all: number[] = [];

  constructor(
    opts: {
      max?: number;
      globalMax?: number;
      windowMs?: number;
      maxKeys?: number;
      now?: () => number;
    } = {},
  ) {
    this.#max = opts.max ?? 5;
    this.#globalMax = opts.globalMax ?? 30;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#maxKeys = opts.maxKeys ?? 1000;
    this.#now = opts.now ?? Date.now;
  }

  #prune(list: number[]): void {
    const since = this.#now() - this.#windowMs;
    while (list.length > 0 && (list[0] as number) <= since) list.shift();
  }

  /** The number of addresses held (test hook: it never exceeds `maxKeys`). */
  get size(): number {
    return this.#byKey.size;
  }

  allow(key: string): boolean {
    const list = this.#byKey.get(key);
    if (!list) return true;
    this.#prune(list);
    if (list.length === 0) {
      this.#byKey.delete(key);
      return true;
    }
    if (list.length >= this.#max) return false;
    this.#prune(this.#all);
    return this.#all.length < this.#globalMax;
  }

  fail(key: string): void {
    const t = this.#now();
    this.#prune(this.#all);
    this.#all.push(t);
    if (this.#all.length > this.#globalMax) this.#all.shift();
    const list = this.#byKey.get(key) ?? [];
    this.#prune(list);
    list.push(t);
    if (list.length > this.#max) list.shift();
    // Re-inserted, so Map order is least recently failed first.
    this.#byKey.delete(key);
    this.#byKey.set(key, list);
    while (this.#byKey.size > this.#maxKeys) {
      const oldest = this.#byKey.keys().next().value as string;
      this.#byKey.delete(oldest);
    }
  }
}
