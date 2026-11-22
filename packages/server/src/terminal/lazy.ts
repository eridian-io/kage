import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TerminalServer, TerminalServerDeps } from './server.ts';

/** What LazyTerminals needs from terminal/server.ts. */
export type TerminalModule = { TerminalServer: new (d: TerminalServerDeps) => TerminalServer };

/**
 * The terminal WebSocket server, loaded on the first upgrade (spec §7, idle cost): `ws` and the
 * terminal server stay out of an idle Kage's memory until a tab opens a terminal. Upgrades that
 * arrive while it loads are handed over in order; close() before the load makes the server
 * refuse them (503), as it refuses upgrades after close().
 */
export class LazyTerminals {
  readonly #d: TerminalServerDeps;
  readonly #load: () => Promise<TerminalModule>;
  #server: TerminalServer | null = null;
  #loading: Promise<TerminalServer> | null = null;
  #closed = false;

  constructor(
    d: TerminalServerDeps,
    load: () => Promise<TerminalModule> = () => import('./server.ts'),
  ) {
    this.#d = d;
    this.#load = load;
  }

  /** True once the terminal server is loaded. */
  get loaded(): boolean {
    return this.#server !== null;
  }

  /** The Node server's 'upgrade' event for any path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#server) {
      this.#server.handleUpgrade(req, socket, head);
      return;
    }
    socket.on('error', () => {});
    this.#loading ??= this.#load().then((m) => {
      const s = new m.TerminalServer(this.#d);
      if (this.#closed) s.close();
      this.#server = s;
      return s;
    });
    this.#loading.then(
      (s) => s.handleUpgrade(req, socket, head),
      () => socket.destroy(),
    );
  }

  close(): void {
    this.#closed = true;
    this.#server?.close();
  }
}
