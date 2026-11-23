import { afterEach, describe, expect, it, vi } from 'vitest';
import { NTFY, NtfyClient, type Ping } from './ntfy.ts';

/** The fake lives in e2e/ (outside this package's rootDir), so it is loaded at run time. */
interface Fake {
  url: string;
  received: { path: string; headers: Record<string, string>; body: unknown }[];
  close(): Promise<void>;
}
interface FakeModule {
  startFakeNtfy(o?: { status?: number[]; hang?: boolean; redirect?: string }): Promise<Fake>;
  assertLocalNtfy(config: Record<string, unknown>): void;
}
const FAKE = new URL('../../../../e2e/fake-ntfy.ts', import.meta.url).href;
const { startFakeNtfy, assertLocalNtfy } = (await import(FAKE)) as FakeModule;

const TOPIC = 'kage-int-0123456789abcdef';
const PING: Ping = {
  title: 'demo needs you',
  message: 'Fix the login form',
  priority: 4,
  click: null,
};
const fakes: Fake[] = [];

async function fake(o?: Parameters<FakeModule['startFakeNtfy']>[0]): Promise<Fake> {
  const f = await startFakeNtfy(o);
  fakes.push(f);
  return f;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

describe('NtfyClient against the fake ntfy server', () => {
  it('a real POST arrives at / with the JSON body and the token header', async () => {
    const f = await fake();
    const lines: string[] = [];
    const c = new NtfyClient({
      config: { server: f.url, topic: TOPIC, token: 'tk_int_abcdefghijklmnop' },
      log: (l) => lines.push(l),
    });
    expect(await c.send(PING)).toBe(true);
    expect(f.received).toHaveLength(1);
    const got = f.received[0];
    expect(got?.path).toBe('/');
    expect(got?.body).toEqual({
      topic: TOPIC,
      title: 'demo needs you',
      message: 'Fix the login form',
      priority: 4,
    });
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers.authorization).toBe('Bearer tk_int_abcdefghijklmnop');
    expect(lines).toEqual([]);
    c.close();
  });

  it('keeps a path in ntfyServer (F15)', async () => {
    const f = await fake();
    const c = new NtfyClient({
      config: { server: `${f.url}/base/path`, topic: TOPIC, token: '' },
      log: () => {},
    });
    expect(await c.send(PING)).toBe(true);
    expect(f.received[0]?.path).toBe('/base/path/');
    expect(f.received[0]?.headers.authorization).toBeUndefined();
  });

  it('retries a 503 and then succeeds', async () => {
    const f = await fake({ status: [503, 200] });
    const c = new NtfyClient({
      config: { server: f.url, topic: TOPIC, token: '' },
      log: () => {},
      sleep: async () => {},
    });
    expect(await c.send(PING)).toBe(true);
    expect(f.received).toHaveLength(2);
  });

  it('a 302 to another port is not followed', async () => {
    const other = await fake();
    const f = await fake({ redirect: `${other.url}/` });
    const lines: string[] = [];
    const c = new NtfyClient({
      config: { server: f.url, topic: TOPIC, token: 'tk_int_abcdefghijklmnop' },
      log: (l) => lines.push(l),
      sleep: async () => {},
    });
    expect(await c.send(PING)).toBe(false);
    expect(f.received).toHaveLength(1);
    expect(other.received).toHaveLength(0);
    expect(lines).toEqual(['ntfy: the server refused the ping (HTTP 302).']);
  });

  it('a server that hangs is cut off at the timeout, and the ping is not sent again (M8)', async () => {
    const f = await fake({ hang: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const c = new NtfyClient({
      config: { server: f.url, topic: TOPIC, token: '' },
      log: (l) => lines.push(l),
      sleep: async () => {},
    });
    const done = c.send(PING);
    // wait (in real time) until the request has reached the fake, then let the timeout fire
    while (f.received.length < 1) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(NTFY.timeoutMs);
    expect(await done).toBe(false);
    // The ping reached the server, which may still deliver it: no second copy.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.received).toHaveLength(1);
    expect(lines).toEqual(["ntfy: couldn't send a ping (timeout)."]);
  });
});

describe('assertLocalNtfy (the e2e harness guard, PF5 F2)', () => {
  it('throws when a topic is set and ntfyServer is not a loopback http URL', () => {
    const msg = 'e2e: ntfyTopic needs ntfyServer on 127.0.0.1 (the fake ntfy)';
    expect(() => assertLocalNtfy({ ntfyTopic: TOPIC })).toThrow(msg);
    expect(() => assertLocalNtfy({ ntfyTopic: TOPIC, ntfyServer: 'https://ntfy.sh' })).toThrow(msg);
    expect(() =>
      assertLocalNtfy({ ntfyTopic: TOPIC, ntfyServer: 'http://example.invalid' }),
    ).toThrow(msg);
    expect(() =>
      assertLocalNtfy({ ntfyTopic: TOPIC, ntfyServer: 'http://127.0.0.1.example.invalid' }),
    ).toThrow(msg);
    expect(() => assertLocalNtfy({ ntfyTopic: TOPIC, ntfyServer: 'not a url' })).toThrow(msg);
  });

  it('allows no topic, or a loopback server', () => {
    expect(() => assertLocalNtfy({})).not.toThrow();
    expect(() => assertLocalNtfy({ ntfyTopic: '', ntfyServer: 'https://ntfy.sh' })).not.toThrow();
    expect(() =>
      assertLocalNtfy({ ntfyTopic: TOPIC, ntfyServer: 'http://127.0.0.1:4567' }),
    ).not.toThrow();
  });
});
