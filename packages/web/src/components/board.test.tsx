import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoSessions, type Session } from '@kage/shared';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDelete, apiPost } from '../api.ts';
import { Board } from '../main.tsx';
import {
  applyEvent,
  confirmingDelete,
  connection,
  host,
  now,
  selectedId,
  sessions,
  toast,
} from '../store.ts';

vi.mock('../api.ts', () => ({
  apiDelete: vi.fn(async () => new Response(null, { status: 204 })),
  apiPost: vi.fn(async () => new Response(null, { status: 204 })),
}));

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const LATER = 'Available in a later version';
const board = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');

function reset(list: Session[] = demoSessions(NOW)) {
  host.value = '';
  sessions.value = [];
  selectedId.value = null;
  confirmingDelete.value = false;
  toast.value = null;
  connection.value = 'live';
  now.value = NOW;
  applyEvent({ type: 'snapshot', host: 'my-pc', sessions: list });
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
const expectInert = (el: Element) => {
  expect(el.getAttribute('aria-disabled')).toBe('true');
  expect(el.getAttribute('title')).toBe(LATER);
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.mocked(apiDelete).mockClear();
  vi.mocked(apiPost).mockClear();
  reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it('shows the question with inert answer buttons', () => {
    const { container } = render(<Board />);
    const ask = q(container, '.k-ask');
    expect(q(ask, '.k-q small').textContent).toBe('Waiting for you');
    expect(q(ask, '.k-q').textContent).toBe('Waiting for youWhich approach should I use?');
    const opts = [...ask.querySelectorAll('.k-opts button')];
    expect(opts.map((b) => [b.querySelector('kbd')?.textContent, b.textContent])).toEqual([
      ['1', '1CSS variables'],
      ['2', '2Tailwind'],
    ]);
    for (const b of opts) expectInert(b);
    expect(q(ask, '.k-or').textContent).toBe('or press R to reply');
    fireEvent.click(opts[0] as Element);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows Terminal and Stop in the footer, inert, and no Archive', () => {
    const { container } = render(<Board />);
    const [term, stop, ...rest] = footButtons(container);
    expect(rest).toEqual([]);
    expect(term?.closest('.l')).not.toBeNull();
    expect(term?.textContent).toBe('TerminalT');
    expect(term?.querySelector('kbd')?.textContent).toBe('T');
    expect(stop?.closest('.r')).not.toBeNull();
    expect(stop?.textContent).toBe('StopX');
    expect(stop?.classList.contains('stop')).toBe(true);
    expectInert(term as Element);
    expectInert(stop as Element);
    expect(container.textContent).not.toContain('Archive');
    fireEvent.click(stop as Element);
    expect(apiPost).not.toHaveBeenCalled();
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
    expect(follow.textContent).toBe('Follow up in this session…R');
    expectInert(follow);
    const [term, archive, del, ...rest] = footButtons(container);
    expect(rest).toEqual([]);
    expect(term?.textContent).toBe('TerminalT');
    expect(archive?.textContent).toBe('ArchiveE');
    expectInert(archive as Element);
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
    expect(apiDelete).toHaveBeenCalledWith('/api/sessions/docs');
    await Promise.resolve();
    applyEvent({ type: 'session.removed', id: 'docs' });
    await Promise.resolve();
    expect(toast.value).toBe('docs · update README');
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
    toast.value = 'docs · update README';
    fireEvent.click(row(container, 'shop'));
    expect(container.querySelector('.k-toast')).toBeNull();
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
