import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type Auth,
  authCookieName,
  clearCookieHeader,
  LoginLimiter,
  normalizePeer,
  peerKey,
  SESSION_IDLE_MS,
  SESSION_MAX,
  SESSION_MAX_MS,
  SessionStore,
  sessionOf,
  setCookieHeader,
} from './auth.ts';

const TOKEN = 'correct-horse-battery-staple';
const PEER = '100.64.0.9';
const OTHER_PEER = '100.64.0.10';
const DAY = 24 * 60 * 60 * 1000;

/** A store on a clock the test moves by hand. */
function clocked(o: { max?: number } = {}) {
  let t = 1_000_000;
  // One clock for both limits here; 'the 30-day limit runs on the wall clock' splits them.
  const store = new SessionStore({ clock: () => t, wallClock: () => t, ...o });
  return {
    store,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const authWith = (sessions: SessionStore, token = TOKEN): Auth => ({
  token,
  sessions,
  cookie: authCookieName(8080),
});
const cookie = (id: string) => `kage_auth_8080=${id}`;

describe('SessionStore and the session cookie (security I1)', () => {
  it('a login gets its own id; a second login gets another; both check', () => {
    const { store } = clocked();
    const a = store.create(PEER);
    const b = store.create(PEER);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    const ka = store.check(a, PEER);
    const kb = store.check(b, PEER);
    expect(ka).not.toBeNull();
    expect(kb).not.toBeNull();
    expect(ka).not.toBe(kb);
    // Only the id's SHA-256 is kept: the key the store answers with is not the id.
    expect(ka).not.toContain(a);
    expect(store.size).toBe(2);
    // A changed character, a short or empty id, the token itself: none is a session.
    const last = a.at(-1) === 'A' ? 'B' : 'A';
    expect(store.check(a.slice(0, -1) + last, PEER)).toBeNull();
    expect(store.check(a.slice(0, -1), PEER)).toBeNull();
    expect(store.check('', PEER)).toBeNull();
    expect(store.check(TOKEN, PEER)).toBeNull();
  });

  it('the cookie is kage_auth_<port>, HttpOnly, SameSite=Strict, Path=/, Max-Age=2592000, Secure only when asked', () => {
    expect(authCookieName(8080)).toBe('kage_auth_8080');
    expect(authCookieName(4385)).toBe('kage_auth_4385');
    expect(setCookieHeader('kage_auth_8080', 'abc', false)).toBe(
      'kage_auth_8080=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000',
    );
    expect(setCookieHeader('kage_auth_8080', 'abc', true)).toBe(
      'kage_auth_8080=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure',
    );
    expect(clearCookieHeader('kage_auth_8080')).toBe(
      'kage_auth_8080=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
  });

  it('revoke refuses that session only and fires onRevoke once', () => {
    const { store } = clocked();
    const a = store.create(PEER);
    const b = store.create(PEER);
    const ka = store.check(a, PEER) as string;
    const heard: string[] = [];
    const off = store.onRevoke((k) => heard.push(k));
    store.revoke(ka);
    store.revoke(ka);
    expect(heard).toEqual([ka]);
    expect(store.check(a, PEER)).toBeNull();
    expect(store.check(b, PEER)).not.toBeNull();
    expect(store.size).toBe(1);
    off();
    store.revoke(store.check(b, PEER) as string);
    expect(heard).toEqual([ka]);
  });

  it('a session idle for 7 days, or 30 days old, is refused', () => {
    expect(SESSION_IDLE_MS).toBe(7 * DAY);
    expect(SESSION_MAX_MS).toBe(30 * DAY);
    const { store, advance } = clocked();
    const heard: string[] = [];
    store.onRevoke((k) => heard.push(k));
    const short = store.create(PEER);
    const idle = store.create(PEER);
    advance(SESSION_IDLE_MS - 1);
    expect(store.check(short, PEER)).not.toBeNull();
    advance(1);
    // 7 days since `idle` was last seen: refused, and its end is heard (F6).
    expect(store.check(idle, PEER)).toBeNull();
    expect(heard).toHaveLength(1);
    expect(store.check(short, PEER)).not.toBeNull();

    // Seen every day, a session still ends 30 days after its login.
    const { store: s2, advance: adv2 } = clocked();
    const old = s2.create(PEER);
    for (let d = 1; d < 30; d++) {
      adv2(DAY);
      expect(s2.check(old, PEER)).not.toBeNull();
    }
    adv2(DAY - 1);
    expect(s2.check(old, PEER)).not.toBeNull();
    adv2(1);
    expect(s2.check(old, PEER)).toBeNull();
    expect(s2.size).toBe(0);
  });

  it('the 30-day limit runs on the wall clock, so host sleep does not stretch it; the 7-day idle limit on the monotonic clock', () => {
    let mono = 0;
    let wall = 1_800_000_000_000;
    const store = new SessionStore({ clock: () => mono, wallClock: () => wall });
    const id = store.create(PEER);
    // 29 days of sleep: the monotonic clock stood still, the wall clock moved on.
    wall += 29 * DAY;
    expect(store.check(id, PEER)).not.toBeNull();
    mono += 1000;
    wall += DAY;
    expect(store.check(id, PEER)).toBeNull();

    // A wall-clock jump alone never ends the idle count early, nor revives it.
    const s2 = new SessionStore({ clock: () => mono, wallClock: () => wall });
    const b = s2.create(PEER);
    mono += SESSION_IDLE_MS - 1;
    expect(s2.check(b, PEER)).not.toBeNull();
    wall -= 10 * DAY;
    mono += SESSION_IDLE_MS;
    expect(s2.check(b, PEER)).toBeNull();
  });

  it('expiry is swept without a request: a timer at the earliest expiry fires onRevoke (F6)', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const store = new SessionStore({
        clock: () => t,
        wallClock: () => t,
        idleMs: 1000,
        maxAgeMs: 10_000,
      });
      const heard: string[] = [];
      store.onRevoke((k) => heard.push(k));
      const a = store.create(PEER);
      const ka = store.check(a, PEER) as string;
      t = 999;
      await vi.advanceTimersByTimeAsync(999);
      expect(heard).toEqual([]);
      t = 1000;
      await vi.advanceTimersByTimeAsync(1);
      expect(heard).toEqual([ka]);
      expect(store.size).toBe(0);
      // With no session left, no timer is held.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cookie from another peer address is refused; ::ffff:100.64.0.1 is 100.64.0.1', () => {
    expect(normalizePeer('::ffff:100.64.0.1')).toBe('100.64.0.1');
    expect(normalizePeer('::FFFF:100.64.0.1')).toBe('100.64.0.1');
    expect(normalizePeer('100.64.0.1')).toBe('100.64.0.1');
    expect(normalizePeer('FD7A:115C:A1E0::1')).toBe('fd7a:115c:a1e0::1');
    const { store } = clocked();
    const id = store.create(PEER);
    expect(store.check(id, OTHER_PEER)).toBeNull();
    // Refused, not revoked: the owner's own device still gets in.
    expect(store.check(id, PEER)).not.toBeNull();
    const mapped = store.create(normalizePeer('::ffff:100.64.0.1'));
    expect(store.check(mapped, normalizePeer('100.64.0.1'))).not.toBeNull();
  });

  it('a new SessionStore (a restart) refuses every old cookie', () => {
    const before = new SessionStore();
    const id = before.create(PEER);
    expect(sessionOf(authWith(before), cookie(id), PEER)).not.toBeNull();
    const after = new SessionStore();
    expect(after.check(id, PEER)).toBeNull();
    expect(sessionOf(authWith(after), cookie(id), PEER)).toBeNull();
  });

  it('a 65th session drops the least recently seen', () => {
    expect(SESSION_MAX).toBe(64);
    const { store, advance } = clocked();
    const heard: string[] = [];
    store.onRevoke((k) => heard.push(k));
    const ids: string[] = [];
    for (let i = 0; i < SESSION_MAX; i++) {
      ids.push(store.create(PEER));
      advance(1);
    }
    // The first login is seen again, so the second is now the least recently seen.
    const second = store.check(ids[1] as string, PEER) as string;
    for (let i = 2; i < SESSION_MAX; i++) store.check(ids[i] as string, PEER);
    store.check(ids[0] as string, PEER);
    const extra = store.create(PEER);
    expect(store.size).toBe(SESSION_MAX);
    expect(heard).toEqual([second]);
    expect(store.check(ids[1] as string, PEER)).toBeNull();
    expect(store.check(ids[0] as string, PEER)).not.toBeNull();
    expect(store.check(extra, PEER)).not.toBeNull();
  });

  it('the old HMAC value of the token is no longer accepted', () => {
    const old = createHmac('sha256', TOKEN).update('kage-auth-v1').digest('base64url');
    const store = new SessionStore();
    store.create(PEER);
    const auth = authWith(store);
    expect(sessionOf(auth, cookie(old), PEER)).toBeNull();
    expect(sessionOf(auth, `kage_auth=${old}`, PEER)).toBeNull();
  });

  it('with no token, sessionOf is open ("")', () => {
    const auth = authWith(new SessionStore(), '');
    expect(sessionOf(auth, undefined, PEER)).toBe('');
    expect(sessionOf(auth, 'kage_auth_8080=nonsense', PEER)).toBe('');
  });

  it('sessionOf reads only its own cookie name, and checks every cookie of that name', () => {
    const store = new SessionStore();
    const id = store.create(PEER);
    const auth = authWith(store);
    const key = store.check(id, PEER);
    expect(sessionOf(auth, undefined, PEER)).toBeNull();
    expect(sessionOf(auth, '', PEER)).toBeNull();
    expect(sessionOf(auth, `theme=dark; ${cookie(id)}; other=1`, PEER)).toBe(key);
    expect(sessionOf(auth, `kage_auth_8080=bad; ${cookie(id)}`, PEER)).toBe(key);
    expect(sessionOf(auth, `${cookie(id)}; kage_auth_8080=bad`, PEER)).toBe(key);
    // Another port's cookie, or a name that only ends the same, is not this Kage's.
    expect(sessionOf(auth, `kage_auth_9090=${id}`, PEER)).toBeNull();
    expect(sessionOf(auth, `x_kage_auth_8080=${id}`, PEER)).toBeNull();
    expect(sessionOf(auth, `kage_auth=${id}`, PEER)).toBeNull();
    expect(sessionOf(auth, cookie(id), OTHER_PEER)).toBeNull();
  });
});

describe('peerKey (review of M2/M3: a tailnet node by its /128, other IPv6 by /64)', () => {
  it('two tailnet IPv6 addresses are two keys: fd7a:115c:a1e0::/48 counts by the full /128', () => {
    // The legacy form: one shared /64 for the whole tailnet.
    const owner = 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240';
    const other = 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b241';
    expect(peerKey(owner)).toBe(owner);
    expect(peerKey(other)).toBe(other);
    expect(peerKey(owner)).not.toBe(peerKey(other));
    // The newer form, fd7a:115c:a1e0::xxxx:xxxx.
    expect(peerKey('fd7a:115c:a1e0::1:2')).toBe('fd7a:115c:a1e0:0:0:0:1:2');
    expect(peerKey('fd7a:115c:a1e0::a01:2c3')).not.toBe(peerKey('fd7a:115c:a1e0::a01:2c4'));
    // One node written two ways is one key.
    expect(peerKey('FD7A:115C:A1E0:0000::0001:0002')).toBe(peerKey('fd7a:115c:a1e0::1:2'));
    // Just outside the /48 is an ordinary address again.
    expect(peerKey('fd7a:115c:a1e1:ab12::1')).toBe('fd7a:115c:a1e1:ab12::/64');
  });

  it('keeps IPv4 as it is and keys other IPv6 by its /64', () => {
    expect(peerKey('100.64.0.9')).toBe('100.64.0.9');
    expect(peerKey('::ffff:100.64.0.9')).toBe('100.64.0.9');
    expect(peerKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(peerKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(peerKey('2001:0db8:0000:0001:ffff::')).toBe('2001:db8:0:1::/64');
    expect(peerKey('::1')).toBe('0:0:0:0::/64');
    expect(peerKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(peerKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
    // Two addresses in one /64 are one key; another /64 is another.
    expect(peerKey('2001:db8:1:2::a')).toBe(peerKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(peerKey('2001:db8:1:2::a')).not.toBe(peerKey('2001:db8:1:3::a'));
    // Not an address: kept as it is (tests without a socket share 'unknown').
    expect(peerKey('unknown')).toBe('unknown');
    expect(peerKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(peerKey('1::2::3')).toBe('1::2::3');
    expect(peerKey('::1.2.3.400')).toBe('::1.2.3.400');
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

  it('30 failures a minute from all addresses together refuse every address that has failed', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 30; i++) {
      const peer = `100.64.1.${i}`;
      expect(l.allow(peer)).toBe(true);
      l.fail(peer);
    }
    // One failure each, far below 5, yet the ceiling is full: refused.
    expect(l.allow('100.64.1.0')).toBe(false);
    expect(l.allow('100.64.1.29')).toBe(false);
    t = 60_000;
    expect(l.allow('100.64.1.0')).toBe(true);
  });

  it('the global ceiling no longer blocks an address with no recent failures (security M2)', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    // The review's probe: six addresses fail five times each and fill the ceiling.
    for (let p = 0; p < 6; p++) {
      for (let i = 0; i < 5; i++) {
        expect(l.allow(`100.64.1.${p}`)).toBe(true);
        l.fail(`100.64.1.${p}`);
      }
    }
    expect(l.allow('100.64.1.0')).toBe(false);
    // The owner's device has failed nothing: it gets its try.
    expect(l.allow(A)).toBe(true);
    // One failure while the ceiling is full, and that address waits too.
    l.fail(A);
    expect(l.allow(A)).toBe(false);
    expect(l.allow(B)).toBe(true);
    // A failure older than the window is forgotten: the address counts as clean again.
    t = 60_001;
    expect(l.allow(A)).toBe(true);
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
