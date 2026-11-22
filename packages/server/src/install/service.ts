/**
 * The background service that keeps `kage serve` running: a systemd user unit on Linux and WSL,
 * a launchd agent on macOS (phase 6, Task 3). Both files hold only the command, the PATH captured
 * at setup and the R91 tuning; the token and the ntfy keys stay in config.json (0600). Nothing
 * here runs as root or calls sudo.
 */
import { launchdManager } from './launchd.ts';
import type { Run } from './run.ts';
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
  /** The clock for the bootstrap retries' overall cap (a test seam; by default Date.now). */
  now?: () => number;
}

/** linux → systemd, darwin → launchd, anything else → null. */
export function serviceManager(platform: NodeJS.Platform, d: ServiceDeps): ServiceManager | null {
  if (platform === 'linux') return systemdManager(d);
  if (platform === 'darwin') return launchdManager(d);
  return null;
}
