import { LIMITS, type NewTaskResponse, type Project, type ProjectsResponse } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, apiPost, errorOf, NO_ANSWER } from '../api.ts';
import { connection, newTaskOpen, projectsRoot, selectStarted } from '../store.ts';

const COUNT_FROM = 3600;
const fmt = (n: number) => n.toLocaleString('en-US');
const encoder = new TextEncoder();

/** The project's branches, with its default branch first if the list lacks it. */
function branchesOf(p: Project | undefined): string[] {
  if (!p) return [];
  return p.branches.includes(p.defaultBranch) ? p.branches : [p.defaultBranch, ...p.branches];
}

const close = () => {
  newTaskOpen.value = false;
};

/**
 * The New task form (spec §5.2, §6.5). It replaces the left column's button while open and is
 * mounted fresh on every open, so each open starts clean. The projects are fetched on open only.
 */
export function NewTask() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('');
  const [task, setTask] = useState('');
  const [acceptEdits, setAcceptEdits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Read by the document listener and by submit before a re-render has happened.
  const busyRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    areaRef.current?.focus();
    alive.current = true;
    (async () => {
      try {
        const res = await apiGet('/api/projects');
        if (!res.ok) {
          // Demo mode (501) or a failed listing: the server's own sentence, unprefixed (F7).
          const message = await errorOf(res);
          if (alive.current) {
            setProjects([]);
            setError(message);
          }
          return;
        }
        const body = (await res.json()) as ProjectsResponse;
        if (!alive.current) return;
        const first = body.projects.find((p) => p.name === body.last) ?? body.projects[0];
        setProjects(body.projects);
        setProject(first?.name ?? '');
        setBranch(first?.defaultBranch ?? '');
      } catch {
        if (alive.current) {
          setProjects([]);
          setError(NO_ANSWER);
        }
      }
    })();
    // Esc closes the form wherever focus is, except while a start is in flight, inside a select
    // (where it closes the open list) or when a field has handled it already.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || busyRef.current) return;
      if ((e.target as Element | null)?.tagName === 'SELECT') return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      alive.current = false;
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const current = projects?.find((p) => p.name === project);
  const live = connection.value === 'live';
  // The server's limits (validate.ts): code points (F4) and UTF-8 bytes of the trimmed task.
  const trimmed = task.trim();
  const chars = [...trimmed].length;
  const tooManyBytes = encoder.encode(trimmed).length > LIMITS.textBytes;
  const fits = chars <= LIMITS.taskChars && !tooManyBytes;
  const count = tooManyBytes
    ? `Too long: over ${fmt(LIMITS.textBytes)} bytes.`
    : chars >= COUNT_FROM
      ? `${fmt(chars)} / ${fmt(LIMITS.taskChars)}`
      : null;
  const canStart =
    !busy && live && current !== undefined && branch !== '' && trimmed !== '' && fits;

  const submit = async () => {
    if (!canStart || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    try {
      const res = await apiPost('/api/sessions', {
        project,
        base: branch,
        task: trimmed,
        acceptEdits,
      });
      if (res.status === 201) {
        // Started, even if the body is unreadable: then the form just closes.
        const id = await res
          .json()
          .then((b: NewTaskResponse) => b.id)
          .catch(() => null);
        close();
        if (typeof id === 'string' && id !== '') selectStarted(id);
        return;
      }
      // A 401 has already sent the board to the login screen; anything else is shown here.
      if (res.status !== 401) failure = `Couldn't start: ${await errorOf(res)}`;
    } catch {
      failure = `Couldn't start: ${NO_ANSWER}`;
    } finally {
      busyRef.current = false;
    }
    if (!alive.current) return;
    setBusy(false);
    setError(failure);
  };

  // Disabling the controls drops focus to the page; give it back to the task once a start fails.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) areaRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  const onAreaKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const loading = projects === null;
  const none = projects !== null && projects.length === 0 && error === null;
  const chosen = (e: Event) => (e.target as HTMLSelectElement).value;

  return (
    <form
      class="k-nt"
      aria-label="New task"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={areaRef}
        class="k-nt-task"
        rows={3}
        placeholder="What should Claude do?"
        aria-label="Task"
        value={task}
        disabled={busy}
        onInput={(e) => setTask((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onAreaKey}
        aria-describedby={count ? 'k-nt-count' : undefined}
      />
      {count && (
        <p class="k-nt-count" id="k-nt-count">
          {count}
        </p>
      )}
      {none ? (
        <p class="k-nt-none" role="status">
          No git repositories in {projectsRoot.value}.
        </p>
      ) : (
        projects?.length !== 0 && (
          <>
            <label class="k-nt-l">
              <span>Project</span>
              <select
                value={loading ? '' : project}
                disabled={loading || busy}
                aria-busy={loading || undefined}
                onChange={(e) => {
                  const name = chosen(e);
                  setProject(name);
                  setBranch(projects?.find((p) => p.name === name)?.defaultBranch ?? '');
                }}
              >
                {loading ? (
                  <option value="">Loading…</option>
                ) : (
                  projects.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label class="k-nt-l">
              <span>Branch off</span>
              <select
                value={loading ? '' : branch}
                disabled={loading || busy}
                aria-busy={loading || undefined}
                onChange={(e) => setBranch(chosen(e))}
              >
                {loading ? (
                  <option value="">Loading…</option>
                ) : (
                  branchesOf(current).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))
                )}
              </select>
            </label>
          </>
        )
      )}
      <div>
        <label class="k-nt-check">
          <input
            type="checkbox"
            checked={acceptEdits}
            disabled={busy}
            aria-describedby="k-nt-hint"
            onChange={(e) => setAcceptEdits((e.target as HTMLInputElement).checked)}
          />
          Accept edits automatically
        </label>
        <p class="k-nt-hint" id="k-nt-hint">
          Claude still asks before it runs commands.
        </p>
      </div>
      <div class="k-nt-row">
        <button class="k-act k-nt-start" type="submit" disabled={!canStart}>
          {busy ? (
            'Starting…'
          ) : (
            <>
              Start<kbd>↵</kbd>
            </>
          )}
        </button>
        <button class="k-act k-nt-cancel" type="button" disabled={busy} onClick={close}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      {error && (
        <p class="k-nt-err" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
