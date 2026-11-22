import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoSessions, type Session } from '@kage/shared';
import { effect, untracked } from '@preact/signals';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDelete, apiPost } from '../api.ts';
import { Board } from '../main.tsx';
import {
  actionError,
  answered,
  applyEvent,
  authRequired,
  beginRemoval,
  busy,
  confirmingDelete,
  connection,
  endRemoval,
  hadSnapshot,
  host,
  linesById,
  mainView,
  now,
  releaseDigits,
  replyOpen,
  selectedId,
  sessions,
  stopArmed,
  stopSent,
  termNote,
  toast,
  viewGen,
} from '../store.ts';

// The board's own actions (act) use the real api module, so they reach the stubbed fetch below.
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiDelete: vi.fn(async () => new Response(null, { status: 204 })),
  apiPost: vi.fn(async () => new Response(null, { status: 204 })),
}));

/** What the next requests answer, in order: a status and, unless 204, the server's error. */
let replies: [number, string?][];
let fetchMock: ReturnType<typeof vi.fn>;
/** The requests the board sent: the URL, the X-Kage header and the parsed body. */
const posts = () =>
  (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => [
    url,
    (init.headers as Record<string, string>)['X-Kage'],
    init.body === undefined ? undefined : JSON.parse(String(init.body)),
  ]);

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
/**
 * Like the server after a view: each view (selection) of a session brings its files, and with
 * them its counts, so the delete confirmation knows them. A test of the unknown state turns it off.
 */
let autoCounts = true;
let stopAutoCounts: () => void = () => {};
const board = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');

function reset(list: Session[] = demoSessions(NOW)) {
  host.value = '';
  hadSnapshot.value = false;
  authRequired.value = false;
  busy.value = new Set();
  actionError.value = null;
  answered.value = null;
  stopSent.value = null;
  releaseDigits();
  replyOpen.value = false;
  stopArmed.value = null;
  sessions.value = [];
  selectedId.value = null;
  confirmingDelete.value = false;
  toast.value = null;
  connection.value = 'live';
  now.value = NOW;
  linesById.value = new Map();
  mainView.value = 'output';
  termNote.value = null;
  applyEvent({
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived: 0,
    sessions: list.map((s) => ({ ...s, lines: [] })),
  });
  for (const s of list) {
    applyEvent({ type: 'session.lines', id: s.id, lines: s.lines, reset: true });
  }
}

const q = <T extends Element = HTMLElement>(c: Element, sel: string) => {
  const el = c.querySelector<T>(sel as never);
  if (!el) throw new Error(`no element for ${sel}`);
  return el as unknown as T;
};
const texts = (c: Element, sel: string) =>
  [...c.querySelectorAll(sel)].map((e) => e.textContent ?? '');
const row = (c: Element, id: string) => q(c, `.k-it[data-id="${id}"]`);
const footButtons = (c: Element) => [...c.querySelectorAll<HTMLButtonElement>('.k-foot button')];
const button = (c: Element, label: string) => {
  const b = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => (x.textContent ?? '').replace(x.querySelector('kbd')?.textContent ?? '', '') === label,
  );
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
beforeEach(() => {
  autoCounts = true;
  stopAutoCounts = effect(() => {
    void viewGen.value;
    const id = selectedId.value;
    untracked(() => {
      const s = sessions.value.find((x) => x.id === id);
      if (autoCounts && s) {
        applyEvent({ type: 'session.files', id: s.id, files: s.files, filesTotal: s.filesTotal });
      }
    });
  });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.mocked(apiDelete).mockClear();
  vi.mocked(apiPost).mockClear();
  replies = [];
  fetchMock = vi.fn(async () => {
    const [status, error] = replies.shift() ?? [204];
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify({ error }), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  reset();
});
afterEach(() => {
  stopAutoCounts();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('top bar', () => {
  it('shows the host pill, the counts and the command key', () => {
    const { container } = render(<Board />);
    expect(q(container, '.k-host').textContent).toBe('my-pc · 6 sessions');
    expect(texts(container, '.k-counts > span')).toEqual(['1 needs you', '2 running']);
    expect(q(container, '.k-top .k-k').textContent).toBe('⌘K');
    expect(q(container, '.k-logo').textContent).toBe('kage');
  });
  it('does not count archived sessions', () => {
    const list = demoSessions(NOW);
    (list[4] as Session).archived = true;
    reset(list);
    const { container } = render(<Board />);
    expect(q(container, '.k-host').textContent).toBe('my-pc · 5 sessions');
  });
});

describe('session list', () => {
  it('shows the groups in order and the rows', () => {
    const { container } = render(<Board />);
    expect(texts(container, '.k-side .k-g')).toEqual(['needs you', 'running', 'done']);
    const web = row(container, 'web');
    expect(web.textContent).toContain('web /');
    expect(web.textContent).toContain('dark mode');
    expect(q(web, '.tm').textContent).toBe('4m');
    expect(q(web, '.w').textContent).toBe('waiting for your reply');
    expect(web.classList.contains('on')).toBe(true);
    expect(row(container, 'rate').textContent?.startsWith('★')).toBe(true);
    expect([...container.querySelectorAll('.k-it')].map((e) => e.getAttribute('data-id'))).toEqual([
      'web',
      'shop',
      'infra',
      'rate',
      'footer',
      'docs',
    ]);
    expect(q(container, '.k-side > .k-new').textContent).toBe('＋ New task N');
  });
});

describe('session panel', () => {
  it('shows the header and meta for the needs-you session', () => {
    const { container } = render(<Board />);
    const h3 = q(container, '.k-head h3');
    expect(q(h3, '.k-proj').textContent).toBe('web /');
    expect(h3.textContent).toContain('dark mode');
    expect(q(h3, '.k-chip').textContent).toBe('needs you');
    expect(q(h3, '.k-chip').classList.contains('wait')).toBe(true);
    expect(texts(container, '.k-meta > span')).toEqual([
      'branch feat/dark-mode',
      'worktree web/.worktrees/dark-mode',
      'started 18m ago',
    ]);
    expect(q(container, '.k-meta > span:nth-child(2)').getAttribute('title')).toBe(
      '~/projects/web/.worktrees/dark-mode',
    );
  });

  it('shows the question with its answer buttons and the reply hint', () => {
    const { container } = render(<Board />);
    const ask = q(container, '.k-ask');
    expect(q(ask, '.k-q small').textContent).toBe('Waiting for you');
    expect(q(ask, '.k-q').textContent).toBe('Waiting for youWhich approach should I use?');
    const opts = [...ask.querySelectorAll('.k-opts button:not(.k-or)')];
    expect(opts.map((b) => [b.querySelector('kbd')?.textContent, b.textContent])).toEqual([
      ['1', '1CSS variables'],
      ['2', '2Tailwind'],
    ]);
    for (const b of opts) {
      expect(b.hasAttribute('aria-disabled')).toBe(false);
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
    expect(q(ask, '.k-or').textContent).toBe('or press R to reply');
  });

  it('shows Terminal (live since Task 13) and Stop in the footer, and no Archive', () => {
    const { container } = render(<Board />);
    const [term, stop, ...rest] = footButtons(container);
    expect(rest).toEqual([]);
    expect(term?.closest('.l')).not.toBeNull();
    expect(term?.textContent).toBe('TerminalT');
    expect(term?.querySelector('kbd')?.textContent).toBe('T');
    expect(stop?.closest('.r')).not.toBeNull();
    expect(stop?.textContent).toBe('StopX');
    expect(stop?.classList.contains('stop')).toBe(true);
    expect(term?.hasAttribute('aria-disabled')).toBe(false);
    expect(stop?.hasAttribute('aria-disabled')).toBe(false);
    expect(container.textContent).not.toContain('Archive');
    // Opening the terminal sends no request (the WebSocket comes from the chunk; terminal.test.tsx).
    fireEvent.click(term as Element);
    expect(mainView.value).toBe('terminal');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('renders the output lines with the target prefixes', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    const lines = [...container.querySelectorAll('.k-tr .ln')];
    expect(lines.map((l) => [l.className, l.textContent])).toEqual([
      ['ln ln-tool', 'Read src/auth/session.ts (142 lines)'],
      [
        'ln ln-say',
        'Found it: isExpired() compares seconds with milliseconds, so every token looks expired after a refresh.',
      ],
      ['ln ln-tool', 'Update src/auth/session.ts'],
      ['ln ln-del', '− if (token.exp < Date.now()) {'],
      ['ln ln-add', '+ if (token.exp * 1000 < Date.now()) {'],
      ['ln ln-tool', 'Bash npm test -- auth'],
      ['ln ln-out', '  PASS test/auth.test.ts (14 tests)'],
      ['ln ln-out', '  PASS test/session.test.ts (6 tests)'],
      ['ln ln-think', 'Writing a regression test for the refresh case… (38s)'],
    ]);
    expect(q(lines[0] as Element, '.dim').textContent).toBe('src/auth/session.ts (142 lines)');
  });

  it('shows a running session with the think line, the cursor and Stop', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    expect(row(container, 'shop').classList.contains('on')).toBe(true);
    expect(row(container, 'web').classList.contains('on')).toBe(false);
    expect(q(container, '.k-chip').textContent).toBe('running');
    expect(q(container, '.k-chip').classList.contains('run')).toBe(true);
    expect(q(container, '.k-tr .ln-think').textContent).toBe(
      'Writing a regression test for the refresh case… (38s)',
    );
    expect(container.querySelector('.k-tr .cursor')).not.toBeNull();
    expect(container.querySelector('.k-ask')).toBeNull();
    expect(footButtons(container).map((b) => b.textContent)).toEqual(['TerminalT', 'StopX']);
    expect(texts(container, '.k-meta > span')[2]).toBe('started 12m ago');
  });

  it('shows the preview pane', () => {
    const { container } = render(<Board />);
    expect(texts(container, '.k-aside .k-sec h4')).toEqual(['Preview', 'Files changed · 1']);
    expect(texts(container, '.k-port')).toEqual([':5173 viteOpen ↗']);
    expect(texts(container, '.k-file')).toEqual(['src/styles/theme.css+0−0']);
    expect(q(container, '.k-diff').textContent).toBe('View diff →');
    fireEvent.click(row(container, 'infra'));
    expect(q(container, '.k-none').textContent).toBe('No ports open yet.');
    expect(texts(container, '.k-aside .k-sec h4')[1]).toBe('Files changed · 3');
  });

  it('shows a done session with the follow-up field, Archive and Delete…, and confirms', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    expect(q(container, '.k-chip').textContent).toBe('done');
    expect(q(container, '.k-chip').classList.contains('done')).toBe(true);
    expect(texts(container, '.k-meta > span')[2]).toBe('finished 1h ago');
    expect(container.querySelector('.k-tr .cursor')).toBeNull();
    const follow = q(container, '.k-follow');
    expect(q<HTMLInputElement>(follow, 'input').placeholder).toBe('Follow up in this session…');
    expect(follow.textContent).toBe('R');
    expect(follow.hasAttribute('aria-disabled')).toBe(false);
    const [term, archive, del, ...rest] = footButtons(container);
    expect(rest).toEqual([]);
    expect(term?.textContent).toBe('TerminalT');
    expect(archive?.textContent).toBe('ArchiveE');
    expect(archive?.hasAttribute('aria-disabled')).toBe(false);
    expect(del?.textContent).toBe('Delete…');
    expect(del?.classList.contains('stop')).toBe(true);
    expect(del?.hasAttribute('aria-disabled')).toBe(false);
    expect(container.textContent).not.toContain('Stop');

    fireEvent.click(del as Element);
    expect(container.querySelector('.k-follow')).toBeNull();
    const confirm = q(container, '.k-confirm');
    expect(q(confirm, 'b').textContent).toBe('Delete this session?');
    expect(q(confirm, 'div').textContent).toBe(
      'Delete this session? This removes the tmux window, the worktree ~/projects/docs/.worktrees/readme and the branch docs/readme. 1 commit isn’t pushed and will be lost.',
    );
    expect(q(confirm, '.warn').textContent).toBe('1 commit isn’t pushed and will be lost.');
    expect(texts(confirm, 'code')).toEqual(['~/projects/docs/.worktrees/readme', 'docs/readme']);
    // Order in the main column: follow-up/confirm, then the footer.
    expect(confirm.nextElementSibling?.classList.contains('k-foot')).toBe(true);

    fireEvent.click(button(container, 'Cancel'));
    expect(container.querySelector('.k-confirm')).toBeNull();
    expect(container.querySelector('.k-follow')).not.toBeNull();
  });

  it('says nothing is lost when everything is pushed', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'footer'));
    fireEvent.click(button(container, 'Delete…'));
    expect(q(container, '.k-confirm div').textContent).toBe(
      'Delete this session? This removes the tmux window, the worktree ~/projects/web/.worktrees/footer and the branch fix/footer. Everything on the branch is pushed, so nothing is lost.',
    );
  });

  it('deletes through the API and toasts once the server removes the session', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    fireEvent.click(button(container, 'Delete session'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([
      ['/api/sessions/docs', '1', { unpushed: 1, uncommitted: 0, ignored: 0 }],
    ]);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE');
    applyEvent({ type: 'session.removed', id: 'docs' });
    await Promise.resolve();
    expect(toast.value).toEqual({ kind: 'deleted', name: 'docs · update README' });
    const t = q(container, '.k-toast');
    expect(t.getAttribute('role')).toBe('status');
    expect(t.textContent).toBe('Deleted docs · update README · worktree and branch removed');
    expect(q(t, 'b').textContent).toBe('docs · update README');
    expect(selectedId.value).toBe('web');
    expect(row(container, 'web').classList.contains('on')).toBe(true);
    expect(container.querySelector('.k-it[data-id="docs"]')).toBeNull();
    expect(container.querySelector('.k-confirm')).toBeNull();
  });

  it('does not toast when a session is removed that this page did not delete', async () => {
    const { container } = render(<Board />);
    applyEvent({ type: 'session.removed', id: 'footer' });
    await Promise.resolve();
    expect(container.querySelector('.k-toast')).toBeNull();
  });

  it('clears the toast when another session is selected', () => {
    const { container } = render(<Board />);
    toast.value = { kind: 'deleted', name: 'docs · update README' };
    fireEvent.click(row(container, 'shop'));
    expect(container.querySelector('.k-toast')).toBeNull();
  });

  it('clears the toast when the already-selected row is clicked', async () => {
    const { container } = render(<Board />);
    expect(selectedId.value).toBe('web');
    toast.value = { kind: 'deleted', name: 'docs · update README' };
    await Promise.resolve();
    expect(container.querySelector('.k-toast')).not.toBeNull();
    fireEvent.click(row(container, 'web'));
    expect(toast.value).toBeNull();
    expect(container.querySelector('.k-toast')).toBeNull();
    expect(selectedId.value).toBe('web');
  });
});

describe('review focus', () => {
  it('1: renders markup in session text literally', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const list = demoSessions(NOW);
    const web = list[0] as Session;
    web.task = evil;
    web.lines = [{ kind: 'say', text: evil }];
    reset(list);
    const { container } = render(<Board />);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(q(container, '.k-tr .ln-say').textContent).toBe(evil);
    expect(q(container, '.k-head h3').textContent).toContain(evil);
    expect(row(container, 'web').textContent).toContain(evil);
  });

  it('2: truncates long tasks and worktrees with an ellipsis and a full title', () => {
    const task = 't'.repeat(120);
    const worktree = `~/projects/${'w'.repeat(189)}`;
    expect(worktree.length).toBe(200);
    const list = demoSessions(NOW);
    const web = list[0] as Session;
    web.task = task;
    web.worktree = worktree;
    reset(list);
    const { container } = render(<Board />);
    const ellipsised = (el: Element) => {
      const cls = [...el.classList].find((c) =>
        new RegExp(String.raw`\.${c}[^{]*\{[^}]*text-overflow: ellipsis`).test(board),
      );
      expect(cls, `${el.className} has an ellipsis class`).toBeDefined();
    };
    const headTask = q(container, '.k-head h3 .k-task');
    expect(headTask.textContent).toBe(task);
    expect(headTask.getAttribute('title')).toBe(task);
    ellipsised(headTask);
    const rowName = q(row(container, 'web'), '.k-name');
    expect(rowName.getAttribute('title')).toBe(`web / ${task}`);
    ellipsised(rowName);
    const wt = q(container, '.k-meta > span:nth-child(2)');
    expect(wt.getAttribute('title')).toBe(worktree);
    expect(wt.textContent).toBe(`worktree ${'w'.repeat(189)}`);
    ellipsised(wt);
  });

  it('5: drops an empty group and shows an empty state', async () => {
    const { container } = render(<Board />);
    applyEvent({ type: 'session.removed', id: 'web' });
    await Promise.resolve();
    expect(texts(container, '.k-side .k-g')).toEqual(['running', 'done']);
    expect(selectedId.value).toBe('shop');
    for (const id of ['shop', 'infra', 'rate', 'footer', 'docs']) {
      applyEvent({ type: 'session.removed', id });
    }
    await Promise.resolve();
    expect(container.querySelectorAll('.k-g')).toHaveLength(0);
    expect(container.querySelectorAll('.k-it')).toHaveLength(0);
    expect(container.textContent).toContain('No sessions yet');
    expect(q(container, '.k-host').textContent).toBe('my-pc · 0 sessions');
    expect(selectedId.value).toBeNull();
  });
});

describe('ages', () => {
  it('re-render from the now signal', async () => {
    const { container } = render(<Board />);
    now.value = NOW + 60 * 60_000;
    await Promise.resolve();
    expect(q(row(container, 'web'), '.tm').textContent).toBe('1h');
    expect(texts(container, '.k-meta > span')[2]).toBe('started 1h ago');
  });
});

describe('store', () => {
  it('upserts updated sessions', async () => {
    const { container } = render(<Board />);
    const shop = { ...(demoSessions(NOW)[1] as Session), task: 'fix logout bug' };
    applyEvent({ type: 'session.updated', session: shop });
    const extra = { ...shop, id: 'new', task: 'brand new' };
    applyEvent({ type: 'session.updated', session: extra });
    await Promise.resolve();
    expect(row(container, 'shop').textContent).toContain('fix logout bug');
    expect(row(container, 'new').textContent).toContain('brand new');
    expect(sessions.value).toHaveLength(7);
  });
});

describe('reconnect bar', () => {
  it('is absent while live', () => {
    const { container } = render(<Board />);
    expect(container.querySelector('.k-reconnect')).toBeNull();
    expect(container.textContent).not.toContain('Reconnecting');
  });

  it('shows under the top bar while not live, and disables Delete', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    connection.value = 'reconnecting';
    await Promise.resolve();
    const bar = q(container, '.k-reconnect');
    expect(bar.textContent).toBe('Reconnecting to my-pc…');
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.previousElementSibling?.classList.contains('k-top')).toBe(true);
    expect(button(container, 'Delete session').disabled).toBe(true);
    fireEvent.click(button(container, 'Delete session'));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    connection.value = 'live';
    await Promise.resolve();
    expect(container.querySelector('.k-reconnect')).toBeNull();
    expect(button(container, 'Delete session').disabled).toBe(false);

    fireEvent.click(button(container, 'Cancel'));
    connection.value = 'connecting';
    await Promise.resolve();
    expect(button(container, 'Delete…').disabled).toBe(true);
    expect(q(container, '.k-reconnect').textContent).toBe('Reconnecting to my-pc…');
  });

  const beforeFirstSnapshot = () => {
    host.value = '';
    hadSnapshot.value = false;
    sessions.value = [];
    selectedId.value = null;
    connection.value = 'connecting';
  };

  it('stays hidden during the first attempt', () => {
    beforeFirstSnapshot();
    const { container } = render(<Board />);
    expect(container.querySelector('.k-reconnect')).toBeNull();
  });

  it('says "Connecting to Kage…" when the first connect fails, the host after a snapshot', async () => {
    beforeFirstSnapshot();
    const { container } = render(<Board />);
    connection.value = 'reconnecting';
    await Promise.resolve();
    const bar = q(container, '.k-reconnect');
    expect(bar.textContent).toBe('Connecting to Kage…');
    expect(bar.getAttribute('role')).toBe('status');
    applyEvent({
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      archived: 0,
      sessions: demoSessions(NOW),
    });
    connection.value = 'live';
    await Promise.resolve();
    expect(container.querySelector('.k-reconnect')).toBeNull();
    connection.value = 'reconnecting';
    await Promise.resolve();
    expect(q(container, '.k-reconnect').textContent).toBe('Reconnecting to my-pc…');
  });
});

describe('before the first snapshot', () => {
  it('is neutral: no empty state, no "0 sessions", no counts', async () => {
    host.value = '';
    hadSnapshot.value = false;
    sessions.value = [];
    selectedId.value = null;
    connection.value = 'connecting';
    const { container } = render(<Board />);
    expect(container.textContent).not.toContain('No sessions yet');
    expect(container.textContent).not.toContain('0 sessions');
    expect(container.querySelector('.k-host')).toBeNull();
    expect(container.querySelector('.k-counts')).toBeNull();
    expect(container.querySelector('.k-main')).not.toBeNull();
    expect(container.querySelectorAll('.k-side .k-it')).toHaveLength(0);
    expect(q(container, '.k-logo').textContent).toBe('kage');

    // An empty first snapshot is a real answer: now it says so.
    applyEvent({
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      archived: 0,
      sessions: [],
    });
    await Promise.resolve();
    expect(container.textContent).toContain('No sessions yet');
    expect(q(container, '.k-host').textContent).toBe('my-pc · 0 sessions');
  });

  it('uses quiet styling from the tokens', () => {
    const rule = /\.k-reconnect\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/--(amber|lime|red)|#/);
  });
});

describe('pending delete', () => {
  it('disables Delete session while the request is pending, and keeps the confirmation', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    fireEvent.click(button(container, 'Delete session'));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button(container, 'Delete session').disabled).toBe(true);
    expect(button(container, 'Delete…').disabled).toBe(true);
    // A second click while pending sends nothing.
    fireEvent.click(button(container, 'Delete session'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(new Response(JSON.stringify({ error: 'Kage is busy.' }), { status: 500 }));
    await waitFor(() => expect(button(container, 'Delete session').disabled).toBe(false));
    expect(container.querySelector('.k-confirm')).not.toBeNull();
  });

  it('forgets a delete whose session is gone from the next snapshot', async () => {
    const s = sessions.value.find((x) => x.id === 'docs') as Session;
    beginRemoval(s, 'deleted');
    endRemoval('docs', true);
    // The removal happened while disconnected; the snapshot no longer has it.
    applyEvent({
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      archived: 0,
      sessions: demoSessions(NOW).filter((x) => x.id !== 'docs'),
    });
    // A later session with the same id is removed by someone else: no toast.
    applyEvent({ type: 'session.updated', session: s });
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(toast.value).toBeNull();
  });
});

describe('delete confirmation reset', () => {
  it('resets when the selected session leaves the done group', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    expect(confirmingDelete.value).toBe(true);
    const docs = sessions.value.find((x) => x.id === 'docs') as Session;
    applyEvent({ type: 'session.updated', session: { ...docs, status: 'running' } });
    expect(confirmingDelete.value).toBe(false);
    applyEvent({ type: 'session.updated', session: docs });
    await Promise.resolve();
    expect(container.querySelector('.k-confirm')).toBeNull();
  });

  it('resets when the selected session is replaced by another', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    applyEvent({ type: 'session.removed', id: 'docs' });
    expect(selectedId.value).toBe('web');
    expect(confirmingDelete.value).toBe(false);
  });

  it('stays while the selected session is updated but still done', () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    const docs = sessions.value.find((x) => x.id === 'docs') as Session;
    applyEvent({ type: 'session.updated', session: { ...docs, unpushed: 3 } });
    expect(confirmingDelete.value).toBe(true);
  });
});

describe('board v2', () => {
  const withSession = (patch: Partial<Session>, id = 'docs') => {
    const list = demoSessions(NOW).map((s) => (s.id === id ? { ...s, ...patch } : s));
    reset(list);
  };
  const lines = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ kind: 'say' as const, text: `line ${from + i}` }));

  it('appends one output line as one new node and keeps the existing nodes', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    const before = [...container.querySelectorAll('.k-tr .ln')];
    applyEvent({ type: 'session.lines', id: 'shop', lines: lines(1, 100), reset: false });
    await Promise.resolve();
    const after = [...container.querySelectorAll('.k-tr .ln')];
    expect(after).toHaveLength(before.length + 1);
    after.slice(0, before.length).forEach((el, i) => {
      expect(el).toBe(before[i]);
    });
    expect(after.at(-1)?.textContent).toBe('line 100');
  });

  it('keeps nodes in place when the cap drops the oldest line', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    applyEvent({ type: 'session.lines', id: 'shop', lines: lines(500), reset: true });
    await Promise.resolve();
    const before = [...container.querySelectorAll('.k-tr .ln')];
    applyEvent({ type: 'session.lines', id: 'shop', lines: lines(1, 501), reset: false });
    await Promise.resolve();
    const after = [...container.querySelectorAll('.k-tr .ln')];
    expect(after).toHaveLength(500);
    expect(after[0]).toBe(before[1]);
    expect(after.at(-1)?.textContent).toBe('line 501');
  });

  it('renders at most 500 output nodes, the newest', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    applyEvent({ type: 'session.lines', id: 'shop', lines: lines(600), reset: true });
    await Promise.resolve();
    const nodes = [...container.querySelectorAll('.k-tr .ln')];
    expect(nodes).toHaveLength(500);
    expect(nodes[0]?.textContent).toBe('line 101');
    expect(nodes.at(-1)?.textContent).toBe('line 600');
    // The output caps by itself too, whatever the store holds.
    linesById.value = new Map(linesById.value).set('shop', lines(600));
    await Promise.resolve();
    const direct = [...container.querySelectorAll('.k-tr .ln')];
    expect(direct).toHaveLength(500);
    expect(direct[0]?.textContent).toBe('line 101');
  });

  it('shows an ended session: grey chip, finished age, Resume, Archive and Delete…', () => {
    withSession({ status: 'ended' });
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    const chip = q(container, '.k-chip');
    expect(chip.textContent).toBe('ended');
    expect(chip.classList.contains('run')).toBe(false);
    expect(chip.classList.contains('wait')).toBe(false);
    const rule = /\.k-chip\.ended\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
    expect(rule).toContain('var(--fg-2)');
    expect(rule).not.toMatch(/--(amber|lime|red)|#/);
    expect(texts(container, '.k-meta > span')[2]).toBe('finished 1h ago');
    expect(container.querySelector('.k-follow')).toBeNull();
    expect(container.querySelector('.k-tr .cursor')).toBeNull();
    const [resume, archive, del, ...rest] = footButtons(container);
    expect(rest).toEqual([]);
    expect(resume?.textContent).toBe('ResumeU');
    expect(resume?.querySelector('kbd')?.textContent).toBe('U');
    expect(resume?.closest('.l')).not.toBeNull();
    expect(resume?.hasAttribute('aria-disabled')).toBe(false);
    expect(archive?.textContent).toBe('ArchiveE');
    expect(archive?.closest('.r')).not.toBeNull();
    expect(del?.textContent).toBe('Delete…');
    expect(del?.closest('.r')).not.toBeNull();
    expect(container.textContent).not.toContain('Terminal');
    fireEvent.click(del as Element);
    expect(container.querySelector('.k-confirm')).not.toBeNull();
    expect(container.querySelector('.k-follow')).toBeNull();
    // The list groups it with done.
    expect(texts(container, '.k-side .k-g')).toEqual(['needs you', 'running', 'done']);
  });

  it('an ended external session offers no Resume: Kage resumes only its own sessions', () => {
    withSession({ status: 'ended', external: true });
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    const buttons = footButtons(container);
    expect(buttons.map((b) => b.textContent)).toEqual(['TerminalT']);
    expect(container.textContent).not.toContain('Resume');
  });

  it('marks an external session in the row and offers only Terminal', () => {
    withSession({ external: true }, 'shop');
    const { container } = render(<Board />);
    const shop = row(container, 'shop');
    const mark = q(shop, '.x');
    expect(mark.textContent).toBe('external');
    const rule = /\.k-it \.x\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
    expect(rule).toContain('var(--fg-3)');
    expect(rule).not.toMatch(/--(amber|lime|red)|#/);
    expect(row(container, 'infra').querySelector('.x')).toBeNull();
    fireEvent.click(shop);
    expect(footButtons(container).map((b) => b.textContent)).toEqual(['TerminalT']);
    expect(container.textContent).not.toContain('Stop');
  });

  it('marks an external done session and keeps the follow-up but no Archive or Delete', async () => {
    withSession({ external: true }, 'docs');
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    expect(footButtons(container).map((b) => b.textContent)).toEqual(['TerminalT']);
    expect(container.querySelector('.k-follow')).not.toBeNull();
    confirmingDelete.value = true;
    await Promise.resolve();
    expect(container.querySelector('.k-confirm')).toBeNull();
  });

  it('puts the external marker after the reply hint on a needs-you row', () => {
    withSession({ external: true }, 'web');
    const { container } = render(<Board />);
    const web = row(container, 'web');
    expect(q(web, '.w').textContent).toBe('waiting for your reply · external');
    expect(q(web, '.w .x').textContent).toBe(' · external');
    expect(web.querySelectorAll('.x')).toHaveLength(1);
  });

  it('shortens the worktree with the projects root', () => {
    withSession({ worktree: '/home/dev/projects/api/.worktrees/x' }, 'web');
    applyEvent({
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/home/dev/projects',
      archived: 0,
      sessions: sessions.value,
    });
    const { container } = render(<Board />);
    expect(texts(container, '.k-meta > span')[1]).toBe('worktree api/.worktrees/x');
    expect(q(container, '.k-meta > span:nth-child(2)').getAttribute('title')).toBe(
      '/home/dev/projects/api/.worktrees/x',
    );
  });

  it('shows the now line as the think line of a running session', () => {
    withSession({ now: 'Running npm test' }, 'shop');
    applyEvent({ type: 'session.lines', id: 'shop', lines: lines(2), reset: true });
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    const all = [...container.querySelectorAll('.k-tr .ln')];
    expect(all.map((l) => l.className).at(-1)).toBe('ln ln-think');
    expect(all.at(-1)?.textContent).toBe('Running npm test');
    expect(all.at(-1)?.nextElementSibling?.classList.contains('cursor')).toBe(true);
  });

  it('does not add the now line when the lines already end with a think line', () => {
    withSession({ now: 'Running npm test' }, 'shop');
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'shop'));
    expect(texts(container, '.k-tr .ln-think')).toEqual([
      'Writing a regression test for the refresh case… (38s)',
    ]);
  });

  it('does not show the now line for a session that is not running', () => {
    withSession({ now: 'Running npm test' }, 'docs');
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    expect(container.querySelector('.k-tr .ln-think')).toBeNull();
  });
});

describe('controls', () => {
  const QUESTION = 'Which approach should I use?';
  const withQuestion = (question: Session['question']) =>
    reset(demoSessions(NOW).map((s) => (s.id === 'web' ? { ...s, question } : s)));
  const optButtons = (c: Element) => [
    ...c.querySelectorAll<HTMLButtonElement>('.k-opts button:not(.k-or)'),
  ];
  const key = (k: string, target: Document | Element = document) =>
    fireEvent.keyDown(target, { key: k });
  /** The next request waits until the returned function is called. */
  const hold = () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    return (status = 204) =>
      release(
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify({ error: 'Refused.' }), { status }),
      );
  };
  const errLine = (c: Element) => c.querySelector('.k-err')?.textContent ?? null;
  const replyInput = (c: Element) => c.querySelector<HTMLInputElement>('.k-ask .k-follow input');
  const openReply = async (c: Element) => {
    key('r');
    await waitFor(() => expect(replyInput(c)).not.toBeNull());
    return replyInput(c) as HTMLInputElement;
  };
  const CHANGED = 'The question changed. Look again before answering.';

  describe('answer buttons and 1–9', () => {
    it('clicking 2 posts the option and the question to the answer route with X-Kage', async () => {
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[1] as Element);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([
        ['/api/sessions/web/answer', '1', { option: 2, question: QUESTION }],
      ]);
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('POST');
    });

    it('key 2 does the same; key 5 with two options does nothing', async () => {
      render(<Board />);
      key('5');
      key('2');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([
        ['/api/sessions/web/answer', '1', { option: 2, question: QUESTION }],
      ]);
    });

    it('keys typed in a field do nothing', async () => {
      render(<Board />);
      const field = document.createElement('input');
      document.body.append(field);
      for (const k of ['1', 'r', 'x', 'x']) key(k, field);
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(replyOpen.value).toBe(false);
      expect(stopArmed.value).toBeNull();
      field.remove();
    });

    it('disables the buttons while the session is busy; a second click or key sends nothing', async () => {
      const release = hold();
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(optButtons(container).every((b) => b.disabled)).toBe(true));
      expect(busy.value.has('web')).toBe(true);
      fireEvent.click(optButtons(container)[1] as Element);
      key('2');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release();
      await waitFor(() => expect(optButtons(container).every((b) => !b.disabled)).toBe(true));
      expect(busy.value.size).toBe(0);
    });

    it('a snapshot re-creating the same question keeps the buttons off; 5 s later they work', async () => {
      vi.useFakeTimers();
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await vi.advanceTimersByTimeAsync(0);
      expect(answered.value).not.toBeNull();
      applyEvent({
        type: 'snapshot',
        host: 'my-pc',
        streamId: 's2',
        projectsRoot: '/p',
        archived: 0,
        sessions: demoSessions(NOW).map((s) => ({ ...s, lines: [] })),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(optButtons(container).every((b) => b.disabled)).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(optButtons(container).every((b) => !b.disabled)).toBe(true);
    });

    it('selecting another session clears the answered mark', async () => {
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(answered.value).not.toBeNull());
      fireEvent.click(row(container, 'shop'));
      expect(answered.value).toBeNull();
    });

    it('keeps an answered question’s buttons disabled until the server replaces it', async () => {
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(busy.value.size).toBe(0));
      expect(optButtons(container).every((b) => b.disabled)).toBe(true);
      fireEvent.click(optButtons(container)[1] as Element);
      key('2');
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The next update brings a new question object: the buttons work again.
      const web = sessions.value.find((s) => s.id === 'web') as Session;
      applyEvent({
        type: 'session.updated',
        session: { ...web, question: { text: 'Next?', options: ['Yes', 'No'] } },
      });
      // After the R51 hold.
      await waitFor(() => expect(optButtons(container).every((b) => !b.disabled)).toBe(true), {
        timeout: 2000,
      });
    });

    it('holds the buttons ~800 ms after the selected question changes (R51)', async () => {
      vi.useFakeTimers();
      const { container } = render(<Board />);
      const web = sessions.value.find((s) => s.id === 'web') as Session;
      applyEvent({
        type: 'session.updated',
        session: { ...web, question: { text: 'Delete it?', options: ['Yes', 'No'] } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(optButtons(container).every((b) => b.disabled)).toBe(true);
      fireEvent.click(optButtons(container)[0] as Element);
      key('1');
      await vi.advanceTimersByTimeAsync(799);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(optButtons(container).every((b) => !b.disabled)).toBe(true);
      fireEvent.click(optButtons(container)[0] as Element);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts()).toEqual([
        ['/api/sessions/web/answer', '1', { option: 1, question: 'Delete it?' }],
      ]);
    });

    it('a click that lands before the re-render, during the hold, does nothing (R51)', async () => {
      vi.useFakeTimers();
      const { container } = render(<Board />);
      const first = optButtons(container)[0] as HTMLButtonElement;
      const web = sessions.value.find((s) => s.id === 'web') as Session;
      applyEvent({
        type: 'session.updated',
        session: { ...web, question: { text: 'Delete it?', options: ['Yes', 'No'] } },
      });
      first.disabled = false;
      fireEvent.click(first);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('disables the buttons and the keys while disconnected', async () => {
      const { container } = render(<Board />);
      connection.value = 'reconnecting';
      await Promise.resolve();
      expect(optButtons(container).every((b) => b.disabled)).toBe(true);
      key('1');
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows disabled options (R39) without sending them, by click or key', async () => {
      withQuestion({
        text: 'Do you want to proceed?',
        options: ['Yes', 'Yes, and don’t ask again', 'Yes, and switch to auto mode', 'No'],
        disabledOptions: [3],
      });
      const { container } = render(<Board />);
      const opts = optButtons(container);
      expect(opts.map((b) => b.disabled)).toEqual([false, false, true, false]);
      fireEvent.click(opts[2] as Element);
      key('3');
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      key('4');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()[0]?.[2]).toEqual({ option: 4, question: 'Do you want to proceed?' });
    });

    it('shows the server’s sentence in one --fg-2 line above the footer', async () => {
      replies = [[409, CHANGED]];
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(errLine(container)).toBe(`Couldn't send: ${CHANGED}`));
      expect(q(container, '.k-err').nextElementSibling?.classList.contains('k-foot')).toBe(true);
      const rule = /\.k-err\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
      expect(rule).toContain('var(--fg-2)');
      expect(rule).not.toMatch(/--(amber|lime|red)|#/);
    });

    it('a long command wraps on the card; a cut one points at the terminal (R52)', async () => {
      const long = `Do you want to proceed? — ${'x'.repeat(300)}`;
      withQuestion({ text: long, options: ['Yes', 'No'] });
      const { container, unmount } = render(<Board />);
      expect(q(container, '.k-ask .k-q').textContent).toBe(`Waiting for you${long}`);
      expect(container.querySelector('.k-ask .k-cut')).toBeNull();
      const rule = /\.k-q\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
      unmount();
      const cut = `Do you want to proceed? — ${'x'.repeat(472)}…`;
      withQuestion({ text: cut, options: ['Yes', 'No'], cut: true });
      const again = render(<Board />);
      expect(q(again.container, '.k-ask .k-cut').textContent).toBe(
        '… see the terminal for the full command',
      );
    });

    it('a 401 returns to the login screen without an error line', async () => {
      replies = [[401, 'Sign in to Kage']];
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(container.querySelector('form.k-login')).not.toBeNull());
      expect(actionError.value).toBeNull();
    });

    it('says when Kage did not answer', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('offline'));
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(errLine(container)).toBe("Couldn't send: Kage didn't answer."));
    });
  });

  describe('reply', () => {
    it('R opens the field focused under the options; Enter posts the text and closes it', async () => {
      const { container } = render(<Board />);
      expect(replyInput(container)).toBeNull();
      const input = await openReply(container);
      expect(input.placeholder).toBe('Reply instead of choosing…');
      expect(q(container, '.k-ask .k-follow kbd').textContent).toBe('Esc');
      const field = input.closest('.k-follow') as Element;
      expect(field.previousElementSibling?.classList.contains('k-opts')).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.input(input, { target: { value: 'Use CSS variables, keep the old names' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([
        ['/api/sessions/web/reply', '1', { text: 'Use CSS variables, keep the old names' }],
      ]);
      await waitFor(() => expect(replyInput(container)).toBeNull());
    });

    it('clicking the hint opens the field', async () => {
      const { container } = render(<Board />);
      fireEvent.click(q(container, '.k-or'));
      await waitFor(() => expect(replyInput(container)).not.toBeNull());
    });

    it('Esc closes the field and nothing else hears it', async () => {
      const { container } = render(<Board />);
      const input = await openReply(container);
      const heard = vi.fn();
      document.addEventListener('keydown', heard);
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      input.dispatchEvent(esc);
      document.removeEventListener('keydown', heard);
      expect(esc.defaultPrevented).toBe(true);
      expect(heard).not.toHaveBeenCalled();
      await waitFor(() => expect(replyInput(container)).toBeNull());
      expect(replyOpen.value).toBe(false);
    });

    it('a refused reply keeps the text and shows the server’s sentence', async () => {
      const refusal =
        "Replies from the board can't start with !, # or /. Use the terminal for those.";
      replies = [[400, refusal]];
      const { container } = render(<Board />);
      const input = await openReply(container);
      fireEvent.input(input, { target: { value: '/compact' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(errLine(container)).toBe(`Couldn't send: ${refusal}`));
      expect(input.value).toBe('/compact');
      expect(replyInput(container)).toBe(input);
    });

    it('an empty reply sends nothing', async () => {
      const { container } = render(<Board />);
      const input = await openReply(container);
      fireEvent.input(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a startup question has buttons but no hint, and R does nothing', async () => {
      withQuestion({
        text: 'Do you trust the files in this folder?',
        options: ['Yes, I trust this folder', 'No, exit'],
        startup: true,
      });
      const { container } = render(<Board />);
      expect(optButtons(container)).toHaveLength(2);
      expect(container.querySelector('.k-or')).toBeNull();
      key('r');
      await Promise.resolve();
      expect(replyOpen.value).toBe(false);
      expect(replyInput(container)).toBeNull();
    });

    it('the login screen shows its text and the terminal line, no buttons (F8)', () => {
      withQuestion({ text: 'Sign in to Claude Code in the terminal', options: [], startup: true });
      const { container } = render(<Board />);
      expect(q(container, '.k-q').textContent).toBe(
        'Waiting for youSign in to Claude Code in the terminal',
      );
      expect(optButtons(container)).toEqual([]);
      expect(container.querySelector('.k-or')).toBeNull();
      expect(q(container, '.k-ask .k-hint').textContent).toBe(
        "Open the session's terminal (tmux attach) and sign in there.",
      );
      const rule = /\.k-ask \.k-hint\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
      expect(rule).toContain('var(--fg-3)');
    });

    it('closes when another session is selected', async () => {
      const { container } = render(<Board />);
      await openReply(container);
      fireEvent.click(row(container, 'shop'));
      fireEvent.click(row(container, 'web'));
      await Promise.resolve();
      expect(replyInput(container)).toBeNull();
    });

    it('closes when the question goes away', async () => {
      const { container } = render(<Board />);
      await openReply(container);
      const web = sessions.value.find((s) => s.id === 'web') as Session;
      applyEvent({ type: 'session.updated', session: { ...web, question: undefined as never } });
      expect(replyOpen.value).toBe(false);
    });
  });

  describe('follow-up', () => {
    const open = () => {
      const r = render(<Board />);
      fireEvent.click(row(r.container, 'docs'));
      return { ...r, input: q<HTMLInputElement>(r.container, '.k-follow input') };
    };

    it('R focuses it; Enter posts the text and clears it on 204', async () => {
      const { input } = open();
      key('r');
      expect(document.activeElement).toBe(input);
      fireEvent.input(input, { target: { value: 'Also add a FAQ section' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([
        ['/api/sessions/docs/reply', '1', { text: 'Also add a FAQ section' }],
      ]);
      await waitFor(() => expect(input.value).toBe(''));
    });

    it('on 409 the text stays and the error line shows the server’s sentence', async () => {
      replies = [[409, 'The session is busy.']];
      const { container, input } = open();
      fireEvent.input(input, { target: { value: 'Also add a FAQ section' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(errLine(container)).toBe("Couldn't send: The session is busy."));
      expect(input.value).toBe('Also add a FAQ section');
    });

    it('a second Enter while the first is in flight sends nothing', async () => {
      const release = hold();
      const { input } = open();
      fireEvent.input(input, { target: { value: 'Also add a FAQ section' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(input.getAttribute('aria-busy')).toBe('true'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release();
      await waitFor(() => expect(input.value).toBe(''));
    });

    it('Esc leaves the field and goes no further', () => {
      const { input } = open();
      input.focus();
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      input.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(input);
    });
  });

  describe('Stop', () => {
    it('the button posts stop at once', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      fireEvent.click(button(container, 'Stop'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/shop/stop', '1', undefined]]);
    });

    it('is disabled while busy and while disconnected; a refused stop enables it again', async () => {
      const release = hold();
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      fireEvent.click(button(container, 'Stop'));
      await waitFor(() => expect(button(container, 'Stop').disabled).toBe(true));
      fireEvent.click(button(container, 'Stop'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release(409);
      await waitFor(() => expect(button(container, 'Stop').disabled).toBe(false));
      connection.value = 'reconnecting';
      await Promise.resolve();
      expect(button(container, 'Stop').disabled).toBe(true);
    });

    it('stays disabled after an accepted stop until the status changes', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      fireEvent.click(button(container, 'Stop'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(busy.value.size).toBe(0));
      expect(button(container, 'Stop').disabled).toBe(true);
      fireEvent.click(button(container, 'Stop'));
      key('x');
      key('x');
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.k-foot .k-hint')).toBeNull();
      // A new status from the server (here needs-you): Stop works again.
      const shop = sessions.value.find((s) => s.id === 'shop') as Session;
      applyEvent({
        type: 'session.updated',
        session: { ...shop, status: 'needs-you', question: { text: 'Go on?', options: ['Yes'] } },
      });
      await Promise.resolve();
      expect(button(container, 'Stop').disabled).toBe(false);
    });

    it('X twice stops a running session; the first X asks for the second (R26)', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      key('x');
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(q(container, '.k-foot .k-hint').textContent).toBe('Press X again to stop');
      const rule = /\.k-foot \.k-hint\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
      expect(rule).toContain('var(--fg-2)');
      key('X');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/shop/stop', '1', undefined]]);
      await waitFor(() => expect(container.querySelector('.k-foot .k-hint')).toBeNull());
    });

    it('external sessions have no Stop and X does nothing', async () => {
      reset(demoSessions(NOW).map((s) => (s.id === 'shop' ? { ...s, external: true } : s)));
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      expect(container.textContent).not.toContain('Stop');
      key('x');
      key('x');
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(stopArmed.value).toBeNull();
    });

    it('X does nothing on a done session', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      key('x');
      key('x');
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    const withPorts = (ports: Session['ports']) =>
      reset(demoSessions(NOW).map((s) => (s.id === 'web' ? { ...s, ports } : s)));
    const setURL = (url: string) =>
      (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
    // The board opened from another machine: links go to the host in the address bar.
    beforeEach(() => setURL('http://my-pc:4400/'));
    afterEach(() => setURL('http://localhost:3000/'));

    it('a port card is a link to this host', () => {
      const { container } = render(<Board />);
      const a = q<HTMLAnchorElement>(container, 'a.k-port');
      expect(a.getAttribute('href')).toBe('http://my-pc:5173/');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.hasAttribute('aria-disabled')).toBe(false);
      expect(a.textContent).toBe(':5173 viteOpen ↗');
      expect(q(a, '.go').textContent).toBe('Open ↗');
    });

    it('on the machine itself, a local-only port is a link too', () => {
      for (const [url, host] of [
        ['http://localhost:4400/', 'localhost'],
        ['http://127.0.0.1:4400/', '127.0.0.1'],
        ['http://[::1]:4400/', '[::1]'],
      ] as const) {
        setURL(url);
        withPorts([{ port: 5432, process: 'postgres', localOnly: true }]);
        const { container, unmount } = render(<Board />);
        expect(q(container, 'a.k-port').getAttribute('href')).toBe(`http://${host}:5432/`);
        expect(container.querySelector('.k-ssh')).toBeNull();
        unmount();
      }
    });

    it('a local-only card has no link and shows the ssh line', () => {
      withPorts([{ port: 5432, process: 'postgres', localOnly: true }]);
      const { container } = render(<Board />);
      expect(container.querySelector('a.k-port')).toBeNull();
      const card = q(container, '.k-port.local');
      expect(card.tagName).toBe('DIV');
      expect(card.textContent).toBe(':5432 postgresOnly on this machine');
      expect(container.querySelector('.k-port .go')).toBeNull();
      const ssh = q(container, '.k-ssh');
      expect(ssh.textContent).toBe('ssh -L 5432:localhost:5432 my-pc');
      expect(ssh.getAttribute('title')).toBe(
        'Run this on your laptop, then open http://localhost:5432',
      );
      for (const sel of ['\\.k-port \\.only', '\\.k-ssh']) {
        const rule = new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(board)?.[1];
        expect(rule, sel).toContain('var(--fg-3)');
      }
    });

    it('an IPv6 host is bracketed in the link and bare in the ssh line', () => {
      setURL('http://[fd7a:115c::1]:4400/');
      withPorts([
        { port: 5173, process: 'vite', localOnly: false },
        { port: 5432, process: 'postgres', localOnly: true },
      ]);
      const { container } = render(<Board />);
      expect(q(container, 'a.k-port').getAttribute('href')).toBe('http://[fd7a:115c::1]:5173/');
      expect(q(container, '.k-ssh').textContent).toBe('ssh -L 5432:localhost:5432 fd7a:115c::1');
    });

    it('shows the total of changed files and how many are not listed', () => {
      const files = Array.from({ length: 100 }, (_, i) => ({
        path: `src/f${i}.ts`,
        added: 1,
        removed: 0,
      }));
      reset(demoSessions(NOW).map((s) => (s.id === 'web' ? { ...s, files, filesTotal: 150 } : s)));
      const { container } = render(<Board />);
      expect(texts(container, '.k-aside .k-sec h4')[1]).toBe('Files changed · 150');
      expect(container.querySelectorAll('.k-file')).toHaveLength(100);
      expect(q(container, '.k-more').textContent).toBe('and 50 more');
      // View diff is wired now (Task 10): a real button, not inert.
      expect(q(container, '.k-diff').getAttribute('aria-disabled')).toBeNull();
    });

    it('lists no "more" row when every file is listed', () => {
      const { container } = render(<Board />);
      expect(container.querySelector('.k-more')).toBeNull();
    });
  });

  describe('the error line', () => {
    it('belongs to its session and clears when another session is selected', async () => {
      replies = [[409, CHANGED]];
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(errLine(container)).not.toBeNull());
      fireEvent.click(row(container, 'shop'));
      expect(actionError.value).toBeNull();
      expect(errLine(container)).toBeNull();
    });

    it('clears on the next action', async () => {
      replies = [[409, CHANGED]];
      const { container } = render(<Board />);
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(errLine(container)).not.toBeNull());
      const release = hold();
      fireEvent.click(optButtons(container)[0] as Element);
      await waitFor(() => expect(errLine(container)).toBeNull());
      release();
    });
  });
});

describe('finish controls (Task 9)', () => {
  const withSession = (patch: Partial<Session>, id = 'docs') =>
    reset(demoSessions(NOW).map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const errLine = (c: Element) => c.querySelector('.k-err');
  /** The raw requests the board sent: URL, method and body text. */
  const raw = () =>
    (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => [
      url,
      init.method,
      init.body,
    ]);

  describe('Archive', () => {
    it('a click posts {archived: true}; the removal shows the archived toast', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Archive'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/docs/archive', '1', { archived: true }]]);
      await waitFor(() => expect(busy.value.size).toBe(0));
      applyEvent({ type: 'archive', count: 1 });
      applyEvent({ type: 'session.removed', id: 'docs' });
      await Promise.resolve();
      const t = q(container, '.k-toast');
      expect(t.getAttribute('role')).toBe('status');
      expect(t.textContent).toBe('Archived docs · update README · worktree and branch kept');
      expect(q(t, 'b').textContent).toBe('docs · update README');
      expect(container.querySelector('.k-it[data-id="docs"]')).toBeNull();
    });

    it('E archives the selected done session too', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'rate'));
      fireEvent.keyDown(document, { key: 'e' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/rate/archive', '1', { archived: true }]]);
    });

    it('a running session has no Archive, and E does nothing', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      expect(container.textContent).not.toContain('Archive');
      fireEvent.keyDown(document, { key: 'e' });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a failure shows the error line and no toast', async () => {
      replies = [[409, 'This session is still running.']];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Archive'));
      await waitFor(() => expect(errLine(container)).not.toBeNull());
      expect(errLine(container)?.textContent).toBe(
        "Couldn't archive: This session is still running.",
      );
      expect(errLine(container)?.getAttribute('role')).toBe('alert');
      applyEvent({ type: 'session.removed', id: 'docs' });
      await Promise.resolve();
      expect(container.querySelector('.k-toast')).toBeNull();
    });
  });

  describe('the delete warning', () => {
    const confirmFor = (patch: Partial<Session>) => {
      withSession(patch);
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      return container;
    };

    it('adds the uncommitted sentence inside the same warning', () => {
      const c = confirmFor({ unpushed: 1, uncommitted: 3 });
      expect(texts(c, '.k-confirm .warn')).toEqual([
        '1 commit isn’t pushed and will be lost. 3 files have uncommitted changes and will be lost.',
      ]);
      expect(q(c, '.k-confirm div').textContent).not.toContain('nothing is lost');
    });

    it('says 1 file in the singular, with no unpushed sentence when all is pushed', () => {
      const c = confirmFor({ unpushed: 0, uncommitted: 1 });
      expect(texts(c, '.k-confirm .warn')).toEqual([
        '1 file has uncommitted changes and will be lost.',
      ]);
    });

    it('warns about ignored files whenever there are any (R75)', () => {
      const c = confirmFor({ unpushed: 2, uncommitted: 0, ignored: 4 });
      expect(texts(c, '.k-confirm .warn')).toEqual([
        '2 commits aren’t pushed and will be lost. 4 ignored files (like .env) will be deleted too.',
      ]);
      cleanup();
      const one = confirmFor({ unpushed: 0, uncommitted: 0, ignored: 1 });
      expect(texts(one, '.k-confirm .warn')).toEqual([
        '1 ignored file (like .env) will be deleted too.',
      ]);
      expect(q(one, '.k-confirm div').textContent).not.toContain('nothing is lost');
    });

    it('keeps the pushed sentence when nothing would be lost', () => {
      const c = confirmFor({ unpushed: 0, uncommitted: 0, ignored: 0 });
      expect(c.querySelector('.k-confirm .warn')).toBeNull();
      expect(q(c, '.k-confirm div').textContent).toBe(
        'Delete this session? This removes the tmux window, the worktree ~/projects/docs/.worktrees/readme and the branch docs/readme. Everything on the branch is pushed, so nothing is lost.',
      );
    });

    it('the counts shown follow the next session.updated', async () => {
      const c = confirmFor({ unpushed: 1, uncommitted: 0 });
      const docs = sessions.value.find((s) => s.id === 'docs') as Session;
      applyEvent({ type: 'session.updated', session: { ...docs, uncommitted: 2 } });
      await Promise.resolve();
      expect(texts(c, '.k-confirm .warn')).toEqual([
        '1 commit isn’t pushed and will be lost. 2 files have uncommitted changes and will be lost.',
      ]);
    });
  });

  describe('Delete session', () => {
    it('sends exactly the counts the confirmation showed', async () => {
      withSession({ unpushed: 1, uncommitted: 3 });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(raw()).toEqual([
        ['/api/sessions/docs', 'DELETE', '{"unpushed":1,"uncommitted":3,"ignored":0}'],
      ]);
    });

    it('a 409 keeps the confirmation open and shows the error line', async () => {
      const CHANGED = 'The branch changed since you looked. Check the warning again.';
      replies = [[409, CHANGED]];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(errLine(container)).not.toBeNull());
      expect(errLine(container)?.textContent).toBe(`Couldn't delete: ${CHANGED}`);
      expect(errLine(container)?.getAttribute('role')).toBe('alert');
      expect(container.querySelector('.k-confirm')).not.toBeNull();
      expect(button(container, 'Delete session').disabled).toBe(false);
      // The failed delete shows no toast if the session goes away for another reason.
      applyEvent({ type: 'session.removed', id: 'docs' });
      await Promise.resolve();
      expect(container.querySelector('.k-toast')).toBeNull();
    });

    it('the off-branch 409 sentence shows as given (R71)', async () => {
      const OFF =
        "This worktree isn't on its branch any more. Switch it back in the terminal, or remove it there.";
      replies = [[409, OFF]];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(errLine(container)?.textContent).toBe(`Couldn't delete: ${OFF}`));
    });

    it('a 204 and the removal show the delete toast', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(container.querySelector('.k-confirm')).toBeNull());
      applyEvent({ type: 'session.removed', id: 'docs' });
      await Promise.resolve();
      expect(q(container, '.k-toast').textContent).toBe(
        'Deleted docs · update README · worktree and branch removed',
      );
    });
  });

  describe('Resume', () => {
    it('a click and U post resume for an ended session Kage started', async () => {
      withSession({ status: 'ended' });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Resume'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(busy.value.size).toBe(0));
      fireEvent.keyDown(document, { key: 'u' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(posts()).toEqual([
        ['/api/sessions/docs/resume', '1', undefined],
        ['/api/sessions/docs/resume', '1', undefined],
      ]);
    });

    it('U does nothing for a done session', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.keyDown(document, { key: 'u' });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a failure shows the error line', async () => {
      withSession({ status: 'ended' });
      const GONE = 'The worktree is gone, so Kage can’t resume this session.';
      replies = [[409, GONE]];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Resume'));
      await waitFor(() => expect(errLine(container)?.textContent).toBe(`Couldn't resume: ${GONE}`));
    });

    it('a resume Claude could not find shows its line in the output (R63)', async () => {
      withSession({ status: 'ended' });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      const line = "Claude couldn't find this conversation, so the session wasn't resumed.";
      applyEvent({
        type: 'session.lines',
        id: 'docs',
        lines: [{ kind: 'out', text: line }],
        reset: false,
      });
      await Promise.resolve();
      expect(texts(container, '.k-tr .ln').at(-1)).toContain(line);
    });
  });

  describe('Pin', () => {
    it('S pins the selected session; the row shows the star once pinned', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.keyDown(document, { key: 's' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/docs/pin', '1', { pinned: true }]]);
      const docs = sessions.value.find((s) => s.id === 'docs') as Session;
      applyEvent({ type: 'session.updated', session: { ...docs, pinned: true } });
      await Promise.resolve();
      expect(q(row(container, 'docs'), '.k-name').textContent).toBe('★ docs / update README');
    });

    it('a failure shows the error line', async () => {
      replies = [[403, 'Kage only pins sessions it started.']];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.keyDown(document, { key: 's' });
      await waitFor(() =>
        expect(errLine(container)?.textContent).toBe(
          "Couldn't pin: Kage only pins sessions it started.",
        ),
      );
    });
  });

  describe('gating', () => {
    it('Archive, Delete… and Delete session are disabled while busy or disconnected', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      const downs = [
        () => {
          busy.value = new Set(['docs']);
        },
        () => {
          connection.value = 'reconnecting';
        },
      ];
      for (const down of downs) {
        down();
        await Promise.resolve();
        expect(button(container, 'Archive').disabled).toBe(true);
        expect(button(container, 'Delete…').disabled).toBe(true);
        expect(button(container, 'Delete session').disabled).toBe(true);
        fireEvent.click(button(container, 'Archive'));
        fireEvent.click(button(container, 'Delete session'));
        fireEvent.keyDown(document, { key: 'e' });
        busy.value = new Set();
        connection.value = 'live';
        await Promise.resolve();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Resume is disabled while busy or disconnected', async () => {
      withSession({ status: 'ended' });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      busy.value = new Set(['docs']);
      await Promise.resolve();
      expect(button(container, 'Resume').disabled).toBe(true);
      busy.value = new Set();
      connection.value = 'reconnecting';
      await Promise.resolve();
      expect(button(container, 'Resume').disabled).toBe(true);
      fireEvent.click(button(container, 'Resume'));
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a double click on Archive sends one request', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Archive'));
      fireEvent.click(button(container, 'Archive'));
      await waitFor(() => expect(busy.value.size).toBe(0));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('carried from Task 9 (R77)', () => {
  const withSession = (patch: Partial<Session>, id = 'docs') =>
    reset(demoSessions(NOW).map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const star = (c: Element) => c.querySelector<HTMLButtonElement>('.k-head .k-pin');
  const bodies = () =>
    (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => [
      url,
      init.method,
      init.body,
    ]);
  const docs = () => sessions.value.find((s) => s.id === 'docs') as Session;

  describe('the ★ pin toggle', () => {
    it('is a quiet toggle in the header: outlined, aria-pressed false; a click pins', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      const b = star(container) as HTMLButtonElement;
      expect(b.textContent).toBe('☆');
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.getAttribute('aria-label')).toBe('Pin');
      fireEvent.click(b);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/docs/pin', '1', { pinned: true }]]);
    });

    it('is filled and pressed when pinned; a click unpins', async () => {
      withSession({ pinned: true });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      const b = star(container) as HTMLButtonElement;
      expect(b.textContent).toBe('★');
      expect(b.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(b);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(posts()).toEqual([['/api/sessions/docs/pin', '1', { pinned: false }]]);
    });

    it('shows for record sessions only, in --fg-3, and is off while busy or disconnected', async () => {
      withSession({ external: true }, 'shop');
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'shop'));
      expect(star(container)).toBeNull();
      fireEvent.click(row(container, 'docs'));
      busy.value = new Set(['docs']);
      await Promise.resolve();
      expect(star(container)?.disabled).toBe(true);
      const rule = /\.k-pin \{([^}]*)\}/.exec(board)?.[1] ?? '';
      expect(rule).toContain('var(--fg-3)');
      // A 32 px hit target; the glyph and layout stay as they were (negative margins).
      expect(rule).toContain('width: 32px');
      expect(rule).toContain('height: 32px');
      expect(rule).toContain('font-size: 16px');
      expect(rule).not.toMatch(/--(amber|lime|red)/);
    });
  });

  describe('the delete 409 loop', () => {
    it('a 409 with new counts re-renders the warning, and the next click sends the new counts', async () => {
      const CHANGED = 'The branch changed since you looked. Check the warning again.';
      withSession({ unpushed: 1, uncommitted: 0 });
      replies = [[409, CHANGED]];
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(container.querySelector('.k-err')).not.toBeNull());
      await waitFor(() => expect(busy.value.size).toBe(0));
      // The server's fresh counts arrive as a session.updated.
      applyEvent({ type: 'session.updated', session: { ...docs(), unpushed: 2, uncommitted: 3 } });
      await Promise.resolve();
      expect(texts(container, '.k-confirm .warn')).toEqual([
        '2 commits aren’t pushed and will be lost. 3 files have uncommitted changes and will be lost.',
      ]);
      vi.mocked(Date.now).mockReturnValue(NOW + 500);
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(bodies()).toEqual([
        ['/api/sessions/docs', 'DELETE', '{"unpushed":1,"uncommitted":0,"ignored":0}'],
        ['/api/sessions/docs', 'DELETE', '{"unpushed":2,"uncommitted":3,"ignored":0}'],
      ]);
    });

    it('ignores a Delete session click within 400 ms of the counts changing', async () => {
      withSession({ unpushed: 1 });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      vi.mocked(Date.now).mockReturnValue(NOW + 10_000);
      applyEvent({ type: 'session.updated', session: { ...docs(), ignored: 4 } });
      await Promise.resolve();
      vi.mocked(Date.now).mockReturnValue(NOW + 10_399);
      fireEvent.click(button(container, 'Delete session'));
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.mocked(Date.now).mockReturnValue(NOW + 10_400);
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(bodies()[0]?.[2]).toBe('{"unpushed":1,"uncommitted":0,"ignored":4}');
    });

    it('Delete session looks off (aria-disabled) during the 400 ms hold, then on again', async () => {
      withSession({ unpushed: 1 });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      const del = () => button(container, 'Delete session');
      expect(del().getAttribute('aria-disabled')).toBeNull();
      vi.mocked(Date.now).mockReturnValue(NOW + 10_000);
      applyEvent({ type: 'session.updated', session: { ...docs(), uncommitted: 2 } });
      await Promise.resolve();
      expect(del().getAttribute('aria-disabled')).toBe('true');
      // Focusable while held: never the disabled attribute, which would drop focus.
      expect(del().disabled).toBe(false);
      vi.mocked(Date.now).mockReturnValue(NOW + 10_400);
      await waitFor(() => expect(del().getAttribute('aria-disabled')).toBeNull(), {
        timeout: 2000,
      });
      expect(board).toMatch(/\.k-confirm \.k-act\[aria-disabled="true"\][^{]*\{[^}]*opacity/);
    });

    it('the hold still ends when its timer fires a moment early by the clock', async () => {
      // Seen in the e2e: Chrome's timers can fire a millisecond early by Date.now() (and the
      // clock can step), so one timer that re-checks Date.now() could leave the button off.
      withSession({ unpushed: 1 });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      const del = () => button(container, 'Delete session');
      vi.mocked(Date.now).mockReturnValue(NOW + 10_000);
      applyEvent({ type: 'session.updated', session: { ...docs(), uncommitted: 2 } });
      await Promise.resolve();
      expect(del().getAttribute('aria-disabled')).toBe('true');
      // The 400 ms timer fires while the clock still reads 399 ms later: still held.
      vi.mocked(Date.now).mockReturnValue(NOW + 10_399);
      await new Promise((r) => setTimeout(r, 600));
      expect(del().getAttribute('aria-disabled')).toBe('true');
      vi.mocked(Date.now).mockReturnValue(NOW + 10_400);
      await waitFor(() => expect(del().getAttribute('aria-disabled')).toBeNull(), {
        timeout: 2000,
      });
    });

    it('a click right after opening the confirmation is not held back', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });
  });

  describe('focus', () => {
    it('Cancel returns focus to Delete…', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      button(container, 'Cancel').focus();
      fireEvent.click(button(container, 'Cancel'));
      await waitFor(() => expect(container.querySelector('.k-confirm')).toBeNull());
      expect(document.activeElement).toBe(button(container, 'Delete…'));
    });

    it('Esc returns focus to Delete…', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      button(container, 'Delete session').focus();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(container.querySelector('.k-confirm')).toBeNull());
      expect(document.activeElement).toBe(button(container, 'Delete…'));
    });

    it('Esc with no confirmation open leaves focus alone', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      row(container, 'docs').focus();
      fireEvent.keyDown(document, { key: 'Escape' });
      await Promise.resolve();
      expect(document.activeElement).toBe(row(container, 'docs'));
    });

    it('after a delete succeeds, focus goes to the selected list row', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(button(container, 'Delete…'));
      button(container, 'Delete session').focus();
      fireEvent.click(button(container, 'Delete session'));
      await waitFor(() => expect(container.querySelector('.k-confirm')).toBeNull());
      applyEvent({ type: 'session.removed', id: 'docs' });
      await waitFor(() => expect(document.activeElement?.classList.contains('on')).toBe(true));
      expect(document.activeElement).toBe(row(container, selectedId.value as string));
    });

    it('after an archive succeeds, focus goes to the selected list row', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      button(container, 'Archive').focus();
      fireEvent.click(button(container, 'Archive'));
      await waitFor(() => expect(busy.value.size).toBe(0));
      applyEvent({ type: 'session.removed', id: 'docs' });
      await waitFor(() => expect(document.activeElement?.classList.contains('on')).toBe(true));
    });

    it('a removal nobody here asked for does not move focus', async () => {
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      button(container, 'Archive').focus();
      applyEvent({ type: 'session.removed', id: 'shop' });
      await Promise.resolve();
      await Promise.resolve();
      expect(document.activeElement).toBe(button(container, 'Archive'));
    });
  });
});

describe('delete before the counts are known (fix wave)', () => {
  beforeEach(() => {
    autoCounts = false;
  });
  const files = (id: string) => {
    const s = sessions.value.find((x) => x.id === id) as Session;
    applyEvent({ type: 'session.files', id, files: s.files, filesTotal: s.filesTotal });
  };

  it('says "Checking the branch…" and keeps Delete session off until the view brings counts', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'footer'));
    fireEvent.click(button(container, 'Delete…'));
    const text = () => q(container, '.k-confirm div').textContent ?? '';
    expect(text()).toContain('Checking the branch…');
    expect(text()).not.toContain('nothing is lost');
    expect(button(container, 'Delete session').disabled).toBe(true);
    files('footer');
    await Promise.resolve();
    expect(text()).toContain('Everything on the branch is pushed, so nothing is lost.');
    expect(text()).not.toContain('Checking the branch…');
    expect(button(container, 'Delete session').disabled).toBe(false);
  });

  it('a counts change (a publish) makes them known too; selecting again forgets them', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    expect(button(container, 'Delete session').disabled).toBe(true);
    const docs = sessions.value.find((s) => s.id === 'docs') as Session;
    applyEvent({ type: 'session.updated', session: { ...docs, uncommitted: 2 } });
    await Promise.resolve();
    expect(button(container, 'Delete session').disabled).toBe(false);
    // Files for another session say nothing about this one.
    fireEvent.click(row(container, 'footer'));
    files('docs');
    fireEvent.click(button(container, 'Delete…'));
    expect(button(container, 'Delete session').disabled).toBe(true);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(button(container, 'Delete…'));
    expect(button(container, 'Delete session').disabled).toBe(true);
  });
});
