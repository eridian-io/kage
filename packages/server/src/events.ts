import type { ServerEvent } from '@kage/shared';
import type { SessionSource } from './source.ts';

interface Client {
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
  private readonly clients = new Set<Client>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    source: SessionSource,
    host: string,
    projectsRoot: string,
    opts: { heartbeatMs?: number } = {},
  ) {
    this.source = source;
    this.host = host;
    this.projectsRoot = projectsRoot;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stream(): ReadableStream<Uint8Array> {
    let client: Client | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const c: Client = {
          controller,
          timer: setInterval(() => this.send(c, ': hb\n\n'), this.heartbeatMs),
        };
        client = c;
        this.clients.add(c);
        this.ensureSubscribed();
        this.send(
          c,
          frame({
            type: 'snapshot',
            host: this.host,
            streamId: crypto.randomUUID(),
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

  close(): void {
    for (const c of [...this.clients]) {
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
      // Task 3 routes lines to the stream viewing the session; for now every stream gets them.
      const text = frame(e.type === 'session.lines' ? { ...e, reset: false } : e);
      for (const c of [...this.clients]) this.send(c, text);
    });
  }

  private send(c: Client, text: string): void {
    try {
      c.controller.enqueue(encoder.encode(text));
    } catch {
      this.drop(c);
    }
  }

  private drop(c: Client): void {
    clearInterval(c.timer);
    this.clients.delete(c);
    if (this.clients.size === 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}
