import { LIMITS, type NewTaskResponse, type Project, type ProjectsResponse } from '@kage/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, apiPost } from '../api.ts';
import { connection, newTaskOpen, projectsRoot, selectStarted } from '../store.ts';

const NO_ANSWER = "Kage didn't answer.";

/** The server's one-sentence error, or a fallback naming the status. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON: fall through.
  }
  return `Kage answered ${res.status}.`;
}

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
  const formRef = useRef<HTMLFormElement>(null);
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
    // Esc closes the form wherever focus is, except while a start is in flight.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || busyRef.current) return;
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
  const canStart = !busy && live && current !== undefined && branch !== '' && task.trim() !== '';

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
        task: task.trim(),
        acceptEdits,
      });
      if (res.status === 201) {
        const { id } = (await res.json()) as NewTaskResponse;
        close();
        selectStarted(id);
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

  const onFormKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !formRef.current) return;
    // Focus stays inside the form while it is open.
    const els = [
      ...formRef.current.querySelectorAll<HTMLElement & { disabled: boolean }>(
        'textarea, select, input, button',
      ),
    ].filter((el) => !el.disabled);
    const first = els[0];
    const last = els.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
      ref={formRef}
      class="k-nt"
      aria-label="New task"
      onKeyDown={onFormKey}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={areaRef}
        class="k-nt-task"
        rows={3}
        maxLength={LIMITS.taskChars}
        placeholder="What should Claude do?"
        aria-label="Task"
        value={task}
        disabled={busy}
        onInput={(e) => setTask((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onAreaKey}
      />
      {none ? (
        <p class="k-nt-none">No git repositories in {projectsRoot.value}.</p>
      ) : (
        projects?.length !== 0 && (
          <>
            <label class="k-nt-l">
              <span>Project</span>
              <select
                value={loading ? '' : project}
                disabled={loading || busy}
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
