import { execFile } from 'node:child_process';
import type { Port } from '@kage/shared';
import { stripAnsi } from '../text/ansi.ts';

/** One listening socket and a process that holds it. */
export interface Listener {
  port: number;
  /** Without brackets or an interface suffix: `127.0.0.1`, `::1`, `0.0.0.0`, `*`. */
  address: string;
  pid: number;
}
export interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

/** `host:port`, `[v6]:port` or `*:port`, as ss and lsof print them; null for anything else. */
function splitAddress(local: string): { address: string; port: number } | null {
  const colon = local.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = Number(local.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let address = local.slice(0, colon);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const scope = address.indexOf('%');
  if (scope >= 0) address = address.slice(0, scope);
  return address === '' ? null : { address, port };
}

/**
 * `ss -ltnpH` (host-integration §3): State, Recv-Q, Send-Q, Local, Peer, Process, split on runs
 * of whitespace. A socket shared by several processes lists each `pid=`; lines without a
 * `users:` field (other users' sockets) have no pid and are skipped.
 */
export function parseSs(out: string): Listener[] {
  const found: Listener[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const addr = splitAddress(cols[3] as string);
    if (!addr) continue;
    const users = cols.slice(5).join(' ');
    for (const m of users.matchAll(/pid=(\d+)/g)) {
      found.push({ port: addr.port, address: addr.address, pid: Number(m[1]) });
    }
  }
  return found;
}

/**
 * `lsof -iTCP -sTCP:LISTEN -nP -F pn`: `p<pid>` starts a process, `n<addr>` is one of its
 * sockets; any other field letter (macOS adds `f`) is skipped.
 */
export function parseLsof(out: string): Listener[] {
  const found: Listener[] = [];
  let pid: number | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null) {
      const addr = splitAddress(line.slice(1));
      if (addr) found.push({ port: addr.port, address: addr.address, pid });
    }
  }
  return found;
}

/** `ps -A -ww -o pid=,ppid=,args=`: right-aligned pid and ppid, then the whole command line. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line.trimEnd());
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: (m[3] ?? '').trim() });
  }
  return procs;
}

const INTERPRETER = /^(node|bun|deno|python[0-9.]*|ruby)$/;
/** Options whose value follows as the next word. */
const TAKES_VALUE = new Set(['-r', '--require', '--import', '--loader', '-W', '-X']);
/** Options that run inline code: the interpreter's own name is the label. */
const INLINE = new Set(['-e', '--eval', '-p', '--print', '-c']);
/** bun and deno subcommands before the script. */
const SUBCOMMAND = new Set(['run', 'serve', 'x', 'exec']);
const MAX_LABEL = 20;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * A short name for a listening process from its command line: an interpreter (node, bun, deno,
 * python, ruby) is named by its script (basename without extension) or `-m` module; any other
 * program by its basename. Plain text, at most 20 characters.
 */
export function processLabel(args: string): string {
  const words = stripAnsi(args, { oneLine: true }).trim().split(/\s+/);
  let prog = basename(words[0] ?? '');
  if (prog.startsWith('-')) prog = prog.slice(1);
  let label = prog;
  if (INTERPRETER.test(prog)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i] as string;
      if (w === '-m' && words[i + 1]) {
        label = words[i + 1] as string;
        break;
      }
      if (INLINE.has(w)) break;
      if (TAKES_VALUE.has(w)) {
        i++;
        continue;
      }
      if (w.startsWith('-')) continue;
      if ((prog === 'bun' || prog === 'deno') && SUBCOMMAND.has(w)) continue;
      const base = basename(w);
      const dot = base.lastIndexOf('.');
      label = dot > 0 ? base.slice(0, dot) : base;
      break;
    }
  }
  return Array.from(label).slice(0, MAX_LABEL).join('');
}

/** 127.0.0.0/8 and ::1 (also IPv4-mapped loopback). */
function loopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * The ports held by the pane process or its descendants: one entry per port, sorted by port,
 * labelled from ps (ruling K6: ss names a Node thread "MainThread"); local only when every
 * address it listens on is loopback.
 */
export function portsFor(panePid: number, listeners: Listener[], procs: Proc[]): Port[] {
  const children = new Map<number, number[]>();
  const args = new Map<number, string>();
  for (const p of procs) {
    args.set(p.pid, p.args);
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const tree = new Set<number>([panePid]);
  const queue = [panePid];
  while (queue.length > 0) {
    for (const c of children.get(queue.pop() as number) ?? []) {
      if (!tree.has(c)) {
        tree.add(c);
        queue.push(c);
      }
    }
  }
  const byPort = new Map<number, Port>();
  for (const l of listeners) {
    if (!tree.has(l.pid)) continue;
    const held = byPort.get(l.port);
    if (held) held.localOnly &&= loopback(l.address);
    else {
      byPort.set(l.port, {
        port: l.port,
        process: processLabel(args.get(l.pid) ?? ''),
        localOnly: loopback(l.address),
      });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

const PS: [string, string[]] = ['ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']];

/** The two commands of a scan: ss and ps on Linux, lsof and ps on macOS; null elsewhere. */
export function scanCommands(
  platform: NodeJS.Platform,
): { listeners: [string, string[]]; procs: [string, string[]] } | null {
  if (platform === 'linux') return { listeners: ['ss', ['-ltnpH']], procs: PS };
  if (platform === 'darwin') {
    return { listeners: ['lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pn']], procs: PS };
  }
  return null;
}

export type ScanExec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const SCAN_TIMEOUT_MS = 5000;

/**
 * Runs a command with an argument array (never a shell) and returns its stdout. stderr is
 * ignored (procps may complain about the screen size). lsof exits 1 when nothing listens: that
 * is an empty answer, not a failure.
 */
export const scanExec: ScanExec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
        windowsHide: true,
      },
      (err, stdout) => {
        if (!err) resolve(stdout);
        else if (file === 'lsof' && err.code === 1 && !err.killed) resolve(stdout);
        else reject(err);
      },
    );
  });

/** One scan of every listener and process, or null where Kage has no scanner (not Linux or macOS). */
export function makeScanner(
  platform: NodeJS.Platform,
  exec: ScanExec = scanExec,
): (() => Promise<{ listeners: Listener[]; procs: Proc[] }>) | null {
  const cmds = scanCommands(platform);
  if (!cmds) return null;
  const parse = cmds.listeners[0] === 'lsof' ? parseLsof : parseSs;
  return async () => {
    const [l, p] = await Promise.all([
      exec(cmds.listeners[0], cmds.listeners[1], SCAN_TIMEOUT_MS),
      exec(cmds.procs[0], cmds.procs[1], SCAN_TIMEOUT_MS),
    ]);
    return { listeners: parse(l), procs: parsePs(p) };
  };
}
