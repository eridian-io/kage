import { effect } from '@preact/signals';
import { apiPost } from './api.ts';
import { selectedId, streamId } from './store.ts';

/** Tells the server which session this tab's stream should carry lines for. */
export function sendView(): void {
  const stream = streamId.value;
  if (stream === null) return;
  // A failed hint is harmless: the next selection or snapshot sends it again.
  apiPost('/api/view', { streamId: stream, id: selectedId.value }).catch(() => undefined);
}

/** Posts the view whenever the stream (a snapshot) or the selection changes. Returns the stopper. */
export function installView(): () => void {
  return effect(() => {
    void streamId.value;
    void selectedId.value;
    sendView();
  });
}
