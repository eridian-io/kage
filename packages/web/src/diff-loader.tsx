import type { Session } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';

type DiffModule = typeof import('./components/DiffView.tsx');

/** The import of the diff chunk (build.ts LAZY), swappable in tests. */
export const diffImport = {
  load: (): Promise<DiffModule> => import('./components/DiffView.tsx'),
};

/** The chunk once it is in, with the load that brought it: a swapped load starts over. */
let loaded: { load: typeof diffImport.load; mod: DiffModule } | null = null;
const cached = (): DiffModule | null =>
  loaded !== null && loaded.load === diffImport.load ? loaded.mod : null;

/**
 * The diff view, loaded the first time it opens (R78). Renders "Loading the diff…" until the chunk
 * is in, then DiffView; a failure shows "Couldn't load the diff." with Try again, which loads it
 * again (a failure is never kept). The footer's Back to session and Esc (SessionPanel, keys.ts) are
 * in the first load, so the way back never waits on the chunk (ruling PF5, F11).
 */
export function LazyDiff({ session }: { session: Session }) {
  const [mod, setMod] = useState<DiffModule | null>(cached);
  const [failed, setFailed] = useState(false);
  // Each Try again is a new attempt.
  const [attempt, setAttempt] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mod !== null) return;
    // Focus in the diff from the start, as DiffView takes it, so J/K and Esc behave the same.
    body.current?.focus();
    let gone = false;
    const load = diffImport.load;
    load().then(
      (m) => {
        loaded = { load, mod: m };
        if (!gone) setMod(m);
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
    };
  }, [attempt]);

  if (mod !== null) return <mod.DiffView session={session} />;
  // The same markup as DiffView's own first frame, so the swap doesn't move anything.
  return (
    <section class="k-dv" id="k-diff-view" aria-label="Diff">
      {failed && (
        <div class="k-diff-error">
          <span class="k-err" role="alert">
            Couldn't load the diff.
          </span>
          <button
            type="button"
            class="k-act"
            onClick={() => {
              // Focus moves to the diff before Try again goes away, never to the page.
              body.current?.focus();
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard */}
      <div class="k-diff-body" ref={body} tabIndex={0}>
        {!failed && (
          <div class="k-diff-msg" role="status">
            Loading the diff…
          </div>
        )}
      </div>
    </section>
  );
}
