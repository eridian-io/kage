import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFormatChar } from '../text/ansi.ts';
import {
  type FetchFn,
  NTFY,
  NtfyClient,
  type NtfyConfig,
  type Ping,
  pingText,
  publishBody,
  redact,
  serverAllowed,
} from './ntfy.ts';

/** RIGHT-TO-LEFT OVERRIDE and LEFT-TO-RIGHT ISOLATE, kept out of the source as literals. */
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);

const CFG: NtfyConfig = {
  server: 'https://ntfy.example.invalid',
  topic: 'kage-topic-abcdefghij',
  token: '',
};
const NEEDS: Ping = {
  title: 'demo needs you',
  message: 'Fix the login form',
  priority: 4,
  click: 'http://box.tail1.ts.net:8080/#s=s1',
};

/** 16 random bytes in base64url: ntfy's sequence id for every try of one ping (M8, R139). */
const SEQ = /^[A-Za-z0-9_-]{22}$/;
const seqOf = (init: RequestInit): string =>
  (init.headers as Record<string, string>)['X-Sequence-ID'] ?? '';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records each call and answers from `answers` in turn (the last one repeats). */
function recording(answers: (() => Response | Promise<Response>)[]): {
  fetch: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next === undefined) throw new Error('no answer');
    return next();
  };
  return { fetch, calls };
}

const status =
  (n: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(n === 204 ? null : 'body', { status: n, headers });

/** A fetch that never answers, and rejects like fetch when its signal aborts. */
const hanging: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

function client(over: Partial<ConstructorParameters<typeof NtfyClient>[0]> = {}) {
  const lines: string[] = [];
  const waits: number[] = [];
  const c = new NtfyClient({
    config: CFG,
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...over,
  });
  return { c, lines, waits };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('publishBody', () => {
  it('is the exact JSON for needs you (priority 4) with click', () => {
    expect(publishBody(CFG, NEEDS)).toBe(
      '{"topic":"kage-topic-abcdefghij","title":"demo needs you","message":"Fix the login form","priority":4,"click":"http://box.tail1.ts.net:8080/#s=s1"}',
    );
  });

  it('is the exact JSON for done (priority 3), with no click when it is null', () => {
    const body = publishBody(CFG, {
      title: 'demo is done',
      message: 'Tidy up',
      priority: 3,
      click: null,
    });
    expect(body).toBe(
      '{"topic":"kage-topic-abcdefghij","title":"demo is done","message":"Tidy up","priority":3}',
    );
    expect(JSON.parse(body)).not.toHaveProperty('click');
  });

  it('strips control and bidi characters and cuts to the shared limit', () => {
    const message = `\x1b[31mred\x1b[0m ${RLO}evil\n${'x'.repeat(300)}`;
    const sent = JSON.parse(publishBody(CFG, { ...NEEDS, message, title: `a\x07b${LRI}c` }));
    expect(sent.title).toBe('abc');
    expect(sent.message).toHaveLength(NTFY.messageChars);
    expect(sent.message.startsWith('red evil x')).toBe(true);
    expect(sent.message.endsWith('…')).toBe(true);
    const bad = [...sent.message].filter(
      (ch) => (ch.codePointAt(0) ?? 0) < 0x20 || isFormatChar(ch.codePointAt(0) ?? 0),
    );
    expect(bad).toEqual([]);
  });

  it('pingText is the one owner of the cut, and is idempotent', () => {
    expect(NTFY.messageChars).toBe(100);
    const once = pingText('y'.repeat(2000));
    expect(once).toHaveLength(100);
    expect(pingText(once)).toBe(once);
  });

  it('drops a click that is not an http(s) URL', () => {
    const sent = JSON.parse(publishBody(CFG, { ...NEEDS, click: 'javascript:alert(1)' }));
    expect(sent).not.toHaveProperty('click');
  });
});

describe('serverAllowed', () => {
  it('allows https anywhere and http only on loopback or the tailnet', () => {
    for (const ok of [
      'https://ntfy.example.invalid',
      'https://ntfy.example.invalid/prefix',
      'http://127.0.0.1:8090',
      'http://localhost:2586',
      'http://[::1]:80',
      'http://100.64.0.1',
      'http://100.127.255.254:81',
      'http://[fd7a:115c:a1e0::1]',
      'http://ntfy.tail1.ts.net',
    ]) {
      expect(serverAllowed(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://ntfy.example.invalid',
      'http://100.128.0.1',
      'http://100.63.255.255',
      'http://10.0.0.1',
      'http://ts.net.example.invalid',
      'ftp://127.0.0.1',
      'not a url',
      'https://user:pw@ntfy.example.invalid',
    ]) {
      expect(serverAllowed(bad), bad).toBe(false);
    }
  });
});

describe('NtfyClient.send', () => {
  it('200 → true: one POST to <server>/ with exact headers and no Authorization without a token', async () => {
    const f = recording([status(200)]);
    const { c, lines } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as Call;
    expect(call.url).toBe('https://ntfy.example.invalid/');
    expect(call.url).not.toContain(CFG.topic);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('manual');
    expect(call.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Sequence-ID': expect.stringMatching(SEQ),
    });
    expect(call.init.body).toBe(publishBody(CFG, NEEDS, seqOf(call.init)));
    // The same id in the body's sequence_id (ntfy's JSON form) as in the header.
    expect(JSON.parse(call.init.body as string).sequence_id).toBe(seqOf(call.init));
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(lines).toEqual([]);
  });

  it('sends the token only as Authorization: Bearer', async () => {
    const f = recording([status(200)]);
    const { c } = client({ fetch: f.fetch, config: { ...CFG, token: 'tk_abcdefghijklmnop' } });
    expect(await c.send(NEEDS)).toBe(true);
    const call = f.calls[0] as Call;
    expect(call.init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Sequence-ID': expect.stringMatching(SEQ),
      Authorization: 'Bearer tk_abcdefghijklmnop',
    });
    expect(call.url).not.toContain('tk_');
    expect(String(call.init.body)).not.toContain('tk_');
  });

  it('keeps a path in ntfyServer and adds only the trailing slash (F15)', async () => {
    const f = recording([status(200)]);
    const { c } = client({
      fetch: f.fetch,
      config: { ...CFG, server: 'https://ntfy.example.invalid/p/q' },
    });
    expect(await c.send(NEEDS)).toBe(true);
    expect((f.calls[0] as Call).url).toBe('https://ntfy.example.invalid/p/q/');
  });

  it('503, 503, 200 → true after waits of 2,000 and 8,000 ms', async () => {
    const f = recording([status(503), status(503), status(200)]);
    const { c, lines, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 8000]);
    expect(lines).toEqual([]);
  });

  it('5xx four times → false after 4 tries, one log line', async () => {
    const f = recording([status(502)]);
    const { c, lines, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(false);
    expect(f.calls).toHaveLength(4);
    expect(waits).toEqual([...NTFY.backoffMs]);
    expect(lines).toEqual(["ntfy: couldn't send a ping (HTTP 502)."]);
  });

  it('429 with Retry-After: 99999 → a wait of 60,000; a small Retry-After replaces the backoff', async () => {
    const f = recording([
      status(429, { 'Retry-After': '99999' }),
      status(429, { 'Retry-After': '3' }),
      status(200),
    ]);
    const { c, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(waits).toEqual([60_000, 3000]);
  });

  it('429 with an unreadable Retry-After keeps the backoff', async () => {
    const f = recording([status(429, { 'Retry-After': 'soon' }), status(200)]);
    const { c, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(waits).toEqual([2000]);
  });

  it('400 → false, no retry, one log line', async () => {
    const f = recording([status(400)]);
    const { c, lines, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(lines).toEqual(['ntfy: the server refused the ping (HTTP 400).']);
  });

  it('401 and 403 → the ntfyToken hint', async () => {
    for (const n of [401, 403]) {
      const f = recording([status(n)]);
      const { c, lines } = client({ fetch: f.fetch });
      expect(await c.send(NEEDS)).toBe(false);
      expect(lines).toEqual([`ntfy: the server refused the ping (HTTP ${n}). Check ntfyToken.`]);
    }
  });

  it('a 3xx is not followed and not retried', async () => {
    const f = recording([status(302, { Location: 'https://elsewhere.example.invalid/' })]);
    const { c, lines } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(lines).toEqual(['ntfy: the server refused the ping (HTTP 302).']);
  });

  it('discards the response body', async () => {
    const cancel = vi.fn(async () => {});
    const res = new Response('x'.repeat(10_000), { status: 200 });
    vi.spyOn(res.body as ReadableStream, 'cancel').mockImplementation(cancel);
    const { c } = client({ fetch: async () => res });
    expect(await c.send(NEEDS)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a hang → aborted at 5,000 ms on each try, then false after 4 tries', async () => {
    vi.useFakeTimers();
    let tries = 0;
    const aborts: number[] = [];
    const start = Date.now();
    const fetch: FetchFn = (url, init) => {
      tries++;
      (init.signal as AbortSignal).addEventListener('abort', () => aborts.push(Date.now() - start));
      return hanging(url, init);
    };
    const lines: string[] = [];
    const c = new NtfyClient({ config: CFG, fetch, log: (l) => lines.push(l) });
    const done = c.send(NEEDS);
    await vi.advanceTimersByTimeAsync(4999);
    expect(aborts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborts).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(2000 + 5000 + 8000 + 5000 + 30000 + 5000);
    expect(await done).toBe(false);
    expect(tries).toBe(4);
    expect(aborts).toEqual([5000, 12_000, 25_000, 60_000]);
    expect(lines).toEqual(["ntfy: couldn't send a ping (timeout)."]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every try of one ping carries the same X-Sequence-ID; another ping gets another (M8, R139)', async () => {
    // A try that timed out may still have been delivered: its retry, with the same id, replaces
    // that notification on ntfy 2.16.0+ instead of adding a copy.
    const f = recording([status(503), status(503), status(200)]);
    const { c } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(await c.send({ ...NEEDS, title: 'demo is done', priority: 3 })).toBe(true);
    expect(f.calls).toHaveLength(4);
    const ids = f.calls.map((x) => seqOf(x.init));
    for (const id of ids) expect(id).toMatch(SEQ);
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(ids[3]).not.toBe(ids[0]);
    // The body carries the same id as sequence_id on every try; it is nothing of the topic.
    for (const x of f.calls) {
      expect(JSON.parse(x.init.body as string).sequence_id).toBe(seqOf(x.init));
    }
    expect(f.calls[0]?.init.body).toBe(publishBody(CFG, NEEDS, ids[0]));
    expect(ids[0]).not.toContain(CFG.topic);
  });

  it('a try that times out is tried again with the same id, after checking it is still wanted', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    let n = 0;
    const fetch: FetchFn = (url, init) => {
      ids.push(seqOf(init));
      n++;
      return n === 1 ? hanging(url, init) : Promise.resolve(new Response('ok'));
    };
    let asked = 0;
    const c = new NtfyClient({ config: CFG, fetch, log: () => {} });
    const done = c.send(NEEDS, () => {
      asked++;
      return true;
    });
    await vi.advanceTimersByTimeAsync(5000 + 2000);
    expect(await done).toBe(true);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(asked).toBeGreaterThanOrEqual(1);
  });

  it('a network error before an answer is still tried again', async () => {
    const f = recording([
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
      status(200),
    ]);
    const { c, waits } = client({ fetch: f.fetch });
    expect(await c.send(NEEDS)).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it('stillWanted false before the second try → false and no second call', async () => {
    const f = recording([status(503), status(200)]);
    const { c, lines } = client({ fetch: f.fetch });
    let checks = 0;
    expect(
      await c.send(NEEDS, () => {
        checks++;
        return false;
      }),
    ).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(checks).toBeGreaterThan(0);
    expect(lines).toEqual([]);
  });

  it('stillWanted turning false during the wait → no second call', async () => {
    const f = recording([status(503), status(200)]);
    let wanted = true;
    const { c } = client({
      fetch: f.fetch,
      sleep: async () => {
        wanted = false;
      },
    });
    expect(await c.send(NEEDS, () => wanted)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('close() during a wait → false at once, with no timers left', async () => {
    vi.useFakeTimers();
    const f = recording([status(503), status(200)]);
    const lines: string[] = [];
    const c = new NtfyClient({ config: CFG, fetch: f.fetch, log: (l) => lines.push(l) });
    const done = c.send(NEEDS);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // the backoff wait
    c.close();
    expect(await done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it('close() aborts a request in flight; send after close does nothing', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: FetchFn = (url, init) => {
      signal = init.signal as AbortSignal;
      return hanging(url, init);
    };
    const c = new NtfyClient({ config: CFG, fetch, log: () => {} });
    const done = c.send(NEEDS);
    await vi.advanceTimersByTimeAsync(10);
    c.close();
    expect(await done).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const after = vi.fn(fetch);
    const c2 = new NtfyClient({ config: CFG, fetch: after, log: () => {} });
    c2.close();
    expect(await c2.send(NEEDS)).toBe(false);
    expect(after).not.toHaveBeenCalled();
  });

  it('a server that is plain http off the tailnet → false, no request, a line without the URL', async () => {
    const f = recording([status(200)]);
    const { c, lines } = client({
      fetch: f.fetch,
      config: { ...CFG, server: 'http://ntfy.example.invalid/s3cr3t' },
    });
    expect(await c.send(NEEDS)).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(lines).toEqual([
      'ntfy: ntfyServer must be https: unless it is on this machine or your tailnet; no ping sent.',
    ]);
  });

  it('never throws, even when log throws', async () => {
    const { c } = client({
      fetch: recording([status(400)]).fetch,
      log: () => {
        throw new Error('log broke');
      },
    });
    expect(await c.send(NEEDS)).toBe(false);
  });
});

describe('redact', () => {
  it('names the failure, never its message', () => {
    expect(redact(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('timeout');
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
    });
    expect(redact(refused)).toBe('ECONNREFUSED');
    expect(redact(new TypeError('fetch failed https://x.example.invalid/topic'))).toBe(
      'network error',
    );
    expect(redact(new TypeError('x', { cause: { code: 'not a code; https://x/' } }))).toBe(
      'network error',
    );
    expect(redact('a string')).toBe('network error');
    expect(redact(undefined)).toBe('network error');
  });
});

describe('the secrets grep (N1)', () => {
  const TOPIC = 'Tq7ZpXw2Lm9RbVc4Hn8KdFs6Jy3GtQe1'; // 32 characters
  const TOKEN = 'tk_secret0123456789abcdefghijklmn';
  const SERVER = 'https://ntfy.example.invalid/hidden-prefix-9f8e7d';
  const cfg: NtfyConfig = { server: SERVER, topic: TOPIC, token: TOKEN };

  it('no log line and no redact result carries the topic, the token or the server path', async () => {
    expect(TOPIC).toHaveLength(32);
    const out: string[] = [];
    const errors: unknown[] = [];
    const failures: FetchFn[] = [
      // a network error whose message holds the full URL and the topic
      async (url) => {
        const e = new TypeError(`fetch failed: ${url} ${TOPIC} Bearer ${TOKEN}`, {
          cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url} ${TOPIC}`), {
            code: 'ENOTFOUND',
            hostname: url,
          }),
        });
        errors.push(e);
        throw e;
      },
      // a 401
      async () => new Response(`topic ${TOPIC} token ${TOKEN}`, { status: 401 }),
      // a thrown TypeError
      async () => {
        const e = new TypeError(`Invalid URL ${SERVER}/${TOPIC} ${TOKEN}`);
        errors.push(e);
        throw e;
      },
      // a 429 with a hostile Retry-After
      async () => new Response(TOPIC, { status: 429, headers: { 'Retry-After': `${TOKEN}` } }),
    ];
    for (const fetch of failures) {
      const c = new NtfyClient({
        config: cfg,
        fetch,
        log: (l) => out.push(l),
        sleep: async () => {},
      });
      expect(await c.send({ ...NEEDS, message: 'm' })).toBe(false);
    }
    // a timeout, with fake timers
    vi.useFakeTimers();
    const c = new NtfyClient({
      config: cfg,
      fetch: hanging,
      log: (l) => out.push(l),
      sleep: async () => {},
    });
    const done = c.send(NEEDS);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(NTFY.timeoutMs);
    expect(await done).toBe(false);
    vi.useRealTimers();
    // a refused server config
    const bad = new NtfyClient({
      config: { ...cfg, server: `http://plain.example.invalid/${TOPIC}` },
      fetch: hanging,
      log: (l) => out.push(l),
    });
    expect(await bad.send(NEEDS)).toBe(false);

    for (const e of errors) out.push(redact(e));
    out.push(redact(new DOMException(`${TOPIC}`, 'TimeoutError')));
    expect(out.length).toBeGreaterThanOrEqual(7);
    for (const line of out) {
      expect(line).not.toContain(TOPIC);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('hidden-prefix');
      expect(line).not.toContain('example.invalid');
    }
  });
});

describe('the fetch guard (packages/server/test/setup-fetch.ts)', () => {
  it('refuses any host but loopback', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(
      'Tests may not call example.invalid',
    );
    await expect(fetch(new URL('http://10.0.0.1:9/x'))).rejects.toThrow(
      'Tests may not call 10.0.0.1',
    );
    await expect(fetch(new Request('https://example.invalid/r'))).rejects.toThrow(
      'Tests may not call example.invalid',
    );
  });

  it('lets loopback through', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
