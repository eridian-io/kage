import { useEffect, useState } from 'preact/hooks';
import { NO_ANSWER } from '../api.ts';
import { couldnt } from '../copy.ts';
import { chunkUrl, lazyChunk } from '../lazy.tsx';
import { archivedCount, archiveOpen } from '../store.ts';

/** ArchivedList.tsx's list (the same id there). */
const LIST_ID = 'k-archived';

type ListModule = typeof import('./ArchivedList.tsx');

/** The archived list's chunk (build.ts LAZY), loaded on the first open. */
export const archivedChunk = lazyChunk<ListModule>('archived', (retry) => {
  const url = retry > 0 ? chunkUrl('archived', retry) : null;
  return url === null
    ? import('./ArchivedList.tsx')
    : (import(/* @vite-ignore */ url) as Promise<ListModule>);
});

/**
 * The list once its chunk is in. Until then, the list's empty box, as the list itself shows before
 * its first answer, so the open looks the same either way; a chunk that won't load says so there.
 */
function List({ count }: { count: number }) {
  const [m, setM] = useState(archivedChunk.loaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (m !== null) return;
    let gone = false;
    archivedChunk.load().then(
      (x) => {
        if (!gone) setM(x);
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
    };
  }, []);
  if (m !== null) return <m.ArchivedList count={count} />;
  return (
    <div id={LIST_ID}>
      {failed && (
        <div class="k-err k-arc-err" role="alert">
          {couldnt('load the archive', NO_ANSWER)}
        </div>
      )}
    </div>
  );
}

/** "archived N" at the bottom of the left column, shown only while something is archived. */
export function Archived() {
  const count = archivedCount.value;
  if (count === 0) return null;
  const open = archiveOpen.value;
  return (
    <div class="k-arch">
      <button
        type="button"
        class="k-g"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? LIST_ID : undefined}
        onClick={() => {
          archiveOpen.value = !open;
        }}
      >
        archived {count}
      </button>
      {open && <List count={count} />}
    </div>
  );
}
