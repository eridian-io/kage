import { authRequired, confirmingDelete, newTaskOpen, selectNext } from './store.ts';

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/**
 * N opens the New task form, J/K move the selection and Esc cancels the delete confirmation.
 * While the form is open it owns the keyboard (Esc, Enter, its focus trap), so these are off.
 * Returns the uninstaller.
 */
export function installKeys(target: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (newTaskOpen.value || authRequired.value) return;
    if (e.key === 'n' || e.key === 'N') newTaskOpen.value = true;
    else if (e.key === 'j' || e.key === 'J') selectNext(1);
    else if (e.key === 'k' || e.key === 'K') selectNext(-1);
    else if (e.key === 'Escape') confirmingDelete.value = false;
    else return;
    e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
