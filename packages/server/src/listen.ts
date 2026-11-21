import { execFile } from 'node:child_process';
import type { KageConfig } from './config.ts';

export interface ListenAddress {
  address: string;
  hostNames: string[];
}

export class ListenError extends Error {}

export interface ListenOptions {
  unsafeListenAll: boolean;
  tailscaleIp: () => Promise<string | null>;
  hostname: () => string;
}

/** Runs `tailscale ip -4` (argument array, no shell); null on any error or empty output. */
export function defaultTailscaleIp(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0]?.trim() ?? '';
      resolve(first === '' ? null : first);
    });
  });
}

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]']);

export async function resolveListenAddress(
  cfg: KageConfig,
  opts: ListenOptions,
): Promise<ListenAddress> {
  let address: string;
  if (cfg.host !== null) {
    address = cfg.host;
    if (WILDCARDS.has(address) && !opts.unsafeListenAll) {
      throw new ListenError(
        `Refusing to listen on ${address}: that exposes Kage to every network. Use a Tailscale address, or pass --unsafe-listen-all if you really mean it.`,
      );
    }
  } else {
    const ip = await opts.tailscaleIp();
    if (ip === null) {
      throw new ListenError(
        'Tailscale isn\'t running. Start it with "tailscale up", or set "host" in ~/.config/kage/config.json.',
      );
    }
    address = ip;
  }
  return { address, hostNames: [...new Set([address, opts.hostname()])] };
}
