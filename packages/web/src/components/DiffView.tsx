import { type DiffFile, type DiffPage, LIMITS, type Session, shortWorktree } from '@kage/shared';
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

/**
 * A page's files. They re-render only for a new page, not for every session event. The server
 * caps a page at LIMITS.diffLines lines; the client holds to it too, counting the cut as clipped.
 */
class Files extends Component<{ page: DiffPage }> {
  override shouldComponentUpdate(next: { page: DiffPage }): boolean {
    return next.page !== this.props.page;
  }
  override render() {
    let left: number = LIMITS.diffLines;
    return this.props.page.files.map((f) => {
      const lines = f.lines.slice(0, Math.max(0, left));
      left -= lines.length;
      const cut = f.lines.length - lines.length;
      return <File f={cut === 0 ? f : { ...f, lines, clipped: f.clipped + cut }} />;
    });
  }
}

/** The page asked for, and where the pages before it started (← Previous goes to the last). */
interface Req {
  from: number;
  back: number[];
}
interface Loaded {
  /** The last page that arrived, with its back stack; kept while loading and after an error. */
  page: DiffPage | null;
  back: number[];
  loading: boolean;
  error: string | null;
}

/**
 * The session's branch as a read-only diff, one page at a time (spec §5.7, §6.5). Fetched when it
 * opens and for each page, never live: a session.files event offers a reload instead. Unmounting
 * (Back, Esc, another session) aborts the request in flight. An error keeps the last page and its
 * controls, and offers Try again.
 */
export function DiffView({ session: s }: { session: Session }) {
  // Every request is a new object, so asking again for the same page refetches it.
  const [req, setReq] = useState<Req>({ from: 0, back: [] });
  const [st, setSt] = useState<Loaded>({ page: null, back: [], loading: true, error: null });
  const view = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(s);
  live.current = s;
  /** The file list the shown page was asked for against; a newer one means it is stale. */
  const asked = useRef(s.files);

  useEffect(() => {
    const el = body.current;
    const sec = view.current;
    if (!el || !sec) return;
    el.focus();
    // J/K anywhere in the diff (its body, the page buttons) move between its files; the board's
    // J/K leave them to it.
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k !== 'j' && k !== 'k') || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const y = el.scrollTop;
      const tops = [...el.querySelectorAll<HTMLElement>('.k-diff-file')].map((f) => f.offsetTop);
      const to = k === 'j' ? tops.find((t) => t > y + 1) : tops.reverse().find((t) => t < y - 1);
      if (to !== undefined) el.scrollTop = to;
    };
    sec.addEventListener('keydown', onKey);
    return () => sec.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const cur = live.current;
    asked.current = cur.files;
    setSt((l) => ({ ...l, loading: true, error: null }));
    void (async () => {
      let error = NO_ANSWER;
      try {
        const res = await apiGet(
          `/api/sessions/${encodeURIComponent(cur.id)}/diff?from=${req.from}`,
          { signal: ctl.signal },
        );
        if (res.ok) {
          const page = (await res.json()) as DiffPage;
          if (ctl.signal.aborted) return;
          // The files shrank under a later page: start again from the first.
          if (page.files.length === 0 && page.from > 0) setReq({ from: 0, back: [] });
          else setSt({ page, back: req.back, loading: false, error: null });
          return;
        }
        // A 401 has sent the board to the login screen.
        if (res.status === 401) return;
        error = await errorOf(res);
      } catch {
        // An abort (closed or switched) shows nothing; anything else is "Kage didn't answer."
      }
      if (!ctl.signal.aborted) setSt((l) => ({ ...l, loading: false, error }));
    })();
    return () => ctl.abort();
  }, [req]);

  // A control that went away with the last state (Try again, the reload link) drops focus to the
  // page; it comes back to the diff instead.
  useEffect(() => {
    const a = document.activeElement;
    if (!st.loading && (a === null || a === document.body)) body.current?.focus();
  }, [st]);

  const p = st.page;
  const shown = st.loading ? null : p;
  const paged = p !== null && (p.from > 0 || p.next !== null);
  const stale = shown !== null && st.error === null && s.files !== asked.current;
  // Try again and the reload link go away while the page loads: focus moves to the diff first,
  // so it never falls to the page.
  const again = () => {
    body.current?.focus();
    setReq({ ...req });
  };
  // aria-disabled, not disabled: a focused button that turns off keeps focus (keyboard paging).
  const prevOff = st.loading || st.back.length === 0;
  const nextOff = st.loading || p === null || p.next === null;
  return (
    <section class="k-dv" id="k-diff-view" aria-label="Diff" ref={view}>
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
              <span class="k-diff-count" aria-live="polite">
                Files {p.from + 1}–{p.from + p.files.length} of {p.filesTotal}
              </span>
              <button
                type="button"
                class="k-act"
                aria-disabled={prevOff ? 'true' : undefined}
                onClick={() => {
                  if (!prevOff) setReq({ from: st.back.at(-1) ?? 0, back: st.back.slice(0, -1) });
                }}
              >
                ← Previous
              </button>
              <button
                type="button"
                class="k-act"
                aria-disabled={nextOff ? 'true' : undefined}
                onClick={() => {
                  if (!nextOff && p.next !== null) {
                    setReq({ from: p.next, back: [...st.back, p.from] });
                  }
                }}
              >
                Next →
              </button>
            </span>
          )}
        </div>
      )}
      {stale && (
        <button type="button" class="k-diff-stale" onClick={again}>
          The files changed. Reload the diff.
        </button>
      )}
      {st.error !== null && (
        <div class="k-diff-error">
          <span class="k-err" role="alert">
            Couldn't load the diff: {st.error}
          </span>
          <button type="button" class="k-act" onClick={again}>
            Try again
          </button>
        </div>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard */}
      <div class="k-diff-body" ref={body} tabIndex={0}>
        {st.loading ? (
          <div class="k-diff-msg" role="status">
            Loading the diff…
          </div>
        ) : shown !== null && shown.files.length === 0 ? (
          <div class="k-diff-msg">No changes yet.</div>
        ) : (
          shown !== null && <Files page={shown} />
        )}
      </div>
    </section>
  );
}
