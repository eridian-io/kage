import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  BAD_ORIGIN,
  csrfGuard,
  hostAllowed,
  hostGuard,
  originAllowed,
  UNKNOWN_HOST,
} from './security.ts';

const allowed = {
  hostNames: ['my-pc', '100.64.0.7', 'fd7a:115c::1', 'box.tail1.ts.net', 'localhost'],
  port: 8080,
};

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
    expect(await r.text()).toBe(UNKNOWN_HOST);
  });
  it('rejects a missing Host', async () => {
    const r = await app.request('/', { headers: { Host: '' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(UNKNOWN_HOST);
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
    const r = await send('POST', { ...good, Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(BAD_ORIGIN);
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
  ['[FD7A:115C:0::1]:8080', true],
  ['my-pc.:8080', false],
  ['localhost.:8080', false],
  ['box.:8080', false],
  ['box.tail1.ts.net.:8080', true],
  ['BOX.tail1.ts.net:8080', true],
  ['my-pc..:8080', false],
  ['fd7a:115c::1:8080', false],
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
  ['http://MY-PC.:8080', false],
  ['http://box.:8080', false],
  ['http://localhost.:8080', false],
  ['http://box.tail1.ts.net.:8080', true],
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
  it('Origin http://127.0.0.1:4385/ with a trailing slash is refused (security M7)', async () => {
    const local = { hostNames: ['127.0.0.1'], port: 4385 };
    expect(originAllowed('http://127.0.0.1:4385', local)).toBe(true);
    for (const o of [
      'http://127.0.0.1:4385/',
      'http://127.0.0.1:4385/x',
      'http://127.0.0.1:4385?',
      'http://127.0.0.1:4385#',
      'http://127.0.0.1:4385\\',
      'http://127.0.0.1/',
    ]) {
      expect(originAllowed(o, local), o).toBe(false);
    }
    const r = await new Hono()
      .use(csrfGuard(local))
      .post('/', (c) => c.text('ok'))
      .request('/', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: 'http://127.0.0.1:4385/', Host: '127.0.0.1:4385' },
      });
    expect(r.status).toBe(403);
  });

  it('a port-80 server takes an Origin without a port', () => {
    const p80 = { hostNames: ['my-pc'], port: 80 };
    expect(originAllowed('http://my-pc', p80)).toBe(true);
    expect(originAllowed('http://my-pc:80', p80)).toBe(true);
  });
});

describe('a rebinding name is refused, with what to set (security I2)', () => {
  // The list a Tailscale bind builds now: the bound IP and the MagicDNS names, nothing else.
  const list = { hostNames: ['100.64.0.9', 'studio.tail1.ts.net', 'studio'], port: 8080 };
  const app = new Hono().use(hostGuard(list)).use(csrfGuard(list));
  app.all('/', (c) => c.text('ok'));

  it('Host: owners-macbook.local:8080 and Origin http://box:8080 are refused (403)', async () => {
    const host = await app.request('/', { headers: { Host: 'owners-macbook.local:8080' } });
    expect(host.status).toBe(403);
    expect(await host.text()).toBe(UNKNOWN_HOST);
    const origin = await app.request('/', {
      method: 'POST',
      headers: { Host: '100.64.0.9:8080', 'X-Kage': '1', Origin: 'http://box:8080' },
    });
    expect(origin.status).toBe(403);
    expect(await origin.text()).toBe(BAD_ORIGIN);
  });

  it('the refusals lead with the address to open, then the host hint and what it trusts', () => {
    for (const text of [UNKNOWN_HOST, BAD_ORIGIN]) {
      expect(text).toMatch(/\.$/);
      expect(text.startsWith('Open the address "kage status" shows.')).toBe(true);
      expect(text).toContain(`set "host" to it in Kage's config file`);
      expect(text).toContain('(this trusts everyone on your local network)');
      expect(text).not.toMatch(/!|^Error/);
    }
  });
});
