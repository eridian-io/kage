/**
 * What both service managers share for their files and commands (phase 6, Task 3): the marker,
 * atomic writes, value checks and the start timeout. It imports nothing of service.ts,
 * systemd.ts or launchd.ts, so there is no import cycle at run time.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Writes a service file atomically: a temp file in the same folder (0644), renamed over the old
 * one. The rename replaces a symlink at `path` instead of writing through it.
 */
export function writeServiceFile(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
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
