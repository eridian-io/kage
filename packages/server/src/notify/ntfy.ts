/**
 * The ntfy client: Kage's only outbound call (ruling N0). One JSON POST to `<server>/` per try,
 * with a timeout, retries with backoff, no redirects and redacted logs.
 *
 * Secrets (N1): the topic travels only in the JSON body and the token only in
 * `Authorization: Bearer`. Neither, nor the server URL, is ever logged, thrown or returned:
 * failures are named by `redact`, which returns a fixed word, an HTTP status or an error code.
 */
import { plainLine } from '../text/bounds.ts';

/** `server` has no trailing slash; it may carry a path (a reverse-proxy prefix). */
export interface NtfyConfig {
  server: string;
  topic: string;
  token: string;
}
export interface Ping {
  title: string;
  message: string;
  priority: 3 | 4;
  click: string | null;
}
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `messageChars` is the one owner of the ping's text cut (PF5 F6): `pingText` applies it, and
 * the notifier and the browser body use the same constant.
 */
export const NTFY = {
  timeoutMs: 5000,
  backoffMs: [2000, 8000, 30000],
  maxRetryAfterMs: 60_000,
  messageChars: 100,
} as const;

/** Ping text: one line, no escape, control, bidi or format characters, at most 100 characters. */
export function pingText(text: string): string {
  return plainLine(text, NTFY.messageChars);
}

/** 100.64.0.0/10: Tailscale's CGNAT range. */
function inTailnetV4(host: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return b >= 64 && b <= 127 && c <= 255 && d <= 255;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether Kage may POST to this server: `https:` anywhere, `http:` only on this machine
 * (loopback) or the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48, a `.ts.net` MagicDNS name).
 * No user info. The config (Task 6) refuses the rest with its own message; the client checks
 * again so that a bad value can never send a topic in clear text over the internet.
 */
export function serverAllowed(server: string): boolean {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return (
    isLoopback(host) ||
    inTailnetV4(host) ||
    /^\[fd7a:115c:a1e0:/.test(host) ||
    (host.endsWith('.ts.net') && host.length > '.ts.net'.length)
  );
}

/** {"topic","title","message","priority","click"?}: the topic is only ever here. */
export function publishBody(cfg: NtfyConfig, p: Ping): string {
  const body: Record<string, string | number> = {
    topic: cfg.topic,
    title: pingText(p.title),
    message: pingText(p.message),
    priority: p.priority,
  };
  if (p.click !== null && /^https?:\/\//.test(p.click)) body.click = p.click;
  return JSON.stringify(body);
}

class HttpStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** 'timeout' | 'HTTP <status>' | the error's cause code (ECONNREFUSED…) | 'network error'. Never a message or URL. */
export function redact(err: unknown): string {
  if (err instanceof HttpStatus) return `HTTP ${err.status}`;
  if (err instanceof Error || err instanceof DOMException) {
    if (err.name === 'TimeoutError') return 'timeout';
    const cause = (err as { cause?: unknown }).cause;
    const code =
      typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  }
  return 'network error';
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Seconds in a 429's Retry-After, as ms capped at `maxRetryAfterMs`; null if unreadable. */
function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after')?.trim() ?? '';
  if (!/^\d{1,10}$/.test(v)) return null;
  return Math.min(Number(v) * 1000, NTFY.maxRetryAfterMs);
}

type Outcome =
  | { kind: 'ok' }
  | { kind: 'final'; status: number }
  | { kind: 'retry'; err: unknown; waitMs: number | null }
  | { kind: 'closed' };

export class NtfyClient {
  readonly #config: NtfyConfig;
  readonly #fetch: FetchFn;
  readonly #log: (line: string) => void;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #closed = new AbortController();

  constructor(d: {
    config: NtfyConfig;
    fetch?: FetchFn;
    log: (line: string) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.#config = d.config;
    this.#fetch = d.fetch ?? ((url, init) => fetch(url, init));
    this.#log = d.log;
    this.#sleep = d.sleep ?? abortableSleep;
  }

  /** true when ntfy answered 2xx. Never throws. `stillWanted` is checked before every retry. */
  async send(p: Ping, stillWanted: () => boolean = () => true): Promise<boolean> {
    try {
      return await this.#send(p, stillWanted);
    } catch {
      return false;
    }
  }

  /** Aborts every request and wait in flight. */
  close(): void {
    this.#closed.abort();
  }

  #say(line: string): void {
    try {
      this.#log(line);
    } catch {
      // a broken log must not break the caller
    }
  }

  async #send(p: Ping, stillWanted: () => boolean): Promise<boolean> {
    if (this.#closed.signal.aborted) return false;
    if (!serverAllowed(this.#config.server)) {
      this.#say(
        'ntfy: ntfyServer must be https: unless it is on this machine or your tailnet; no ping sent.',
      );
      return false;
    }
    const body = publishBody(this.#config, p);
    let last: unknown;
    let retryAfter: number | null = null;
    for (let i = 0; i <= NTFY.backoffMs.length; i++) {
      if (i > 0) {
        if (!stillWanted()) return false;
        // A 429's Retry-After replaces this wait.
        const wait = retryAfter ?? NTFY.backoffMs[i - 1] ?? 0;
        try {
          await this.#sleep(wait, this.#closed.signal);
        } catch {
          return false;
        }
        if (this.#closed.signal.aborted || !stillWanted()) return false;
      }
      const out = await this.#try(body);
      if (out.kind === 'ok') return true;
      if (out.kind === 'closed') return false;
      if (out.kind === 'final') {
        const hint = out.status === 401 || out.status === 403 ? ' Check ntfyToken.' : '';
        this.#say(`ntfy: the server refused the ping (HTTP ${out.status}).${hint}`);
        return false;
      }
      last = out.err;
      retryAfter = out.waitMs;
    }
    this.#say(`ntfy: couldn't send a ping (${redact(last)}).`);
    return false;
  }

  /** One POST with its own timeout; the response body is discarded unread. */
  async #try(body: string): Promise<Outcome> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('The ntfy request timed out.', 'TimeoutError')),
      NTFY.timeoutMs,
    );
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#config.token !== '') headers.Authorization = `Bearer ${this.#config.token}`;
    try {
      const res = await this.#fetch(`${this.#config.server}/`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([timeout.signal, this.#closed.signal]),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { kind: 'ok' };
      if (res.status === 429)
        return { kind: 'retry', err: new HttpStatus(429), waitMs: retryAfterMs(res) };
      if (res.status >= 500)
        return { kind: 'retry', err: new HttpStatus(res.status), waitMs: null };
      return { kind: 'final', status: res.status };
    } catch (err) {
      if (this.#closed.signal.aborted) return { kind: 'closed' };
      return { kind: 'retry', err, waitMs: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
