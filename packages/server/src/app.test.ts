import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, DEMO } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { type Auth, authCookieName, clearCookieHeader, SessionStore } from './auth.ts';
import { ActionError } from './control/actions.ts';
import { LaunchError } from './control/launcher.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';
import { LiveSource, type LiveSourceDeps } from './live-source.ts';
import { DiffError, DiffService } from './preview/diff.ts';

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
  await writeFile(join(dist, 'term-GHI789.js'), 'export const t = 1;');
  await writeFile(join(dist, 'term-JKL012.css'), '.xterm{}');
  // Phase 5 (R78): shared chunks and the lazy entries are hashed the same way.
  await writeFile(join(dist, 'chunk-abc123.js'), 'export const c = 1;');
  await writeFile(join(dist, 'diff-abc123.js'), 'export const d = 1;');
  await writeFile(join(dist, 'palette-abc123.js'), 'export const p = 1;');
  // Hardening Task 14 (performance P6): three more lazy entries.
  for (const name of ['newtask', 'archived', 'notify']) {
    await writeFile(join(dist, `${name}-abc123.js`), 'export const l = 1;');
  }
  await writeFile(join(dist, 'other-abc123.js'), 'export const o = 1;');
  await writeFile(join(dist, 'app-DEF456.css'), `.k-app{color:red}${'.a{b:c}'.repeat(100)}`);
  await writeFile(join(dist, 'fonts', 'geist-latin-wght-normal.woff2'), new Uint8Array([1, 2, 3]));
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
/** An Auth as serve.ts builds it: the config's token, a fresh session store, the port's cookie. */
const authFor = (token = ''): Auth => ({
  token,
  sessions: new SessionStore(),
  cookie: authCookieName(8080),
});
const app = (demo = false, token = '', projects = false, auth = authFor(token)) =>
  createApp({
    source,
    hub,
    assets,
    allowed,
    auth,
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
/** A delete's body: the counts the confirmation showed. */
const SEEN = { unpushed: 0, uncommitted: 0, ignored: 0 };
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
    expect(assets.get('/fonts/geist-latin-wght-normal.woff2')?.type).toBe('font/woff2');
    expect(assets.get('/app-ABC123.js')?.immutable).toBe(true);
    // The terminal chunk is hashed the same way (Task 13).
    expect(assets.get('/term-GHI789.js')?.immutable).toBe(true);
    expect(assets.get('/term-JKL012.css')?.immutable).toBe(true);
    expect(assets.get('/chunk-abc123.js')?.immutable).toBe(true);
    expect(assets.get('/diff-abc123.js')?.immutable).toBe(true);
    // A lazy palette (ruling PF5, F7) is ready too; an unknown name is not.
    expect(assets.get('/palette-abc123.js')?.immutable).toBe(true);
    for (const name of ['newtask', 'archived', 'notify']) {
      expect(assets.get(`/${name}-abc123.js`)?.immutable, name).toBe(true);
    }
    expect(assets.get('/other-abc123.js')?.immutable).toBe(false);
    expect(index?.immutable).toBe(false);
    expect(assets.get('/fonts/geist-latin-wght-normal.woff2')?.immutable).toBe(false);
  });

  it('compresses one file at a time (R100: concurrent brotli encoders leave idle RSS behind)', async () => {
    let inFlight = 0;
    let most = 0;
    const seen: number[] = [];
    const one = async (body: Uint8Array) => {
      inFlight++;
      most = Math.max(most, inFlight);
      seen.push(body.length);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { gzip: body, br: body };
    };
    const loaded = await loadAssets(dist, one);
    expect(most).toBe(1);
    // Every compressible file went through it; fonts and images did not.
    expect(seen).toHaveLength(
      [...loaded.keys()].filter((k) => !/\.(woff2|png|jpe?g|webp)$/.test(k) && k !== '/').length,
    );
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
    for (const path of ['/chunk-abc123.js', '/diff-abc123.js']) {
      const r = await app().fetch(req(path));
      expect(r.status, path).toBe(200);
      expect(r.headers.get('cache-control'), path).toBe('public, max-age=31536000, immutable');
    }

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
      req('/fonts/geist-latin-wght-normal.woff2', { headers: { 'Accept-Encoding': 'br, gzip' } }),
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

  it('every answer carries CORP and COOP same-origin, and the CSP has object-src and frame-src none', async () => {
    const a = app();
    const answers = [
      await a.fetch(req('/')),
      await a.fetch(req('/app-ABC123.js')),
      await a.fetch(req('/nope.js')),
      await a.fetch(req('/api/nope')),
      await a.fetch(req('/api/auth')),
      await a.fetch(mutate('POST', '/api/view', {})),
      // Refused by the guards, too.
      await a.fetch(new Request('http://evil:8080/', { headers: { Host: 'evil:8080' } })),
      await a.fetch(req('/api/view', { method: 'POST' })),
    ];
    for (const res of answers) {
      const where = `${res.status} ${res.url}`;
      expect(res.headers.get('cross-origin-resource-policy'), where).toBe('same-origin');
      expect(res.headers.get('cross-origin-opener-policy'), where).toBe('same-origin');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, where).toContain("object-src 'none'");
      expect(csp, where).toContain("frame-src 'none'");
    }
  });

  it('/api JSON answers are no-store', async () => {
    const a = app(false, '', true);
    const answers = [
      await a.fetch(req('/api/projects')),
      await a.fetch(req('/api/nope')),
      await a.fetch(req('/api/sessions')),
      await a.fetch(mutate('POST', '/api/view', {})),
      await app(false, 'a-very-secret-token-0123').fetch(req('/api/projects')),
    ];
    for (const res of answers) {
      expect(res.headers.get('content-type'), String(res.status)).toContain('application/json');
      expect(res.headers.get('cache-control'), String(res.status)).toBe('no-store');
    }
    // The event stream keeps its own; assets keep theirs.
    const sse = await a.fetch(req('/api/events'));
    expect(sse.headers.get('cache-control')).toBe('no-cache, no-transform');
    await sse.body?.cancel();
    expect((await a.fetch(req('/app-ABC123.js'))).headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it("keeps the strict CSP for the terminal too: no 'unsafe-inline', no nonce (R55, R60)", async () => {
    for (const path of ['/', '/term-GHI789.js', '/term-JKL012.css', '/api/nope']) {
      const csp = (await app().fetch(req(path))).headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("style-src 'self'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).not.toMatch(/unsafe-|nonce-/);
    }
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
    const ok = await app().fetch(mutate('DELETE', '/api/sessions/docs', SEEN));
    expect(ok.status).toBe(204);
    expect(source.get('docs')).toBeUndefined();

    const missing = await app().fetch(mutate('DELETE', '/api/sessions/nope', SEEN));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await missing.json()).toEqual({ error: 'No session with id nope.' });
  });

  it('answers 501 when the live source cannot delete yet', async () => {
    const live = new LiveSource({} as LiveSourceDeps);
    const liveHub = new EventHub(live, 'my-pc', '/p');
    const liveApp = createApp({ source: live, hub: liveHub, assets, allowed, auth: authFor() });
    const res = await liveApp.fetch(mutate('DELETE', '/api/sessions/k-1', SEEN));
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
    expect(await unknown.json()).toEqual({ error: 'Unknown stream.' });
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

  it('every demo refusal is the one demo sentence (usability U6)', async () => {
    expect(DEMO).toBe(
      'This is the demo, so nothing here changes. Install Kage to run your own sessions.',
    );
    const demo = app(true);
    for (const r of [
      req('/api/projects'),
      mutate('POST', '/api/sessions', { task: 't', project: 'p', branch: 'main' }),
      mutate('POST', '/api/sessions/k-1/answer', { option: 1, question: 'Q?' }),
      mutate('POST', '/api/sessions/k-1/reply', { text: 'hi' }),
      mutate('POST', '/api/sessions/k-1/stop'),
      mutate('POST', '/api/sessions/k-1/pin', { pinned: true }),
      mutate('POST', '/api/sessions/k-1/archive', { archived: true }),
      mutate('POST', '/api/sessions/k-1/resume'),
      req('/api/archive'),
      req('/api/sessions/docs/diff'),
    ]) {
      const res = await demo.fetch(r);
      const where = `${r.method} ${new URL(r.url).pathname}`;
      expect(`${where} ${res.status}`).toBe(`${where} 501`);
      expect(await res.json()).toEqual({ error: DEMO });
    }
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

describe('GET /api/sessions/:id/terminal without an upgrade (Task 12)', () => {
  it('answers 426 with a sentence', async () => {
    const res = await app().fetch(req('/api/sessions/x/terminal'));
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: 'Open the terminal with a WebSocket.' });
  });
});

describe('token login (B13)', () => {
  const TOKEN = 'a-very-secret-token-0123';
  const withCookie = (r: Request, cookie: string) => {
    const h = new Headers(r.headers);
    h.set('Cookie', cookie);
    return new Request(r, { headers: h });
  };
  const login = (body: unknown) => mutate('POST', '/api/login', body);
  /** Signs in with the right token and returns the Cookie header the browser would send. */
  const signIn = async (a: ReturnType<typeof app>, remoteAddress?: string) => {
    const r = login({ token: TOKEN });
    const res = remoteAddress === undefined ? await a.fetch(r) : await from(a, r, remoteAddress);
    expect(res.status).toBe(204);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  };
  /** A request as @hono/node-server hands it over: the socket's address in env.incoming. */
  const from = (a: ReturnType<typeof app>, r: Request, remoteAddress: string) =>
    a.fetch(r, { incoming: { socket: { remoteAddress } } });
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
      mutate('DELETE', '/api/sessions/docs', SEEN),
      req('/api/nope'),
    ];
    for (const r of cases) {
      const res = await record(await a.fetch(r));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Sign in to Kage' });
    }
    // A made-up session id is no better than none.
    const wrong = await a.fetch(withCookie(req('/api/events'), `kage_auth_8080=${'x'.repeat(43)}`));
    expect(wrong.status).toBe(401);
    expect(hub.clientCount).toBe(0);
    expect(source.get('docs')).toBeDefined();
  });

  it('with the cookie, the stream, the view and a delete behave as before', async () => {
    const a = app(false, TOKEN);
    const c = await signIn(a);
    const res = await a.fetch(withCookie(req('/api/events'), c));
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const snap = JSON.parse(
      new TextDecoder().decode((await reader.read()).value).split('data: ')[1] ?? '',
    );
    const view = await a.fetch(
      withCookie(mutate('POST', '/api/view', { streamId: snap.streamId, id: 'web' }), c),
    );
    expect(view.status).toBe(204);
    expect(
      (await a.fetch(withCookie(mutate('DELETE', '/api/sessions/docs', SEEN), c))).status,
    ).toBe(204);
    expect(source.get('docs')).toBeUndefined();
    expect((await a.fetch(withCookie(req('/api/nope'), c))).status).toBe(404);
    await reader.cancel();
  });

  it('serves the board and its assets without the cookie', async () => {
    const a = app(false, TOKEN);
    expect((await record(await a.fetch(req('/')))).status).toBe(200);
    expect((await record(await a.fetch(req('/app-ABC123.js')))).status).toBe(200);
  });

  it('GET /api/auth: 204 with the cookie, 401 without', async () => {
    const a = app(false, TOKEN);
    const c = await signIn(a);
    expect((await record(await a.fetch(withCookie(req('/api/auth'), c)))).status).toBe(204);
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

  it('the right token: 204 with a fresh session cookie for this port; each login gets its own', async () => {
    const auth = authFor(TOKEN);
    const a = app(false, TOKEN, false, auth);
    const res = await record(await a.fetch(login({ token: TOKEN })));
    expect(res.status).toBe(204);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(
      /^kage_auth_8080=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/,
    );
    expect(auth.sessions.size).toBe(1);
    const again = await record(await a.fetch(login({ token: TOKEN })));
    expect(again.headers.get('set-cookie')).not.toBe(header);
    expect(auth.sessions.size).toBe(2);
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
    expect(res.headers.get('set-cookie')).toMatch(/; Max-Age=2592000; Secure$/);
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
      expect(await res.json()).toEqual({ error: 'Expected {"token": "<access token>"}.' });
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
    const c = await signIn(a);
    for (const r of [
      withCookie(mutate('POST', '/api/logout'), c),
      mutate('POST', '/api/logout'),
      withCookie(mutate('POST', '/api/logout'), `kage_auth_8080=${'y'.repeat(43)}`),
    ]) {
      const res = await record(await a.fetch(r));
      expect(res.status).toBe(204);
      expect(res.headers.get('set-cookie')).toBe(clearCookieHeader('kage_auth_8080'));
    }
    // CSRF still applies.
    const noHeader = await a.fetch(
      req('/api/logout', { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(noHeader.status).toBe(403);
  });

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

  it('30 failures a minute across all addresses refuse every address that has failed', async () => {
    const a = app(false, TOKEN);
    for (let i = 0; i < 30; i++) {
      const r = login({ token: `wrong-token-${i}-padding` });
      expect((await from(a, r, `100.64.1.${i}`)).status).toBe(401);
    }
    expect((await from(a, login({ token: TOKEN }), '100.64.1.0')).status).toBe(429);
  });

  it('the global ceiling no longer blocks an address with no recent failures (security M2)', async () => {
    const a = app(false, TOKEN);
    // The review's probe: six addresses fail five times each.
    for (let p = 0; p < 6; p++) {
      for (let i = 0; i < 5; i++) {
        const r = login({ token: `wrong-token-${i}-padding` });
        expect((await from(a, r, `100.64.1.${p}`)).status).toBe(401);
      }
    }
    expect((await from(a, login({ token: TOKEN }), '100.64.1.0')).status).toBe(429);
    // A seventh address with the right token gets in.
    expect((await from(a, login({ token: TOKEN }), '100.64.0.9')).status).toBe(204);
  });

  it('over Tailscale IPv6, a locked-out node does not lock out the owner (each node is its own /128)', async () => {
    const a = app(false, TOKEN);
    const attacker = 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b241';
    for (let i = 0; i < 5; i++) {
      const r = login({ token: `wrong-token-${i}-padding` });
      expect((await from(a, r, attacker)).status).toBe(401);
    }
    expect((await from(a, login({ token: TOKEN }), attacker)).status).toBe(429);
    const owner = 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240';
    const c = await signIn(a, owner);
    // The attacker's streams don't count against the owner's.
    const open: ReadableStream<Uint8Array>[] = [];
    const mine = await signIn(a, attacker.replace(/b241$/, 'b242'));
    for (let i = 0; i < 16; i++) {
      const res = await from(
        a,
        withCookie(req('/api/events'), mine),
        attacker.replace(/b241$/, 'b242'),
      );
      open.push(res.body as ReadableStream<Uint8Array>);
    }
    const res = await from(a, withCookie(req('/api/events'), c), owner);
    expect(res.status).toBe(200);
    for (const s of [...open, res.body]) await s?.cancel();
  });

  it('IPv6 addresses in one /64 share a limiter bucket and the stream cap; the cookie stays per address', async () => {
    const a = app(false, TOKEN);
    // Five failures spread over five addresses of one /64: the sixth address in it waits.
    for (let i = 1; i <= 5; i++) {
      const r = login({ token: `wrong-token-${i}-padding` });
      expect((await from(a, r, `2001:db8:1:2::${i}`)).status).toBe(401);
    }
    expect((await from(a, login({ token: TOKEN }), '2001:db8:1:2::6')).status).toBe(429);
    expect((await from(a, login({ token: TOKEN }), '2001:db8:1:3::1')).status).toBe(204);
    const c = await signIn(a, '2001:db8:1:3::1');
    // The session stays bound to its exact address.
    expect((await from(a, withCookie(req('/api/auth'), c), '2001:db8:1:3::2')).status).toBe(401);
    const open: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await from(a, withCookie(req('/api/events'), c), '2001:db8:1:3::1');
      expect(res.status).toBe(200);
      open.push(res.body as ReadableStream<Uint8Array>);
    }
    expect(hub.streamsFrom('2001:db8:1:3::/64')).toBe(16);
    for (const s of open) await s.cancel();
  });

  it('a 17th stream from one peer gets 429; another peer still connects', async () => {
    const a = app(false, TOKEN);
    const mine = await signIn(a, '100.64.0.9');
    const theirs = await signIn(a, '100.64.0.10');
    const open: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await from(a, withCookie(req('/api/events'), mine), '100.64.0.9');
      expect(res.status).toBe(200);
      open.push(res.body as ReadableStream<Uint8Array>);
    }
    expect(hub.streamsFrom('100.64.0.9')).toBe(16);
    const refused = await record(await from(a, withCookie(req('/api/events'), mine), '100.64.0.9'));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'Too many open boards from this address.' });
    expect(hub.clientCount).toBe(16);
    const other = await from(a, withCookie(req('/api/events'), theirs), '100.64.0.10');
    expect(other.status).toBe(200);
    expect(hub.streamsFrom('100.64.0.10')).toBe(1);
    // One closed, and the next one is let in.
    await open.pop()?.cancel();
    const again = await from(a, withCookie(req('/api/events'), mine), '100.64.0.9');
    expect(again.status).toBe(200);
    for (const s of [...open, again.body, other.body]) await s?.cancel();
    expect(hub.clientCount).toBe(0);
  });

  it("logout revokes its session: that cookie gets 401, another login's still 204", async () => {
    const auth = authFor(TOKEN);
    const a = app(false, TOKEN, false, auth);
    const mine = await signIn(a);
    const theirs = await signIn(a);
    const heard: string[] = [];
    auth.sessions.onRevoke((k) => heard.push(k));
    expect((await a.fetch(withCookie(req('/api/auth'), mine))).status).toBe(204);
    const out = await record(await a.fetch(withCookie(mutate('POST', '/api/logout'), mine)));
    expect(out.status).toBe(204);
    expect(heard).toHaveLength(1);
    expect((await a.fetch(withCookie(req('/api/auth'), mine))).status).toBe(401);
    expect((await a.fetch(withCookie(req('/api/events'), mine))).status).toBe(401);
    expect((await a.fetch(withCookie(req('/api/auth'), theirs))).status).toBe(204);
    expect(auth.sessions.size).toBe(1);
  });

  it('a wrong token still answers 401 and counts toward the limiter', async () => {
    const a = app(false, TOKEN);
    for (let i = 0; i < 4; i++) {
      expect(
        (await from(a, login({ token: `wrong-token-${i}-padding` }), '100.64.0.9')).status,
      ).toBe(401);
    }
    // A right login in between doesn't reset the count: only failures count.
    expect((await signIn(a, '100.64.0.9')).startsWith('kage_auth_8080=')).toBe(true);
    expect((await from(a, login({ token: 'wrong-token-4-padding' }), '100.64.0.9')).status).toBe(
      401,
    );
    expect((await from(a, login({ token: TOKEN }), '100.64.0.9')).status).toBe(429);
  });

  it('a cookie is good only from the address that signed in (::ffff: mapped is the same)', async () => {
    const a = app(false, TOKEN);
    const c = await signIn(a, '::ffff:100.64.0.9');
    expect((await from(a, withCookie(req('/api/auth'), c), '100.64.0.9')).status).toBe(204);
    expect((await from(a, withCookie(req('/api/auth'), c), '100.64.0.10')).status).toBe(401);
    expect((await from(a, withCookie(req('/api/events'), c), '100.64.0.10')).status).toBe(401);
    expect(hub.clientCount).toBe(0);
  });

  it('a new app with a new store (a restart) refuses the old cookie', async () => {
    const c = await signIn(app(false, TOKEN));
    expect((await app(false, TOKEN).fetch(withCookie(req('/api/auth'), c))).status).toBe(401);
  });

  it('logout closes the streams that session opened, and no others (F6)', async () => {
    const auth = authFor(TOKEN);
    const a = app(false, TOKEN, false, auth);
    auth.sessions.onRevoke((k) => hub.dropOwner(k));
    const mine = await signIn(a);
    const theirs = await signIn(a);
    const r1 = (
      (await a.fetch(withCookie(req('/api/events'), mine))).body as ReadableStream<Uint8Array>
    ).getReader();
    const r2 = (
      (await a.fetch(withCookie(req('/api/events'), theirs))).body as ReadableStream<Uint8Array>
    ).getReader();
    await r1.read();
    await r2.read();
    expect(hub.clientCount).toBe(2);
    await a.fetch(withCookie(mutate('POST', '/api/logout'), mine));
    await expect(r1.read()).rejects.toThrow();
    expect(hub.clientCount).toBe(1);
    await r2.cancel();
  });

  it('with no token set, everything passes as in phase 2', async () => {
    const a = app();
    expect((await a.fetch(req('/api/auth'))).status).toBe(204);
    const res = await a.fetch(req('/api/events'));
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect((await a.fetch(mutate('DELETE', '/api/sessions/docs', SEEN))).status).toBe(204);
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
    expect(await res.json()).toEqual({ error: DEMO });
  });
  it('needs the token when one is set', async () => {
    const token = 'x'.repeat(20);
    expect((await app(false, token, true).fetch(req('/api/projects'))).status).toBe(401);
    const a = app(false, token, true);
    const login = await a.fetch(mutate('POST', '/api/login', { token }));
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const ok = await a.fetch(req('/api/projects', { headers: { Cookie: cookie } }));
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
      auth: authFor(),
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
      auth: authFor(token),
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
    expect(await res.json()).toEqual({ error: DEMO });
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
      auth: authFor(token),
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

  it('is 501 in demo mode, with the demo sentence', async () => {
    for (const [path, body] of [
      ['answer', { option: 1, question: 'Q?' }],
      ['reply', { text: 'hi' }],
      ['stop', undefined],
    ] as const) {
      const res = await app(true).fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: DEMO });
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

describe('POST /api/sessions/:id/pin, /archive and GET /api/archive (phase 4 Task 4)', () => {
  type Call = [string, string, unknown];
  const ARCHIVED = [
    { id: 'k-2', project: 'shop', task: 'Newer', branch: 'kage/newer', archivedAt: 20 },
    { id: 'k-1', project: 'shop', task: 'Older', branch: 'kage/older', archivedAt: 10 },
  ];
  const withFinish = (fail: Error | null = null, token = '') => {
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
      auth: authFor(token),
      finish: {
        pin: (id, pinned) => act(['pin', id, pinned]),
        archive: (id, archived) => act(['archive', id, archived]),
        remove: (id, seen) => act(['remove', id, seen]),
      },
      archivedList: () => ARCHIVED.map((s) => ({ ...s })),
    });
    return { a, calls };
  };

  it('pin {pinned} and archive {archived} → 204 and reach the finish actions', async () => {
    const { a, calls } = withFinish();
    for (const [path, body] of [
      ['pin', { pinned: true }],
      ['pin', { pinned: false }],
      ['archive', { archived: true }],
      ['archive', { archived: false }],
    ] as const) {
      const res = await a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
      expect(res.status).toBe(204);
    }
    expect(calls).toEqual([
      ['pin', 'k-1', true],
      ['pin', 'k-1', false],
      ['archive', 'k-1', true],
      ['archive', 'k-1', false],
    ]);
  });

  it('validates the bodies (400, the exact sentence) before any action', async () => {
    const { a, calls } = withFinish();
    for (const [path, body, error] of [
      ['pin', { pinned: 'yes' }, 'Expected {"pinned": true|false}'],
      ['pin', [], 'Expected {"pinned": true|false}'],
      ['pin', undefined, 'Expected {"pinned": true|false}'],
      ['pin', { pinned: true, x: 1 }, 'Unexpected field "x"'],
      ['archive', { archived: 1 }, 'Expected {"archived": true|false}'],
      ['archive', {}, 'Expected {"archived": true|false}'],
    ] as const) {
      const res = await a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(calls).toEqual([]);
  });

  it('maps ActionError statuses (403, 404, 409, 422) and messages; anything else is a one-sentence 500', async () => {
    for (const status of [403, 404, 409, 422] as const) {
      const { a } = withFinish(new ActionError(status, `Problem ${status}.`));
      for (const [path, body] of [
        ['pin', { pinned: true }],
        ['archive', { archived: true }],
      ] as const) {
        const res = await a.fetch(mutate('POST', `/api/sessions/k-1/${path}`, body));
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: `Problem ${status}.` });
      }
    }
    const { a } = withFinish(new Error('disk full\nstack'));
    const res = await a.fetch(mutate('POST', '/api/sessions/k-1/archive', { archived: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Kage couldn't change the session: disk full" });
  });

  it('GET /api/archive returns the archived list', async () => {
    const { a } = withFinish();
    const res = await a.fetch(req('/api/archive'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: ARCHIVED });
  });

  it('is 501 in demo mode, with the demo sentence', async () => {
    for (const r of [
      mutate('POST', '/api/sessions/k-1/pin', { pinned: true }),
      mutate('POST', '/api/sessions/k-1/archive', { archived: true }),
      req('/api/archive'),
    ]) {
      const res = await app(true).fetch(r);
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: DEMO });
    }
  });

  it('needs X-Kage and Origin on the posts, and the token everywhere when one is set', async () => {
    const { a, calls } = withFinish();
    for (const headers of [
      { 'Content-Type': 'application/json' } as Record<string, string>,
      { 'Content-Type': 'application/json', 'X-Kage': '1' },
      { 'Content-Type': 'application/json', Origin: ORIGIN },
      { 'Content-Type': 'application/json', 'X-Kage': '1', Origin: 'http://evil.example' },
    ]) {
      for (const [path, body] of [
        ['pin', { pinned: true }],
        ['archive', { archived: true }],
      ] as const) {
        const res = await a.fetch(
          req(`/api/sessions/k-1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
        );
        expect(res.status).toBe(403);
      }
    }
    const t = withFinish(null, 'x'.repeat(20));
    expect(
      (await t.a.fetch(mutate('POST', '/api/sessions/k-1/pin', { pinned: true }))).status,
    ).toBe(401);
    expect(
      (await t.a.fetch(mutate('POST', '/api/sessions/k-1/archive', { archived: true }))).status,
    ).toBe(401);
    expect((await t.a.fetch(req('/api/archive'))).status).toBe(401);
    expect(calls).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it("the snapshot's archived count matches GET /api/archive (live source)", async () => {
    const rec = (kageId: string, archived: boolean, archivedAt: number | null) => ({
      kageId,
      windowId: null,
      project: 'shop',
      task: `Task ${kageId}`,
      branch: `kage/${kageId}`,
      worktree: `/p/shop/.worktrees/${kageId}`,
      createdAt: 1,
      pinned: false,
      archived,
      sessionId: null,
      transcriptPath: null,
      base: 'main',
      permissionMode: 'default' as const,
      baseCommit: null,
      doneAt: null,
      archivedAt,
      restoredAt: null,
      unpinnedAt: null,
    });
    const records = [rec('k-1', true, 10), rec('k-2', false, null), rec('k-3', true, 30)];
    const live = new LiveSource({
      tmux: {
        ensureSession: async () => {},
        listWindows: async () => [],
        capturePane: async () => '',
        clearPlaceholder: async () => {},
      },
      watcher: { on: () => () => {}, start: () => {}, stop: () => {} },
      hooks: { on: () => () => {} },
      store: { load: async () => records.map((r) => ({ ...r })), save: async () => {} },
      tail: () => {
        throw new Error('no transcripts here');
      },
      projectsRoot: '/p',
    });
    await live.start();
    const liveHub = new EventHub(live, 'my-pc', '/p');
    const a = createApp({
      source: live,
      hub: liveHub,
      assets,
      allowed,
      auth: authFor(),
      finish: { pin: async () => {}, archive: async () => {}, remove: async () => {} },
      archivedList: () => live.archivedList(),
    });
    const res = await a.fetch(req('/api/events'));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    const snap = JSON.parse(text.slice('event: snapshot\ndata: '.length));
    await reader.cancel();
    const list = (await (await a.fetch(req('/api/archive'))).json()) as {
      sessions: { id: string }[];
    };
    expect(snap.archived).toBe(2);
    expect(list.sessions.map((s) => s.id)).toEqual(['k-3', 'k-1']);
    expect(snap.sessions.map((s: { id: string }) => s.id)).toEqual(['k-2']);
    liveHub.close();
    await live.stop();
  });
});

describe('DELETE /api/sessions/:id {unpushed, uncommitted, ignored} (phase 4 Task 6)', () => {
  const EXPECTED_DELETE =
    'Expected {"unpushed": <count>, "uncommitted": <count>, "ignored": <count>}';
  const withRemove = (fail: Error | null = null, token = '') => {
    const calls: [string, unknown][] = [];
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      auth: authFor(token),
      finish: {
        pin: async () => {},
        archive: async () => {},
        remove: async (id, seen) => {
          calls.push([id, seen]);
          if (fail) throw fail;
        },
      },
    });
    return { a, calls };
  };

  it('live: 204 and the confirmed counts reach FinishActions.remove; the demo source is not touched', async () => {
    const { a, calls } = withRemove();
    const res = await a.fetch(
      mutate('DELETE', '/api/sessions/k-1', { unpushed: 1, uncommitted: 2, ignored: 3 }),
    );
    expect(res.status).toBe(204);
    expect(calls).toEqual([['k-1', { unpushed: 1, uncommitted: 2, ignored: 3 }]]);
  });

  it('validates the body (400, the exact sentence) in live and demo modes, before any action', async () => {
    const bad: [unknown, string][] = [
      [undefined, EXPECTED_DELETE],
      [{}, EXPECTED_DELETE],
      [{ unpushed: -1, uncommitted: 0, ignored: 0 }, EXPECTED_DELETE],
      [{ unpushed: 0, uncommitted: 0 }, EXPECTED_DELETE],
      [{ unpushed: 1.5, uncommitted: 0, ignored: 0 }, EXPECTED_DELETE],
      [{ unpushed: 0, uncommitted: 0, ignored: 0, force: true }, 'Unexpected field "force"'],
    ];
    const { a, calls } = withRemove();
    for (const [body, error] of bad) {
      for (const target of [a, app(true)]) {
        const res = await target.fetch(mutate('DELETE', '/api/sessions/docs', body));
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error });
      }
    }
    const notJson = await app(true).fetch(
      req('/api/sessions/docs', {
        method: 'DELETE',
        headers: { 'X-Kage': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(notJson.status).toBe(400);
    expect(calls).toEqual([]);
    expect(source.get('docs')).toBeDefined();
  });

  it('demo mode still removes the session (DemoSource.remove), with any valid counts', async () => {
    const res = await app(true).fetch(
      mutate('DELETE', '/api/sessions/docs', { unpushed: 3, uncommitted: 1, ignored: 0 }),
    );
    expect(res.status).toBe(204);
    expect(source.get('docs')).toBeUndefined();
  });

  it('maps ActionError statuses (403, 404, 409, 422) and messages; anything else is a one-sentence 500', async () => {
    for (const status of [403, 404, 409, 422] as const) {
      const { a } = withRemove(new ActionError(status, `Problem ${status}.`));
      const res = await a.fetch(mutate('DELETE', '/api/sessions/k-1', SEEN));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `Problem ${status}.` });
    }
    const { a } = withRemove(new Error('disk full\nstack'));
    const res = await a.fetch(mutate('DELETE', '/api/sessions/k-1', SEEN));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Kage couldn't delete the session: disk full" });
  });

  it('needs X-Kage and a matching Origin, and the token when one is set', async () => {
    const { a, calls } = withRemove();
    for (const headers of [
      { 'Content-Type': 'application/json' } as Record<string, string>,
      { 'Content-Type': 'application/json', 'X-Kage': '1' },
      { 'Content-Type': 'application/json', Origin: ORIGIN },
      { 'Content-Type': 'application/json', 'X-Kage': '1', Origin: 'http://evil.example' },
    ]) {
      const res = await a.fetch(
        req('/api/sessions/k-1', { method: 'DELETE', headers, body: JSON.stringify(SEEN) }),
      );
      expect(res.status).toBe(403);
    }
    const t = withRemove(null, 'x'.repeat(20));
    expect((await t.a.fetch(mutate('DELETE', '/api/sessions/k-1', SEEN))).status).toBe(401);
    expect(calls).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});

describe('POST /api/sessions/:id/resume (phase 4 Task 7)', () => {
  const withResume = (fail: Error | null = null, token = '') => {
    const calls: string[] = [];
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      auth: authFor(token),
      resumer: {
        resume: async (id: string) => {
          calls.push(id);
          if (fail) throw fail;
        },
      },
    });
    return { a, calls };
  };

  it('no body (or {}) → 204 and reaches the launcher', async () => {
    const { a, calls } = withResume();
    expect((await a.fetch(mutate('POST', '/api/sessions/k-1/resume'))).status).toBe(204);
    expect((await a.fetch(mutate('POST', '/api/sessions/k-2/resume', {}))).status).toBe(204);
    expect(calls).toEqual(['k-1', 'k-2']);
  });

  it('a body is a 400 before any resume', async () => {
    const { a, calls } = withResume();
    const res = await a.fetch(mutate('POST', '/api/sessions/k-1/resume', { sessionId: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unexpected field "sessionId"' });
    expect(calls).toEqual([]);
  });

  it('maps LaunchError statuses (403, 404, 409, 422, 503) and messages; anything else is a one-sentence 500', async () => {
    for (const status of [403, 404, 409, 422, 503] as const) {
      const { a } = withResume(new LaunchError(status, `Problem ${status}.`));
      const res = await a.fetch(mutate('POST', '/api/sessions/k-1/resume'));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `Problem ${status}.` });
    }
    const { a } = withResume(new Error('boom\nstack'));
    const res = await a.fetch(mutate('POST', '/api/sessions/k-1/resume'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Kage couldn't resume the session: boom" });
  });

  it('is 501 in demo mode, with the demo sentence', async () => {
    const res = await app(true).fetch(mutate('POST', '/api/sessions/k-1/resume'));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: DEMO });
  });

  it('needs X-Kage and Origin, and the token when one is set', async () => {
    const { a, calls } = withResume();
    for (const headers of [
      {} as Record<string, string>,
      { 'X-Kage': '1' },
      { Origin: ORIGIN },
      { 'X-Kage': '1', Origin: 'http://evil.example' },
    ]) {
      const res = await a.fetch(req('/api/sessions/k-1/resume', { method: 'POST', headers }));
      expect(res.status).toBe(403);
    }
    const t = withResume(null, 'x'.repeat(20));
    expect((await t.a.fetch(mutate('POST', '/api/sessions/k-1/resume'))).status).toBe(401);
    expect(calls).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});

describe('GET /api/sessions/:id/diff (phase 4 Task 8)', () => {
  const PAGE = { base: 'main', branch: 'kage/x', from: 0, next: null, filesTotal: 0, files: [] };
  const withDiff = (fail: Error | null = null, token = '') => {
    const calls: [string, number][] = [];
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      auth: authFor(token),
      differ: {
        page: async (id: string, from: number) => {
          calls.push([id, from]);
          if (fail) throw fail;
          return { ...PAGE, from };
        },
      },
    });
    return { a, calls };
  };

  it('a GET with no CSRF header answers the page; from defaults to 0', async () => {
    const { a, calls } = withDiff();
    const res = await a.fetch(req('/api/sessions/k-1/diff?from=9'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ...PAGE, from: 9 });
    expect((await a.fetch(req('/api/sessions/k-1/diff'))).status).toBe(200);
    expect(calls).toEqual([
      ['k-1', 9],
      ['k-1', 0],
    ]);
  });

  it('from=-1, x, 1.5 or empty → 400 "from must be a whole number." before any diff', async () => {
    const { a, calls } = withDiff();
    for (const q of ['-1', 'x', '1.5', '', '1e3', '99999999999999999999']) {
      const res = await a.fetch(req(`/api/sessions/k-1/diff?from=${q}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'from must be a whole number.' });
    }
    expect(calls).toEqual([]);
  });

  it('maps DiffError statuses (404, 422, 429) and messages', async () => {
    for (const status of [404, 422, 429] as const) {
      const { a } = withDiff(new DiffError(status, `Problem ${status}.`));
      const res = await a.fetch(req('/api/sessions/k-1/diff'));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `Problem ${status}.` });
    }
  });

  it('an unknown id in live mode → 404 (through the real DiffService)', async () => {
    const a = createApp({
      source,
      hub,
      assets,
      allowed,
      auth: authFor(),
      differ: new DiffService({ target: () => null }),
    });
    const res = await a.fetch(req('/api/sessions/nope/diff'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No session with id nope.' });
  });

  it('is 501 in demo mode, with the demo sentence', async () => {
    const res = await app(true).fetch(req('/api/sessions/docs/diff'));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: DEMO });
  });

  it('is behind the host guard and the token guard', async () => {
    const { a, calls } = withDiff(null, 'x'.repeat(20));
    expect((await a.fetch(req('/api/sessions/k-1/diff'))).status).toBe(401);
    const evil = new Request(`http://${HOST}/api/sessions/k-1/diff`, {
      headers: { Host: 'evil.example:8080' },
    });
    expect((await withDiff().a.fetch(evil)).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
