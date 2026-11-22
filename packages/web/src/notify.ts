/**
 * The board's side of notifications (W1, spec 5.9): the needs-you count in the tab title,
 * browser notifications when a session moves into needs-you, and `#s=<id>` links (a ping's
 * `click`). Event driven: no timers, no polling.
 *
 * Browsers expose `Notification` only in a secure context (https, localhost), so a board opened
 * as `http://my-pc:8080` over the tailnet has the title count and ntfy, not notifications. The
 * notification's text and construction are a lazy chunk (notify-show.ts), loaded only when one
 * may show.
 */
import { LIMITS, type ServerEvent, type Session, type SessionStatus } from '@kage/shared';
import { computed, effect, type Signal, signal } from '@preact/signals';
import { hadSnapshot, host, onApplied, select, selectWhenSeen, sorted } from './store.ts';

export type NotifyState = 'unsupported' | 'insecure' | 'default' | 'granted' | 'denied';
export const notifyState: Signal<NotifyState> = signal('unsupported');

const TITLE = 'kage';
/** The server's session ids: a UUID, or `ext-@<window>` (as terminal/upgrade.ts accepts). */
const SESSION_ID = /^[A-Za-z0-9@_-]{1,100}$/;

let win: Window | undefined = typeof window === 'undefined' ? undefined : window;

const api = (): typeof Notification | undefined =>
  win?.isSecureContext
    ? (win as Window & { Notification?: typeof Notification }).Notification
    : undefined;

function refresh(): void {
  const N = api();
  notifyState.value = !win?.isSecureContext ? 'insecure' : N ? N.permission : 'unsupported';
}

/** Asks for permission; call only from a user action (the palette, Task 8). */
export async function enableNotifications(): Promise<void> {
  const N = api();
  if (N?.permission === 'default') {
    try {
      await N.requestPermission();
    } catch {
      // A browser that refuses outright leaves the state as it is.
    }
  }
  refresh();
}

/** The sessions that need you, as one key: effects on it run only when the set changes. */
const waiting = computed(() =>
  sorted.value
    .filter((s) => s.status === 'needs-you')
    .map((s) => s.id)
    .join('\n'),
);
const isWaiting = (id: string) => sorted.value.some((s) => s.id === id && s.status === 'needs-you');

/** `#s=<id>`, decoded and checked: the id, '' when malformed, null for any other hash. */
function linkedId(hash: string): string | null {
  if (!hash.startsWith('#s=')) return null;
  try {
    const id = decodeURIComponent(hash.slice(3));
    return SESSION_ID.test(id) ? id : '';
  } catch {
    return '';
  }
}

/** The title count, browser notifications on moves into needs-you, and #s=<id> on load. Returns the stopper. */
export function installNotify(w: Window | undefined = win): () => void {
  if (!w) return () => {};
  win = w;
  let stopped = false;
  const open = new Map<string, Notification>();
  /** A link's id still waiting for the first snapshot; an unknown one is then dropped. */
  let linked: string | null = null;

  const follow = () => {
    const id = linkedId(w.location.hash);
    if (id === null) return;
    // Drop the hash first, so a reload doesn't follow it again.
    w.history.replaceState(w.history.state, '', w.location.pathname + w.location.search);
    if (id === '') return;
    if (sorted.value.some((s) => s.id === id)) select(id);
    else if (!hadSnapshot.value) {
      linked = id;
      selectWhenSeen.value = id;
    }
  };

  const shut = (id: string) => {
    open.get(id)?.close();
    open.delete(id);
  };

  /** Only while the page has no focus (a hidden page has none either): never for what's on screen. */
  const notify = (s: Session) => {
    if (api()?.permission !== 'granted' || w.document.hasFocus()) return;
    import('./notify-show.ts').then(
      (m) => {
        const N = api();
        // It may have been answered, or the board stopped, while the chunk loaded.
        if (!N || stopped || !isWaiting(s.id)) return;
        shut(s.id);
        const n = m.show(N, s, host.value, LIMITS.pingChars, () => {
          w.focus();
          if (isWaiting(s.id)) select(s.id);
          shut(s.id);
        });
        if (n) open.set(s.id, n);
      },
      () => {}, // the chunk didn't load: ntfy and the title still tell
    );
  };

  onApplied((e: ServerEvent, was: SessionStatus | undefined) => {
    if (e.type === 'snapshot' && linked !== null) {
      // The snapshot has already selected a linked session it carries; an unknown id goes quietly.
      if (selectWhenSeen.value === linked) selectWhenSeen.value = null;
      linked = null;
    } else if (
      e.type === 'session.updated' &&
      e.session.status === 'needs-you' &&
      was !== 'needs-you'
    ) {
      notify(e.session);
    }
  });

  // Runs only when the set of waiting sessions changes, not on every event.
  const stopWaiting = effect(() => {
    const ids = waiting.value === '' ? [] : waiting.value.split('\n');
    w.document.title = ids.length > 0 ? `(${ids.length}) ${TITLE}` : TITLE;
    for (const id of [...open.keys()]) if (!ids.includes(id)) shut(id);
  });

  refresh();
  follow();
  w.addEventListener('hashchange', follow);
  return () => {
    stopped = true;
    w.removeEventListener('hashchange', follow);
    onApplied(null);
    stopWaiting();
    for (const id of [...open.keys()]) shut(id);
    w.document.title = TITLE;
  };
}
