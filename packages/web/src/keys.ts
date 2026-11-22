import { groupOf } from '@kage/shared';
import { answer, archive, pin, resume, stop } from './api.ts';
import { isLeave } from './leave.ts';
import {
  authRequired,
  canStop,
  closeDiff,
  closeTerminal,
  confirmingDelete,
  digitsHeld,
  mainView,
  newTaskOpen,
  openTerminal,
  paletteOpen,
  releaseDigits,
  replyOpen,
  selected,
  selectNext,
  stopArmed,
  stopPending,
} from './store.ts';

/** R26: a first X arms Stop for this long; a second X within it stops the session. */
export const STOP_ARM_MS = 2000;

/**
 * ⌘K or Ctrl+K, without Alt or Shift: the command palette. K is matched by its physical key only on a
 * layout whose K key types no Latin letter, so Dvorak's Ctrl+T is never taken for it.
 */
export function isPaletteKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return false;
  const k = e.key.toLowerCase();
  return k === 'k' || (!/^[a-z]$/.test(k) && e.code === 'KeyK');
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/**
 * N opens the New task form, J/K move the selection, 1–9 answer, R replies or follows up, X twice
 * stops, S pins, E archives, U resumes, T opens the terminal, and Esc closes the diff, cancels the
 * delete confirmation or closes the reply field. While the form is open it owns the keyboard (Esc,
 * Enter), so these are off. While the terminal is open every key is its own (F9), except
 * Shift+Esc and Ctrl+Shift+X, which leave it (T2, R64). Elsewhere ⌘K / Ctrl+K toggles the command
 * palette, which owns the keyboard while open (Task 8). Returns the uninstaller.
 */
export function installKeys(target: Document = document): () => void {
  let disarm: ReturnType<typeof setTimeout> | undefined;
  const onKey = (e: KeyboardEvent) => {
    const open = selected.value;
    // Only a terminal that is on screen owns the keys (an ended session shows none).
    if (mainView.value === 'terminal' && open !== null && open.status !== 'ended') {
      // From inside xterm too: its key handler lets these two through to here.
      if (isLeave(e) && !e.repeat) {
        e.preventDefault();
        closeTerminal();
      }
      return;
    }
    // The login screen: the browser keeps every key, Ctrl+K included.
    if (authRequired.value) return;
    // The palette's key works anywhere else, typing and the New task form included (F14). A held
    // key toggles once, but its repeats still don't reach the browser.
    if (isPaletteKey(e)) {
      e.preventDefault();
      if (!e.repeat) paletteOpen.value = !paletteOpen.value;
      return;
    }
    // While it is open the palette owns the keyboard.
    if (paletteOpen.value) return;
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (newTaskOpen.value) return;
    const k = e.key.toLowerCase();
    // A held key repeats: J/K may move on, but nothing else acts twice (a held X must not stop).
    if (e.repeat && k !== 'j' && k !== 'k') return;
    // Inside the diff, J/K move between its files (DiffView handles them).
    if ((k === 'j' || k === 'k') && e.target instanceof Element && e.target.closest('.k-dv')) {
      return;
    }
    const s = selected.value;
    const diff = mainView.value === 'diff';
    if (k === 'n') {
      releaseDigits();
      newTaskOpen.value = true;
    } else if (k === 'j') selectNext(1);
    else if (k === 'k') selectNext(-1);
    else if (k === 'escape') {
      if (diff) closeDiff();
      else if (confirmingDelete.value) {
        confirmingDelete.value = false;
        // Focus back on Delete…, which opened it (R77).
        target.querySelector<HTMLElement>('[data-act="del"]')?.focus();
      }
      replyOpen.value = false;
    } else if (k.length === 1 && k >= '1' && k <= '9') {
      // The diff hides the question: a digit must not answer what isn't on screen.
      if (s?.status === 'needs-you' && !digitsHeld() && !diff) void answer(s, Number(k));
    } else if (k === 'r' && s) {
      if (diff) {
        // R leaves the diff only for a session that takes a reply or a follow-up; the field is
        // focused once it has rendered.
        const typed =
          s.status === 'needs-you' ? !!s.question && !s.question.startup : s.status === 'done';
        if (!typed) return;
        mainView.value = 'output';
        setTimeout(() => target.querySelector<HTMLInputElement>('.k-follow input')?.focus());
      }
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
    else if (k === 't' && s && s.status !== 'ended') openTerminal(s);
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
