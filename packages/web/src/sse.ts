import type { ServerEvent } from '@kage/shared';
import { batch } from '@preact/signals';
import { applyEvent, connection } from './store.ts';

const TYPES: ServerEvent['type'][] = ['snapshot', 'session.updated', 'session.removed'];

/**
 * Opens the server's event stream and keeps it open. On an error the board shows
 * "reconnecting" at once and a fresh stream opens after `retryMs`; the server's next
 * snapshot replaces the sessions and makes the board live again. Returns the stopper.
 */
export function connect(url = '/api/events', opts: { retryMs?: number } = {}): () => void {
  const retryMs = opts.retryMs ?? 1000;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const onMessage = (m: MessageEvent) => {
    let e: ServerEvent;
    try {
      e = JSON.parse(String(m.data)) as ServerEvent;
    } catch {
      return;
    }
    if (!TYPES.includes(e?.type)) return;
    batch(() => {
      if (e.type === 'snapshot') connection.value = 'live';
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
      retry = setTimeout(open, retryMs);
    };
  };

  open();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    es?.close();
    es = null;
  };
}
