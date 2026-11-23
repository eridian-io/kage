import type { ServerEvent } from '@kage/shared';
import type { SessionSource } from './source.ts';

interface Client {
  streamId: string;
  /** The session whose lines this stream receives, or null. */
  viewing: string | null;
  /** The login session that opened it (its key), or null with no token. */
  owner: string | null;
  /** The TCP peer that opened it (normalised), for the per-address cap. */
  peer: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer: ReturnType<typeof setInterval>;
}

const encoder = new TextEncoder();

/**
 * Open event streams one address may hold (security M3); GET /api/events answers 429 past it.
 * Each holds a snapshot's worth of queue and a heartbeat timer.
 */
export const MAX_STREAMS_PER_PEER = 16;

export const frame = (e: ServerEvent): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * The heartbeat: a named event, not a comment, because the page's script never sees a comment
 * and its watchdog must (reliability I3). One shared frame for every stream.
 */
const HEARTBEAT: Uint8Array = encoder.encode(frame({ type: 'hb' }));

/** An event's frame, encoded: one buffer that every stream it goes to shares (P9). */
const encode = (e: ServerEvent): Uint8Array => encoder.encode(frame(e));

export class EventHub {
  private readonly source: SessionSource;
  private readonly host: string;
  private readonly projectsRoot: string;
  private readonly heartbeatMs: number;
  private readonly maxQueue: number;
  /** A token is set: the snapshot's `auth`, so the board offers Sign out. */
  private readonly auth: boolean;
  /** The demo (kage serve --demo): the snapshot's `demo`, so the board shows its badge. */
  private readonly demo: boolean;
  private readonly clients = new Map<string, Client>();
  private unsubscribe: (() => void) | null = null;
  /** The union of every stream's viewed session, as last told to the source. */
  private viewed = new Set<string>();

  constructor(
    source: SessionSource,
    host: string,
    projectsRoot: string,
    opts: { heartbeatMs?: number; maxQueue?: number; auth?: boolean; demo?: boolean } = {},
  ) {
    this.source = source;
    this.host = host;
    this.projectsRoot = projectsRoot;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxQueue = opts.maxQueue ?? 256;
    this.auth = opts.auth ?? false;
    this.demo = opts.demo ?? false;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** The streams open from `peer` (GET /api/events refuses one past MAX_STREAMS_PER_PEER). */
  streamsFrom(peer: string): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.peer === peer) n++;
    return n;
  }

  /**
   * A new stream; `owner` is the login session that opened it (dropOwner closes it), `peer` the
   * address it came from (streamsFrom counts it).
   */
  stream(owner: string | null = null, peer = 'unknown'): ReadableStream<Uint8Array> {
    let client: Client | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const c: Client = {
          streamId: crypto.randomUUID(),
          viewing: null,
          owner,
          peer,
          controller,
          timer: setInterval(() => this.send(c, HEARTBEAT), this.heartbeatMs),
        };
        client = c;
        this.clients.set(c.streamId, c);
        this.ensureSubscribed();
        this.send(
          c,
          encode({
            type: 'snapshot',
            auth: this.auth,
            demo: this.demo,
            host: this.host,
            streamId: c.streamId,
            projectsRoot: this.projectsRoot,
            sessions: this.source.list(),
            archived: this.source.archivedCount?.() ?? 0,
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
    // Read the lines first: if that throws, the stream isn't half-switched. The reset goes out
    // before the source learns of the view, so lines it emits in response arrive after it.
    const lines = id === null ? null : this.source.lines(id);
    c.viewing = id;
    if (id !== null && lines !== null) {
      this.send(c, encode({ type: 'session.lines', id, lines, reset: true }));
    }
    // A session viewed already doesn't change the viewed set, so the source hears of it here.
    const already = id !== null && this.viewed.has(id);
    this.syncViewed();
    if (already) this.source.refreshView?.(id);
    return true;
  }

  /**
   * Errors every stream the session `key` opened (sign-out, eviction or expiry, F6). The tab sees
   * the stream fail, asks GET /api/auth, gets 401 and shows the login screen.
   */
  dropOwner(key: string): void {
    for (const c of [...this.clients.values()]) {
      if (c.owner !== key) continue;
      this.drop(c);
      try {
        c.controller.error(new Error('Signed out'));
      } catch {
        // already closed
      }
    }
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
    // Each event is serialised and encoded once, for every stream it goes to (P9).
    this.unsubscribe ??= this.source.subscribe((e) => {
      // A transition is for the server's own consumers; the board learns of it from its frame.
      if (e.type === 'session.transition') return;
      if (e.type === 'session.lines') {
        const bytes = encode({ ...e, reset: e.reset ?? false });
        for (const c of [...this.clients.values()]) if (c.viewing === e.id) this.send(c, bytes);
        return;
      }
      const bytes = encode(e);
      for (const c of [...this.clients.values()]) {
        if (e.type === 'session.removed' && c.viewing === e.id) c.viewing = null;
        this.send(c, bytes);
      }
      if (e.type === 'session.removed') this.syncViewed();
    });
  }

  /** Tells the source which sessions some stream views, when that set changed. */
  private syncViewed(): void {
    const ids = new Set<string>();
    for (const c of this.clients.values()) if (c.viewing !== null) ids.add(c.viewing);
    if (ids.size === this.viewed.size && [...ids].every((id) => this.viewed.has(id))) return;
    this.viewed = ids;
    this.source.setViewed?.(new Set(ids));
  }

  private send(c: Client, bytes: Uint8Array): void {
    try {
      c.controller.enqueue(bytes);
      // A tab that stops reading must not make the server buffer without limit.
      if ((c.controller.desiredSize ?? 0) < -this.maxQueue) {
        this.drop(c);
        // error(), not close(): close() would keep the backlog queued until the tab read it.
        c.controller.error(new Error('Event stream fell too far behind'));
      }
    } catch {
      this.drop(c);
    }
  }

  private drop(c: Client): void {
    clearInterval(c.timer);
    this.clients.delete(c.streamId);
    this.syncViewed();
    if (this.clients.size === 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}
