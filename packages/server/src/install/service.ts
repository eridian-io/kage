/**
 * The background service that keeps `kage serve` running: a systemd user unit on Linux and WSL,
 * a launchd agent on macOS (phase 6, Task 3). Both files hold only the command and what
 * runtime.ts serviceEnv adds to the manager's environment (the PATH captured at setup, the R91
 * tuning and the folder settings of R124); the token and the ntfy keys stay in config.json
 * (0600). Nothing here runs as root or calls sudo.
 */
import { launchdManager } from './launchd.ts';
import type { Run } from './run.ts';
import { systemdManager, systemdUnitDir } from './systemd.ts';

/** What the service runs: `serviceArgv(mode)` and `serviceEnv(mode, path)` from runtime.ts. */
export interface ServiceSpec {
  argv: string[];
  env: Record<string, string>;
}

/**
 * starting: the restart loop while Tailscale has no address (R111): systemd's activating, and
 * launchd's not running after a non-zero exit (KeepAlive starts it again).
 */
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
  /** systemd only: the folder the user manager reads units from (systemd.ts systemdUnitDir). */
  unitDir?: string;
}

/**
 * linux → systemd, darwin → launchd, anything else → null. On Linux it first asks the user
 * manager where it reads units from (systemdUnitDir).
 */
export async function serviceManager(
  platform: NodeJS.Platform,
  d: ServiceDeps,
): Promise<ServiceManager | null> {
  if (platform === 'linux') {
    const unitDir = d.unitDir ?? (await systemdUnitDir(d.run, d.home, d.env));
    return systemdManager({ ...d, unitDir });
  }
  if (platform === 'darwin') return launchdManager(d);
  return null;
}
