import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { authCookieValue } from '../auth.ts';
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
const check = (
  url: string,
  headers: IncomingHttpHeaders = good(),
  o: { method?: string; token?: string } = {},
) => checkUpgrade({ method: o.method ?? 'GET', url, headers }, { allowed, token: o.token ?? '' });
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

  it('a foreign Host → 403 Unknown host', () => {
    expect(check('/api/sessions/k-1/terminal', good({ host: 'evil.example' }))).toEqual({
      ok: false,
      status: 403,
      error: 'Unknown host',
    });
    expect(check('/api/sessions/k-1/terminal', without('host'))).toMatchObject({ status: 403 });
  });

  it.each(['http://evil.example', 'http://my-pc:9999', 'https://my-pc:8080', 'null'])(
    'Origin %s → 403 Bad origin',
    (origin) => {
      expect(check('/api/sessions/k-1/terminal', good({ origin }))).toEqual({
        ok: false,
        status: 403,
        error: 'Bad origin',
      });
    },
  );

  it('a missing Origin → 403 Bad origin', () => {
    expect(check('/api/sessions/k-1/terminal', without('origin'))).toEqual({
      ok: false,
      status: 403,
      error: 'Bad origin',
    });
  });

  it('with a token: no cookie, or a wrong one → 401; the right one passes', () => {
    const signIn = { ok: false, status: 401, error: 'Sign in to Kage' };
    expect(check('/api/sessions/k-1/terminal', good(), { token: TOKEN })).toEqual(signIn);
    expect(
      check('/api/sessions/k-1/terminal', good({ cookie: 'kage_auth=nope' }), { token: TOKEN }),
    ).toEqual(signIn);
    expect(
      check(
        '/api/sessions/k-1/terminal',
        good({ cookie: `a=b; kage_auth=${authCookieValue(TOKEN)}` }),
        { token: TOKEN },
      ).ok,
    ).toBe(true);
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
      error: 'Unknown host',
    });
    const noHostFault = { ...all, host: 'my-pc:8080' };
    expect(check('/api/sessions/k-1/terminal', noHostFault, { token: TOKEN })).toMatchObject({
      error: 'Bad origin',
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
