/**
 * One test ping with the config's ntfy settings (usability U7): what `kage ping` sends, and what
 * `kage setup` sends once pings are set up. One try, no 40 s of retries at a prompt. The answer
 * names the server's host and a redacted reason only: never the topic, the token or the
 * server's path (N1, PF5 F15).
 */
import type { KageConfig } from '../config.ts';
import { NtfyClient, redact } from './ntfy.ts';

export type TestPingResult = { ok: true; host: string } | { ok: false; reason: string };

export async function sendTestPing(
  cfg: KageConfig,
  fetchFn: typeof fetch = fetch,
): Promise<TestPingResult> {
  if (cfg.ntfyTopic === '') return { ok: false, reason: 'no ntfyTopic' };
  // The client never says why a try failed, so the fetch it uses remembers it.
  let failure: unknown = null;
  const client = new NtfyClient({
    config: { server: cfg.ntfyServer, topic: cfg.ntfyTopic, token: cfg.ntfyToken },
    log: () => {},
    fetch: async (url, init) => {
      try {
        const res = await fetchFn(url, init);
        if (res.status < 200 || res.status >= 300) failure = `HTTP ${res.status}`;
        return res;
      } catch (err) {
        failure = err;
        throw err;
      }
    },
  });
  const ok = await client.send(
    {
      title: 'Kage test ping',
      message: `ntfy is set up for ${cfg.name}.`,
      priority: 3,
      click: null,
    },
    () => false,
  );
  client.close();
  if (ok) return { ok: true, host: new URL(cfg.ntfyServer).host };
  return { ok: false, reason: typeof failure === 'string' ? failure : redact(failure) };
}
