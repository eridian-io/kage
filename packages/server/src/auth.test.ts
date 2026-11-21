import { describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE,
  authCookieValue,
  CLEAR_COOKIE,
  isAuthorised,
  LoginLimiter,
  setCookieHeader,
} from './auth.ts';

const TOKEN = 'correct-horse-battery-staple';
const OTHER = 'another-token-of-16+';

describe('authCookieValue', () => {
  it('is base64url, stable per token, and never contains the token', () => {
    const v = authCookieValue(TOKEN);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authCookieValue(TOKEN)).toBe(v);
    expect(authCookieValue(OTHER)).not.toBe(v);
    expect(v).not.toContain(TOKEN);
    expect(setCookieHeader(TOKEN)).not.toContain(TOKEN);
  });

  it('builds the cookie headers exactly', () => {
    expect(setCookieHeader(TOKEN)).toBe(
      `kage_auth=${authCookieValue(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    );
    expect(CLEAR_COOKIE).toBe('kage_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    expect(AUTH_COOKIE).toBe('kage_auth');
  });
});

describe('isAuthorised', () => {
  const cookie = (v: string) => `${AUTH_COOKIE}=${v}`;

  it('passes everything when no token is set', () => {
    expect(isAuthorised('', undefined)).toBe(true);
    expect(isAuthorised('', 'kage_auth=nonsense')).toBe(true);
  });

  it('passes the right cookie', () => {
    expect(isAuthorised(TOKEN, cookie(authCookieValue(TOKEN)))).toBe(true);
  });

  it('fails a cookie for another token, a one-character change, an empty or missing cookie', () => {
    const right = authCookieValue(TOKEN);
    const last = right.at(-1) === 'A' ? 'B' : 'A';
    expect(isAuthorised(TOKEN, cookie(authCookieValue(OTHER)))).toBe(false);
    expect(isAuthorised(TOKEN, cookie(right.slice(0, -1) + last))).toBe(false);
    expect(isAuthorised(TOKEN, cookie(right.slice(0, -1)))).toBe(false);
    expect(isAuthorised(TOKEN, cookie(''))).toBe(false);
    expect(isAuthorised(TOKEN, '')).toBe(false);
    expect(isAuthorised(TOKEN, undefined)).toBe(false);
    // The token itself is not the cookie.
    expect(isAuthorised(TOKEN, cookie(TOKEN))).toBe(false);
  });

  it('ignores other cookies in the header', () => {
    const right = authCookieValue(TOKEN);
    expect(isAuthorised(TOKEN, `theme=dark; ${cookie(right)}; other=1`)).toBe(true);
    expect(isAuthorised(TOKEN, `theme=dark; x_kage_auth=${right}`)).toBe(false);
    expect(isAuthorised(TOKEN, `theme=${right}`)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('allows 5 failures in 60 s, refuses the 6th try, and allows again after the window', () => {
    let t = 1_000_000;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(l.allow()).toBe(true);
      l.fail();
      t += 1000;
    }
    expect(l.allow()).toBe(false);
    t += 54_999; // 59.999 s after the first failure
    expect(l.allow()).toBe(false);
    t += 1; // the first failure leaves the window
    expect(l.allow()).toBe(true);
    l.fail();
    expect(l.allow()).toBe(false);
  });

  it('counts only failures, and its memory stays bounded', () => {
    let t = 0;
    const l = new LoginLimiter({ max: 2, windowMs: 100, now: () => t });
    for (let i = 0; i < 10; i++) expect(l.allow()).toBe(true);
    for (let i = 0; i < 1000; i++) l.fail();
    expect(l.size).toBeLessThanOrEqual(2);
    expect(l.allow()).toBe(false);
    t = 100;
    expect(l.allow()).toBe(true);
  });
});
