import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';

const dec = new TextDecoder();
const read = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
  const { value } = await r.read();
  return dec.decode(value);
};

afterEach(() => vi.useRealTimers());

describe('EventHub', () => {
  it('sends a snapshot first, then source events', async () => {
    const source = new DemoSource(1_000_000);
    const hub = new EventHub(source, 'my-pc');
    const reader = hub.stream().getReader();
    const first = await read(reader);
    expect(first.startsWith('event: snapshot\ndata: ')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(first.slice('event: snapshot\ndata: '.length));
    expect(data.host).toBe('my-pc');
    expect(data.sessions).toHaveLength(6);
    await source.remove('docs');
    expect(await read(reader)).toContain('event: session.removed\ndata: ');
    await reader.cancel();
    hub.close();
  });
  it('fans out to every client', async () => {
    const source = new DemoSource(1);
    const hub = new EventHub(source, 'h');
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
    const hub = new EventHub(new DemoSource(1), 'h', { heartbeatMs: 20 });
    const reader = hub.stream().getReader();
    await read(reader);
    await vi.advanceTimersByTimeAsync(25);
    expect(await read(reader)).toBe(': hb\n\n');
    await reader.cancel();
    hub.close();
  });
  it('cancelling drops clientCount to 0', async () => {
    const hub = new EventHub(new DemoSource(1), 'h');
    const reader = hub.stream().getReader();
    await read(reader);
    expect(hub.clientCount).toBe(1);
    await reader.cancel();
    expect(hub.clientCount).toBe(0);
    hub.close();
  });
});
