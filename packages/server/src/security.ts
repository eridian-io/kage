import type { MiddlewareHandler } from 'hono';

export interface Allowed {
  hostNames: string[];
  port: number;
}

/**
 * The body of a refused Host (hostGuard and the terminal upgrade): a name Kage doesn't trust.
 * Only the bound IP, the MagicDNS names, an explicit `host` and, on loopback, `localhost` pass
 * (security I2); any other name could be answered by a device on the local network.
 */
export const UNKNOWN_HOST = `Open the address "kage status" shows. Kage doesn't answer to this name. To use this name, set "host" to it in Kage's config file (this trusts everyone on your local network).`;

/** The body of a refused Origin (csrfGuard and the terminal upgrade). */
export const BAD_ORIGIN = `Open the address "kage status" shows. Kage only takes requests from a page on its own address. To use this page's name, set "host" to it in Kage's config file (this trusts everyone on your local network).`;

/**
 * Parse a Host header or Origin into bracket-free lowercase hostname and port. One trailing
 * dot is dropped from a multi-label name: `box.tail1.ts.net.` is the same DNS name as
 * `box.tail1.ts.net`. A single label keeps it (R130): `box.` skips the MagicDNS search domain
 * and can fall to LLMNR, so it is a different name, and `localhost.` isn't `localhost`.
 */
function parseAuthority(value: string, scheme = 'http'): { hostname: string; port: string } | null {
  try {
    const u = new URL(`${scheme}://${value}`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return { hostname: dropRootDot(u.hostname.replace(/^\[|\]$/g, '')), port: u.port };
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  const p = parseAuthority(name.includes(':') ? `[${name.replace(/^\[|\]$/g, '')}]` : name);
  return p?.hostname ?? dropRootDot(name.toLowerCase());
}

/** Drops one trailing dot, only when the rest still holds a dot (a multi-label name). */
function dropRootDot(name: string): string {
  return /\..*\.$/.test(name) ? name.slice(0, -1) : name;
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

/**
 * `http://<allowed name>:<port>` exactly (the port may be left out only when it is 80); missing
 * → false. A browser's Origin has no path, query or fragment, so not even a trailing `/` passes
 * (security M7).
 */
const originOk = (origin: string | undefined, ok: Matcher): boolean => {
  // A backslash too: the URL parser reads it as `/` in an http URL.
  const m = origin ? /^http:\/\/([^/?#\\]+)$/.exec(origin) : null;
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
    if (!hostOk(c.req.header('Host'), ok)) return c.text(UNKNOWN_HOST, 403);
    await next();
  };
}

export function csrfGuard(allowed: Allowed): MiddlewareHandler {
  const ok = makeMatcher(allowed);
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD') return next();
    if (c.req.header('X-Kage') !== '1') return c.text('Missing X-Kage header', 403);
    if (!originOk(c.req.header('Origin'), ok)) return c.text(BAD_ORIGIN, 403);
    await next();
  };
}
