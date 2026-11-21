import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { type HookEvent, parseHookEvent } from './event.ts';

export type { HookEvent, HookEventName } from './event.ts';

/** Largest accepted body. */
export const MAX_BODY = 1024 * 1024;
/** Past this many bytes the connection is cut instead of drained for a 413 answer. */
const HARD_CAP = 8 * MAX_BODY;

const isPipe = (path: string) => path.startsWith('\\\\.\\pipe\\') || path.startsWith('//./pipe/');

/** Sets the process umask; null where it can't be set (worker threads). */
function setUmask(mask: number): number | null {
  try {
    return process.umask(mask);
  } catch {
    return null;
  }
}

/** True when something accepts connections on the socket. */
function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (alive: boolean) => {
      s.destroy();
      resolve(alive);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

/**
 * Receives `kage hook` posts on a Unix socket (or a named pipe on Windows):
 * `POST /hook` with a JSON envelope, at most 1 MB. The socket file is mode 0600.
 */
export class HookServer {
  readonly path: string;
  #now: () => number;
  #listeners = new Set<(e: HookEvent) => void>();
  #server: Server | null = null;
  #uid: number | undefined;

  /** `uid` is the owner the socket's directory must have (default: this process's). */
  constructor(path: string, opts: { now?: () => number; uid?: number } = {}) {
    this.path = path;
    this.#now = opts.now ?? Date.now;
    this.#uid = opts.uid ?? process.getuid?.();
  }

  on(fn: (e: HookEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  async listen(): Promise<void> {
    if (this.#server) throw new Error('HookServer is already listening');
    if (!isPipe(this.path)) await this.#prepareSocketPath();
    const server = createServer((req, res) => this.#handle(req, res));
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    // The socket is created 0600 from the start (umask 0177), so there is no window in which
    // others could connect; the chmod after listening stays as a second guard.
    const oldMask = isPipe(this.path) ? null : setUmask(0o177);
    const restore = () => {
      if (oldMask !== null) process.umask(oldMask);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          restore();
          reject(
            err.code === 'EADDRINUSE' ? new Error(`Hook socket ${this.path} is in use.`) : err,
          );
        };
        server.once('error', onError);
        server.listen(this.path, () => {
          restore();
          server.off('error', onError);
          resolve();
        });
      });
    } finally {
      restore();
    }
    this.#server = server;
    if (!isPipe(this.path)) {
      try {
        await chmod(this.path, 0o600);
      } catch (err) {
        await this.close();
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /**
   * Makes sure the parent directory is ours and 0700 (creating it, or tightening a looser one),
   * then removes a stale socket left by a crash.
   */
  async #prepareSocketPath(): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await lstat(parent);
    if (!dir.isDirectory()) throw new Error(`Hook socket directory ${parent} is not a directory.`);
    if (this.#uid !== undefined && dir.uid !== this.#uid) {
      throw new Error(`Hook socket directory ${parent} is not owned by this user.`);
    }
    if ((dir.mode & 0o077) !== 0) await chmod(parent, 0o700);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (!st.isSocket())
      throw new Error(`Hook socket path ${this.path} exists and is not a socket.`);
    if (await probe(this.path)) throw new Error(`Hook socket ${this.path} is in use.`);
    await unlink(this.path);
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number) => {
      if (res.headersSent) return;
      res.writeHead(status, status === 204 ? {} : { 'content-length': 0 });
      res.end();
    };
    req.on('error', () => res.destroy());
    if (req.url !== '/hook') {
      req.resume();
      reply(404);
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('allow', 'POST');
      reply(405);
      return;
    }
    // A declared size over the limit is refused before reading any of it; the connection
    // closes after the answer, so the unread body is never drained.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      res.setHeader('connection', 'close');
      reply(413);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > HARD_CAP) {
        req.destroy();
        res.destroy();
        return;
      }
      if (size <= MAX_BODY) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reply(413);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400);
      }
      const event = parseHookEvent(body, this.#now());
      if (!event) return reply(400);
      reply(204);
      for (const fn of [...this.#listeners]) {
        try {
          fn(event);
        } catch {
          // one bad listener must not stop the others
        }
      }
    });
  }
}
