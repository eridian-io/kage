import { demoSessions, type ProjectsResponse, type Session } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '../api.ts';
import { Board } from '../main.tsx';
import {
  applyEvent,
  confirmingDelete,
  connection,
  hadSnapshot,
  newTaskOpen,
  selectedId,
  selectWhenSeen,
  sessions,
  toast,
} from '../store.ts';

vi.mock('../api.ts', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(async () => new Response(null, { status: 204 })),
}));

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const PROJECTS: ProjectsResponse = {
  projects: [
    { name: 'api', defaultBranch: 'main', branches: ['main', 'dev'] },
    { name: 'web', defaultBranch: 'trunk', branches: ['trunk', 'feature/x'] },
  ],
  last: 'web',
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function snapshot(list: Session[]) {
  applyEvent({
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/home/me/code',
    sessions: list,
  });
}

const q = <T extends Element = HTMLElement>(c: ParentNode, sel: string) => {
  const el = c.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  return el as unknown as T;
};
const form = (c: Element) => c.querySelector<HTMLFormElement>('form.k-nt');
const area = (c: Element) => q<HTMLTextAreaElement>(c, '.k-nt textarea');
const select = (c: Element, label: string) => {
  const l = [...c.querySelectorAll('.k-nt-l')].find(
    (e) => e.querySelector('span')?.textContent === label,
  );
  if (!l) throw new Error(`no field ${label}`);
  return q<HTMLSelectElement>(l, 'select');
};
const check = (c: Element) => q<HTMLInputElement>(c, '.k-nt input[type="checkbox"]');
const start = (c: Element) => q<HTMLButtonElement>(c, '.k-nt-start');
const cancel = (c: Element) => q<HTMLButtonElement>(c, '.k-nt-cancel');
const type = (el: HTMLTextAreaElement, text: string) =>
  fireEvent.input(el, { target: { value: text } });
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key, ...init });

async function open(c: Element) {
  fireEvent.click(q(c, '.k-side > .k-new'));
  await waitFor(() => expect(select(c, 'Project').disabled).toBe(false));
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation(async () => json(PROJECTS, 200));
  vi.mocked(apiPost).mockImplementation(async () => json({ id: 'new' }, 201));
  sessions.value = [];
  selectedId.value = null;
  selectWhenSeen.value = null;
  confirmingDelete.value = false;
  toast.value = null;
  newTaskOpen.value = false;
  hadSnapshot.value = false;
  connection.value = 'live';
  snapshot(demoSessions(NOW));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('opening the New task form', () => {
  it('the button opens it in place of itself, with the task field focused', async () => {
    const { container } = render(<Board />);
    expect(form(container)).toBeNull();
    fireEvent.click(q(container, '.k-side > .k-new'));
    expect(form(container)).not.toBeNull();
    expect(container.querySelector('.k-side > .k-new')).toBeNull();
    const t = area(container);
    expect(document.activeElement).toBe(t);
    expect(t.placeholder).toBe('What should Claude do?');
    expect(t.getAttribute('rows')).toBe('3');
    expect(t.maxLength).toBe(4000);
  });

  it('N opens it; n typed in the task field neither reopens nor closes it', async () => {
    const { container } = render(<Board />);
    press(document.body, 'n');
    await waitFor(() => expect(form(container)).not.toBeNull());
    expect(document.activeElement).toBe(area(container));
    press(area(container), 'n');
    press(area(container), 'N');
    expect(form(container)).not.toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('fetches the projects on open and not before', async () => {
    const { container } = render(<Board />);
    expect(apiGet).not.toHaveBeenCalled();
    await open(container);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/projects');
  });

  it('shows Loading… in disabled selects until the projects arrive', async () => {
    let answer: (r: Response) => void = () => {};
    vi.mocked(apiGet).mockImplementation(() => new Promise((r) => (answer = r)));
    const { container } = render(<Board />);
    fireEvent.click(q(container, '.k-side > .k-new'));
    for (const label of ['Project', 'Branch off']) {
      expect(select(container, label).disabled).toBe(true);
      expect(select(container, label).textContent).toBe('Loading…');
    }
    type(area(container), 'fix it');
    expect(start(container).disabled).toBe(true);
    answer(json(PROJECTS, 200));
    await waitFor(() => expect(select(container, 'Project').disabled).toBe(false));
    expect(start(container).disabled).toBe(false);
  });

  it('defaults to last and its defaultBranch; changing the project resets the branch', async () => {
    const { container } = render(<Board />);
    await open(container);
    expect(select(container, 'Project').value).toBe('web');
    expect([...select(container, 'Project').options].map((o) => o.value)).toEqual(['api', 'web']);
    expect(select(container, 'Branch off').value).toBe('trunk');
    expect([...select(container, 'Branch off').options].map((o) => o.value)).toEqual([
      'trunk',
      'feature/x',
    ]);
    fireEvent.change(select(container, 'Branch off'), { target: { value: 'feature/x' } });
    fireEvent.change(select(container, 'Project'), { target: { value: 'api' } });
    expect(select(container, 'Branch off').value).toBe('main');
    expect([...select(container, 'Branch off').options].map((o) => o.value)).toEqual([
      'main',
      'dev',
    ]);
  });

  it('without a last project it takes the first', async () => {
    vi.mocked(apiGet).mockImplementation(async () => json({ ...PROJECTS, last: null }, 200));
    const { container } = render(<Board />);
    await open(container);
    expect(select(container, 'Project').value).toBe('api');
    expect(select(container, 'Branch off').value).toBe('main');
  });

  it('with no projects it says so and Start stays disabled', async () => {
    vi.mocked(apiGet).mockImplementation(async () => json({ projects: [], last: null }, 200));
    const { container } = render(<Board />);
    fireEvent.click(q(container, '.k-side > .k-new'));
    await waitFor(() =>
      expect(q(container, '.k-nt-none').textContent).toBe('No git repositories in /home/me/code.'),
    );
    type(area(container), 'fix it');
    expect(start(container).disabled).toBe(true);
  });

  it('a failed projects fetch (demo mode: 501) shows the server message unprefixed (F7)', async () => {
    vi.mocked(apiGet).mockImplementation(async () =>
      json({ error: "Demo mode can't start tasks." }, 501),
    );
    const { container } = render(<Board />);
    fireEvent.click(q(container, '.k-side > .k-new'));
    await waitFor(() =>
      expect(q(container, '.k-nt-err').textContent).toBe("Demo mode can't start tasks."),
    );
    expect(container.querySelector('.k-nt-none')).toBeNull();
    type(area(container), 'fix it');
    expect(start(container).disabled).toBe(true);
  });

  it('shows the copy: labels, checkbox, hint and buttons', async () => {
    const { container } = render(<Board />);
    await open(container);
    const f = form(container) as HTMLFormElement;
    expect([...f.querySelectorAll('.k-nt-l > span')].map((e) => e.textContent)).toEqual([
      'Project',
      'Branch off',
    ]);
    expect(q(f, '.k-nt-check').textContent).toBe('Accept edits automatically');
    expect(q(f, '.k-nt-hint').textContent).toBe('Claude still asks before it runs commands.');
    expect(start(container).textContent).toBe('Start↵');
    expect(cancel(container).textContent).toBe('CancelEsc');
  });
});

describe('starting a task', () => {
  it('Enter posts exactly {project, base, task, acceptEdits} with the task trimmed', async () => {
    const { container } = render(<Board />);
    await open(container);
    fireEvent.change(select(container, 'Project'), { target: { value: 'api' } });
    fireEvent.change(select(container, 'Branch off'), { target: { value: 'dev' } });
    fireEvent.click(check(container));
    type(area(container), '  add a login page \n');
    press(area(container), 'Enter');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/sessions', {
      project: 'api',
      base: 'dev',
      task: 'add a login page',
      acceptEdits: true,
    });
  });

  it('Shift+Enter does not post; a blank task does not post', async () => {
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'line one');
    press(area(container), 'Enter', { shiftKey: true });
    expect(apiPost).not.toHaveBeenCalled();
    type(area(container), '   \n ');
    press(area(container), 'Enter');
    expect(start(container).disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('Start is disabled while the stream is down', async () => {
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'fix it');
    expect(start(container).disabled).toBe(false);
    connection.value = 'reconnecting';
    await waitFor(() => expect(start(container).disabled).toBe(true));
    press(area(container), 'Enter');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('while starting, Start reads Starting… and everything is disabled', async () => {
    let answer: (r: Response) => void = () => {};
    vi.mocked(apiPost).mockImplementation(() => new Promise((r) => (answer = r)));
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'fix it');
    fireEvent.click(start(container));
    await waitFor(() => expect(start(container).textContent).toBe('Starting…'));
    const f = form(container) as HTMLFormElement;
    for (const el of f.querySelectorAll<HTMLButtonElement>('textarea, select, input, button')) {
      expect(el.disabled, el.outerHTML).toBe(true);
    }
    // Esc can't abandon a start in flight.
    press(document.body, 'Escape');
    expect(form(container)).not.toBeNull();
    answer(json({ error: 'git worktree add failed' }, 422));
    await waitFor(() => expect(start(container).textContent).toBe('Start↵'));
  });

  it('a 201 closes the form; the new session is selected once its session.updated arrives', async () => {
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'fix it');
    press(area(container), 'Enter');
    await waitFor(() => expect(form(container)).toBeNull());
    expect(newTaskOpen.value).toBe(false);
    expect(selectWhenSeen.value).toBe('new');
    // keepSelection runs on another event first and must not drop the pending selection.
    applyEvent({ type: 'session.removed', id: 'web' });
    expect(selectedId.value).toBe('shop');
    applyEvent({
      type: 'session.updated',
      session: { ...(demoSessions(NOW)[1] as Session), id: 'new', task: 'fix it' },
    });
    expect(selectedId.value).toBe('new');
    // Focus returns to the New task button.
    await waitFor(() => expect(document.activeElement).toBe(q(container, '.k-side > .k-new')));
  });

  it('a 201 for a session already in the store selects it at once (F5)', async () => {
    const { container } = render(<Board />);
    await open(container);
    applyEvent({
      type: 'session.updated',
      session: { ...(demoSessions(NOW)[1] as Session), id: 'new', task: 'fix it' },
    });
    type(area(container), 'fix it');
    press(area(container), 'Enter');
    await waitFor(() => expect(selectedId.value).toBe('new'));
    expect(selectWhenSeen.value).toBeNull();
  });

  it("a 422 shows Couldn't start: <error> and keeps the text", async () => {
    vi.mocked(apiPost).mockImplementation(async () =>
      json({ error: 'git worktree add failed: invalid reference' }, 422),
    );
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'fix it');
    press(area(container), 'Enter');
    await waitFor(() =>
      expect(q(container, '.k-nt-err').textContent).toBe(
        "Couldn't start: git worktree add failed: invalid reference",
      ),
    );
    expect(area(container).value).toBe('fix it');
    expect(form(container)).not.toBeNull();
    expect(document.activeElement).toBe(area(container));
  });

  it("a failed request shows Couldn't start with a reason of its own", async () => {
    vi.mocked(apiPost).mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<Board />);
    await open(container);
    type(area(container), 'fix it');
    press(area(container), 'Enter');
    await waitFor(() =>
      expect(q(container, '.k-nt-err').textContent).toBe("Couldn't start: Kage didn't answer."),
    );
  });
});

describe('closing and reopening', () => {
  it('Esc closes; the next open is clean, with the checkbox unchecked', async () => {
    vi.mocked(apiPost).mockImplementation(async () => json({ error: 'nope' }, 422));
    const { container } = render(<Board />);
    await open(container);
    expect(check(container).checked).toBe(false);
    fireEvent.click(check(container));
    expect(check(container).checked).toBe(true);
    type(area(container), 'fix it');
    press(area(container), 'Enter');
    await waitFor(() => expect(container.querySelector('.k-nt-err')).not.toBeNull());
    press(area(container), 'Escape');
    expect(form(container)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(q(container, '.k-side > .k-new')));
    await open(container);
    expect(area(container).value).toBe('');
    expect(check(container).checked).toBe(false);
    expect(container.querySelector('.k-nt-err')).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('Cancel closes it', async () => {
    const { container } = render(<Board />);
    await open(container);
    fireEvent.click(cancel(container));
    expect(form(container)).toBeNull();
  });

  it('Esc closes it wherever focus is', async () => {
    const { container } = render(<Board />);
    await open(container);
    press(document.body, 'Escape');
    expect(form(container)).toBeNull();
  });

  it('traps focus: Tab from the last control goes to the task, Shift+Tab back', async () => {
    const { container } = render(<Board />);
    await open(container);
    cancel(container).focus();
    press(cancel(container), 'Tab');
    expect(document.activeElement).toBe(area(container));
    press(area(container), 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(cancel(container));
  });

  it('the board keys are off while it is open', async () => {
    const { container } = render(<Board />);
    await open(container);
    expect(selectedId.value).toBe('web');
    press(cancel(container), 'j');
    expect(selectedId.value).toBe('web');
  });
});

describe('the empty state', () => {
  it('explains and offers the form; its button opens it', async () => {
    snapshot([]);
    const { container } = render(<Board />);
    const empty = q(container, '.k-empty');
    expect(q(empty, '.k-empty-t').textContent).toBe('No sessions yet');
    expect(q(empty, 'p').textContent).toBe(
      'Start a task: Kage makes a git worktree and branch for it and runs Claude there.',
    );
    const b = q<HTMLButtonElement>(empty, 'button.k-new');
    expect(b.textContent).toBe('＋ New task');
    fireEvent.click(b);
    expect(form(container)).not.toBeNull();
    expect(document.activeElement).toBe(area(container));
    // The empty state's button goes while the form is open.
    expect(container.querySelector('.k-empty button')).toBeNull();
  });
});
