import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { csrfGuard, hostAllowed, hostGuard, originAllowed } from './security.ts';

const allowed = { hostNames: ['my-pc', '100.64.0.7', 'fd7a:115c::1'], port: 8080 };

describe('hostGuard', () => {
  const app = new Hono().use(hostGuard(allowed)).get('/', (c) => c.text('ok'));
  it.each(['my-pc:8080', 'my-pc', '100.64.0.7:8080', '[fd7a:115c::1]:8080'])(
    'accepts %s',
    async (h) => {
      expect((await app.request('/', { headers: { Host: h } })).status).toBe(200);
    },
  );
  it.each(['evil.example', 'my-pc:9999'])('rejects %s', async (h) => {
    const r = await app.request('/', { headers: { Host: h } });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('Unknown host');
  });
  it('rejects a missing Host', async () => {
    const r = await app.request('/', { headers: { Host: '' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('Unknown host');
  });
});

describe('csrfGuard', () => {
  const app = new Hono().use(csrfGuard(allowed));
  app.all('/', (c) => c.text('ok'));
  const send = (method: string, headers: Record<string, string> = {}) =>
    app.request('/', { method, headers });
  const good = { 'X-Kage': '1', Origin: 'http://my-pc:8080' };
  it('rejects POST without X-Kage', async () => {
    expect((await send('POST', { Origin: 'http://my-pc:8080' })).status).toBe(403);
  });
  it('accepts POST with header and valid Origin', async () => {
    expect((await send('POST', good)).status).toBe(200);
  });
  it('rejects POST with a foreign Origin', async () => {
    expect((await send('POST', { ...good, Origin: 'http://evil.example' })).status).toBe(403);
  });
  it('rejects POST with a missing Origin', async () => {
    expect((await send('POST', { 'X-Kage': '1' })).status).toBe(403);
  });
  it('rejects POST with a malformed Origin', async () => {
    expect((await send('POST', { 'X-Kage': '1', Origin: 'null' })).status).toBe(403);
  });
  it('lets GET and HEAD through', async () => {
    expect((await send('GET')).status).toBe(200);
    expect((await send('HEAD')).status).toBe(200);
  });
  it.each(['PUT', 'PATCH', 'DELETE'])('guards %s', async (m) => {
    expect((await send(m)).status).toBe(403);
    expect((await send(m, good)).status).toBe(200);
  });
});

/** One table for the middlewares and the plain matchers the terminal upgrade uses (Task 12). */
const HOSTS: [string | undefined, boolean][] = [
  ['my-pc:8080', true],
  ['my-pc', true],
  ['MY-PC:8080', true],
  ['100.64.0.7:8080', true],
  ['[fd7a:115c::1]:8080', true],
  ['evil.example', false],
  ['my-pc:9999', false],
  ['my-pc:8080/x', false],
  ['user@my-pc:8080', false],
  ['', false],
  [undefined, false],
];
const ORIGINS: [string | undefined, boolean][] = [
  ['http://my-pc:8080', true],
  ['http://100.64.0.7:8080', true],
  ['http://[fd7a:115c::1]:8080', true],
  ['http://my-pc', false],
  ['http://evil.example', false],
  ['http://my-pc:9999', false],
  ['https://my-pc:8080', false],
  ['null', false],
  ['my-pc:8080', false],
  ['', false],
  [undefined, false],
];

describe('hostAllowed and originAllowed agree with the middlewares', () => {
  const hostApp = new Hono().use(hostGuard(allowed)).get('/', (c) => c.text('ok'));
  const csrfApp = new Hono().use(csrfGuard(allowed)).post('/', (c) => c.text('ok'));
  it.each(HOSTS)('Host %j → %s', async (host, ok) => {
    expect(hostAllowed(host, allowed)).toBe(ok);
    const r = await hostApp.request('/', { headers: host === undefined ? {} : { Host: host } });
    // app.request fills in a Host of its own when none is given; only a given one is compared.
    if (host !== undefined) expect(r.status === 200).toBe(ok);
  });
  it.each(ORIGINS)('Origin %j → %s', async (origin, ok) => {
    expect(originAllowed(origin, allowed)).toBe(ok);
    const headers: Record<string, string> = { 'X-Kage': '1' };
    if (origin !== undefined) headers.Origin = origin;
    const r = await csrfApp.request('/', { method: 'POST', headers });
    expect(r.status === 200).toBe(ok);
  });
  it('a port-80 server takes an Origin without a port', () => {
    const p80 = { hostNames: ['my-pc'], port: 80 };
    expect(originAllowed('http://my-pc', p80)).toBe(true);
    expect(originAllowed('http://my-pc:80', p80)).toBe(true);
  });
});
