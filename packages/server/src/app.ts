import type { ArchivedResponse, ArchivedSession, ProjectsResponse } from '@kage/shared';
import type { Context } from 'hono';
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
import { ActionError, type SessionControls } from './control/actions.ts';
import { LaunchError, type TaskLauncher } from './control/launcher.ts';
import {
  type Parsed,
  parseAnswer,
  parseArchive,
  parseDelete,
  parsePin,
  parseReply,
} from './control/validate.ts';
import type { EventHub } from './events.ts';
import type { FinishActions } from './finish/actions.ts';
import { firstLine } from './git/exec.ts';
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
  /** Live mode: the projects under projectsRoot. Without it (demo mode) the route answers 501. */
  projects?: () => Promise<ProjectsResponse>;
  /** Live mode: starts tasks (POST /api/sessions). Without it (demo mode) the route answers 501. */
  launcher?: Pick<TaskLauncher, 'start'>;
  /** R35: forgets the cached project listing after a launch (it adds a branch). */
  invalidateProjects?: () => void;
  /** Live mode: answer, reply and stop. Without it (demo mode) those routes answer 501. */
  controls?: Pick<SessionControls, 'answer' | 'reply' | 'stop'>;
  /**
   * Live mode: pin, archive, restore and delete. Without it pin and archive answer 501, and
   * delete goes to the source (demo mode removes the session).
   */
  finish?: Pick<FinishActions, 'pin' | 'archive' | 'remove'>;
  /** Live mode: the archived sessions for GET /api/archive (501 without it). */
  archivedList?: () => ArchivedSession[];
}

const DEMO_NO_TASKS = "Demo mode can't start tasks.";
const DEMO_NO_CONTROLS = "Demo mode can't run tasks.";

/** Stop takes no body: none, or an empty JSON object. */
function parseNoBody(raw: string): Parsed<null> {
  if (raw.trim() === '') return { ok: true, value: null };
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const [extra] = Object.keys(body);
      if (extra === undefined) return { ok: true, value: null };
      return { ok: false, error: `Unexpected field "${extra}"` };
    }
  } catch {}
  return { ok: false, error: 'Expected no body' };
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

  const { projects } = deps;
  app.get('/api/projects', async (c) => {
    if (!projects) return c.json({ error: DEMO_NO_TASKS }, 501);
    try {
      return c.json(await projects());
    } catch (err) {
      return c.json({ error: `Couldn't list the projects: ${firstLine(err)}` }, 500);
    }
  });

  const { launcher, invalidateProjects } = deps;
  app.post('/api/sessions', async (c) => {
    if (!launcher) return c.json({ error: DEMO_NO_TASKS }, 501);
    // Not JSON: the launcher answers 400 for undefined, after its 503 check.
    const body: unknown = await c.req.json().catch(() => undefined);
    try {
      return c.json(await launcher.start(body), 201);
    } catch (err) {
      if (err instanceof LaunchError) return c.json({ error: err.message }, err.status);
      return c.json({ error: `Kage couldn't start the task: ${firstLine(err)}` }, 500);
    } finally {
      invalidateProjects?.();
    }
  });

  const { controls, finish, archivedList } = deps;
  /**
   * One route helper for the session actions (F19): 501 in demo mode (no `actor`), 400 for a bad
   * body, the ActionError's status and message, else a one-sentence 500 starting with `failed`.
   */
  const action =
    <A, T>(
      actor: A | undefined,
      failed: string,
      parse: (raw: string) => Parsed<T>,
      run: (a: A, id: string, body: T) => Promise<void>,
    ) =>
    async (c: Context) => {
      if (!actor) return c.json({ error: DEMO_NO_CONTROLS }, 501);
      const parsed = parse(await c.req.text());
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      try {
        await run(actor, c.req.param('id') as string, parsed.value);
      } catch (err) {
        if (err instanceof ActionError) return c.json({ error: err.message }, err.status);
        return c.json({ error: `${failed}: ${firstLine(err)}` }, 500);
      }
      return c.body(null, 204);
    };
  const control = <T>(
    parse: (raw: string) => Parsed<T>,
    run: (ctl: NonNullable<typeof controls>, id: string, body: T) => Promise<void>,
  ) => action(controls, "Kage couldn't send that to the session", parse, run);
  const finishing = <T>(
    parse: (raw: string) => Parsed<T>,
    run: (f: NonNullable<typeof finish>, id: string, body: T) => Promise<void>,
  ) => action(finish, "Kage couldn't change the session", parse, run);
  /** A JSON body for the body parsers; `undefined` when it isn't JSON (they answer 400). */
  const json = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  app.post(
    '/api/sessions/:id/answer',
    control(
      (raw) => parseAnswer(json(raw)),
      (ctl, id, b) => ctl.answer(id, b.option, b.question),
    ),
  );
  app.post(
    '/api/sessions/:id/reply',
    control(
      (raw) => parseReply(json(raw)),
      (ctl, id, b) => ctl.reply(id, b.text),
    ),
  );
  app.post(
    '/api/sessions/:id/stop',
    control(parseNoBody, (ctl, id) => ctl.stop(id)),
  );
  app.post(
    '/api/sessions/:id/pin',
    finishing(
      (raw) => parsePin(json(raw)),
      (f, id, b) => f.pin(id, b.pinned),
    ),
  );
  app.post(
    '/api/sessions/:id/archive',
    finishing(
      (raw) => parseArchive(json(raw)),
      (f, id, b) => f.archive(id, b.archived),
    ),
  );
  app.get('/api/archive', (c) => {
    if (!archivedList) return c.json({ error: DEMO_NO_CONTROLS }, 501);
    const body: ArchivedResponse = { sessions: archivedList() };
    return c.json(body);
  });

  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    // The counts the confirmation showed, in live and demo modes alike.
    const parsed = parseDelete(json(await c.req.text()));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (finish) {
      try {
        await finish.remove(id, parsed.value);
      } catch (err) {
        if (err instanceof ActionError) return c.json({ error: err.message }, err.status);
        return c.json({ error: `Kage couldn't delete the session: ${firstLine(err)}` }, 500);
      }
      return c.body(null, 204);
    }
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
