import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';

const HOST = 'my-pc:8080';
const ORIGIN = 'http://my-pc:8080';
const allowed = { hostNames: ['my-pc', '100.64.0.7'], port: 8080 };
const HTML = `<!doctype html><html><head><title>kage</title></head><body>${'<div id="app"></div>'.repeat(20)}</body></html>`;
const JS = `console.log(${JSON.stringify('x'.repeat(2000))});`;

let dist: string;
let assets: Map<string, Asset>;
let source: DemoSource;
let hub: EventHub;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'kage-assets-'));
  await mkdir(join(dist, 'fonts'));
  await writeFile(join(dist, 'index.html'), HTML);
  await writeFile(join(dist, 'app-ABC123.js'), JS);
  await writeFile(join(dist, 'app-DEF456.css'), `.k-app{color:red}${'.a{b:c}'.repeat(100)}`);
  await writeFile(join(dist, 'fonts', 'geist-latin-400-normal.woff2'), new Uint8Array([1, 2, 3]));
  assets = await loadAssets(dist);
});
afterAll(() => rm(dist, { recursive: true, force: true }));

let demoResets = 0;
beforeEach(() => {
  source = new DemoSource(1_000_000);
  hub = new EventHub(source, 'my-pc');
  demoResets = 0;
});
afterEach(() => hub.close());

const app = (demo = false) =>
  createApp({
    source,
    hub,
    assets,
    allowed,
    ...(demo
      ? {
          demoReset: () => {
            demoResets++;
            source.reset();
          },
        }
      : {}),
  });

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://${HOST}${path}`, {
    ...init,
    headers: { Host: HOST, ...init.headers },
  });
const mutate = (method: string, path: string, body?: unknown) =>
  req(path, {
    method,
    headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('loadAssets', () => {
  it('maps / to index.html and precompresses every file', () => {
    const index = assets.get('/');
    expect(index).toBe(assets.get('/index.html'));
    expect(index?.type).toBe('text/html; charset=utf-8');
    expect(new TextDecoder().decode(gunzipSync(index?.gzip as Uint8Array))).toBe(HTML);
    expect(new TextDecoder().decode(brotliDecompressSync(index?.br as Uint8Array))).toBe(HTML);
    expect(assets.get('/app-ABC123.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(assets.get('/app-DEF456.css')?.type).toBe('text/css; charset=utf-8');
    expect(assets.get('/fonts/geist-latin-400-normal.woff2')?.type).toBe('font/woff2');
    expect(assets.get('/app-ABC123.js')?.immutable).toBe(true);
    expect(index?.immutable).toBe(false);
    expect(assets.get('/fonts/geist-latin-400-normal.woff2')?.immutable).toBe(false);
  });
});

describe('static assets', () => {
  it('serves / as brotli when the browser accepts it, gzip otherwise', async () => {
    const br = await app().fetch(req('/', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } }));
    expect(br.status).toBe(200);
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    const brBody = new Uint8Array(await br.arrayBuffer());
    expect(new TextDecoder().decode(brotliDecompressSync(brBody))).toBe(HTML);

    const gz = await app().fetch(req('/', { headers: { 'Accept-Encoding': 'gzip, deflate' } }));
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    const gzBody = new Uint8Array(await gz.arrayBuffer());
    expect(new TextDecoder().decode(gunzipSync(gzBody))).toBe(HTML);

    const plain = await app().fetch(req('/'));
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(HTML);

    const refused = await app().fetch(req('/', { headers: { 'Accept-Encoding': 'br;q=0, gzip' } }));
    expect(refused.headers.get('content-encoding')).toBe('gzip');
  });

  it('caches hashed assets for a year and revalidates index.html by etag', async () => {
    const js = await app().fetch(req('/app-ABC123.js'));
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const index = await app().fetch(req('/index.html'));
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const etag = index.headers.get('etag');
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await app().fetch(req('/', { headers: { 'If-None-Match': etag as string } }));
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');

    const stale = await app().fetch(req('/', { headers: { 'If-None-Match': '"nope"' } }));
    expect(stale.status).toBe(200);
  });

  it('does not re-encode files that do not shrink', async () => {
    const font = await app().fetch(
      req('/fonts/geist-latin-400-normal.woff2', { headers: { 'Accept-Encoding': 'br, gzip' } }),
    );
    expect(font.status).toBe(200);
    expect(font.headers.get('content-encoding')).toBeNull();
    expect([...new Uint8Array(await font.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('answers 404 for unknown paths', async () => {
    expect((await app().fetch(req('/nope.js'))).status).toBe(404);
    expect((await app().fetch(req('/api/nope'))).status).toBe(404);
  });

  it('sets the security headers', async () => {
    const res = await app().fetch(req('/'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('API', () => {
  it('streams events, a snapshot first', async () => {
    const res = await app().fetch(req('/api/events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('content-encoding')).toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text.startsWith('event: snapshot\ndata: ')).toBe(true);
    expect(JSON.parse(text.slice('event: snapshot\ndata: '.length)).host).toBe('my-pc');
    await reader.cancel();
  });

  it('deletes a session, and answers 404 for an unknown one', async () => {
    const ok = await app().fetch(mutate('DELETE', '/api/sessions/docs'));
    expect(ok.status).toBe(204);
    expect(source.get('docs')).toBeUndefined();

    const missing = await app().fetch(mutate('DELETE', '/api/sessions/nope'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await missing.json()).toEqual({ error: 'No session with id nope' });
  });

  it('refuses a delete without X-Kage or with a foreign Origin', async () => {
    const noHeader = await app().fetch(
      req('/api/sessions/docs', { method: 'DELETE', headers: { Origin: ORIGIN } }),
    );
    expect(noHeader.status).toBe(403);
    const foreign = await app().fetch(
      req('/api/sessions/docs', {
        method: 'DELETE',
        headers: { 'X-Kage': '1', Origin: 'http://evil.example' },
      }),
    );
    expect(foreign.status).toBe(403);
    expect(source.get('docs')).toBeDefined();
  });

  it('accepts the viewed session', async () => {
    expect((await app().fetch(mutate('POST', '/api/view', { id: 'web' }))).status).toBe(204);
    expect((await app().fetch(mutate('POST', '/api/view', { id: null }))).status).toBe(204);
    const bad = await app().fetch(mutate('POST', '/api/view', { id: 3 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Expected {"id": "<session id>"}' });
    const garbage = await app().fetch(
      req('/api/view', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(garbage.status).toBe(400);
    const huge = await app().fetch(mutate('POST', '/api/view', { id: 'x'.repeat(20_000) }));
    expect(huge.status).toBe(413);
  });

  it('registers POST /api/demo/reset only in demo mode, behind the guards', async () => {
    expect((await app().fetch(mutate('POST', '/api/demo/reset'))).status).toBe(404);
    expect(demoResets).toBe(0);

    await source.remove('docs');
    const demo = app(true);
    const refused = await demo.fetch(
      req('/api/demo/reset', { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(refused.status).toBe(403);
    expect(demoResets).toBe(0);

    const ok = await demo.fetch(mutate('POST', '/api/demo/reset'));
    expect(ok.status).toBe(204);
    expect(demoResets).toBe(1);
    expect(source.get('docs')).toBeDefined();
  });
});

describe('host guard', () => {
  const routes: [string, string][] = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/app-ABC123.js'],
    ['GET', '/nope'],
    ['GET', '/api/events'],
    ['DELETE', '/api/sessions/docs'],
    ['POST', '/api/view'],
    ['POST', '/api/demo/reset'],
  ];
  it.each(routes)('%s %s answers 403 for Host: evil.example', async (method, path) => {
    const res = await app(true).fetch(
      new Request(`http://evil.example${path}`, {
        method,
        headers: {
          Host: 'evil.example',
          'X-Kage': '1',
          Origin: 'http://evil.example',
          'Content-Type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{"id":"web"}' } : {}),
      }),
    );
    expect(res.status).toBe(403);
    expect(hub.clientCount).toBe(0);
    expect(source.get('docs')).toBeDefined();
    expect(demoResets).toBe(0);
  });
});
