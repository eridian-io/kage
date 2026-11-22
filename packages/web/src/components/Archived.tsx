import { type ArchivedResponse, type ArchivedSession, formatAge } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, archive, canAct, errorOf, NO_ANSWER } from '../api.ts';
import { couldnt } from '../copy.ts';
import { actionError, archivedCount, archiveOpen, now } from '../store.ts';

const LIST_ID = 'k-archived';

/** The rows (null until the first answer) and the load error, if the last fetch failed. */
type Loaded = { rows: ArchivedSession[] | null; error: string | null };

function Rows({ count }: { count: number }) {
  const [loaded, setLoaded] = useState<Loaded>({ rows: null, error: null });
  // Fetched on open, and again whenever the count changes while open (an archive or a restore).
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      let error: string | null = null;
      try {
        const res = await apiGet('/api/archive', { signal: ctl.signal });
        if (res.ok) {
          const body = (await res.json()) as ArchivedResponse;
          if (!ctl.signal.aborted) setLoaded({ rows: body.sessions, error: null });
          return;
        }
        // A 401 has sent the board to the login screen.
        if (res.status === 401) return;
        error = await errorOf(res);
      } catch {
        error = NO_ANSWER;
      }
      if (!ctl.signal.aborted) setLoaded((l) => ({ rows: l.rows, error }));
    })();
    return () => ctl.abort();
  }, [count]);

  const rows = loaded.rows ?? [];
  // Closing the list clears a restore error it showed (R77): it must not greet the next opening.
  const shownRows = useRef(rows);
  shownRows.current = rows;
  useEffect(
    () => () => {
      const f = actionError.peek();
      if (f && shownRows.current.some((a) => a.id === f.id)) actionError.value = null;
    },
    [],
  );
  const failed = actionError.value;
  const restoreError = failed && rows.some((a) => a.id === failed.id) ? failed.text : null;
  return (
    <div id={LIST_ID}>
      {rows.map((a) => (
        <div class="k-it k-arc" key={a.id}>
          <span class="k-name" title={`${a.project} / ${a.task}`}>
            <span class="pj">{a.project} /</span> {a.task}
          </span>
          <span class="tm">{formatAge(now.value - a.archivedAt)}</span>
          <button
            type="button"
            class="k-restore"
            aria-label={`Restore ${a.project} / ${a.task}`}
            disabled={!canAct(a.id)}
            onClick={() => archive(a, false)}
          >
            Restore
          </button>
        </div>
      ))}
      {loaded.error !== null && (
        <div class="k-err k-arc-err" role="alert">
          {couldnt('load the archive', loaded.error)}
        </div>
      )}
      {restoreError !== null && (
        <div class="k-err k-arc-err" role="alert">
          {restoreError}
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
      {open && <Rows count={count} />}
    </div>
  );
}
