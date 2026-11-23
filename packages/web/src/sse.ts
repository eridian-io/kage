import type { ServerEvent } from '@kage/shared';
import { batch } from '@preact/signals';
import { authStatus } from './api.ts';
import { applyEvent, authRequired, connection } from './store.ts';

const TYPES: ServerEvent['type'][] = [
  'snapshot',
  'session.updated',
  'session.lines',
  'session.removed',
  'session.ports',
  'session.files',
  'archive',
  'hb',
];

/** The server's heartbeat period (events.ts). */
const HEARTBEAT_MS = 30_000;

/** The current connection's stopper. */
let active: (() => void) | null = null;

/**
 * Opens the server's event stream and keeps it open. On an error the board shows
 * "reconnecting" at once and a fresh stream opens after a backoff: `retryMs` (1 s), doubling
 * with each failure up to `maxRetryMs` (10 s), and back to `retryMs` after a snapshot. The
 * server's next snapshot replaces the sessions and makes the board live again. Returns the stopper.
 *
 * A half-open stream never errors, so a watchdog counts as one (reliability I3): no event,
 * the 30 s heartbeat included, for `watchdogMs` (75 s, 2.5 heartbeats) since the stream opened
 * or last spoke. Coming back to a visible tab whose last event is older than a heartbeat counts
 * too, and reconnects at once, without the backoff's wait.
 *
 * Each error also asks `GET /api/auth`: a 401 means the board needs signing in, so the stream
 * stops and `authRequired` shows the login screen; signing in calls connect() again. One stream
 * at a time: a new connect() stops the previous one.
 */
export function connect(
  url = '/api/events',
  opts: { retryMs?: number; maxRetryMs?: number; watchdogMs?: number } = {},
): () => void {
  const retryMs = opts.retryMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 10_000;
  const watchdogMs = opts.watchdogMs ?? 75_000;
  let delay = retryMs;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /** When the current stream opened or last delivered an event. */
  let last = 0;
  let stopped = false;
  /** Spec §7: the first snapshot's board is marked once it is on screen (`kage:board`). */
  let marked = false;
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(watchdog);
    document.removeEventListener('visibilitychange', onVisible);
    es?.close();
    es = null;
  };
  active?.();
  active = stop;

  const onMessage = (m: MessageEvent) => {
    last = Date.now();
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
    if (e.type === 'snapshot' && !marked) {
      // Time to a usable board (e2e/perf.spec.ts): the frame after the first snapshot rendered.
      // A reconnect's snapshot is not a first board.
      marked = true;
      requestAnimationFrame(() => performance.mark('kage:board'));
    }
  };

  // The stream `s` failed, or went quiet: close it, show "reconnecting", open a fresh one after
  // the backoff (or `now`), and ask whether the board still has a login.
  const fail = (s: EventSource, now = false) => {
    s.close();
    if (es !== s || stopped) return;
    es = null;
    clearTimeout(watchdog);
    connection.value = 'reconnecting';
    if (now) open();
    else {
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, maxRetryMs);
    }
    authStatus().then(
      (status) => {
        if (status !== 401 || stopped) return;
        stop();
        authRequired.value = true;
      },
      () => {}, // unreachable: the retry already scheduled tries again
    );
  };

  // One timer per stream, moved on only when it fires: an event just updates `last`.
  const watch = (s: EventSource) => {
    const left = last + watchdogMs - Date.now();
    if (left > 0) watchdog = setTimeout(watch, left, s);
    else fail(s);
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible' && es && Date.now() - last > HEARTBEAT_MS) {
      fail(es, true);
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  const open = () => {
    const s = new EventSource(url);
    es = s;
    last = Date.now();
    watchdog = setTimeout(watch, watchdogMs, s);
    for (const type of TYPES) s.addEventListener(type, onMessage);
    // EventSource retries some failures by itself but gives up on others (an HTTP error, say),
    // so close it and retry on our own schedule either way.
    s.onerror = () => fail(s);
  };

  open();
  return stop;
}
