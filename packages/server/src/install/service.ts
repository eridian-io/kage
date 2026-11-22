/**
 * The background service that keeps `kage serve` running: a systemd user unit on Linux and WSL,
 * a launchd agent on macOS (phase 6, Task 3). Both files hold only the command, the PATH captured
 * at setup and the R91 tuning; the token and the ntfy keys stay in config.json (0600). Nothing
 * here runs as root or calls sudo.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { launchdManager } from './launchd.ts';
import type { Run, RunResult } from './run.ts';
import { systemdManager } from './systemd.ts';

/** What the service runs: `serviceArgv(mode)` and `serviceEnv(mode, path)` from runtime.ts. */
export interface ServiceSpec {
  argv: string[];
  env: Record<string, string>;
}

export type ServiceState = 'active' | 'inactive' | 'failed' | 'missing';

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
  /** Stops, disables, deletes the file and reloads; fine when it isn't installed. */
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
}

/** linux → systemd, darwin → launchd, anything else → null. */
export function serviceManager(platform: NodeJS.Platform, d: ServiceDeps): ServiceManager | null {
  if (platform === 'linux') return systemdManager(d);
  if (platform === 'darwin') return launchdManager(d);
  return null;
}

/** Writes a service file: its folder created, the file 0644 even if it existed with another mode. */
export function writeServiceFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
  chmodSync(path, 0o644);
}

/** Throws unless the command exited 0, naming it and its own words. */
export function mustSucceed(r: RunResult, cmd: string[]): void {
  if (r.code === 0) return;
  const said = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';
  const how = r.missing ? 'is not installed' : `exited ${r.code}`;
  throw new Error(`"${cmd.join(' ')}" ${how}${said ? `: ${said}` : ''}`);
}
