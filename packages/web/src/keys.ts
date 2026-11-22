import { groupOf } from '@kage/shared';
import { answer, archive, pin, resume, stop } from './api.ts';
import {
  authRequired,
  canStop,
  confirmingDelete,
  digitsHeld,
  newTaskOpen,
  releaseDigits,
  replyOpen,
  selected,
  selectNext,
  stopArmed,
  stopPending,
} from './store.ts';

/** R26: a first X arms Stop for this long; a second X within it stops the session. */
export const STOP_ARM_MS = 2000;

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/**
 * N opens the New task form, J/K move the selection, 1–9 answer, R replies or follows up, X twice
 * stops, S pins, E archives, U resumes, and Esc cancels the delete confirmation or closes the reply field. While the form is
 * open it owns the keyboard (Esc, Enter), so these are off. Returns the uninstaller.
 */
export function installKeys(target: Document = document): () => void {
  let disarm: ReturnType<typeof setTimeout> | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (newTaskOpen.value || authRequired.value) return;
    const k = e.key.toLowerCase();
    // A held key repeats: J/K may move on, but nothing else acts twice (a held X must not stop).
    if (e.repeat && k !== 'j' && k !== 'k') return;
    const s = selected.value;
    if (k === 'n') {
      releaseDigits();
      newTaskOpen.value = true;
    } else if (k === 'j') selectNext(1);
    else if (k === 'k') selectNext(-1);
    else if (k === 'escape') {
      confirmingDelete.value = false;
      replyOpen.value = false;
    } else if (k.length === 1 && k >= '1' && k <= '9') {
      if (s?.status === 'needs-you' && !digitsHeld()) void answer(s, Number(k));
    } else if (k === 'r' && s) {
      if (s.status === 'needs-you') {
        // Startup screens take buttons only (R9).
        if (!s.question || s.question.startup) return;
        replyOpen.value = true;
      }
      // A new reply field focuses itself as it mounts; an open one, or the follow-up, is focused here.
      target.querySelector<HTMLInputElement>('.k-follow input')?.focus();
    } else if (k === 's' && s && !s.external) void pin(s);
    else if (k === 'e' && s && !s.external && groupOf(s) === 'done') void archive(s, true);
    else if (k === 'u' && s && !s.external && s.status === 'ended') void resume(s);
    else if (k === 'x' && s && canStop(s) && !stopPending(s)) {
      clearTimeout(disarm);
      if (stopArmed.value === s.id) {
        stopArmed.value = null;
        void stop(s);
      } else {
        stopArmed.value = s.id;
        disarm = setTimeout(() => {
          stopArmed.value = null;
        }, STOP_ARM_MS);
      }
    } else return;
    e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => {
    clearTimeout(disarm);
    target.removeEventListener('keydown', onKey);
  };
}
