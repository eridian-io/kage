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
  /** The MagicDNS name (B1), asked only for a Tailscale or all-interfaces bind; null adds none. */
  tailscaleDnsName?: () => Promise<string | null>;
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

function isTailscale(p: Parsed): boolean {
  if (p.v === 4) return inV4(p.n, 0x64400000, 10);
  return p.n >> 80n === 0xfd7a115ca1e0n;
}

function isAllowedBind(p: Parsed): boolean {
  if (p.v === 4) return isTailscale(p) || inV4(p.n, 0x7f000000, 8);
  return p.n === 1n || isTailscale(p);
}

/** The machine name as people type it: before the first dot, lowercased ("Box.local" → "box"). */
export function shortHostname(full: string): string {
  return (full.split('.')[0] ?? '').toLowerCase();
}

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * The host to print in "Kage is running at …": the configured host name if one was given;
 * else, for a Tailscale (or all-interfaces) bind, cfg.name when it is a usable host name,
 * otherwise the short hostname; else the IP (loopback and other addresses; IPv6 bracketed).
 * Never the full os.hostname(): "box.local" resolves via mDNS to the LAN address.
 */
export function displayHost(cfg: KageConfig, address: string, hostname: string): string {
  const configured = cfg.host?.trim() ?? '';
  if (configured !== '' && parseIp(configured) === null) return configured;
  const p = parseIp(address);
  if (p === null || p.n === 0n || isTailscale(p)) {
    return LABEL.test(cfg.name) ? cfg.name : shortHostname(hostname);
  }
  return p.v === 6 ? `[${address.replace(/^\[|\]$/g, '')}]` : address;
}

/** True for a DNS name made of valid labels ("box", "box.tail1234.ts.net"). */
function isHostName(name: string): boolean {
  return name.length <= 253 && name.split('.').every((l) => l.length <= 63 && LABEL.test(l));
}

/**
 * B12: cfg.name is trusted as a Host and Origin name only when no one else can own it in public
 * DNS: a single label, or a name under .ts.net (the tailnet) or .local (mDNS).
 */
export function isSafeName(name: string): boolean {
  const n = name.toLowerCase();
  if (LABEL.test(n)) return true;
  return (n.endsWith('.ts.net') || n.endsWith('.local')) && isHostName(n);
}

export type ExecText = (cmd: string, args: string[]) => Promise<string>;

const execText: ExecText = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

/**
 * B1: this machine's MagicDNS name from `tailscale status --json` (`Self.DNSName`, e.g.
 * "box.tail1234.ts.net." → "box.tail1234.ts.net"); null on any error.
 */
export async function tailscaleDnsName(exec: ExecText = execText): Promise<string | null> {
  try {
    const data: unknown = JSON.parse(await exec('tailscale', ['status', '--json']));
    const self = (data as { Self?: { DNSName?: unknown } } | null)?.Self;
    const name = self?.DNSName;
    if (typeof name !== 'string') return null;
    const n = name.replace(/\.$/, '').toLowerCase();
    return n !== '' && isHostName(n) ? n : null;
  } catch {
    return null;
  }
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
  const bound = parseIp(address);
  if (opts.tailscaleDnsName && (bound === null || bound.n === 0n || isTailscale(bound))) {
    const dns = await opts.tailscaleDnsName();
    if (dns) names.push(dns);
  }
  const full = opts.hostname();
  const hostNames = [
    ...names,
    address,
    full,
    shortHostname(full),
    isSafeName(cfg.name) ? cfg.name : '',
  ].filter((h) => h !== '');
  return { address, hostNames: [...new Set(hostNames)] };
}
