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

const OPEN = new Set(['GET /api/auth', 'HEAD /api/auth', 'POST /api/login']);

/** With a token set, every /api/* route but `GET /api/auth` and `POST /api/login` needs the cookie. */
export function authGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (token === '' || OPEN.has(`${c.req.method} ${c.req.path}`)) return next();
    if (!isAuthorised(token, c.req.header('Cookie'))) return c.json({ error: SIGN_IN }, 401);
    await next();
  };
}

/**
 * Failed logins, globally: `max` failures within `windowMs` refuse further tries until the oldest
 * leaves the window. Only failures count, and it keeps at most `max` timestamps.
 */
export class LoginLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #failures: number[] = [];

  constructor(opts: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = opts.max ?? 5;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  #prune(): void {
    const since = this.#now() - this.#windowMs;
    while (this.#failures.length > 0 && (this.#failures[0] as number) <= since) {
      this.#failures.shift();
    }
  }

  /** The number of failures held (test hook: it never exceeds `max`). */
  get size(): number {
    return this.#failures.length;
  }

  allow(): boolean {
    this.#prune();
    return this.#failures.length < this.#max;
  }

  fail(): void {
    this.#prune();
    this.#failures.push(this.#now());
    if (this.#failures.length > this.#max) this.#failures.shift();
  }
}
