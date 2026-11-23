/**
 * What both service managers share for their files and commands (phase 6, Task 3): the marker,
 * atomic writes, value checks and the start timeout. It imports nothing of service.ts,
 * systemd.ts or launchd.ts, so there is no import cycle at run time.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import type { RunResult } from './run.ts';

/** How long a start may take (restart, enable --now, kickstart -k): longer than Run's 10 s. */
export const START_TIMEOUT_MS = 60_000;

/** The words of the marker line every file Kage writes carries (first line of the unit; the plist's line after the doctype). */
export const SERVICE_MARKER = 'Written by kage setup';

/**
 * Refuses a file at `path` that kage setup didn't write, naming it: `isOurs` gets its lines and
 * checks the marker line where the renderer puts it (the marker text elsewhere doesn't count). Only
 * a missing file (ENOENT) is fine; any other read error refuses too.
 */
export function assertOurs(path: string, isOurs: (lines: string[]) => boolean): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new Error(
      `Kage can't read ${path} (${code ?? (err as Error).message}), so it leaves it alone. Move it away, then try again.`,
    );
  }
  if (!isOurs(text.split(/\r?\n/))) {
    throw new Error(
      `${path} wasn't written by kage setup, so Kage leaves it alone. Another tool may have rewritten it. Move it away, then try again.`,
    );
  }
}

/** The file calls writeServiceFile makes; a test seam (M11). */
export interface ServiceFs {
  mkdirSync: (path: string, o: { recursive: true }) => unknown;
  openSync: (path: string, flags: string, mode?: number) => number;
  writeSync: (fd: number, buf: Buffer, offset: number, length: number) => number;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  chmodSync: (path: string, mode: number) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (path: string, o: { force: true }) => void;
}

const nodeFs: ServiceFs = {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  renameSync,
  rmSync,
};

/** Folders can't be opened or fsynced on Windows (and some filesystems); that's fine. */
const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'ENOTSUP']);

function syncDir(fs: ServiceFs, dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Writes a service file atomically: a temp file in the same folder (0644), renamed over the old
 * one. The rename replaces a symlink at `path` instead of writing through it. M11: the file and
 * its folder are fsynced before the rename and the folder again after it, so a power cut right
 * after setup leaves the old unit or the new one, never an empty file.
 */
export function writeServiceFile(path: string, text: string, fs: ServiceFs = nodeFs): void {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
      const buf = Buffer.from(text);
      for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
      fs.chmodSync(tmp, 0o644);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDir(fs, dir);
    fs.renameSync(tmp, path);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(fs, dir);
}

/** Throws for a value a service file can't hold: a control character or a lone surrogate. */
export function assertWritable(value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f]/.test(value) || !value.isWellFormed()) {
    throw new Error(
      `A service value can't hold a control character or a lone surrogate: ${JSON.stringify(value)}`,
    );
  }
}

/** The program a service runs must be an absolute path (systemd and launchd both need one). */
export function assertAbsoluteProgram(argv: string[]): void {
  const exe = argv[0] ?? '';
  if (!posix.isAbsolute(exe)) {
    throw new Error(`The service's program must be an absolute path, not "${exe}".`);
  }
}

/** Throws unless the command exited 0, naming it and its own words. */
export function mustSucceed(r: RunResult, cmd: string[]): void {
  if (r.code === 0) return;
  if (r.missing) throw new Error(`"${cmd[0]}" is not installed.`);
  const said = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';
  throw new Error(`"${cmd.join(' ')}" exited ${r.code}${said ? `: ${said}` : ''}`);
}
