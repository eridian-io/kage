/**
 * The board's side of notifications (W1, spec 5.9): the needs-you count in the tab title and
 * browser notifications when a session moves into needs-you. Event driven: no timers, no polling.
 * A lazy chunk itself (performance P6): lazy.tsx loads and installs it after the first snapshot,
 * and hands notifyApi to the palette. `#s=<id>` links are link.ts, in the first load.
 *
 * Browsers expose `Notification` only in a secure context (https, localhost), so a board opened
 * as `http://my-pc.tail1234.ts.net:8080` over the tailnet has the title count and ntfy, not
 * notifications. The notification's text and construction are a lazy chunk (notify-show.ts),
 * loaded only when one may show.
 */
import { LIMITS, type Session } from '@kage/shared';
import { computed, effect, type Signal, signal } from '@preact/signals';
import { host, onApplied, select, sorted } from './store.ts';

export type NotifyState = 'unsupported' | 'insecure' | 'default' | 'granted' | 'denied';
export const notifyState: Signal<NotifyState> = signal('unsupported');

const TITLE = 'kage';

let win: Window | undefined = typeof window === 'undefined' ? undefined : window;

const api = (): typeof Notification | undefined =>
  win?.isSecureContext
    ? (win as Window & { Notification?: typeof Notification }).Notification
    : undefined;

/** Reads the permission again (the palette, on each open: it may have changed in the browser). */
export function readPermission(): void {
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
  readPermission();
}

/**
 * What the palette needs from here, handed to it by palette-loader.tsx once this chunk is in, so
 * the palette chunk doesn't import this module.
 */
export interface NotifyApi {
  state: Signal<NotifyState>;
  enable: () => Promise<void>;
  read: () => void;
}
export const notifyApi: NotifyApi = {
  state: notifyState,
  enable: enableNotifications,
  read: readPermission,
};

/** The sessions that need you, as one key: effects on it run only when the set changes. */
const waiting = computed(() =>
  sorted.value
    .filter((s) => s.status === 'needs-you')
    .map((s) => s.id)
    .join('\n'),
);
const isWaiting = (id: string) => sorted.value.some((s) => s.id === id && s.status === 'needs-you');

/** The title count and browser notifications on moves into needs-you. Returns the stopper. */
export function installNotify(w: Window | undefined = win): () => void {
  if (!w) return () => {};
  win = w;
  let stopped = false;
  const open = new Map<string, Notification>();

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

  // A live transition into needs-you only (transitions Task 8): a snapshot, a frame without a
  // cause (no transition; the demo) and a reconcile or act move never notify.
  const off = onApplied((e) => {
    if (e.type === 'session.updated' && e.cause === 'live' && e.session.status === 'needs-you') {
      notify(e.session);
    }
  });

  // Runs only when the set of waiting sessions changes, not on every event.
  const stopWaiting = effect(() => {
    const ids = waiting.value === '' ? [] : waiting.value.split('\n');
    w.document.title = ids.length > 0 ? `(${ids.length}) ${TITLE}` : TITLE;
    for (const id of [...open.keys()]) if (!ids.includes(id)) shut(id);
  });

  readPermission();
  return () => {
    stopped = true;
    off();
    stopWaiting();
    for (const id of [...open.keys()]) shut(id);
    w.document.title = TITLE;
  };
}
