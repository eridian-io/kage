import { effect } from '@preact/signals';
import { apiPost } from './api.ts';
import { selectedId, streamId } from './store.ts';

interface View {
  streamId: string;
  id: string | null;
}

/** True while a view post is in flight. */
let sending = false;
/** The newest view asked for while a post was in flight; it goes next, older ones are dropped. */
let queued: View | null = null;

function post(view: View): void {
  sending = true;
  // A failed hint is harmless: the next selection or snapshot sends it again.
  apiPost('/api/view', view)
    .catch(() => undefined)
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

/** Posts the view whenever the stream (a snapshot) or the selection changes. Returns the stopper. */
export function installView(): () => void {
  return effect(() => {
    sendView(streamId.value, selectedId.value);
  });
}
