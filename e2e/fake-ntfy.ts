/**
 * A fake ntfy server on 127.0.0.1 for integration tests and e2e (ruling R85: tests never reach a
 * real ntfy server). It records each POST's path, headers and JSON body, and answers with the
 * next status in `status` (the last one repeats; default 200), or never (`hang`), or with a 302
 * to `redirect`.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeNtfy {
  url: string;
  received: { path: string; headers: Record<string, string>; body: unknown }[];
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('body too large'));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function startFakeNtfy(
  o: { status?: number[]; hang?: boolean; redirect?: string } = {},
): Promise<FakeNtfy> {
  const received: FakeNtfy['received'] = [];
  const statuses = o.status ?? [200];
  const server = createServer(async (req, res) => {
    let text: string;
    try {
      text = await readBody(req);
    } catch {
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    received.push({ path: req.url ?? '', headers, body: parse(text) });
    if (o.hang === true) return;
    if (o.redirect !== undefined) {
      res.writeHead(302, { Location: o.redirect }).end();
      return;
    }
    const status = statuses[Math.min(received.length - 1, statuses.length - 1)] ?? 200;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"id":"fake"}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * The e2e harness guard (PF5 F2): Kage's config in a test may set `ntfyTopic` only with an
 * `ntfyServer` on 127.0.0.1 (the fake above). The default server is the public ntfy.sh, so a
 * missing or mistyped `ntfyServer` would otherwise send a real ping from a test.
 */
export function assertLocalNtfy(config: Record<string, unknown>): void {
  const topic = config.ntfyTopic;
  if (typeof topic !== 'string' || topic === '') return;
  let host = '';
  let protocol = '';
  try {
    const u = new URL(String(config.ntfyServer));
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    // refused below
  }
  if (protocol !== 'http:' || host !== '127.0.0.1') {
    throw new Error('e2e: ntfyTopic needs ntfyServer on 127.0.0.1 (the fake ntfy)');
  }
}
