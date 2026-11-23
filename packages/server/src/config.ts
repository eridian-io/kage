import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { serverAllowed } from './notify/ntfy.ts';

export interface KageConfig {
  /** Display name in the host pill; default: the short os.hostname(). */
  name: string;
  projectsRoot: string;
  /** Listen address; null means auto-detect (Tailscale IP). */
  host: string | null;
  port: number;
  tmuxSession: string;
  /** `tmux -L <name>` socket; null means the default server. Env only (tests use a private one). */
  tmuxSocket: string | null;
  worktreeDir: string;
  branchPrefix: string;
  autoArchive: { onMerge: boolean; afterDays: number };
  /** "" means no pings. */
  ntfyTopic: string;
  /** No trailing "/"; https:, or http: on loopback or the tailnet. */
  ntfyServer: string;
  /** "" or an access token, sent only as `Authorization: Bearer`. Never logged. */
  ntfyToken: string;
  /** Ping when a session is done after a minute or more of work. */
  ntfyOnDone: boolean;
  token: string;
}

export const DEFAULT_CONFIG: KageConfig = {
  name: hostname().split('.')[0] ?? 'kage',
  projectsRoot: '~/projects',
  host: null,
  port: 8080,
  tmuxSession: 'kage',
  tmuxSocket: null,
  worktreeDir: '.worktrees',
  branchPrefix: 'kage/',
  autoArchive: { onMerge: true, afterDays: 14 },
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  ntfyToken: '',
  ntfyOnDone: false,
  token: '',
};

export class ConfigError extends Error {}

/**
 * Lines `kage serve` prints at startup about settings that don't do what they suggest yet.
 * None today: the token, the last one, is enforced since phase 3 (B13).
 */
export function startupWarnings(_cfg: KageConfig): string[] {
  return [];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, key: string): string {
  if (typeof v !== 'string') throw new ConfigError(`${key} must be a string`);
  return v;
}

function bool(v: unknown, key: string): boolean {
  if (typeof v !== 'boolean') throw new ConfigError(`${key} must be true or false`);
  return v;
}

/** "" (no login) or at least 16 characters. The message never repeats the value. */
function token(v: unknown, key: string): string {
  const t = str(v, key);
  if (t !== '' && t.length < 16) throw new ConfigError(`${key} must be at least 16 characters`);
  return t;
}

function port(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new ConfigError(`${key} must be an integer in 1–65535`);
  }
  return v;
}

function days(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ConfigError(`${key} must be a non-negative integer`);
  }
  return v;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A relative folder inside the repo: segments of safe characters, none "." or "..". */
function worktreeDir(v: unknown, key: string): string {
  const d = str(v, key);
  const bad = d
    .split('/')
    .some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || s.toLowerCase() === '.git');
  if (bad) throw new ConfigError(`${key} must be a relative folder name like ".worktrees"`);
  return d;
}

/** "" or safe segments separated by "/", optionally ending in "/", usable at the start of a branch name. */
function branchPrefix(v: unknown, key: string): string {
  const p = str(v, key);
  if (p === '') return p;
  const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  const bad = segs.some(
    (s) =>
      !SEGMENT.test(s) ||
      s.startsWith('-') ||
      s.startsWith('.') ||
      s.endsWith('.lock') ||
      s.includes('..'),
  );
  if (bad) throw new ConfigError(`${key} must look like "kage/" (letters, digits, . _ - and /)`);
  return p;
}

const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const NTFY_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/** "" or 1 to 64 letters, digits, - or _ (N4). The message never repeats the value. */
function ntfyTopic(v: unknown, key: string): string {
  const t = str(v, key);
  if (t !== '' && !NTFY_TOPIC.test(t)) {
    throw new ConfigError(`${key} must be up to 64 letters, digits, - or _`);
  }
  return t;
}

/** "" or 1 to 128 letters, digits, - or _: a header-safe ntfy access token. */
function ntfyToken(v: unknown, key: string): string {
  const t = str(v, key);
  if (t !== '' && !NTFY_TOKEN.test(t)) {
    throw new ConfigError(`${key} must be up to 128 letters, digits, - or _`);
  }
  return t;
}

/**
 * An https: URL, or http: on loopback or the tailnet (`serverAllowed`); no user info, query or
 * fragment; trailing "/" dropped, so the client's `${server}/` stays one slash. The value may
 * hold a secret path, so the message never repeats it.
 */
function ntfyServer(v: unknown, key: string): string {
  const s = str(v, key).trim();
  if (!serverAllowed(s) || s.includes('?') || s.includes('#') || s.includes('@')) {
    throw new ConfigError(
      `${key} must be an https: URL (http: only on this machine or your tailnet), with no user name, query or fragment`,
    );
  }
  return s.replace(/\/+$/, '');
}

function hostOf(url: string): string {
  try {
    // "ntfy.sh." is the same host as "ntfy.sh".
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** A public topic without a token is readable by anyone who guesses it (N4). */
function checkNtfyTopicLength(c: KageConfig): void {
  if (c.ntfyTopic === '' || c.ntfyToken !== '' || hostOf(c.ntfyServer) !== 'ntfy.sh') return;
  if (c.ntfyTopic.length < 16) {
    throw new ConfigError(
      'ntfyTopic must be at least 16 letters, digits, - or _ on ntfy.sh: anyone who guesses it can read your pings',
    );
  }
}

/** "line L column C" or "position N" from a JSON.parse error, never the text it quotes. */
function jsonWhere(e: unknown): string {
  const m = /line \d+ column \d+|position \d+/.exec(String((e as Error).message));
  return m ? ` (at ${m[0]})` : '';
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** The config file `loadConfig` reads: under XDG_CONFIG_HOME, else HOME/.config. */
export function configPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, 'kage', 'config.json')
    : join(home, '.config', 'kage', 'config.json');
}

/** `~/…` for a path under `home`, else the path itself. */
export function displayPath(path: string, home: string): string {
  const rel = relative(home, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path;
  return `~/${rel.split(sep).join('/')}`;
}

export async function loadConfig(
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KageConfig> {
  const env = opts.env ?? process.env;
  const path = opts.path ?? configPath(env);

  let raw: Obj = {};
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read config file ${path}: ${(e as Error).message}`);
    }
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // The parser's message can quote the file, and a token may be in it: say where only.
      throw new ConfigError(`invalid JSON in config file ${path}${jsonWhere(e)}`);
    }
    if (!isObj(parsed)) throw new ConfigError(`config file ${path} must contain a JSON object`);
    raw = parsed;
  }
  return configFrom(raw, env);
}

/**
 * The config a parsed config file's object stands for, with the environment's overrides; throws
 * a ConfigError naming the first bad key (never its value). `kage setup` checks the object it is
 * about to write with this, before writing it.
 */
export function configFrom(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): KageConfig {
  const home = env.HOME || env.USERPROFILE || homedir();
  const c: KageConfig = { ...DEFAULT_CONFIG, autoArchive: { ...DEFAULT_CONFIG.autoArchive } };
  if (raw.name !== undefined) c.name = str(raw.name, 'name');
  if (raw.projectsRoot !== undefined) c.projectsRoot = str(raw.projectsRoot, 'projectsRoot');
  if (raw.host !== undefined && raw.host !== null) c.host = str(raw.host, 'host');
  if (raw.host === null) c.host = null;
  if (raw.port !== undefined) c.port = port(raw.port, 'port');
  if (raw.tmuxSession !== undefined) c.tmuxSession = str(raw.tmuxSession, 'tmuxSession');
  if (raw.worktreeDir !== undefined) c.worktreeDir = worktreeDir(raw.worktreeDir, 'worktreeDir');
  if (raw.branchPrefix !== undefined)
    c.branchPrefix = branchPrefix(raw.branchPrefix, 'branchPrefix');
  if (raw.autoArchive !== undefined) {
    if (!isObj(raw.autoArchive)) throw new ConfigError('autoArchive must be an object');
    const a = raw.autoArchive;
    if (a.onMerge !== undefined) c.autoArchive.onMerge = bool(a.onMerge, 'autoArchive.onMerge');
    if (a.afterDays !== undefined)
      c.autoArchive.afterDays = days(a.afterDays, 'autoArchive.afterDays');
  }
  if (raw.ntfyTopic !== undefined) c.ntfyTopic = ntfyTopic(raw.ntfyTopic, 'ntfyTopic');
  if (raw.ntfyServer !== undefined) c.ntfyServer = ntfyServer(raw.ntfyServer, 'ntfyServer');
  if (raw.ntfyToken !== undefined) c.ntfyToken = ntfyToken(raw.ntfyToken, 'ntfyToken');
  if (raw.ntfyOnDone !== undefined) c.ntfyOnDone = bool(raw.ntfyOnDone, 'ntfyOnDone');
  checkNtfyTopicLength(c);
  if (raw.token !== undefined) c.token = token(raw.token, 'token');

  if (env.KAGE_NAME) c.name = env.KAGE_NAME;
  if (env.KAGE_HOST) c.host = env.KAGE_HOST;
  if (env.KAGE_TMUX_SOCKET) c.tmuxSocket = env.KAGE_TMUX_SOCKET;
  if (env.KAGE_PORT) {
    const n = Number(env.KAGE_PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(`KAGE_PORT must be an integer in 1–65535, got "${env.KAGE_PORT}"`);
    }
    c.port = n;
  }

  c.projectsRoot = expandHome(c.projectsRoot, home);
  return c;
}
