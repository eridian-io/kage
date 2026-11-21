import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

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
  ntfyTopic: string;
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
  const bad = d.split('/').some((s) => !SEGMENT.test(s) || s === '.' || s === '..');
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

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

export async function loadConfig(
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KageConfig> {
  const env = opts.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  const path =
    opts.path ??
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, 'kage', 'config.json')
      : join(home, '.config', 'kage', 'config.json'));

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
      throw new ConfigError(`invalid JSON in config file ${path}: ${(e as Error).message}`);
    }
    if (!isObj(parsed)) throw new ConfigError(`config file ${path} must contain a JSON object`);
    raw = parsed;
  }

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
  if (raw.ntfyTopic !== undefined) c.ntfyTopic = str(raw.ntfyTopic, 'ntfyTopic');
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
