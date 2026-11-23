import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type KageConfig } from '../config.ts';
import { sendTestPing } from './test-ping.ts';

const TOPIC = 'kage-invented-topic-0123';
const TOKEN = 'tk_invented_token_0123';
const cfg = (over: Partial<KageConfig> = {}): KageConfig => ({
  ...DEFAULT_CONFIG,
  name: 'box',
  ntfyTopic: TOPIC,
  ntfyServer: 'https://ntfy.example.invalid/secret-prefix',
  ntfyToken: TOKEN,
  ...over,
});

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records each call and answers with `answer` (R85: nothing leaves the test). */
function recording(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('sendTestPing', () => {
  it('posts the test ping once and names only the server host', async () => {
    const r = recording(() => new Response(null, { status: 200 }));
    expect(await sendTestPing(cfg(), r.fetchFn)).toEqual({
      ok: true,
      host: 'ntfy.example.invalid',
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toBe('https://ntfy.example.invalid/secret-prefix/');
    const body = JSON.parse(String(r.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      topic: TOPIC,
      title: 'Kage test ping',
      message: 'ntfy is set up for box.',
      priority: 3,
    });
    const headers = (r.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a refusal or a server error: one try, the status as the reason', async () => {
    for (const status of [403, 500, 429]) {
      const r = recording(() => new Response(null, { status }));
      expect(await sendTestPing(cfg(), r.fetchFn)).toEqual({
        ok: false,
        reason: `HTTP ${status}`,
      });
      expect(r.calls, String(status)).toHaveLength(1);
    }
  });

  it('a network error: its code, never its message, the topic or the token', async () => {
    const r = recording(() => {
      throw new TypeError(`fetch failed for ${TOPIC}`, {
        cause: Object.assign(new Error(`connect ${TOKEN}`), { code: 'ECONNREFUSED' }),
      });
    });
    const res = await sendTestPing(cfg(), r.fetchFn);
    expect(res).toEqual({ ok: false, reason: 'ECONNREFUSED' });
    expect(JSON.stringify(res)).not.toContain(TOPIC);
  });

  it('no topic: nothing is sent', async () => {
    const r = recording(() => new Response(null, { status: 200 }));
    expect(await sendTestPing(cfg({ ntfyTopic: '' }), r.fetchFn)).toEqual({
      ok: false,
      reason: 'no ntfyTopic',
    });
    expect(r.calls).toEqual([]);
  });
});
