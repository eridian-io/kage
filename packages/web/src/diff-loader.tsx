import type { Session } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { chunkUrl } from './lazy.tsx';
import { paletteOpen } from './store.ts';

type DiffModule = typeof import('./components/DiffView.tsx');

/**
 * The diff chunk's URL with a cache-busting `?r=<retry>`, from `<meta name="kage-diff">` (build.ts
 * writes it), or null outside a build. A browser keeps a failed module fetch for its URL, so a retry
 * must ask under a new one.
 */
export const retryUrl = (retry: number): string | null => chunkUrl('diff', retry);

/** The import of the diff chunk (build.ts LAZY) and the page reload, swappable in tests. */
export const diffImport = {
  load: (retry = 0): Promise<DiffModule> => {
    const url = retry > 0 ? retryUrl(retry) : null;
    return url === null
      ? import('./components/DiffView.tsx')
      : (import(/* @vite-ignore */ url) as Promise<DiffModule>);
  },
  reload: (): void => location.reload(),
};

/**
 * What the loads so far came to, for the load function that made them (a swapped load in a test
 * starts over): the module once it is in, and how many attempts failed before.
 */
let state: { load: typeof diffImport.load; mod: DiffModule | null; failures: number } | null = null;
const current = () => {
  if (state === null || state.load !== diffImport.load) {
    state = { load: diffImport.load, mod: null, failures: 0 };
  }
  return state;
};

/**
 * The diff view, loaded the first time it opens (R78). Renders "Loading the diff…" until the chunk
 * is in, then DiffView. A failure shows "Couldn't load the diff." with Try again, which loads it
 * again under a new `?r=<n>` (a failure is never kept); from the second failure on, Reload the page
 * is offered too. The footer's Back to session and Esc (SessionPanel, keys.ts) are in the first
 * load, so the way back never waits on the chunk (ruling PF5, F11).
 */
export function LazyDiff({ session }: { session: Session }) {
  const [mod, setMod] = useState<DiffModule | null>(() => current().mod);
  /** Failed attempts so far while the error shows; null while loading. */
  const [failures, setFailures] = useState<number | null>(null);
  // Each Try again is a new attempt.
  const [attempt, setAttempt] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mod !== null) return;
    // Focus in the diff from the start, as DiffView takes it, so J/K and Esc behave the same;
    // never while the palette is open (B47).
    if (!paletteOpen.value) body.current?.focus();
    let gone = false;
    const s = current();
    s.load(s.failures).then(
      (m) => {
        s.mod = m;
        if (!gone) setMod(m);
      },
      () => {
        s.failures++;
        if (!gone) setFailures(s.failures);
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
      {failures !== null && (
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
              setFailures(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
          {failures >= 2 && (
            <button type="button" class="k-act" onClick={() => diffImport.reload()}>
              Reload the page
            </button>
          )}
        </div>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard */}
      <div class="k-diff-body" ref={body} tabIndex={0}>
        {failures === null && (
          <div class="k-diff-msg" role="status">
            Loading the diff…
          </div>
        )}
      </div>
    </section>
  );
}
