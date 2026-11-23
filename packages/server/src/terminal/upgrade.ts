import type { IncomingHttpHeaders } from 'node:http';
import { LIMITS, TERM_PROTOCOL } from '@kage/shared';
import { type Auth, SIGN_IN, sessionOf } from '../auth.ts';
import { type Allowed, hostAllowed, originAllowed } from '../security.ts';

/** The terminal's path, matched on the raw (undecoded) path: one segment, the session id. */
export const TERMINAL_PATH = /^\/api\/sessions\/([^/]{1,200})\/terminal$/;
/** A session id once decoded: a record's kage id or `ext-@<n>`. */
const SESSION_ID = /^[A-Za-z0-9@_-]{1,100}$/;
const SIZE = /^\d{1,4}$/;

export type UpgradeCheck =
  | {
      ok: true;
      id: string;
      cols: number | null;
      rows: number | null;
      /** The login session's key when a token is set: its sign-out closes this terminal. */
      session?: string;
    }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string };

const refuse = (status: 400 | 401 | 403 | 404, error: string): UpgradeCheck => ({
  ok: false,
  status,
  error,
});

const one = (h: string | string[] | undefined): string | undefined =>
  Array.isArray(h) ? undefined : h;

/** A query value within [min, max]: null when absent, undefined when bad. */
function size(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | null | undefined {
  const all = q.getAll(name);
  if (all.length === 0) return null;
  const v = all[0] as string;
  if (all.length > 1 || !SIZE.test(v)) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Every check of a terminal upgrade, before it happens (Task 12), in order: the path, GET with
 * `Upgrade: websocket`, Host, the exact Origin, a live session from `peer` (the TCP address) when
 * a token is set, the `kage.term.v1` protocol, and `cols`/`rows` within the limits. The first
 * that fails gives the HTTP status and sentence.
 */
export function checkUpgrade(
  req: { method?: string; url?: string; headers: IncomingHttpHeaders },
  o: { allowed: Allowed; auth: Auth; peer: string },
): UpgradeCheck {
  const url = req.url ?? '';
  const qi = url.indexOf('?');
  const path = qi < 0 ? url : url.slice(0, qi);
  const m = TERMINAL_PATH.exec(path);
  let id: string | null = null;
  if (m) {
    try {
      id = decodeURIComponent(m[1] as string);
    } catch {
      id = null;
    }
  }
  if (id === null || !SESSION_ID.test(id)) return refuse(404, 'Not found');
  const h = req.headers;
  if (req.method !== 'GET' || one(h.upgrade)?.toLowerCase() !== 'websocket') {
    return refuse(400, 'Open the terminal with a WebSocket.');
  }
  if (!hostAllowed(one(h.host), o.allowed)) return refuse(403, 'Unknown host');
  if (!originAllowed(one(h.origin), o.allowed)) return refuse(403, 'Bad origin');
  const session = sessionOf(o.auth, one(h.cookie), o.peer);
  if (session === null) return refuse(401, SIGN_IN);
  const offered = (one(h['sec-websocket-protocol']) ?? '').split(',').map((p) => p.trim());
  if (!offered.includes(TERM_PROTOCOL))
    return refuse(400, `Kage's terminal speaks ${TERM_PROTOCOL}.`);
  const q = new URLSearchParams(qi < 0 ? '' : url.slice(qi + 1));
  const cols = size(q, 'cols', LIMITS.termMinCols, LIMITS.termMaxCols);
  const rows = size(q, 'rows', LIMITS.termMinRows, LIMITS.termMaxRows);
  if (cols === undefined || rows === undefined) {
    return refuse(400, 'The terminal size is out of range.');
  }
  return session === '' ? { ok: true, id, cols, rows } : { ok: true, id, cols, rows, session };
}
