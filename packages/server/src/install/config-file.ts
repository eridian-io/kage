/**
 * Writing Kage's config file for `kage setup` (phase 6, Task 5). Setup owns only the keys it
 * asks about; every other key in the file (the ntfy settings, autoArchive, keys this version
 * doesn't know) is kept as it was. The file may hold the token, so it is written 0600 in a 0700
 * folder, atomically (a temporary file renamed over it), and a file Kage can't parse is never
 * replaced.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ConfigError } from '../config.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A fresh access token: 32 base64url characters from 24 random bytes. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The config file's object as written; null when there is no file. Throws a ConfigError (whose
 * message never quotes the file) when it isn't a JSON object.
 */
export async function readConfigObject(path: string): Promise<Obj | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`Kage can't read ${path} (${(err as NodeJS.ErrnoException).code}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(
      `${path} isn't valid JSON. Fix it or move it away, then run kage setup again.`,
    );
  }
  if (!isObj(parsed)) {
    throw new ConfigError(
      `${path} must hold a JSON object. Fix it or move it away, then run kage setup again.`,
    );
  }
  return parsed;
}

/** Owner-only modes; Windows has none to set. */
async function tighten(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode);
}

/**
 * Merges `patch` into the config file's object and writes it back, keeping every other key.
 * When nothing differs the file is left as written. Either way the folder ends up 0700 and the
 * file 0600.
 */
export async function writeConfig(path: string, patch: Obj): Promise<void> {
  const current = await readConfigObject(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tighten(dir, 0o700);

  const same =
    current !== null &&
    Object.entries(patch).every(([k, v]) => JSON.stringify(current[k]) === JSON.stringify(v));
  if (same) {
    await tighten(path, 0o600);
    return;
  }

  const next = { ...(current ?? {}), ...patch };
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await tighten(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
