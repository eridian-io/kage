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
  worktreeDir: '.worktrees',
  branchPrefix: 'kage/',
  autoArchive: { onMerge: true, afterDays: 14 },
  ntfyTopic: '',
  token: '',
};

export class ConfigError extends Error {}

/** Lines `kage serve` prints at startup about settings that don't do what they suggest yet. */
export function startupWarnings(cfg: KageConfig): string[] {
  return cfg.token === ''
    ? []
    : [
        `Warning: "token" is set in the config but isn't enforced yet; anyone on your tailnet can open Kage.`,
      ];
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
  if (raw.worktreeDir !== undefined) c.worktreeDir = str(raw.worktreeDir, 'worktreeDir');
  if (raw.branchPrefix !== undefined) c.branchPrefix = str(raw.branchPrefix, 'branchPrefix');
  if (raw.autoArchive !== undefined) {
    if (!isObj(raw.autoArchive)) throw new ConfigError('autoArchive must be an object');
    const a = raw.autoArchive;
    if (a.onMerge !== undefined) c.autoArchive.onMerge = bool(a.onMerge, 'autoArchive.onMerge');
    if (a.afterDays !== undefined)
      c.autoArchive.afterDays = days(a.afterDays, 'autoArchive.afterDays');
  }
  if (raw.ntfyTopic !== undefined) c.ntfyTopic = str(raw.ntfyTopic, 'ntfyTopic');
  if (raw.token !== undefined) c.token = str(raw.token, 'token');

  if (env.KAGE_NAME) c.name = env.KAGE_NAME;
  if (env.KAGE_HOST) c.host = env.KAGE_HOST;
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
