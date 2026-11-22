import { type DiffFile, type DiffPage, type Session, shortWorktree } from '@kage/shared';
import { Component } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, errorOf, NO_ANSWER } from '../api.ts';
import { projectsRoot } from '../store.ts';

const GUTTER = { add: '+', del: '−', ctx: ' ' } as const;

/** One file: a heading with its path and counts, then its lines, or what stands in for them. */
function File({ f }: { f: DiffFile }) {
  const note =
    f.kind === 'binary'
      ? 'Binary file, not shown.'
      : f.kind === 'link'
        ? 'Symbolic link, not shown.'
        : f.clipped > 0
          ? `${f.clipped} more ${f.clipped === 1 ? "line in this file isn't" : "lines in this file aren't"} shown.`
          : null;
  return (
    <div class="k-diff-file">
      <h4 class="k-diff-h">
        <span class="p">{f.oldPath === undefined ? f.path : `${f.oldPath} → ${f.path}`}</span>
        <span class="a">+{f.added}</span>
        <span class="r">−{f.removed}</span>
      </h4>
      {/* Text children only: the server's lines never become markup. */}
      {f.lines.map(([k, t]) =>
        k === 'hunk' ? (
          <div class="k-dl hunk">{t}</div>
        ) : (
          <div class={`k-dl ${k}`}>
            <span class="g">{GUTTER[k]}</span>
            {t}
          </div>
        ),
      )}
      {note !== null && <div class="k-diff-note">{note}</div>}
    </div>
  );
}

/** A page's files. They re-render only for a new page, not for every session event. */
class Files extends Component<{ page: DiffPage }> {
  override shouldComponentUpdate(next: { page: DiffPage }): boolean {
    return next.page !== this.props.page;
  }
  override render() {
    return this.props.page.files.map((f) => <File f={f} />);
  }
}

interface Loaded {
  /** The last page that arrived; kept while the next one loads, for the top line. */
  page: DiffPage | null;
  loading: boolean;
  error: string | null;
}

/**
 * The session's branch as a read-only diff, one page at a time (spec §5.7, §6.5). Fetched when it
 * opens and for each page, never live: a session.files event offers a reload instead. Unmounting
 * (Back, Esc, another session) aborts the request in flight.
 */
export function DiffView({ session: s }: { session: Session }) {
  const [from, setFrom] = useState(0);
  /** Where the earlier pages started: ← Previous refetches the last one. */
  const [back, setBack] = useState<number[]>([]);
  const [reloads, setReloads] = useState(0);
  const [st, setSt] = useState<Loaded>({ page: null, loading: true, error: null });
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(s);
  live.current = s;
  /** The file list the shown page was asked for against; a newer one means it is stale. */
  const asked = useRef(s.files);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.focus();
    // J/K inside the diff move between its files; the board's J/K leave them to it.
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k !== 'j' && k !== 'k') || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const y = el.scrollTop;
      const tops = [...el.querySelectorAll<HTMLElement>('.k-diff-file')].map((f) => f.offsetTop);
      const to = k === 'j' ? tops.find((t) => t > y + 1) : tops.reverse().find((t) => t < y - 1);
      if (to !== undefined) el.scrollTop = to;
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const cur = live.current;
    asked.current = cur.files;
    setSt((l) => ({ page: l.page, loading: true, error: null }));
    void (async () => {
      let error = NO_ANSWER;
      try {
        const res = await apiGet(`/api/sessions/${encodeURIComponent(cur.id)}/diff?from=${from}`, {
          signal: ctl.signal,
        });
        if (res.ok) {
          const page = (await res.json()) as DiffPage;
          if (!ctl.signal.aborted) setSt({ page, loading: false, error: null });
          return;
        }
        // A 401 has sent the board to the login screen.
        if (res.status === 401) return;
        error = await errorOf(res);
      } catch {
        // An abort (closed or switched) shows nothing; anything else is "Kage didn't answer."
      }
      if (!ctl.signal.aborted) setSt({ page: null, loading: false, error });
    })();
    return () => ctl.abort();
  }, [from, reloads]);

  const go = (to: number, stack: number[]) => {
    setBack(stack);
    setFrom(to);
  };

  const p = st.page;
  const shown = st.loading ? null : p;
  const paged = p !== null && (p.from > 0 || p.next !== null);
  const stale = shown !== null && s.files !== asked.current;
  return (
    <section class="k-dv" id="k-diff-view" aria-label="Diff">
      {p !== null && (
        <div class="k-diff-top">
          <span class="k-diff-ref">
            {p.branch === ''
              ? shortWorktree(s.worktree, projectsRoot.value)
              : p.base === null
                ? p.branch
                : `${p.branch} against ${p.base}`}
          </span>
          {paged && (
            <span class="k-diff-pages">
              <span class="k-diff-count">
                Files {p.from + 1}–{p.from + p.files.length} of {p.filesTotal}
              </span>
              <button
                type="button"
                class="k-act"
                disabled={st.loading || back.length === 0}
                onClick={() => go(back.at(-1) ?? 0, back.slice(0, -1))}
              >
                ← Previous
              </button>
              <button
                type="button"
                class="k-act"
                disabled={st.loading || p.next === null}
                onClick={() => p.next !== null && go(p.next, [...back, p.from])}
              >
                Next →
              </button>
            </span>
          )}
        </div>
      )}
      {stale && (
        <button type="button" class="k-diff-stale" onClick={() => setReloads((n) => n + 1)}>
          The files changed. Reload the diff.
        </button>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard */}
      <div class="k-diff-body" ref={body} tabIndex={0}>
        {st.loading ? (
          <div class="k-diff-msg" role="status">
            Loading the diff…
          </div>
        ) : st.error !== null ? (
          <div class="k-err" role="alert">
            Couldn't load the diff: {st.error}
          </div>
        ) : shown !== null && shown.files.length === 0 && shown.from === 0 ? (
          <div class="k-diff-msg">No changes yet.</div>
        ) : (
          shown !== null && <Files page={shown} />
        )}
      </div>
    </section>
  );
}
