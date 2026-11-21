import { confirmingDelete, selectNext } from './store.ts';

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/** J/K move the selection and Esc cancels the delete confirmation. Returns the uninstaller. */
export function installKeys(target: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (e.key === 'j' || e.key === 'J') selectNext(1);
    else if (e.key === 'k' || e.key === 'K') selectNext(-1);
    else if (e.key === 'Escape') confirmingDelete.value = false;
    else return;
    e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
