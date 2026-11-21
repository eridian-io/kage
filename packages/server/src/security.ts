import type { MiddlewareHandler } from 'hono';

interface Allowed {
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

function makeMatcher(allowed: Allowed) {
  const names = new Set(allowed.hostNames.map(normalizeName));
  const port = String(allowed.port);
  return (hostname: string, p: string, allowNoPort: boolean): boolean =>
    names.has(hostname) && (p === port || (p === '' && (allowNoPort || port === '80')));
}

export function hostGuard(allowed: Allowed): MiddlewareHandler {
  const ok = makeMatcher(allowed);
  return async (c, next) => {
    const host = c.req.header('Host');
    const p = host ? parseAuthority(host) : null;
    if (!p || !ok(p.hostname, p.port, true)) return c.text('Unknown host', 403);
    await next();
  };
}

export function csrfGuard(allowed: Allowed): MiddlewareHandler {
  const ok = makeMatcher(allowed);
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD') return next();
    if (c.req.header('X-Kage') !== '1') return c.text('Missing X-Kage header', 403);
    const origin = c.req.header('Origin');
    const m = origin ? /^http:\/\/(.+)$/.exec(origin) : null;
    const p = m?.[1] ? parseAuthority(m[1]) : null;
    if (!p || !ok(p.hostname, p.port, false)) return c.text('Bad origin', 403);
    await next();
  };
}
