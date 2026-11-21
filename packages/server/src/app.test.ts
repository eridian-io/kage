import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { authCookieValue, CLEAR_COOKIE, setCookieHeader } from './auth.ts';
import { ActionError } from './control/actions.ts';
import { LaunchError } from './control/launcher.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';
import { LiveSource, type LiveSourceDeps } from './live-source.ts';

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
  // Compressible bytes under already-compressed extensions: must still be served raw.
  await writeFile(join(dist, 'fonts', 'big.woff2'), new Uint8Array(4096).fill(7));
  await writeFile(join(dist, 'logo.png'), new Uint8Array(4096).fill(7));
  await writeFile(join(dist, 'photo.jpg'), new Uint8Array(4096).fill(7));
  await writeFile(join(dist, 'photo.webp'), new Uint8Array(4096).fill(7));
  assets = await loadAssets(dist);
});
afterAll(() => rm(dist, { recursive: true, force: true }));

let demoResets = 0;
beforeEach(() => {
  source = new DemoSource(1_000_000);
  hub = new EventHub(source, 'my-pc', '/p');
  demoResets = 0;
});
afterEach(() => hub.close());

const PROJECTS = {
  projects: [{ name: 'api', defaultBranch: 'main', branches: ['main'] }],
  last: 'api',
};
const app = (demo = false, token = '', projects = false) =>
  createApp({
    source,
    hub,
    assets,
    allowed,
    token,
    ...(projects ? { projects: async () => PROJECTS } : {}),
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

  it.each([
    ['/fonts/big.woff2', 'font/woff2'],
    ['/logo.png', 'image/png'],
    ['/photo.jpg', 'image/jpeg'],
    ['/photo.webp', 'image/webp'],
  ])('serves already-compressed %s raw, even when it would shrink', async (path, type) => {
    const res = await app().fetch(req(path, { headers: { 'Accept-Encoding': 'br, gzip' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBe('4096');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(4096).fill(7));
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

  it('answers HEAD on the event stream with the SSE headers and no client', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) {
      const res = await a.request('/api/events', { method: 'HEAD', headers: { Host: HOST } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(res.body).toBeNull();
    }
    expect(hub.clientCount).toBe(0);
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

  it('answers 501 when the live source cannot delete yet', async () => {
    const live = new LiveSource({} as LiveSourceDeps);
    const liveHub = new EventHub(live, 'my-pc', '/p');
    const liveApp = createApp({ source: live, hub: liveHub, assets, allowed, token: '' });
    const res = await liveApp.fetch(mutate('DELETE', '/api/sessions/k-1'));
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Deleting sessions arrives in a later version' });
    liveHub.close();
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

  it('routes the view to its stream', async () => {
    const reader = hub.stream().getReader();
    const snap = JSON.parse(
      new TextDecoder().decode((await reader.read()).value).split('data: ')[1] ?? '',
    );
    const ok = await app().fetch(
      mutate('POST', '/api/view', { streamId: snap.streamId, id: 'web' }),
    );
    expect(ok.status).toBe(204);
    expect((await reader.read()).value).toBeDefined();
    expect(
      (await app().fetch(mutate('POST', '/api/view', { streamId: snap.streamId, id: null })))
        .status,
    ).toBe(204);
    const unknown = await app().fetch(mutate('POST', '/api/view', { streamId: 'nope', id: 'web' }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Unknown stream' });
    for (const bad of [{ id: 3, streamId: 'x' }, { id: 'web' }, { streamId: 4, id: null }]) {
      expect((await app().fetch(mutate('POST', '/api/view', bad))).status).toBe(400);
    }
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
    await reader.cancel();
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

describe('token login (B13)', () => {
  const TOKEN = 'a-very-secret-token-0123';
  const COOKIE = `kage_auth=${authCookieValue(TOKEN)}`;
  const withCookie = (r: Request, cookie = COOKIE) => {
    const h = new Headers(r.headers);
    h.set('Cookie', cookie);
    return new Request(r, { headers: h });
  };
  const login = (body: unknown) => mutate('POST', '/api/login', body);
  /** Every response's status, headers and body, to check that none holds the token. */
  const seen: string[] = [];
  const record = async (res: Response) => {
    seen.push(String(res.status), ...[...res.headers].map(([k, v]) => `${k}: ${v}`));
    seen.push(await res.clone().text());
    return res;
  };
  beforeEach(() => {
    seen.length = 0;
  });
  afterEach(() => {
    for (const s of seen) expect(s).not.toContain(TOKEN);
  });

  it('answers 401 without the cookie on the stream, the view and a delete', async () => {
    const a = app(false, TOKEN);
    const cases = [
      req('/api/events'),
      mutate('POST', '/api/view', { streamId: 's', id: null }),
      mutate('DELETE', '/api/sessions/docs'),
      req('/api/nope'),
    ];
    for (const r of cases) {
      const res = await record(await a.fetch(r));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Sign in to Kage' });
    }
    // A cookie made for another token is no better than none.
    const wrong = await a.fetch(
      withCookie(req('/api/events'), `kage_auth=${authCookieValue('x'.repeat(16))}`),
    );
    expect(wrong.status).toBe(401);
    expect(hub.clientCount).toBe(0);
    expect(source.get('docs')).toBeDefined();
  });

  it('with the cookie, the stream, the view and a delete behave as before', async () => {
    const a = app(false, TOKEN);
    const res = await a.fetch(withCookie(req('/api/events')));
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const snap = JSON.parse(
      new TextDecoder().decode((await reader.read()).value).split('data: ')[1] ?? '',
    );
    const view = await a.fetch(
      withCookie(mutate('POST', '/api/view', { streamId: snap.streamId, id: 'web' })),
    );
    expect(view.status).toBe(204);
    expect((await a.fetch(withCookie(mutate('DELETE', '/api/sessions/docs')))).status).toBe(204);
    expect(source.get('docs')).toBeUndefined();
    expect((await a.fetch(withCookie(req('/api/nope')))).status).toBe(404);
    await reader.cancel();
  });

  it('serves the board and its assets without the cookie', async () => {
    const a = app(false, TOKEN);
    expect((await record(await a.fetch(req('/')))).status).toBe(200);
    expect((await record(await a.fetch(req('/app-ABC123.js')))).status).toBe(200);
  });

  it('GET /api/auth: 204 with the cookie, 401 without', async () => {
    const a = app(false, TOKEN);
    expect((await record(await a.fetch(withCookie(req('/api/auth'))))).status).toBe(204);
    const no = await record(await a.fetch(req('/api/auth')));
    expect(no.status).toBe(401);
    expect(await no.json()).toEqual({ error: 'Sign in to Kage' });
  });

  it('POST /api/login still needs X-Kage and the Origin', async () => {
    const a = app(false, TOKEN);
    const body = JSON.stringify({ token: TOKEN });
    const noHeader = await a.fetch(
      req('/api/login', { method: 'POST', headers: { Origin: ORIGIN }, body }),
    );
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get('set-cookie')).toBeNull();
    const foreign = await a.fetch(
      req('/api/login', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: 'http://evil.example' },
        body,
      }),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('set-cookie')).toBeNull();
  });

  it('the right token: 204 with exactly the cookie header', async () => {
    const res = await record(await app(false, TOKEN).fetch(login({ token: TOKEN })));
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBe(setCookieHeader(TOKEN));
  });

  it('marks the cookie Secure only on a request that came over https', async () => {
    const r = login({ token: TOKEN });
    const https = new Request(r.url.replace('http:', 'https:'), {
      method: 'POST',
      headers: r.headers,
      body: JSON.stringify({ token: TOKEN }),
    });
    const res = await app(false, TOKEN).fetch(https);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBe(`${setCookieHeader(TOKEN)}; Secure`);
  });

  it('a wrong token: 401; the 6th wrong try in a minute: 429, even with the right token', async () => {
    const a = app(false, TOKEN);
    for (let i = 0; i < 5; i++) {
      const res = await record(await a.fetch(login({ token: `wrong-token-${i}-padding` })));
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.json()).toEqual({ error: "That token isn't right." });
    }
    const limited = await record(await a.fetch(login({ token: TOKEN })));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('set-cookie')).toBeNull();
    expect(await limited.json()).toEqual({
      error: 'Too many tries. Wait a minute and try again.',
    });
  });

  it('a body that is not exactly {"token": string}: 400, not counted as a failure', async () => {
    const a = app(false, TOKEN);
    for (const bad of [{ token: TOKEN, extra: 1 }, { token: 42 }, {}, [TOKEN], null, 'x']) {
      const res = await record(await a.fetch(login(bad)));
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.json()).toEqual({ error: 'Expected {"token": "<access token>"}' });
    }
    const garbage = await a.fetch(
      req('/api/login', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(garbage.status).toBe(400);
    expect((await a.fetch(login({ token: TOKEN }))).status).toBe(204);
  });

  it('logout always answers 204 and clears the cookie: with it, without it, or a wrong one', async () => {
    const a = app(false, TOKEN);
    for (const r of [
      withCookie(mutate('POST', '/api/logout')),
      mutate('POST', '/api/logout'),
      withCookie(mutate('POST', '/api/logout'), `kage_auth=${authCookieValue('y'.repeat(16))}`),
    ]) {
      const res = await record(await a.fetch(r));
      expect(res.status).toBe(204);
      expect(res.headers.get('set-cookie')).toBe(CLEAR_COOKIE);
    }
    // CSRF still applies.
    const noHeader = await a.fetch(
      req('/api/logout', { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(noHeader.status).toBe(403);
  });

  /** A request as @hono/node-server hands it over: the socket's address in env.incoming. */
  const from = (a: ReturnType<typeof app>, r: Request, remoteAddress: string) =>
    a.fetch(r, { incoming: { socket: { remoteAddress } } });

  it('parallel wrong tries can not race the limiter: exactly 5 get 401, the rest 429', async () => {
    const a = app(false, TOKEN);
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        from(a, login({ token: `wrong-token-${i}-padding` }), '100.64.0.9'),
      ),
    );
    const statuses = all.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
  });

  it('limits per socket address, never by a header; one address locked out leaves another alone', async () => {
    const a = app(false, TOKEN);
    for (let i = 0; i < 5; i++) {
      const r = login({ token: `wrong-token-${i}-padding` });
      expect((await from(a, r, '100.64.0.9')).status).toBe(401);
    }
    // A forwarded-for header does not make the locked-out peer someone else.
    const spoofed = login({ token: TOKEN });
    spoofed.headers.set('X-Forwarded-For', '100.64.0.10');
    expect((await from(a, spoofed, '100.64.0.9')).status).toBe(429);
    expect((await from(a, login({ token: TOKEN }), '100.64.0.10')).status).toBe(204);
  });

  it('30 failures a minute across all addresses refuse every address', async () => {
    const a = app(false, TOKEN);
    for (let i = 0; i < 30; i++) {
      const r = login({ token: `wrong-token-${i}-padding` });
      expect((await from(a, r, `100.64.1.${i}`)).status).toBe(401);
    }
    expect((await from(a, login({ token: TOKEN }), '100.64.2.1')).status).toBe(429);
  });

  it('with no token set, everything passes as in phase 2', async () => {
    const a = app();
    expect((await a.fetch(req('/api/auth'))).status).toBe(204);
    const res = await a.fetch(req('/api/events'));
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect((await a.fetch(mutate('DELETE', '/api/sessions/docs'))).status).toBe(204);
    const l = await a.fetch(login({ token: 'anything' }));
    expect(l.status).toBe(204);
    expect(l.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/projects', () => {
  it('returns the projects from the dep', async () => {
    const res = await app(false, '', true).fetch(req('/api/projects'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PROJECTS);
  });
  it('is 501 without a projects dep', async () => {
    const res = await app().fetch(req('/api/projects'));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Demo mode can't start tasks." });
  });
  it('needs the token when one is set', async () => {
    const token = 'x'.repeat(20);
    expect((await app(false, token, true).fetch(req('/api/projects'))).status).toBe(401);
    const ok = await app(false, token, true).fetch(
      req('/api/projects', { headers: { Cookie: `kage_auth=${authCookieValue(token)}` } }),
    );
    expect(ok.status).toBe(200);
  });
});

describe('GET /api/projects errors (R35)', () => {
  it('wraps a failed listing into a one-sentence body', async () => {
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      token: '',
      projects: async () => {
        throw Object.assign(new Error('spawn git ENOENT'), { stderr: '' });
      },
    });
    const res = await a.fetch(req('/api/projects'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't list the projects: spawn git ENOENT" });
  });
});

describe('POST /api/sessions', () => {
  const BODY = { project: 'api', base: 'main', task: 'Fix it', acceptEdits: false };
  const withLauncher = (start: (body: unknown) => Promise<{ id: string }>, token = '') => {
    let invalidated = 0;
    const bodies: unknown[] = [];
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      token,
      projects: async () => PROJECTS,
      launcher: {
        start: (b: unknown) => {
          bodies.push(b);
          return start(b);
        },
      },
      invalidateProjects: () => {
        invalidated++;
      },
    });
    return { a, bodies, invalidated: () => invalidated };
  };

  it('answers 201 with the id, passes the body through and invalidates the projects', async () => {
    const { a, bodies, invalidated } = withLauncher(async () => ({ id: 'k-1' }));
    const res = await a.fetch(mutate('POST', '/api/sessions', BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'k-1' });
    expect(bodies).toEqual([BODY]);
    expect(invalidated()).toBe(1);
  });

  it('passes LaunchError statuses and messages through', async () => {
    for (const status of [400, 404, 422, 503] as const) {
      const { a } = withLauncher(async () => {
        throw new LaunchError(status, `Problem ${status}.`);
      });
      const res = await a.fetch(mutate('POST', '/api/sessions', BODY));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `Problem ${status}.` });
    }
  });

  it('a failed launch still invalidates the projects (a rollback may have run)', async () => {
    const { a, invalidated } = withLauncher(async () => {
      throw new LaunchError(422, "tmux couldn't open a window: x");
    });
    await a.fetch(mutate('POST', '/api/sessions', BODY));
    expect(invalidated()).toBe(1);
  });

  it('a body that is not JSON reaches the launcher as undefined (it answers 400)', async () => {
    const { a, bodies } = withLauncher(async () => ({ id: 'k-1' }));
    await a.fetch(
      req('/api/sessions', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(bodies).toEqual([undefined]);
  });

  it('an unexpected error is a 500 with a one-sentence body', async () => {
    const { a } = withLauncher(async () => {
      throw new Error('boom\nstack');
    });
    const res = await a.fetch(mutate('POST', '/api/sessions', BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Kage couldn't start the task: boom" });
  });

  it('is 501 in demo mode', async () => {
    const res = await app(true).fetch(mutate('POST', '/api/sessions', BODY));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Demo mode can't start tasks." });
  });

  it('needs X-Kage and Origin, and the token when one is set', async () => {
    const { a, bodies } = withLauncher(async () => ({ id: 'k-1' }));
    const res = await a.fetch(
      req('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(BODY),
      }),
    );
    expect(res.status).toBe(403);
    const token = 'x'.repeat(20);
    const t = withLauncher(async () => ({ id: 'k-1' }), token);
    expect((await t.a.fetch(mutate('POST', '/api/sessions', BODY))).status).toBe(401);
    expect(bodies).toEqual([]);
    expect(t.bodies).toEqual([]);
  });
});

describe('POST /api/sessions/:id/answer, /reply, /stop (Task 7)', () => {
  type Call = [string, string, unknown?, unknown?];
  const withControls = (fail: Error | null = null, token = '') => {
    const calls: Call[] = [];
    const act = async (call: Call) => {
      calls.push(call);
      if (fail) throw fail;
    };
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      token,
      controls: {
        answer: (id, option, question) => act(['answer', id, option, question]),
        reply: (id, text) => act(['reply', id, text]),
        stop: (id) => act(['stop', id]),
      },
    });
    return { a, calls };
  };

  it('answer {option, question} → 204 and calls answer(id, option, question) (R36)', async () => {
    const { a, calls } = withControls();
    const res = await a.fetch(
      mutate('POST', '/api/sessions/k-1/answer', { option: 2, question: 'Proceed?' }),
    );
    expect(res.status).toBe(204);
    expect(calls).toEqual([['answer', 'k-1', 2, 'Proceed?']]);
  });

  it('reply {text} → 204 with the trimmed text', async () => {
    const { a, calls } = withControls();
    const res = await a.fetch(mutate('POST', '/api/sessions/k-1/reply', { text: '  use b.sh ' }));
    expect(res.status).toBe(204);
    expect(calls).toEqual([['reply', 'k-1', 'use b.sh']]);
  });

  it('stop → 204, with or without a body; an external id reaches the controls as is', async () => {
    const { a, calls } = withControls();
    expect((await a.fetch(mutate('POST', '/api/sessions/k-1/stop'))).status).toBe(204);
    expect((await a.fetch(mutate('POST', '/api/sessions/ext-@3/stop', {}))).status).toBe(204);
    expect(calls).toEqual([
      ['stop', 'k-1'],
      ['stop', 'ext-@3'],
    ]);
  });

  it('validates the bodies (400) before any action', async () => {
    const { a, calls } = withControls();
    for (const [path, body] of [
      ['answer', { option: 0, question: 'Q?' }],
      ['answer', { option: '1', question: 'Q?' }],
      ['answer', { option: 1, question: 'Q?', enter: true }],
      ['answer', { option: 1 }],
      ['answer', { option: 1, question: '' }],
      ['answer', undefined],
      ['reply', { text: '!rm -rf ~' }],
      ['reply', { text: '/exit' }],
      ['reply', { text: '1' }],
      ['reply', { text: 'a\nb' }],
      ['reply', { text: 'a\u001b[2J' }],
      ['reply', { text: 'x'.repeat(4001) }],
      ['reply', { text: '' }],
      ['stop', { force: true }],
    ] as const) {
      const res = await a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(Object.keys((await res.json()) as object)).toEqual(['error']);
    }
    const notJson = await a.fetch(
      req('/api/sessions/k-1/answer', {
        method: 'POST',
        headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{"option":',
      }),
    );
    expect(notJson.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('maps ActionError statuses and messages', async () => {
    for (const status of [403, 404, 409, 422] as const) {
      const { a } = withControls(new ActionError(status, `Problem ${status}.`));
      for (const [path, body] of [
        ['answer', { option: 1, question: 'Q?' }],
        ['reply', { text: 'hi' }],
        ['stop', undefined],
      ] as const) {
        const res = await a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: `Problem ${status}.` });
      }
    }
  });

  it('an unexpected error is a 500 with a one-sentence body', async () => {
    const { a } = withControls(new Error('boom\nstack'));
    const res = await a.fetch(mutate('POST', '/api/sessions/k-1/stop'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Kage couldn't send that to the session: boom" });
  });

  it('is 501 in demo mode: "Demo mode can\'t run tasks."', async () => {
    for (const [path, body] of [
      ['answer', { option: 1, question: 'Q?' }],
      ['reply', { text: 'hi' }],
      ['stop', undefined],
    ] as const) {
      const res = await app(true).fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "Demo mode can't run tasks." });
    }
  });

  it('needs X-Kage and Origin, and the token when one is set', async () => {
    const { a, calls } = withControls();
    for (const headers of [
      { 'Content-Type': 'application/json' } as Record<string, string>,
      { 'Content-Type': 'application/json', 'X-Kage': '1' },
      { 'Content-Type': 'application/json', Origin: ORIGIN },
      { 'Content-Type': 'application/json', 'X-Kage': '1', Origin: 'http://evil.example' },
    ]) {
      for (const path of ['answer', 'reply', 'stop']) {
        const res = await a.fetch(
          req(`/api/sessions/k-1/${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(
              path === 'answer' ? { option: 1, question: 'Q?' } : { text: 'hi' },
            ),
          }),
        );
        expect(res.status).toBe(403);
      }
    }
    const t = withControls(null, 'x'.repeat(20));
    for (const path of ['answer', 'reply', 'stop']) {
      const body =
        path === 'answer'
          ? { option: 1, question: 'Q?' }
          : path === 'reply'
            ? { text: 'hi' }
            : undefined;
      expect((await t.a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body))).status).toBe(401);
    }
    expect(calls).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('GET is not a way in', async () => {
    const { a, calls } = withControls();
    const res = await a.fetch(req('/api/sessions/k-1/stop'));
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
