import { request } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { HookEnvelope } from './event.ts';

/** Sends one envelope; may reject or hang — the caller bounds it. */
export type PostFn = (socket: string, body: string, signal: AbortSignal) => Promise<void>;

/** The whole `kage hook` run, stdin included, ends within this; Node startup fits in the rest of 2 s. */
export const HOOK_DEADLINE_MS = 1500;
const MAX_STDIN = 1024 * 1024;

/**
 * Where the hook socket lives: `KAGE_SOCKET`, else `$XDG_RUNTIME_DIR/kage.sock`, else
 * `$XDG_STATE_HOME/kage/kage.sock`, else
 * `~/.local/state/kage/kage.sock`. On Windows (dev only) a per-user named pipe.
 */
export function socketPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.KAGE_SOCKET) return env.KAGE_SOCKET;
  if (platform === 'win32') {
    const user = (env.USERNAME || safeUser() || 'user').replace(/[^\w.-]/g, '_');
    return `\\\\.\\pipe\\kage-${user}`;
  }
  if (env.XDG_RUNTIME_DIR) return posix.join(env.XDG_RUNTIME_DIR, 'kage.sock');
  if (env.XDG_STATE_HOME) return posix.join(env.XDG_STATE_HOME, 'kage', 'kage.sock');
  const home = env.HOME || homedir();
  return posix.join(home, '.local', 'state', 'kage', 'kage.sock');
}

function safeUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

/** `POST /hook` over the socket with node:http. */
export const httpPost: PostFn = (socket, body, signal) =>
  new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/hook',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        signal,
      },
      (res) => {
        res.on('error', reject);
        res.on('end', resolve);
        res.resume();
      },
    );
    req.on('error', reject);
    req.end(body);
  });

/** Reads stdin to the end; null if it errors or passes MAX_STDIN. */
function readStdin(stdin: Readable, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (value: string | null) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (value === null) stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > MAX_STDIN) finish(null);
      else chunks.push(b);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(null);
    const onAbort = () => finish(null);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function deliver(
  event: string,
  io: { stdin: Readable; env: NodeJS.ProcessEnv; post: PostFn },
  signal: AbortSignal,
): Promise<void> {
  const text = await readStdin(io.stdin, signal);
  if (text === null || signal.aborted) return;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const envelope: HookEnvelope = {
    event,
    pane: io.env.TMUX_PANE || null,
    payload: payload as Record<string, unknown>,
  };
  await io.post(socketPath(io.env), JSON.stringify(envelope), signal);
}

/**
 * `kage hook <event>`: forwards Claude's hook JSON to the Kage server. It must never disturb
 * Claude, so it prints nothing, swallows every error and resolves 0 within HOOK_DEADLINE_MS.
 */
export async function runHookCli(
  event: string,
  io: { stdin: Readable; env: NodeJS.ProcessEnv; post?: PostFn },
): Promise<0> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve();
    }, HOOK_DEADLINE_MS);
  });
  const work = (async () => {
    try {
      await deliver(event, { stdin: io.stdin, env: io.env, post: io.post ?? httpPost }, ac.signal);
    } catch {
      // the server may be down; Claude must not notice
    }
  })();
  await Promise.race([work, deadline]);
  clearTimeout(timer);
  ac.abort();
  return 0;
}
