import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { KageConfig } from './config.ts';

export interface ListenAddress {
  address: string;
  hostNames: string[];
}

export class ListenError extends Error {}

export interface ListenOptions {
  unsafeListenAll: boolean;
  tailscaleIp: () => Promise<string | null>;
  hostname: () => string;
  /** Resolves a host name to addresses; defaults to dns.lookup(name, { all: true }). */
  lookup?: (name: string) => Promise<{ address: string; family: number }[]>;
}

interface Parsed {
  v: 4 | 6;
  n: bigint;
}

function ip4(s: string): bigint | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').reduce((a, o) => a * 256n + BigInt(o), 0n);
}

/** Parse an IPv4 or IPv6 literal (brackets and zone ignored); IPv4-mapped IPv6 becomes IPv4. */
function parseIp(raw: string): Parsed | null {
  const s = raw.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const four = ip4(s);
  if (four !== null) return { v: 4, n: four };
  if (isIP(s) !== 6) return null;
  let t = s;
  if (t.includes('.')) {
    const cut = t.lastIndexOf(':') + 1;
    const tail = ip4(t.slice(cut));
    if (tail === null) return null;
    t = `${t.slice(0, cut)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const [head = '', rest] = t.split('::');
  const h = head === '' ? [] : head.split(':');
  const r = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : Array<string>(8 - h.length - r.length).fill('0');
  const groups = [...h, ...fill, ...r];
  if (groups.length !== 8) return null;
  const n = groups.reduce((a, g) => (a << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

function inV4(n: bigint, base: number, bits: number): boolean {
  return n >> BigInt(32 - bits) === BigInt(base) >> BigInt(32 - bits);
}

function isAllowedBind(p: Parsed): boolean {
  if (p.v === 4) return inV4(p.n, 0x64400000, 10) || inV4(p.n, 0x7f000000, 8);
  return p.n === 1n || p.n >> 80n === 0xfd7a115ca1e0n;
}

/** Runs `tailscale ip -4` (argument array, no shell); null on error, empty or non-Tailscale output. */
export function defaultTailscaleIp(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0]?.trim() ?? '';
      const n = ip4(first);
      resolve(n !== null && inV4(n, 0x64400000, 10) ? first : null);
    });
  });
}

export async function resolveListenAddress(
  cfg: KageConfig,
  opts: ListenOptions,
): Promise<ListenAddress> {
  const names: string[] = [];
  let address: string;
  if (cfg.host !== null) {
    const configured = cfg.host.trim();
    let unspecified = false;
    let allowedBind = true;
    const parsed = configured === '' ? null : parseIp(configured);
    if (configured === '') {
      unspecified = true;
      address = configured;
    } else if (parsed) {
      address = configured.replace(/^\[|\]$/g, '');
      unspecified = parsed.n === 0n;
      allowedBind = isAllowedBind(parsed);
    } else {
      const resolve = opts.lookup ?? ((n: string) => lookup(n, { all: true }));
      let found: { address: string; family: number }[] = [];
      try {
        found = await resolve(configured);
      } catch {
        // handled below
      }
      const pick = found.find((a) => a.family === 4) ?? found[0];
      if (!pick) throw new ListenError(`Couldn't resolve host "${configured}" from config.json.`);
      address = pick.address;
      const p = parseIp(address);
      unspecified = p === null || p.n === 0n;
      allowedBind = p !== null && isAllowedBind(p);
      names.push(configured);
    }
    if (!opts.unsafeListenAll) {
      if (unspecified) {
        throw new ListenError(
          `Refusing to listen on "${address}": that exposes Kage to every network. Pass --unsafe-listen-all if you really mean it.`,
        );
      }
      if (!allowedBind) {
        throw new ListenError(
          `${address} isn't a Tailscale address. Kage only listens on Tailscale or loopback; pass --unsafe-listen-all to override.`,
        );
      }
    }
  } else {
    const ip = await opts.tailscaleIp();
    if (ip === null) {
      throw new ListenError(
        'Tailscale isn\'t running. Start it with "tailscale up", or set "host" in ~/.config/kage/config.json.',
      );
    }
    address = ip;
  }
  return { address, hostNames: [...new Set([...names, address, opts.hostname()])] };
}
