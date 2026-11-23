import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { KageConfig } from './config.ts';
import { tailscaleCommand } from './tailscale.ts';

export interface ListenAddress {
  address: string;
  hostNames: string[];
  /** The `tailscale status` MagicDNS name when it was asked for and found, else null (ntfy links). */
  dnsName: string | null;
  /** For an all-interfaces bind only: this machine's Tailscale IP when known (F11), else null. */
  tailscaleIp?: string | null;
}

export class ListenError extends Error {}

export interface ListenOptions {
  unsafeListenAll: boolean;
  /** `tailscale ip -4`: the address to bind when no host is set, and trusted on an all-interfaces bind. */
  tailscaleIp: () => Promise<string | null>;
  /** The MagicDNS name (B1), asked only for a Tailscale or all-interfaces bind; null adds none. */
  tailscaleDnsName?: () => Promise<string | null>;
  /** Resolves a host name to addresses; defaults to dns.lookup(name, { all: true }). */
  lookup?: (name: string) => Promise<{ address: string; family: number }[]>;
  /** The config file as the user reads it (config.ts displayPath), named in the refusal. */
  configFile?: string;
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

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** An IP literal for a URL's host: IPv6 bracketed, IPv4 as it is. */
function urlHost(ip: string, p: Parsed): string {
  const bare = ip.replace(/^\[|\]$/g, '');
  return p.v === 6 ? `[${bare}]` : bare;
}

/** The MagicDNS short name: the first label of the MagicDNS name ("box.tail1.ts.net" → "box"). */
function firstLabel(dnsName: string): string {
  return dnsName.split('.')[0] ?? '';
}

function isLoopback(p: Parsed): boolean {
  return p.v === 4 ? inV4(p.n, 0x7f000000, 8) : p.n === 1n;
}

/**
 * The names the Host and Origin guards trust (security I2): an explicitly configured `host`
 * (a name the user chose is trusted even when it is `.local` or one label), the MagicDNS name
 * and its first label, the bound IP, and `localhost` on a loopback bind only (a browser resolves
 * `localhost` itself, so nobody on the network can answer for it). Never `os.hostname()`, a
 * `.local` name or a single label Kage picked itself: a device on the local network can answer
 * for those over mDNS or LLMNR and rebind them. `cfg.name` is the host pill's label only.
 */
export function hostNamesFor(cfg: KageConfig, address: string, dnsName: string | null): string[] {
  const names: string[] = [];
  const configured = cfg.host?.trim() ?? '';
  if (configured !== '') {
    const p = parseIp(configured);
    if (p === null) names.push(configured);
    else if (p.n !== 0n) names.push(configured.replace(/^\[|\]$/g, ''));
  }
  if (dnsName) names.push(dnsName, firstLabel(dnsName));
  const bound = parseIp(address);
  if (bound !== null && bound.n !== 0n) {
    names.push(address.replace(/^\[|\]$/g, ''));
    if (isLoopback(bound)) names.push('localhost');
  }
  return [...new Set(names.filter((n) => n !== ''))];
}

type Listening = { address: string; dnsName: string | null; tailscaleIp?: string | null };

/**
 * The host to print in "Kage is running at …" (F11): the configured host name; else the
 * MagicDNS first label; else the bound IP (IPv6 bracketed), or for an all-interfaces bind the
 * Tailscale IP when known. Each is in hostNamesFor, so the printed address passes its own guard.
 * Never cfg.name and never os.hostname().
 */
export function displayHost(cfg: KageConfig, listen: Listening): string {
  const configured = cfg.host?.trim() ?? '';
  if (configured !== '' && parseIp(configured) === null) return configured;
  if (listen.dnsName) return firstLabel(listen.dnsName);
  const p = parseIp(listen.address);
  if (p === null || p.n === 0n) {
    const ts = listen.tailscaleIp ? parseIp(listen.tailscaleIp) : null;
    return ts && listen.tailscaleIp ? urlHost(listen.tailscaleIp, ts) : listen.address;
  }
  return urlHost(listen.address, p);
}

/**
 * The host in a ping's board link: an explicitly configured `host` wins, as written (an IPv6
 * literal bracketed), unless it is an all-interfaces address; else the MagicDNS name when
 * Tailscale gave one; else displayHost.
 */
export function linkHost(cfg: KageConfig, listen: Listening): string {
  const configured = cfg.host?.trim() ?? '';
  if (configured !== '') {
    const p = parseIp(configured);
    if (p === null) return configured;
    if (p.n !== 0n) return urlHost(configured, p);
  }
  return listen.dnsName ?? displayHost(cfg, listen);
}

/** True for a DNS name made of valid labels ("box", "box.tail1234.ts.net"). */
function isHostName(name: string): boolean {
  return name.length <= 253 && name.split('.').every((l) => l.length <= 63 && LABEL.test(l));
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
    const data: unknown = JSON.parse(await exec(tailscaleCommand(), ['status', '--json']));
    const self = (data as { Self?: { DNSName?: unknown } } | null)?.Self;
    const name = self?.DNSName;
    if (typeof name !== 'string') return null;
    const n = name.replace(/\.$/, '').toLowerCase();
    return n !== '' && isHostName(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Runs `tailscale ip -4` (argument array, no shell; the macOS app's CLI when none is on PATH,
 * R115); null on error, empty or non-Tailscale output.
 */
export function defaultTailscaleIp(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(tailscaleCommand(), ['ip', '-4'], { timeout: 5000 }, (err, stdout) => {
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
        `Tailscale isn't running. Start it with "tailscale up", or set "host" in ${opts.configFile ?? 'config.json'}.`,
      );
    }
    address = ip;
  }
  const bound = parseIp(address);
  const allInterfaces = bound === null || bound.n === 0n;
  let dnsName: string | null = null;
  if (opts.tailscaleDnsName && (allInterfaces || isTailscale(bound))) {
    dnsName = (await opts.tailscaleDnsName()) || null;
  }
  const hostNames = hostNamesFor(cfg, address, dnsName);
  if (!allInterfaces) return { address, hostNames, dnsName };
  // --unsafe-listen-all (F11): the bound address names nothing, so the Tailscale IP, when known,
  // is trusted next to the configured host and the MagicDNS names.
  const ip = await opts.tailscaleIp();
  const ts = ip === null ? null : parseIp(ip);
  const tailscaleIp = ip !== null && ts !== null && ts.n !== 0n ? ip : null;
  if (tailscaleIp !== null && !hostNames.includes(tailscaleIp)) hostNames.push(tailscaleIp);
  return { address, hostNames, dnsName, tailscaleIp };
}
