import type { MiddlewareHandler } from 'hono';

export interface Allowed {
  hostNames: string[];
  port: number;
}

/** Parse a Host header or Origin into bracket-free lowercase hostname and port. */
function parseAuthority(value: string, scheme = 'http'): { hostname: string; port: string } | null {
  try {
    const u = new URL(`${scheme}://${value}`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return { hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port };
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  const p = parseAuthority(name.includes(':') ? `[${name.replace(/^\[|\]$/g, '')}]` : name);
  return p?.hostname ?? name.toLowerCase();
}

type Matcher = (hostname: string, p: string, allowNoPort: boolean) => boolean;

function makeMatcher(allowed: Allowed): Matcher {
  const names = new Set(allowed.hostNames.map(normalizeName));
  const port = String(allowed.port);
  return (hostname, p, allowNoPort) =>
    names.has(hostname) && (p === port || (p === '' && (allowNoPort || port === '80')));
}

const hostOk = (host: string | undefined, ok: Matcher): boolean => {
  const p = host ? parseAuthority(host) : null;
  return p !== null && ok(p.hostname, p.port, true);
};

/** `http://<allowed name>:<port>` (the port may be left out only when it is 80); missing → false. */
const originOk = (origin: string | undefined, ok: Matcher): boolean => {
  const m = origin ? /^http:\/\/(.+)$/.exec(origin) : null;
  const p = m?.[1] ? parseAuthority(m[1]) : null;
  return p !== null && ok(p.hostname, p.port, false);
};

/** The Host header names this server (hostGuard's rule, for the terminal upgrade). */
export function hostAllowed(host: string | undefined, allowed: Allowed): boolean {
  return hostOk(host, makeMatcher(allowed));
}

/** The Origin is exactly this server over http (csrfGuard's rule); a missing Origin is refused. */
export function originAllowed(origin: string | undefined, allowed: Allowed): boolean {
  return originOk(origin, makeMatcher(allowed));
}

export function hostGuard(allowed: Allowed): MiddlewareHandler {
  const ok = makeMatcher(allowed);
  return async (c, next) => {
    if (!hostOk(c.req.header('Host'), ok)) return c.text('Unknown host', 403);
    await next();
  };
}

export function csrfGuard(allowed: Allowed): MiddlewareHandler {
  const ok = makeMatcher(allowed);
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD') return next();
    if (c.req.header('X-Kage') !== '1') return c.text('Missing X-Kage header', 403);
    if (!originOk(c.req.header('Origin'), ok)) return c.text('Bad origin', 403);
    await next();
  };
}
