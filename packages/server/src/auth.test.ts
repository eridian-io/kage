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
  const A = '100.64.0.9';
  const B = '100.64.0.10';

  it('allows 5 failures from an address in 60 s, refuses the 6th try, and allows again after the window', () => {
    let t = 1_000_000;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(l.allow(A)).toBe(true);
      l.fail(A);
      t += 1000;
    }
    expect(l.allow(A)).toBe(false);
    t += 54_999; // 59.999 s after the first failure
    expect(l.allow(A)).toBe(false);
    t += 1; // the first failure leaves the window
    expect(l.allow(A)).toBe(true);
    l.fail(A);
    expect(l.allow(A)).toBe(false);
  });

  it('an address that is locked out does not lock out another', () => {
    const l = new LoginLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) l.fail(A);
    expect(l.allow(A)).toBe(false);
    expect(l.allow(B)).toBe(true);
  });

  it('30 failures a minute from all addresses together refuse everyone', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 30; i++) {
      const peer = `100.64.1.${i}`;
      expect(l.allow(peer)).toBe(true);
      l.fail(peer);
    }
    expect(l.allow('100.64.2.1')).toBe(false);
    t = 60_000;
    expect(l.allow('100.64.2.1')).toBe(true);
  });

  it('counts only failures, and its memory stays bounded', () => {
    let t = 0;
    const l = new LoginLimiter({ max: 2, globalMax: 1e9, windowMs: 100, maxKeys: 3, now: () => t });
    for (let i = 0; i < 10; i++) expect(l.allow(A)).toBe(true);
    for (let i = 0; i < 1000; i++) l.fail(A);
    expect(l.allow(A)).toBe(false);
    for (let i = 0; i < 1000; i++) l.fail(`peer-${i}`);
    expect(l.size).toBe(3);
    // The least recently failed addresses went first: A is forgotten, the newest are kept.
    expect(l.allow(A)).toBe(true);
    l.fail('peer-999');
    l.fail('peer-999');
    expect(l.allow('peer-999')).toBe(false);
    t = 100;
    expect(l.allow('peer-999')).toBe(true);
  });
});
