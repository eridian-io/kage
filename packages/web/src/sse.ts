import type { ServerEvent } from '@kage/shared';
import { batch } from '@preact/signals';
import { authStatus } from './api.ts';
import { applyEvent, authRequired, connection } from './store.ts';

const TYPES: ServerEvent['type'][] = [
  'snapshot',
  'session.updated',
  'session.lines',
  'session.removed',
];

/** The current connection's stopper. */
let active: (() => void) | null = null;

/**
 * Opens the server's event stream and keeps it open. On an error the board shows
 * "reconnecting" at once and a fresh stream opens after a backoff: `retryMs` (1 s), doubling
 * with each failure up to `maxRetryMs` (10 s), and back to `retryMs` after a snapshot. The
 * server's next snapshot replaces the sessions and makes the board live again. Returns the stopper.
 *
 * Each error also asks `GET /api/auth`: a 401 means the board needs signing in, so the stream
 * stops and `authRequired` shows the login screen; signing in calls connect() again. One stream
 * at a time: a new connect() stops the previous one.
 */
export function connect(
  url = '/api/events',
  opts: { retryMs?: number; maxRetryMs?: number } = {},
): () => void {
  const retryMs = opts.retryMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 10_000;
  let delay = retryMs;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    es?.close();
    es = null;
  };
  active?.();
  active = stop;

  const onMessage = (m: MessageEvent) => {
    let e: ServerEvent;
    try {
      e = JSON.parse(String(m.data)) as ServerEvent;
    } catch {
      return;
    }
    if (!TYPES.includes(e?.type)) return;
    batch(() => {
      if (e.type === 'snapshot') {
        connection.value = 'live';
        delay = retryMs;
      }
      applyEvent(e);
    });
  };

  const open = () => {
    retry = null;
    const s = new EventSource(url);
    es = s;
    for (const type of TYPES) s.addEventListener(type, onMessage);
    // EventSource retries some failures by itself but gives up on others (an HTTP error, say),
    // so close it and retry on our own schedule either way.
    s.onerror = () => {
      s.close();
      if (es !== s || stopped) return;
      es = null;
      connection.value = 'reconnecting';
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, maxRetryMs);
      authStatus().then(
        (status) => {
          if (status !== 401 || stopped) return;
          stop();
          authRequired.value = true;
        },
        () => {}, // unreachable: the retry already scheduled tries again
      );
    };
  };

  open();
  return stop;
}
