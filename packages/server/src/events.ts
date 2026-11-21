import type { ServerEvent } from '@kage/shared';
import type { SessionSource } from './source.ts';

interface Client {
  streamId: string;
  /** The session whose lines this stream receives, or null. */
  viewing: string | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer: ReturnType<typeof setInterval>;
}

const encoder = new TextEncoder();

export const frame = (e: ServerEvent): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

export class EventHub {
  private readonly source: SessionSource;
  private readonly host: string;
  private readonly projectsRoot: string;
  private readonly heartbeatMs: number;
  private readonly maxQueue: number;
  private readonly clients = new Map<string, Client>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    source: SessionSource,
    host: string,
    projectsRoot: string,
    opts: { heartbeatMs?: number; maxQueue?: number } = {},
  ) {
    this.source = source;
    this.host = host;
    this.projectsRoot = projectsRoot;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxQueue = opts.maxQueue ?? 256;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stream(): ReadableStream<Uint8Array> {
    let client: Client | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const c: Client = {
          streamId: crypto.randomUUID(),
          viewing: null,
          controller,
          timer: setInterval(() => this.send(c, ': hb\n\n'), this.heartbeatMs),
        };
        client = c;
        this.clients.set(c.streamId, c);
        this.ensureSubscribed();
        this.send(
          c,
          frame({
            type: 'snapshot',
            host: this.host,
            streamId: c.streamId,
            projectsRoot: this.projectsRoot,
            sessions: this.source.list(),
          }),
        );
      },
      cancel: () => {
        if (client) this.drop(client);
      },
    });
  }

  /** Points a stream at one session (or none) and sends that session's lines. False for an unknown stream. */
  view(streamId: string, id: string | null): boolean {
    const c = this.clients.get(streamId);
    if (!c) return false;
    c.viewing = id;
    if (id !== null) {
      this.send(c, frame({ type: 'session.lines', id, lines: this.source.lines(id), reset: true }));
    }
    return true;
  }

  close(): void {
    for (const c of [...this.clients.values()]) {
      this.drop(c);
      try {
        c.controller.close();
      } catch {
        // already closed
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ensureSubscribed(): void {
    this.unsubscribe ??= this.source.subscribe((e) => {
      if (e.type === 'session.lines') {
        const text = frame({ ...e, reset: false });
        for (const c of [...this.clients.values()]) if (c.viewing === e.id) this.send(c, text);
        return;
      }
      const text = frame(e);
      for (const c of [...this.clients.values()]) {
        if (e.type === 'session.removed' && c.viewing === e.id) c.viewing = null;
        this.send(c, text);
      }
    });
  }

  private send(c: Client, text: string): void {
    try {
      c.controller.enqueue(encoder.encode(text));
      // A tab that stops reading must not make the server buffer without limit.
      if ((c.controller.desiredSize ?? 0) < -this.maxQueue) {
        this.drop(c);
        c.controller.close();
      }
    } catch {
      this.drop(c);
    }
  }

  private drop(c: Client): void {
    clearInterval(c.timer);
    this.clients.delete(c.streamId);
    if (this.clients.size === 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}
