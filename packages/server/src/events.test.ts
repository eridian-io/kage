import { type DisplayLine, demoSessions, type Session } from '@kage/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoSource } from './demo-source.ts';
import { EventHub, MAX_STREAMS_PER_PEER } from './events.ts';
import { NotFoundError, type SessionSource, type SourceEvent } from './source.ts';

const dec = new TextDecoder();
const read = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
  const { value } = await r.read();
  return dec.decode(value);
};

/** A source the tests drive by hand: emit() any event, see every setViewed call. */
class StubSource implements SessionSource {
  sessions: Session[] = demoSessions(1);
  readonly listeners = new Set<(e: SourceEvent) => void>();
  readonly viewedCalls: string[][] = [];
  onSetViewed: ((ids: ReadonlySet<string>) => void) | null = null;
  linesCalls = 0;

  list(): Session[] {
    return this.sessions.map((s) => ({ ...s, lines: [] }));
  }
  get(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id);
  }
  lines(id: string): DisplayLine[] {
    this.linesCalls++;
    return this.get(id)?.lines ?? [];
  }
  async remove(id: string): Promise<void> {
    if (!this.get(id)) throw new NotFoundError(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.emit({ type: 'session.removed', id });
  }
  setViewed(ids: ReadonlySet<string>): void {
    this.viewedCalls.push([...ids].sort());
    this.onSetViewed?.(ids);
  }
  archivedCount?: () => number;
  readonly refreshCalls: string[] = [];
  refreshView(id: string): void {
    this.refreshCalls.push(id);
  }
  subscribe(fn: (e: SourceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(e: SourceEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }
}

afterEach(() => vi.useRealTimers());

describe('EventHub', () => {
  it('sends a snapshot first, then source events', async () => {
    const source = new DemoSource(1_000_000);
    const hub = new EventHub(source, 'my-pc', '/p');
    const reader = hub.stream().getReader();
    const first = await read(reader);
    expect(first.startsWith('event: snapshot\ndata: ')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(first.slice('event: snapshot\ndata: '.length));
    expect(data.host).toBe('my-pc');
    expect(data.sessions).toHaveLength(6);
    expect(data.projectsRoot).toBe('/p');
    expect(typeof data.streamId).toBe('string');
    expect(data.sessions.every((s: { lines: unknown[] }) => s.lines.length === 0)).toBe(true);
    await source.remove('docs');
    expect(await read(reader)).toContain('event: session.removed\ndata: ');
    await reader.cancel();
    hub.close();
  });
  it('the snapshot says whether a token is set (auth), false by default', async () => {
    const source = new DemoSource(1_000_000);
    const snap = async (hub: EventHub) => {
      const reader = hub.stream().getReader();
      const text = await read(reader);
      await reader.cancel();
      return JSON.parse(text.slice('event: snapshot\ndata: '.length));
    };
    expect((await snap(new EventHub(source, 'my-pc', '/p'))).auth).toBe(false);
    expect((await snap(new EventHub(source, 'my-pc', '/p', { auth: true }))).auth).toBe(true);
  });

  it('dropOwner errors the streams that session opened, and no others', async () => {
    const source = new StubSource();
    const hub = new EventHub(source, 'my-pc', '/p');
    const mine = [hub.stream('key-a').getReader(), hub.stream('key-a').getReader()];
    const theirs = hub.stream('key-b').getReader();
    const open = hub.stream(null).getReader();
    for (const r of [...mine, theirs, open]) await read(r);
    expect(hub.clientCount).toBe(4);
    hub.dropOwner('key-a');
    for (const r of mine) await expect(r.read()).rejects.toThrow();
    expect(hub.clientCount).toBe(2);
    // The others still get events.
    source.emit({ type: 'session.removed', id: 'x' });
    expect(await read(theirs)).toContain('session.removed');
    expect(await read(open)).toContain('session.removed');
    // An unknown key, or one already dropped, changes nothing.
    hub.dropOwner('key-a');
    hub.dropOwner('nobody');
    expect(hub.clientCount).toBe(2);
    hub.close();
  });

  it('streamsFrom counts the open streams of one peer; a cancel or dropOwner lowers it (security M3)', async () => {
    expect(MAX_STREAMS_PER_PEER).toBe(16);
    const source = new StubSource();
    const hub = new EventHub(source, 'my-pc', '/p');
    const a = [hub.stream('key-a', '100.64.0.9'), hub.stream('key-a', '100.64.0.9')];
    const b = hub.stream('key-b', '100.64.0.10');
    expect(hub.streamsFrom('100.64.0.9')).toBe(2);
    expect(hub.streamsFrom('100.64.0.10')).toBe(1);
    expect(hub.streamsFrom('100.64.0.11')).toBe(0);
    await (a[0] as ReadableStream<Uint8Array>).cancel();
    expect(hub.streamsFrom('100.64.0.9')).toBe(1);
    hub.dropOwner('key-a');
    expect(hub.streamsFrom('100.64.0.9')).toBe(0);
    await b.cancel();
    expect(hub.streamsFrom('100.64.0.10')).toBe(0);
    hub.close();
  });

  it('the snapshot carries archived from archivedCount(), or 0 without one', async () => {
    const none = new EventHub(new StubSource(), 'h', '/p');
    const r1 = none.stream().getReader();
    expect(JSON.parse((await read(r1)).split('data: ')[1] as string).archived).toBe(0);
    const source = new StubSource();
    source.archivedCount = () => 3;
    const hub = new EventHub(source, 'h', '/p');
    const r2 = hub.stream().getReader();
    expect(JSON.parse((await read(r2)).split('data: ')[1] as string).archived).toBe(3);
    await r1.cancel();
    await r2.cancel();
    none.close();
    hub.close();
  });
  it('an archive source event goes to every stream', async () => {
    const source = new StubSource();
    const hub = new EventHub(source, 'h', '/p');
    const a = hub.stream().getReader();
    const b = hub.stream().getReader();
    await read(a);
    await read(b);
    source.emit({ type: 'archive', count: 4 });
    for (const r of [a, b]) {
      expect(await read(r)).toBe('event: archive\ndata: {"type":"archive","count":4}\n\n');
    }
    await a.cancel();
    await b.cancel();
    hub.close();
  });
  it('fans out to every client', async () => {
    const source = new DemoSource(1);
    const hub = new EventHub(source, 'h', '/p');
    const a = hub.stream().getReader();
    const b = hub.stream().getReader();
    await read(a);
    await read(b);
    expect(hub.clientCount).toBe(2);
    await source.remove('docs');
    expect(await read(a)).toContain('session.removed');
    expect(await read(b)).toContain('session.removed');
    hub.close();
    expect(hub.clientCount).toBe(0);
  });
  it('sends heartbeat comments', async () => {
    vi.useFakeTimers();
    const hub = new EventHub(new DemoSource(1), 'h', '/p', { heartbeatMs: 20 });
    const reader = hub.stream().getReader();
    await read(reader);
    await vi.advanceTimersByTimeAsync(25);
    expect(await read(reader)).toBe(': hb\n\n');
    await reader.cancel();
    hub.close();
  });
  it('cancelling drops clientCount to 0', async () => {
    const hub = new EventHub(new DemoSource(1), 'h', '/p');
    const reader = hub.stream().getReader();
    await read(reader);
    expect(hub.clientCount).toBe(1);
    await reader.cancel();
    expect(hub.clientCount).toBe(0);
    hub.close();
  });

  describe('view routing', () => {
    const open = async (hub: EventHub) => {
      const reader = hub.stream().getReader();
      const snap = JSON.parse((await read(reader)).split('data: ')[1] ?? '');
      return { reader, streamId: snap.streamId as string };
    };
    const lines = (text: string): SourceEvent => ({
      type: 'session.lines',
      id: 'shop',
      lines: [{ kind: 'out', text }],
    });

    it('sends a view only to its stream, and stops on null', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      const b = await open(hub);
      expect(a.streamId).not.toBe(b.streamId);
      expect(hub.view(a.streamId, 'shop')).toBe(true);
      const got = await read(a.reader);
      expect(got.startsWith('event: session.lines\n')).toBe(true);
      const ev = JSON.parse(got.split('data: ')[1] ?? '');
      expect(ev).toMatchObject({ id: 'shop', reset: true });
      expect(ev.lines).toHaveLength(9);
      expect(ev.lines).toEqual(source.lines('shop'));

      source.emit(lines('x1'));
      expect(await read(a.reader)).toContain('"reset":false');
      // A source's reset (a pane snapshot or a new transcript) passes through.
      source.emit({ type: 'session.lines', id: 'shop', lines: [], reset: true });
      expect(await read(a.reader)).toContain('"reset":true');
      expect(hub.view(a.streamId, null)).toBe(true);
      source.emit(lines('x2'));
      await source.remove('docs');
      // a got no lines after null: its next frame is the removal
      expect(await read(a.reader)).toContain('session.removed');
      // b never viewed: its first frame is the removal too
      expect(await read(b.reader)).toContain('session.removed');
      hub.close();
    });
    it('session.updated reaches every stream, viewing or not', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      const b = await open(hub);
      hub.view(a.streamId, 'shop');
      await read(a.reader);
      const shop = source.get('shop');
      if (!shop) throw new Error('no shop');
      const updated: Session = { ...shop, status: 'done', lines: [] };
      source.emit({ type: 'session.updated', session: updated });
      for (const r of [a.reader, b.reader]) {
        const got = await read(r);
        expect(got.startsWith('event: session.updated\ndata: ')).toBe(true);
        expect(JSON.parse(got.split('data: ')[1] ?? '')).toEqual({
          type: 'session.updated',
          session: updated,
        });
      }
      hub.close();
    });
    it('session.ports and session.files reach every stream, whatever it views', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      const b = await open(hub);
      hub.view(a.streamId, 'shop');
      await read(a.reader);
      const ports: SourceEvent = { type: 'session.ports', id: 'shop', ports: [] };
      const files: SourceEvent = { type: 'session.files', id: 'shop', files: [], filesTotal: 3 };
      source.emit(ports);
      source.emit(files);
      for (const r of [a.reader, b.reader]) {
        const p = await read(r);
        expect(p.startsWith('event: session.ports\ndata: ')).toBe(true);
        expect(JSON.parse(p.split('data: ')[1] ?? '')).toEqual(ports);
        const f = await read(r);
        expect(f.startsWith('event: session.files\ndata: ')).toBe(true);
        expect(JSON.parse(f.split('data: ')[1] ?? '')).toEqual(files);
      }
      hub.close();
    });
    it('a removed session stops being viewed: its later lines reach nobody', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      hub.view(a.streamId, 'shop');
      await read(a.reader);
      source.emit({ type: 'session.removed', id: 'shop' });
      expect(await read(a.reader)).toContain('session.removed');
      source.emit(lines('late'));
      source.emit({ type: 'session.removed', id: 'docs' });
      // the next frame is the second removal, not the late lines
      expect(await read(a.reader)).toContain('"id":"docs"');
      hub.close();
    });
    it('reads the lines before it starts routing, so the reset comes first', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      // A source that emits as soon as it learns the view (e.g. a fresh pane capture).
      source.onSetViewed = () => source.emit(lines('fresh'));
      hub.view(a.streamId, 'shop');
      const first = JSON.parse((await read(a.reader)).split('data: ')[1] ?? '');
      expect(first).toMatchObject({ id: 'shop', reset: true });
      expect(first.lines).toHaveLength(9);
      const second = JSON.parse((await read(a.reader)).split('data: ')[1] ?? '');
      expect(second).toMatchObject({ reset: false, lines: [{ text: 'fresh' }] });
      hub.close();
    });
    it('a source whose lines() throws leaves the stream not viewing', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      source.lines = () => {
        throw new Error('boom');
      };
      expect(() => hub.view(a.streamId, 'shop')).toThrow('boom');
      expect(source.viewedCalls).toEqual([]);
      hub.close();
    });
    it('an unknown stream id is false', () => {
      const hub = new EventHub(new StubSource(), 'h', '/p');
      expect(hub.view('nope', 'shop')).toBe(false);
      hub.close();
    });
    it('errors and removes a stream that never reads, discarding its queue', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p', { maxQueue: 3 });
      const slow = await open(hub);
      const quick = await open(hub);
      expect(hub.clientCount).toBe(2);
      for (let i = 0; i < 6; i++) hub.view(slow.streamId, 'shop');
      expect(hub.clientCount).toBe(1);
      expect(hub.view(slow.streamId, 'shop')).toBe(false);
      // The queued frames are dropped with the stream: the reader sees an error, not a backlog.
      await expect(slow.reader.read()).rejects.toThrow();
      hub.view(quick.streamId, 'shop');
      expect(await read(quick.reader)).toContain('session.lines');
      hub.close();
    });
    it('tells the source the union of viewed sessions whenever it changes', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      const b = await open(hub);
      hub.view(a.streamId, 'shop');
      hub.view(b.streamId, 'shop'); // same union: no call
      hub.view(b.streamId, 'docs');
      hub.view(a.streamId, null);
      expect(source.viewedCalls).toEqual([['shop'], ['docs', 'shop'], ['docs']]);
      await b.reader.cancel(); // a dropped stream leaves the union
      expect(source.viewedCalls.at(-1)).toEqual([]);
      hub.close();
    });
    it('R32: a view of a session viewed already asks the source to send its preview again', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      const b = await open(hub);
      hub.view(a.streamId, 'shop'); // a new member of the union: setViewed, no refresh
      hub.view(b.streamId, 'shop'); // viewed already: refresh
      hub.view(b.streamId, 'docs');
      hub.view(b.streamId, null);
      expect(source.refreshCalls).toEqual(['shop']);
      hub.close();
    });
    it('a removed session leaves the union', async () => {
      const source = new StubSource();
      const hub = new EventHub(source, 'h', '/p');
      const a = await open(hub);
      hub.view(a.streamId, 'docs');
      await source.remove('docs');
      expect(source.viewedCalls).toEqual([['docs'], []]);
      hub.close();
    });
  });
});
