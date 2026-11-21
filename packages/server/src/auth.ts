import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** Token login (spec §5.10, backlog B13). The token itself is never logged, echoed or stored. */
export const AUTH_COOKIE = 'kage_auth';
const COOKIE_LABEL = 'kage-auth-v1';
const MAX_AGE_S = 30 * 24 * 60 * 60;
const ATTRS = 'HttpOnly; SameSite=Strict; Path=/';

export const SIGN_IN = 'Sign in to Kage';

/** The cookie's value: base64url(HMAC-SHA256(key = token, 'kage-auth-v1')). It reveals nothing of the token. */
export function authCookieValue(token: string): string {
  return createHmac('sha256', token).update(COOKIE_LABEL).digest('base64url');
}

/** The Set-Cookie header for a successful login (Secure is added by the route over https only). */
export function setCookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${authCookieValue(token)}; ${ATTRS}; Max-Age=${MAX_AGE_S}`;
}

export const CLEAR_COOKIE = `${AUTH_COOKIE}=; ${ATTRS}; Max-Age=0`;

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Constant-time equality of two secrets of any length: both are hashed first, so
 * `timingSafeEqual` compares equal-length digests and the time says nothing about where they differ.
 */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** True when no token is set, or when the Cookie header holds the right `kage_auth` value. */
export function isAuthorised(token: string, cookieHeader: string | undefined): boolean {
  if (token === '') return true;
  if (!cookieHeader) return false;
  const expected = authCookieValue(token);
  let ok = false;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== AUTH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    // Every candidate is compared, so the time doesn't depend on which one matched.
    if (value !== '' && sameSecret(value, expected)) ok = true;
  }
  return ok;
}

const OPEN = new Set(['GET /api/auth', 'HEAD /api/auth', 'POST /api/login', 'POST /api/logout']);

/** With a token set, every /api/* route but `GET /api/auth`, `POST /api/login` and `POST /api/logout` needs the cookie. */
export function authGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (token === '' || OPEN.has(`${c.req.method} ${c.req.path}`)) return next();
    if (!isAuthorised(token, c.req.header('Cookie'))) return c.json({ error: SIGN_IN }, 401);
    await next();
  };
}

/**
 * Failed logins (ruling R31): `max` failures from one address within `windowMs` refuse that
 * address until its oldest failure leaves the window, and `globalMax` failures from all addresses
 * together refuse everyone. Only failures count. Memory is bounded: at most `max` timestamps per
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
    this.#prune(this.#all);
    if (this.#all.length >= this.#globalMax) return false;
    const list = this.#byKey.get(key);
    if (!list) return true;
    this.#prune(list);
    if (list.length === 0) {
      this.#byKey.delete(key);
      return true;
    }
    return list.length < this.#max;
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
