import { effect } from '@preact/signals';
import { apiPost } from './api.ts';
import { selectedId, streamId, viewGen } from './store.ts';

interface View {
  streamId: string;
  id: string | null;
}

/** A view post that hangs is given up after this long, so later views are not held back. */
const VIEW_TIMEOUT_MS = 5000;

/** True while a view post is in flight. */
let sending = false;
/** The newest view asked for while a post was in flight; it goes next, older ones are dropped. */
let queued: View | null = null;

/** One attempt: true when the server took it. */
function attempt(view: View): Promise<boolean> {
  return apiPost('/api/view', view, { signal: AbortSignal.timeout(VIEW_TIMEOUT_MS) }).then(
    (r) => r.ok,
    () => false,
  );
}

function post(view: View): void {
  sending = true;
  // A failed hint is retried once, unless a newer view is waiting: that one goes instead.
  // After that it is harmless: the next selection or snapshot sends it again.
  attempt(view)
    .then((ok) => (ok || queued ? ok : attempt(view)))
    .finally(() => {
      sending = false;
      const next = queued;
      queued = null;
      if (next) post(next);
    });
}

/**
 * Tells the server which session this tab's stream should carry lines for. Latest wins: one post
 * is in flight at a time and the changes made meanwhile collapse into the newest, so the server
 * can never apply an older view after a newer one.
 */
export function sendView(stream: string | null, id: string | null): void {
  if (stream === null) return;
  const view = { streamId: stream, id };
  if (sending) queued = view;
  else post(view);
}

/**
 * Posts the view whenever this tab's view changes (viewGen: a new stream, an automatic pick, or
 * any selection, even of the selected row). The server answers each view with the session's
 * files and counts, so a re-selection must post too or countsKnown would wait for good.
 * Returns the stopper.
 */
export function installView(): () => void {
  return effect(() => {
    void viewGen.value;
    sendView(streamId.value, selectedId.value);
  });
}
