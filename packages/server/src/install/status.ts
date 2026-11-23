/**
 * The client half of `GET /status` (phase 6, Task 4): asks the running `kage serve` over its hook
 * socket, so `kage status`, setup's final check and `kage doctor` need neither the token nor the
 * network. `kage status` itself (Task 5) is at the end.
 */
import { stat } from 'node:fs/promises';
import { type ClientRequest, request } from 'node:http';
import { ConfigError, configPath, loadConfig } from '../config.ts';
import { socketPath } from '../hooks/cli.ts';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import type { CheckDeps } from './checks.ts';
import { KAGE_VERSION } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';

const MAX_ANSWER = 64 * 1024;

function isStatus(v: unknown): v is ServerStatus {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return (
    typeof s.version === 'string' &&
    typeof s.url === 'string' &&
    count(s.sessions) &&
    count(s.needsYou) &&
    count(s.pid)
  );
}

/** The server's status over the socket; null when nothing answers in time, or not with a status. */
export function fetchStatus(socket: string, timeoutMs = 1000): Promise<ServerStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    // Both are set below; done() may run before either exists (request() can throw at once).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: ClientRequest | undefined;
    const done = (value: ServerStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(value);
    };
    try {
      req = request({ socketPath: socket, path: '/status', method: 'GET' }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER) done(null);
          else chunks.push(c);
        });
        res.on('end', () => {
          try {
            const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done(
              isStatus(v)
                ? {
                    version: v.version,
                    url: v.url,
                    sessions: v.sessions,
                    needsYou: v.needsYou,
                    pid: v.pid,
                  }
                : null,
            );
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      });
    } catch {
      done(null);
      return;
    }
    req.on('error', () => done(null));
    timer = setTimeout(() => done(null), timeoutMs);
    req.end();
  });
}

const SERVICE_WORDS: Record<ServiceState, (name: string) => string> = {
  active: (name) => `running (${name})`,
  starting: () => 'starting (waiting for Tailscale?)',
  inactive: () => 'stopped',
  failed: () => 'failed',
  missing: () => 'not installed',
};

/**
 * The Service line's words, and the state when known; unavailable() comes first, since state()
 * needs a user manager (R112).
 */
async function serviceWords(
  m: ServiceManager | null,
): Promise<{ words: string; state: ServiceState | null }> {
  // No service manager here (not Linux or macOS): nothing setup could install either.
  if (m === null) return { words: SERVICE_WORDS.missing(''), state: null };
  const why = await m.unavailable();
  if (why !== null) return { words: `can't run here. ${why}`, state: null };
  try {
    const state = await m.state();
    return { words: SERVICE_WORDS[state](m.name), state };
  } catch {
    return { words: "unknown (Kage couldn't read its state)", state: null };
  }
}

/**
 * Whether the config holds an access token (security I3), never the token itself. null
 * without a config file, or with one Kage can't read (doctor says what's wrong with it).
 */
async function tokenOn(env: NodeJS.ProcessEnv): Promise<boolean | null> {
  const path = configPath(env);
  if (
    !(await stat(path).then(
      () => true,
      () => false,
    ))
  )
    return null;
  try {
    return (await loadConfig({ env, path })).token !== '';
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

/**
 * `kage status`: the version, the service, the access token, and the server's address and
 * sessions. 0 when the server answers, else 1.
 */
export async function statusCommand(io: Io, deps: CheckDeps): Promise<number> {
  io.out(`Kage ${KAGE_VERSION}`);
  const service = await serviceWords(deps.manager);
  io.out(`Service: ${service.words}`);
  // An old tokenless config stops the service, so this line says so even when nothing answers.
  const token = await tokenOn(deps.env);
  if (token !== null) io.out(token ? 'Access token: on' : 'Access token: off');
  const socket = socketPath(deps.env, deps.platform);
  const status = await deps.status(socket);
  if (status === null) {
    io.out(`Kage isn't answering on ${socket}.`);
    // Without a service, setup installs one; otherwise doctor says what's wrong.
    io.out(service.state === 'missing' ? 'Run kage setup.' : 'Run kage doctor to see why.');
    return 1;
  }
  io.out(`Address: ${status.url}`);
  const waiting =
    status.needsYou === 0
      ? ''
      : ` (${status.needsYou} ${status.needsYou === 1 ? 'needs' : 'need'} you)`;
  io.out(`Sessions: ${status.sessions}${waiting}`);
  return 0;
}
