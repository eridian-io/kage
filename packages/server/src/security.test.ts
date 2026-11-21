import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { csrfGuard, hostGuard } from './security.ts';

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
