import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ArchivedSession, demoSessions, type Session } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../main.tsx';
import {
  actionError,
  applyEvent,
  archiveOpen,
  busy,
  connection,
  now,
  selectedId,
  sessions,
  toast,
} from '../store.ts';
import { archivedChunk } from './Archived.tsx';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const HOUR = 3_600_000;
const board = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');

const ARCHIVED: ArchivedSession[] = [
  { id: 'old', project: 'api', task: 'cache headers', branch: 'api/cache', archivedAt: NOW - HOUR },
  {
    id: 'older',
    project: 'web',
    task: 'drop jquery',
    branch: 'web/jq',
    archivedAt: NOW - 3 * 24 * HOUR,
  },
];

/** GET /api/archive answers this (a list or a status with an error); every POST answers `post`. */
let archive: ArchivedSession[] | [number, string];
let post: [number, string?];
let fetchMock: ReturnType<typeof vi.fn>;
const gets = () =>
  (fetchMock.mock.calls as [string, RequestInit][]).filter(([, i]) => i.method === 'GET');
const posts = () =>
  (fetchMock.mock.calls as [string, RequestInit][])
    .filter(([, i]) => i.method === 'POST')
    .map(([url, i]) => [url, JSON.parse(String(i.body))]);

function snapshot(count: number) {
  applyEvent({
    type: 'snapshot',
    auth: false,
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived: count,
    sessions: demoSessions(NOW),
  });
}

const toggle = (c: Element) => c.querySelector<HTMLButtonElement>('.k-arch > button');
const rows = (c: Element) => [...c.querySelectorAll('.k-arc')];

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  now.value = NOW;
  archive = ARCHIVED;
  post = [204];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'GET' && url === '/api/archive') {
      if (typeof archive[0] !== 'number') {
        return new Response(JSON.stringify({ sessions: archive }), { status: 200 });
      }
      const [status, error] = archive as [number, string];
      return new Response(JSON.stringify({ error }), { status });
    }
    const [status, error] = post;
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify({ error }), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  sessions.value = [];
  selectedId.value = null;
  busy.value = new Set();
  actionError.value = null;
  toast.value = null;
  archiveOpen.value = false;
  connection.value = 'live';
  snapshot(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the archived list', () => {
  it('is absent while nothing is archived', () => {
    const { container } = render(<Board />);
    expect(toggle(container)).toBeNull();
    expect(container.textContent).not.toContain('archived');
  });

  it('shows "archived N" at the bottom of the left column, closed', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    const t = toggle(container) as HTMLButtonElement;
    expect(t.textContent).toBe('archived 2');
    expect(t.classList.contains('k-g')).toBe(true);
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.closest('.k-side')).not.toBeNull();
    expect(t.parentElement?.nextElementSibling).toBeNull();
    expect(gets()).toHaveLength(0);
    applyEvent({ type: 'archive', count: 3 });
    await Promise.resolve();
    expect(toggle(container)?.textContent).toBe('archived 3');
  });

  // The first test in this file to open the list (the chunk stays loaded after it).
  it('the list is a lazy chunk, loaded on the first open (performance P6)', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    expect(archivedChunk.loaded()).toBeNull();
    fireEvent.click(toggle(container) as HTMLButtonElement);
    // Its box is there at once, empty, as the list shows before its first answer.
    const id = toggle(container)?.getAttribute('aria-controls') as string;
    expect(container.querySelector(`#${id}`)).not.toBeNull();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(archivedChunk.loaded()).not.toBeNull();
    expect(rows(container)[0]?.parentElement?.id).toBe(id);
  });

  it('opening it fetches once and lists the rows like done rows, with Restore', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    expect(toggle(container)?.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(gets()).toHaveLength(1);
    const [first, second] = rows(container) as [Element, Element];
    expect(first.querySelector('.pj')?.textContent).toBe('api /');
    expect(first.querySelector('.k-name')?.textContent).toBe('api / cache headers');
    expect(first.querySelector('.tm')?.textContent).toBe('1h');
    expect(second.querySelector('.tm')?.textContent).toBe('3d');
    const restore = first.querySelector('button') as HTMLButtonElement;
    expect(restore.textContent).toBe('Restore');
    expect(restore.getAttribute('aria-label')).toBe('Restore api / cache headers');
    // Closing hides the rows without another request.
    fireEvent.click(toggle(container) as HTMLButtonElement);
    expect(rows(container)).toHaveLength(0);
    expect(gets()).toHaveLength(1);
  });

  it('Restore posts {archived: false} and selects the session once it arrives', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]?.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()).toEqual([['/api/sessions/old/archive', { archived: false }]]);
    await waitFor(() => expect(busy.value.size).toBe(0));
    expect(selectedId.value).toBe('web');
    const restored: Session = {
      ...(demoSessions(NOW)[5] as Session),
      id: 'old',
      project: 'api',
      task: 'cache headers',
    };
    applyEvent({ type: 'session.updated', session: restored });
    expect(selectedId.value).toBe('old');
  });

  it('refetches when the count changes while open, and not while closed', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    applyEvent({ type: 'archive', count: 3 });
    await Promise.resolve();
    expect(gets()).toHaveLength(0);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(gets()).toHaveLength(1));
    archive = ARCHIVED.slice(1);
    applyEvent({ type: 'archive', count: 1 });
    await waitFor(() => expect(rows(container)).toHaveLength(1));
    expect(gets()).toHaveLength(2);
  });

  it('closes when the count drops to 0', async () => {
    snapshot(1);
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(gets()).toHaveLength(1));
    applyEvent({ type: 'archive', count: 0 });
    await Promise.resolve();
    expect(toggle(container)).toBeNull();
    expect(archiveOpen.value).toBe(false);
  });

  it('a fetch error shows one line in the secondary text colour', async () => {
    snapshot(2);
    archive = [500, 'Kage couldn’t read its state.'];
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    const line = await waitFor(() => {
      const el = container.querySelector('.k-arch .k-err');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(line.textContent).toBe("Couldn't load the archive. Kage couldn’t read its state.");
    expect(line.getAttribute('role')).toBe('alert');
    const rule = /\.k-err\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
    expect(rule).toContain('var(--fg-2)');
  });

  it('a restore failure shows under the list', async () => {
    snapshot(2);
    post = [409, 'The screen is still drawing. Try again in a moment.'];
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[1]?.querySelector('button') as HTMLButtonElement);
    await waitFor(() =>
      expect(container.querySelector('.k-arch .k-err')?.textContent).toBe(
        "Couldn't restore. The screen is still drawing. Try again in a moment.",
      ),
    );
    expect(container.querySelector('.k-arch .k-err')?.getAttribute('role')).toBe('alert');
  });

  it('closing the list clears its restore error, so it is gone when it opens again (R77)', async () => {
    snapshot(2);
    post = [409, 'The screen is still drawing. Try again in a moment.'];
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[1]?.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(actionError.value?.id).toBe('older'));
    fireEvent.click(toggle(container) as HTMLButtonElement);
    expect(actionError.value).toBeNull();
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(container.querySelector('.k-arch .k-err')).toBeNull();
  });

  it('closing the list keeps an error that belongs to a listed session', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    actionError.value = { id: 'docs', text: "Couldn't archive. No." };
    fireEvent.click(toggle(container) as HTMLButtonElement);
    expect(actionError.value).toEqual({ id: 'docs', text: "Couldn't archive. No." });
  });

  it('Restore is disabled while disconnected or busy, and a double click sends one request', async () => {
    snapshot(2);
    const { container } = render(<Board />);
    fireEvent.click(toggle(container) as HTMLButtonElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    const restore = () => rows(container)[0]?.querySelector('button') as HTMLButtonElement;
    connection.value = 'reconnecting';
    await Promise.resolve();
    expect(restore().disabled).toBe(true);
    connection.value = 'live';
    busy.value = new Set(['old']);
    await Promise.resolve();
    expect(restore().disabled).toBe(true);
    busy.value = new Set();
    await Promise.resolve();
    fireEvent.click(restore());
    fireEvent.click(restore());
    await waitFor(() => expect(busy.value.size).toBe(0));
    expect(posts()).toHaveLength(1);
  });

  it('the Restore link is quiet, lime only on hover', () => {
    const rule = /\.k-restore\s*\{([^}]*)\}/.exec(board)?.[1] ?? '';
    expect(rule).toContain('var(--fg-3)');
    expect(rule).not.toMatch(/--(amber|lime|red)/);
    expect(board).toMatch(/\.k-restore:hover[^{]*\{[^}]*var\(--lime\)/);
  });
});

describe('the archived list chunk', () => {
  it('a chunk that still fails after the reload says how to retry, and closing and opening tries again', async () => {
    let fail = true;
    vi.doMock('./ArchivedList.tsx', async (importOriginal) => {
      if (fail) throw new Error('404');
      return importOriginal();
    });
    sessionStorage.setItem('kage-reloaded:archived', '1');
    try {
      vi.resetModules();
      const { Board: FreshBoard } = await import('../main.tsx');
      const store = await import('../store.ts');
      store.applyEvent({
        type: 'snapshot',
        auth: false,
        host: 'my-pc',
        streamId: 's',
        projectsRoot: '/p',
        archived: 2,
        sessions: demoSessions(NOW),
      });
      const { container } = render(<FreshBoard />);
      fireEvent.click(toggle(container) as HTMLButtonElement);
      await waitFor(() =>
        expect(container.querySelector('.k-arc-err')?.textContent).toBe(
          "Couldn't load the archive. Close and open it again.",
        ),
      );
      fail = false;
      fireEvent.click(toggle(container) as HTMLButtonElement);
      fireEvent.click(toggle(container) as HTMLButtonElement);
      await waitFor(() => expect(rows(container)).toHaveLength(2));
      expect(container.querySelector('.k-arc-err')).toBeNull();
    } finally {
      sessionStorage.clear();
      vi.doUnmock('./ArchivedList.tsx');
    }
  });
});
