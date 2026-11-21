import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Asset } from './assets.ts';
import {
  authGuard,
  CLEAR_COOKIE,
  isAuthorised,
  LoginLimiter,
  SIGN_IN,
  sameSecret,
  setCookieHeader,
} from './auth.ts';
import type { EventHub } from './events.ts';
import { csrfGuard, hostGuard } from './security.ts';
import { NotFoundError, NotImplementedError, type SessionSource } from './source.ts';

export interface AppDeps {
  source: SessionSource;
  hub: EventHub;
  assets: Map<string, Asset>;
  allowed: { hostNames: string[]; port: number };
  /** The config's access token; '' means no login (spec §5.10). */
  token: string;
  /** Demo mode only: registers POST /api/demo/reset, which calls this. */
  demoReset?: () => void;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** True when an Accept-Encoding header lists `coding` with a non-zero q. */
function accepts(header: string, coding: string): boolean {
  for (const part of header.split(',')) {
    const [name = '', ...params] = part.split(';').map((p) => p.trim());
    if (name.toLowerCase() !== coding) continue;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

function matchesEtag(header: string, etag: string): boolean {
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

function serveAsset(asset: Asset, req: Request): Response {
  const headers = new Headers({
    'Content-Type': asset.type,
    'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: asset.etag,
    Vary: 'Accept-Encoding',
  });
  const inm = req.headers.get('If-None-Match');
  if (inm !== null && matchesEtag(inm, asset.etag))
    return new Response(null, { status: 304, headers });
  const ae = req.headers.get('Accept-Encoding') ?? '';
  let body = asset.body;
  if (accepts(ae, 'br') && asset.br.length < body.length) {
    body = asset.br;
    headers.set('Content-Encoding', 'br');
  } else if (accepts(ae, 'gzip') && asset.gzip.length < body.length) {
    body = asset.gzip;
    headers.set('Content-Encoding', 'gzip');
  }
  headers.set('Content-Length', String(body.length));
  return new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers });
}

/**
 * The TCP peer's address, from @hono/node-server's `env.incoming`; never from a header, which the
 * client controls. Requests without a socket (tests calling fetch directly) share one key.
 */
function remoteAddress(env: unknown): string {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export function createApp(deps: AppDeps): Hono {
  const { source, hub, assets, allowed, token } = deps;
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('Content-Security-Policy', CSP);
  });
  app.use('*', hostGuard(allowed));
  // Every method but GET and HEAD needs X-Kage: 1 and a matching Origin (ruling R1).
  app.use('*', csrfGuard(allowed));
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }),
  );
  app.use('/api/*', authGuard(token));

  app.get('/api/auth', (c) =>
    isAuthorised(token, c.req.header('Cookie'))
      ? c.body(null, 204)
      : c.json({ error: SIGN_IN }, 401),
  );

  const limiter = new LoginLimiter();
  app.post('/api/login', async (c) => {
    if (token === '') return c.body(null, 204);
    const body: unknown = await c.req.json().catch(() => undefined);
    const keys = typeof body === 'object' && body !== null ? Object.keys(body) : [];
    const given = (body as { token?: unknown } | undefined)?.token;
    if (Array.isArray(body) || keys.length !== 1 || typeof given !== 'string') {
      return c.json({ error: 'Expected {"token": "<access token>"}' }, 400);
    }
    // No await from here to fail(): parallel tries can't all pass allow() before one fails.
    const peer = remoteAddress(c.env);
    if (!limiter.allow(peer)) {
      return c.json({ error: 'Too many tries. Wait a minute and try again.' }, 429);
    }
    if (!sameSecret(given, token)) {
      limiter.fail(peer);
      return c.json({ error: "That token isn't right." }, 401);
    }
    // Kage is usually served over plain http on the tailnet, where Secure would drop the cookie.
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
    c.header('Set-Cookie', setCookieHeader(token) + secure);
    return c.body(null, 204);
  });

  app.post('/api/logout', (c) => {
    c.header('Set-Cookie', CLEAR_COOKIE);
    return c.body(null, 204);
  });

  app.get('/api/events', (c) => {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    };
    // Hono routes HEAD here too, and a HEAD body is dropped without cancel: a stream
    // would leave its client (heartbeat and queue) in the hub forever.
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    return new Response(hub.stream(), { headers });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await source.remove(id);
    } catch (err) {
      if (err instanceof NotFoundError) return c.json({ error: `No session with id ${id}` }, 404);
      if (err instanceof NotImplementedError) return c.json({ error: err.message }, 501);
      throw err;
    }
    return c.body(null, 204);
  });

  app.post('/api/view', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (typeof b.streamId !== 'string' || (typeof b.id !== 'string' && b.id !== null)) {
      return c.json({ error: 'Expected {"streamId": "<stream id>", "id": "<session id>"}' }, 400);
    }
    if (!hub.view(b.streamId, b.id)) return c.json({ error: 'Unknown stream' }, 404);
    return c.body(null, 204);
  });

  const { demoReset } = deps;
  if (demoReset) {
    app.post('/api/demo/reset', (c) => {
      demoReset();
      return c.body(null, 204);
    });
  }

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  app.get('*', (c) => {
    const asset = assets.get(c.req.path);
    if (!asset) return c.text('Not found', 404);
    return serveAsset(asset, c.req.raw);
  });

  return app;
}
