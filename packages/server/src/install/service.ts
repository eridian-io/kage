/**
 * The background service that keeps `kage serve` running: a systemd user unit on Linux and WSL,
 * a launchd agent on macOS (phase 6, Task 3). Both files hold only the command, the PATH captured
 * at setup and the R91 tuning; the token and the ntfy keys stay in config.json (0600). Nothing
 * here runs as root or calls sudo.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { launchdManager } from './launchd.ts';
import type { Run, RunResult } from './run.ts';
import { systemdManager } from './systemd.ts';

/** What the service runs: `serviceArgv(mode)` and `serviceEnv(mode, path)` from runtime.ts. */
export interface ServiceSpec {
  argv: string[];
  env: Record<string, string>;
}

/** starting: systemd's activating, the restart loop while Tailscale has no address (R111). */
export type ServiceState = 'active' | 'starting' | 'inactive' | 'failed' | 'missing';

export interface ServiceManager {
  readonly kind: 'systemd' | 'launchd';
  /** The unit or plist path. */
  readonly file: string;
  /** "systemd user unit kage.service" / "launchd agent io.eridian.kage". */
  readonly name: string;
  /** null, or one sentence why the service can't be installed here (with the fix). */
  unavailable(): Promise<string | null>;
  /** Writes the file (0644, no secrets), reloads, enables, and starts or restarts it. */
  install(spec: ServiceSpec): Promise<void>;
  restart(): Promise<void>;
  /**
   * Stops, disables, deletes the file and reloads; fine when it isn't installed. A file of that
   * name that kage setup didn't write is refused (install too), never disabled.
   */
  remove(): Promise<void>;
  state(): Promise<ServiceState>;
  /** The PATH written in the file (doctor's service-path check); null without a file. */
  pathOfInstalled(): Promise<string | null>;
  /** systemd only (F6): whether the user manager outlives the login session. */
  lingerEnabled?(): Promise<boolean>;
  /** systemd only (F6): `loginctl enable-linger` for oneself, never sudo; false if refused. */
  enableLinger?(): Promise<boolean>;
}

export interface ServiceDeps {
  run: Run;
  home: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  /** True inside WSL; by default, the WSL interop entry or WSL_DISTRO_NAME (a test seam). */
  wsl?: () => boolean;
  /** Waits between launchctl bootstrap retries (a test seam; by default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** How long a start may take (restart, enable --now, kickstart -k): longer than Run's 10 s. */
export const START_TIMEOUT_MS = 60_000;

/** The words in every file Kage writes; a file of the same name without them isn't Kage's. */
export const SERVICE_MARKER = 'Written by kage setup';

/** linux → systemd, darwin → launchd, anything else → null. */
export function serviceManager(platform: NodeJS.Platform, d: ServiceDeps): ServiceManager | null {
  if (platform === 'linux') return systemdManager(d);
  if (platform === 'darwin') return launchdManager(d);
  return null;
}

/**
 * Refuses a file at `path` that kage setup didn't write (no marker), naming it. A missing file
 * is fine.
 */
export function assertOurs(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(SERVICE_MARKER)) {
    throw new Error(
      `${path} wasn't written by kage setup, so Kage leaves it alone. Move it away, then try again.`,
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
