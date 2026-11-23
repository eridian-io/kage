import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { type Auth, authCookieName, SessionStore } from '../auth.ts';
import { BAD_ORIGIN, UNKNOWN_HOST } from '../security.ts';
import { checkUpgrade, TERMINAL_PATH } from './upgrade.ts';

const allowed = { hostNames: ['my-pc', '100.64.0.7'], port: 8080 };
const TOKEN = 'correct horse battery staple';

const good = (over: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
  host: 'my-pc:8080',
  origin: 'http://my-pc:8080',
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-protocol': 'kage.term.v1',
  ...over,
});
const PEER = '100.64.0.9';
const authOf = (token: string, sessions = new SessionStore()): Auth => ({
  token,
  sessions,
  cookie: authCookieName(8080),
});
const check = (
  url: string,
  headers: IncomingHttpHeaders = good(),
  o: { method?: string; token?: string; auth?: Auth; peer?: string } = {},
) =>
  checkUpgrade(
    { method: o.method ?? 'GET', url, headers },
    { allowed, auth: o.auth ?? authOf(o.token ?? ''), peer: o.peer ?? PEER },
  );
const without = (name: string): IncomingHttpHeaders => {
  const h = good();
  delete h[name];
  return h;
};

describe('checkUpgrade', () => {
  it('a good request → ok, with cols and rows', () => {
    expect(check('/api/sessions/k-1/terminal?cols=120&rows=40')).toEqual({
      ok: true,
      id: 'k-1',
      cols: 120,
      rows: 40,
    });
    expect(check('/api/sessions/k-1/terminal')).toEqual({
      ok: true,
      id: 'k-1',
      cols: null,
      rows: null,
    });
  });

  it('the protocol may be one of several offered', () => {
    expect(
      check('/api/sessions/k-1/terminal', good({ 'sec-websocket-protocol': 'x, kage.term.v1' })).ok,
    ).toBe(true);
  });

  it('a foreign Host → 403 with the unknown-host sentence', () => {
    expect(check('/api/sessions/k-1/terminal', good({ host: 'evil.example' }))).toEqual({
      ok: false,
      status: 403,
      error: UNKNOWN_HOST,
    });
    expect(check('/api/sessions/k-1/terminal', without('host'))).toMatchObject({ status: 403 });
  });

  it.each(['http://evil.example', 'http://my-pc:9999', 'https://my-pc:8080', 'null'])(
    'Origin %s → 403 with the bad-origin sentence',
    (origin) => {
      expect(check('/api/sessions/k-1/terminal', good({ origin }))).toEqual({
        ok: false,
        status: 403,
        error: BAD_ORIGIN,
      });
    },
  );

  it('a missing Origin → 403 with the bad-origin sentence', () => {
    expect(check('/api/sessions/k-1/terminal', without('origin'))).toEqual({
      ok: false,
      status: 403,
      error: BAD_ORIGIN,
    });
  });

  it('with a token: no cookie, or a wrong one → 401; the right one passes', () => {
    const signIn = { ok: false, status: 401, error: 'Sign in to Kage' };
    expect(check('/api/sessions/k-1/terminal', good(), { token: TOKEN })).toEqual(signIn);
    expect(
      check('/api/sessions/k-1/terminal', good({ cookie: 'kage_auth=nope' }), { token: TOKEN }),
    ).toEqual(signIn);
    const sessions = new SessionStore();
    const id = sessions.create(PEER);
    const auth = authOf(TOKEN, sessions);
    const ok = check('/api/sessions/k-1/terminal', good({ cookie: `a=b; kage_auth_8080=${id}` }), {
      auth,
    });
    expect(ok.ok).toBe(true);
    // The check names the session, so the terminal server can close it on sign-out.
    expect((ok as { session?: string }).session).toBe(sessions.check(id, PEER));
  });

  it('the upgrade needs a live session from the same peer', () => {
    const sessions = new SessionStore();
    const id = sessions.create(PEER);
    const auth = authOf(TOKEN, sessions);
    const signIn = { ok: false, status: 401, error: 'Sign in to Kage' };
    const withCookie = good({ cookie: `kage_auth_8080=${id}` });
    expect(check('/api/sessions/k-1/terminal', withCookie, { auth }).ok).toBe(true);
    // Another address with the same cookie: refused.
    expect(check('/api/sessions/k-1/terminal', withCookie, { auth, peer: '100.64.0.10' })).toEqual(
      signIn,
    );
    // The old cookie name, or another port's: refused.
    expect(
      check('/api/sessions/k-1/terminal', good({ cookie: `kage_auth=${id}` }), { auth }),
    ).toEqual(signIn);
    // A revoked session: refused.
    sessions.revoke(sessions.check(id, PEER) as string);
    expect(check('/api/sessions/k-1/terminal', withCookie, { auth })).toEqual(signIn);
    // A restart's new store: refused.
    expect(check('/api/sessions/k-1/terminal', withCookie, { auth: authOf(TOKEN) })).toEqual(
      signIn,
    );
  });

  it('a missing or other subprotocol → 400', () => {
    expect(check('/api/sessions/k-1/terminal', without('sec-websocket-protocol'))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      check('/api/sessions/k-1/terminal', good({ 'sec-websocket-protocol': 'kage.term.v2' })),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    'cols=0',
    'cols=abc',
    'cols=80.5',
    'cols=-1',
    'cols=501',
    'rows=4',
    'rows=201',
    'cols=',
    'cols=80&cols=90',
  ])('%s → 400', (q) => {
    expect(check(`/api/sessions/k-1/terminal?${q}`)).toMatchObject({ ok: false, status: 400 });
  });

  it('the limits themselves pass', () => {
    expect(check('/api/sessions/k-1/terminal?cols=20&rows=5')).toMatchObject({ cols: 20, rows: 5 });
    expect(check('/api/sessions/k-1/terminal?cols=500&rows=200')).toMatchObject({
      cols: 500,
      rows: 200,
    });
  });

  it.each([
    '/api/sessions/a/b/terminal',
    '/api/sessions//terminal',
    '/api/sessions/a/terminal/',
    '/api/sessions/a/terminalx',
    '/x/api/sessions/a/terminal',
    '/api/sessions/..%2F/terminal',
    '/api/sessions/%2e%2e/terminal',
    '/api/sessions/a%20b/terminal',
    '/api/sessions/%E0%A4%A/terminal',
    `/api/sessions/${'a'.repeat(101)}/terminal`,
  ])('%s → 404 Not found', (url) => {
    expect(check(url)).toEqual({ ok: false, status: 404, error: 'Not found' });
  });

  it('the id ext-%407 decodes to ext-@7 and passes', () => {
    expect(check('/api/sessions/ext-%407/terminal')).toMatchObject({ ok: true, id: 'ext-@7' });
  });

  it('the path is checked first: a bad path with a bad Host is 404', () => {
    expect(check('/nope', good({ host: 'evil.example' }))).toMatchObject({ status: 404 });
  });

  it('a method other than GET, or no Upgrade: websocket → 400', () => {
    expect(check('/api/sessions/k-1/terminal', good(), { method: 'POST' })).toMatchObject({
      status: 400,
    });
    expect(check('/api/sessions/k-1/terminal', good({ upgrade: 'h2c' }))).toMatchObject({
      status: 400,
    });
  });

  it('the checks run in order: Host before Origin before the cookie before the protocol', () => {
    const all = good({ host: 'evil.example', origin: 'http://evil.example' });
    delete all['sec-websocket-protocol'];
    expect(check('/api/sessions/k-1/terminal', all, { token: TOKEN })).toMatchObject({
      error: UNKNOWN_HOST,
    });
    const noHostFault = { ...all, host: 'my-pc:8080' };
    expect(check('/api/sessions/k-1/terminal', noHostFault, { token: TOKEN })).toMatchObject({
      error: BAD_ORIGIN,
    });
    const cookieFault = { ...noHostFault, origin: 'http://my-pc:8080' };
    expect(check('/api/sessions/k-1/terminal', cookieFault, { token: TOKEN })).toMatchObject({
      status: 401,
    });
  });

  it('TERMINAL_PATH takes one raw segment of 1–200 characters', () => {
    expect(TERMINAL_PATH.exec('/api/sessions/k-1/terminal')?.[1]).toBe('k-1');
    expect(TERMINAL_PATH.test(`/api/sessions/${'a'.repeat(200)}/terminal`)).toBe(true);
    expect(TERMINAL_PATH.test(`/api/sessions/${'a'.repeat(201)}/terminal`)).toBe(false);
    expect(TERMINAL_PATH.test('/api/sessions/a/b/terminal')).toBe(false);
  });
});
