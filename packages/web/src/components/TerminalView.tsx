import type { Session } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { authStatus } from '../api.ts';
import { authRequired, closeTerminal, selectedId, termNote } from '../store.ts';
import { loadTerminal } from '../term-loader.ts';

const LOAD_FAILED = "Couldn't load the terminal.";
const OPEN_FAILED = "Couldn't open the terminal.";

/**
 * The terminal ended by itself: back to the output, with the server's reason in the error line.
 * A socket that never opened asks /api/auth whether the user must sign in first.
 */
async function ended(id: string, reason: string | null): Promise<void> {
  closeTerminal();
  if (reason === null) {
    let status = 0;
    try {
      status = await authStatus();
    } catch {}
    if (status === 401) {
      authRequired.value = true;
      return;
    }
    reason = OPEN_FAILED;
  }
  // A note for a session the user has since left would land on another one.
  if (reason !== '' && selectedId.value === id) termNote.value = reason;
}

/**
 * The session's tmux pane, live (spec §5.6), in place of the output. The chunk loads on first
 * open; unmounting (Back, Shift+Esc, another session) disposes xterm and closes the socket.
 */
export function TerminalView({ session: s }: { session: Session }) {
  const area = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [ro, setRo] = useState(false);
  useEffect(() => {
    let gone = false;
    let handle: { focus(): void; dispose(): void } | null = null;
    loadTerminal().then(
      (m) => {
        const el = area.current;
        if (gone || !el) return;
        setReady(true);
        handle = m.mountTerminal(el, {
          id: s.id,
          onMode: (mode) => setRo(mode === 'ro'),
          onEnd: (reason) => {
            handle = null;
            void ended(s.id, reason);
          },
        });
        handle.focus();
      },
      () => {
        if (gone) return;
        closeTerminal();
        termNote.value = LOAD_FAILED;
      },
    );
    return () => {
      gone = true;
      handle?.dispose();
    };
  }, []);
  return (
    <section class="k-term" aria-label="Terminal">
      {!ready && (
        <div class="k-term-msg" role="status">
          Loading the terminal…
        </div>
      )}
      {/* xterm's own nodes; Preact renders no children here. */}
      <div class="k-term-x" ref={area} />
      {ro && (
        <div class="k-term-ro" role="status">
          View only: Kage didn't start this window, so it doesn't type into it.
        </div>
      )}
    </section>
  );
}
