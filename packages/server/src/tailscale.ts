/**
 * Which program answers for `tailscale` (R115): the one on PATH; on macOS, when there is none,
 * the CLI inside the Tailscale app (the App Store and standalone apps don't put it on PATH).
 * `kage serve` (listen.ts) and `kage doctor` (install/checks.ts) both ask here.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';

export const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface TailscaleLookup {
  /** Default: this process's platform. */
  platform?: NodeJS.Platform;
  /** A PATH value; default: this process's. */
  path?: string;
  /** Default: an executable regular file. A test seam. */
  isExecutable?: (file: string) => boolean;
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** "tailscale", or on macOS the app's CLI when no tailscale is on PATH and the app is there. */
export function tailscaleCommand(o: TailscaleLookup = {}): string {
  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin') return 'tailscale';
  const isExec = o.isExecutable ?? executable;
  const path = o.path ?? process.env.PATH ?? '';
  // macOS only from here, so its PATH separator and paths are POSIX ones.
  for (const dir of path.split(':')) {
    if (dir !== '' && posix.isAbsolute(dir) && isExec(posix.join(dir, 'tailscale')))
      return 'tailscale';
  }
  return isExec(MAC_APP_TAILSCALE) ? MAC_APP_TAILSCALE : 'tailscale';
}
