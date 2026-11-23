/**
 * `#s=<id>` links (a ping's `click`, W1): the board selects that session, at load once the first
 * snapshot has it, or at once on a hashchange. Moved out of notify.ts, which now loads after the
 * first snapshot (performance P6): the follow must be waiting before the stream opens.
 */
import { hadSnapshot, onApplied, select, selectWhenSeen, sorted } from './store.ts';

/** The server's session ids: a UUID, or `ext-@<window>` (as terminal/upgrade.ts accepts). */
const SESSION_ID = /^[A-Za-z0-9@_-]{1,100}$/;

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

/** Follows the hash at load and on every hashchange. Returns the stopper. */
export function installLink(
  w: Window | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (!w) return () => {};
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

  const off = onApplied((e) => {
    // The snapshot has already selected a linked session it carries; an unknown id goes quietly.
    if (e.type === 'snapshot' && linked !== null) {
      if (selectWhenSeen.value === linked) selectWhenSeen.value = null;
      linked = null;
    }
  });

  follow();
  w.addEventListener('hashchange', follow);
  return () => {
    w.removeEventListener('hashchange', follow);
    off();
  };
}
