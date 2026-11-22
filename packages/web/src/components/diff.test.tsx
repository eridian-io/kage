import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DiffPage, demoSessions, LIMITS, type Session } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../main.tsx';
import {
  actionError,
  applyEvent,
  authRequired,
  busy,
  confirmingDelete,
  connection,
  hadSnapshot,
  linesById,
  mainView,
  now,
  releaseDigits,
  replyOpen,
  select,
  selectedId,
  sessions,
  stopArmed,
  toast,
} from '../store.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const board = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');

const PAGE: DiffPage = {
  base: 'main',
  branch: 'docs/readme',
  from: 0,
  next: null,
  filesTotal: 5,
  files: [
    {
      path: 'README.md',
      kind: 'modified',
      added: 2,
      removed: 1,
      lines: [
        ['hunk', '@@ -1,3 +1,4 @@ # docs'],
        ['ctx', 'Kage'],
        ['del', 'old line'],
        ['add', 'new line'],
        ['add', '<b>not html</b>'],
      ],
      clipped: 0,
    },
    {
      path: 'docs/new.md',
      oldPath: 'docs/old.md',
      kind: 'renamed',
      added: 0,
      removed: 0,
      lines: [],
      clipped: 0,
    },
    { path: 'logo.png', kind: 'binary', added: 0, removed: 0, lines: [], clipped: 0 },
    { path: 'current', kind: 'link', added: 0, removed: 0, lines: [], clipped: 0 },
    { path: 'big.txt', kind: 'modified', added: 1500, removed: 0, lines: [], clipped: 1500 },
  ],
};

/** What GET …/diff?from=N answers: a page, or [status, error]. */
let pages: Map<number, DiffPage | [number, string]>;
let fetchMock: ReturnType<typeof vi.fn>;
const diffGets = () =>
  (fetchMock.mock.calls as [string, RequestInit][])
    .filter(([url]) => url.includes('/diff'))
    .map(([url]) => url);

function reset(list: Session[] = demoSessions(NOW)) {
  hadSnapshot.value = false;
  authRequired.value = false;
  busy.value = new Set();
  actionError.value = null;
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
  applyEvent({
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived: 0,
    sessions: list,
  });
}

const q = (c: Element, sel: string) => {
  const el = c.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  return el;
};
const texts = (c: Element, sel: string) =>
  [...c.querySelectorAll(sel)].map((e) => e.textContent ?? '');
const row = (c: Element, id: string) => q(c, `.k-it[data-id="${id}"]`);
const button = (c: Element, label: string) => {
  const b = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => (x.textContent ?? '').replace(x.querySelector('kbd')?.textContent ?? '', '') === label,
  );
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const viewDiff = (c: Element) => q(c, '.k-diff');

/** Renders the board on docs and opens its diff; resolves once the first page shows. */
async function openDiff(id = 'docs') {
  const r = render(<Board />);
  fireEvent.click(row(r.container, id));
  fireEvent.click(viewDiff(r.container));
  await waitFor(() =>
    expect(r.container.querySelector('.k-diff-file, .k-dv .k-err')).not.toBeNull(),
  );
  return r.container;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  pages = new Map([[0, PAGE]]);
  fetchMock = vi.fn(async (url: string) => {
    const m = /\/diff\?from=(\d+)$/.exec(url);
    if (m) {
      const p = pages.get(Number(m[1]));
      if (p === undefined)
        return new Response(JSON.stringify({ error: 'no page' }), { status: 500 });
      if (Array.isArray(p)) return new Response(JSON.stringify({ error: p[1] }), { status: p[0] });
      return new Response(JSON.stringify(p), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the diff view', () => {
  it('View diff → is a real button now, and opens the diff in place of the output', async () => {
    const c = await openDiff();
    expect(viewDiff(c).tagName).toBe('BUTTON');
    expect(viewDiff(c).getAttribute('aria-disabled')).toBeNull();
    expect(viewDiff(c).getAttribute('aria-expanded')).toBe('true');
    expect(mainView.value).toBe('diff');
    expect(c.querySelector('.k-tr')).toBeNull();
    expect(c.querySelector('.k-follow')).toBeNull();
    expect(diffGets()).toEqual(['/api/sessions/docs/diff?from=0']);
  });

  it('fetches only on open: nothing before, once after', async () => {
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    await Promise.resolve();
    expect(diffGets()).toEqual([]);
    fireEvent.click(viewDiff(container));
    await waitFor(() => expect(container.querySelector('.k-diff-file')).not.toBeNull());
    // Re-renders from session events don't refetch.
    const docs = sessions.value.find((s) => s.id === 'docs') as Session;
    applyEvent({ type: 'session.updated', session: { ...docs, statusSince: NOW - 1000 } });
    await Promise.resolve();
    expect(diffGets()).toHaveLength(1);
  });

  it('is a labelled region with a heading per file', async () => {
    const c = await openDiff();
    const region = q(c, '.k-dv');
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('aria-label')).toBe('Diff');
    expect(texts(c, '.k-dv h4')).toEqual([
      'README.md+2−1',
      'docs/old.md → docs/new.md+0−0',
      'logo.png+0−0',
      'current+0−0',
      'big.txt+1500−0',
    ]);
  });

  it('shows the branch against its base, or the branch alone', async () => {
    const c = await openDiff();
    expect(q(c, '.k-diff-ref').textContent).toBe('docs/readme against main');
    cleanup();
    pages.set(0, { ...PAGE, base: null });
    const c2 = await openDiff();
    expect(q(c2, '.k-diff-ref').textContent).toBe('docs/readme');
  });

  it('an external session (no branch) names its folder', async () => {
    pages.set(0, { ...PAGE, base: null, branch: '' });
    reset(demoSessions(NOW).map((s) => (s.id === 'docs' ? { ...s, external: true } : s)));
    const c = await openDiff();
    // The short folder, as the meta line shows it.
    expect(q(c, '.k-diff-ref').textContent).toBe('docs/.worktrees/readme');
  });

  it('renders the lines with their kinds and gutters, as text only', async () => {
    const c = await openDiff();
    const lines = [...c.querySelectorAll('.k-diff-file')][0]?.querySelectorAll('.k-dl') ?? [];
    expect([...lines].map((l) => l.className)).toEqual([
      'k-dl hunk',
      'k-dl ctx',
      'k-dl del',
      'k-dl add',
      'k-dl add',
    ]);
    expect([...lines].map((l) => l.textContent)).toEqual([
      '@@ -1,3 +1,4 @@ # docs',
      ' Kage',
      '−old line',
      '+new line',
      '+<b>not html</b>',
    ]);
    expect(lines[3]?.querySelector('.g')?.textContent).toBe('+');
    expect(c.querySelector('.k-dv b')).toBeNull();
  });

  it('summarises binary files and links, and says how many lines were left out', async () => {
    const c = await openDiff();
    expect(texts(c, '.k-diff-note')).toEqual([
      'Binary file, not shown.',
      'Symbolic link, not shown.',
      "1500 more lines in this file aren't shown.",
    ]);
  });

  it('a clipped file keeps the lines it has, then the clipped sentence', async () => {
    pages.set(0, {
      ...PAGE,
      filesTotal: 1,
      files: [
        {
          path: 'a.ts',
          kind: 'modified',
          added: 3,
          removed: 0,
          lines: [
            ['hunk', '@@ -0,0 +1,3 @@'],
            ['add', 'x'],
          ],
          clipped: 1,
        },
      ],
    });
    const c = await openDiff();
    expect(texts(c, '.k-dl')).toEqual(['@@ -0,0 +1,3 @@', '+x']);
    expect(texts(c, '.k-diff-note')).toEqual(["1 more line in this file isn't shown."]);
  });

  it('says No changes yet. when nothing changed', async () => {
    pages.set(0, { ...PAGE, filesTotal: 0, files: [] });
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(viewDiff(container));
    await waitFor(() =>
      expect(container.querySelector('.k-diff-msg')?.textContent).toBe('No changes yet.'),
    );
    expect(container.querySelector('.k-diff-pages')).toBeNull();
  });

  it('says Loading the diff… until the page arrives', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const { container } = render(<Board />);
    fireEvent.click(row(container, 'docs'));
    fireEvent.click(viewDiff(container));
    await waitFor(() =>
      expect(container.querySelector('.k-diff-msg')?.textContent).toBe('Loading the diff…'),
    );
    release(new Response(JSON.stringify(PAGE), { status: 200 }));
    await waitFor(() => expect(container.querySelector('.k-diff-file')).not.toBeNull());
    expect(container.querySelector('.k-diff-msg')).toBeNull();
  });

  it('an error shows the error line, announced', async () => {
    for (const [status, error] of [
      [429, 'Kage is still working on the last diff.'],
      [404, 'No session with id docs'],
      [422, "git couldn't show the diff: the folder is gone."],
      [501, "Demo mode can't show diffs."],
    ] as const) {
      pages.set(0, [status, error]);
      const c = await openDiff();
      const err = q(c, '.k-dv .k-err');
      expect(err.textContent).toBe(`Couldn't load the diff: ${error}`);
      expect(err.getAttribute('role')).toBe('alert');
      cleanup();
    }
  });

  it('a network failure shows Kage didn’t answer', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    const c = await openDiff();
    expect(q(c, '.k-dv .k-err').textContent).toBe("Couldn't load the diff: Kage didn't answer.");
  });

  describe('paging', () => {
    const file = (i: number) => ({
      path: `f${i}.ts`,
      kind: 'modified' as const,
      added: 2,
      removed: 0,
      lines: [
        ['hunk', '@@ -0,0 +1,2 @@'],
        ['add', `a${i}`],
        ['add', `b${i}`],
      ] as DiffPage['files'][number]['lines'],
      clipped: 0,
    });
    beforeEach(() => {
      pages = new Map([
        [0, { ...PAGE, filesTotal: 5, next: 2, files: [file(0), file(1)] }],
        [2, { ...PAGE, from: 2, filesTotal: 5, next: 4, files: [file(2), file(3)] }],
        [4, { ...PAGE, from: 4, filesTotal: 5, next: null, files: [file(4)] }],
      ]);
    });

    it('Next → fetches from=next; ← Previous goes back and refetches', async () => {
      const c = await openDiff();
      expect(q(c, '.k-diff-count').textContent).toBe('Files 1–2 of 5');
      expect(button(c, '← Previous').disabled).toBe(true);
      fireEvent.click(button(c, 'Next →'));
      await waitFor(() => expect(q(c, '.k-diff-count').textContent).toBe('Files 3–4 of 5'));
      expect(texts(c, '.k-dv h4')).toEqual(['f2.ts+2−0', 'f3.ts+2−0']);
      fireEvent.click(button(c, 'Next →'));
      await waitFor(() => expect(q(c, '.k-diff-count').textContent).toBe('Files 5–5 of 5'));
      expect(button(c, 'Next →').disabled).toBe(true);
      fireEvent.click(button(c, '← Previous'));
      await waitFor(() => expect(q(c, '.k-diff-count').textContent).toBe('Files 3–4 of 5'));
      fireEvent.click(button(c, '← Previous'));
      await waitFor(() => expect(q(c, '.k-diff-count').textContent).toBe('Files 1–2 of 5'));
      expect(diffGets()).toEqual([
        '/api/sessions/docs/diff?from=0',
        '/api/sessions/docs/diff?from=2',
        '/api/sessions/docs/diff?from=4',
        '/api/sessions/docs/diff?from=2',
        '/api/sessions/docs/diff?from=0',
      ]);
    });

    it('keeps exactly one page in the DOM', async () => {
      const c = await openDiff();
      expect(c.querySelectorAll('.k-diff-file')).toHaveLength(2);
      fireEvent.click(button(c, 'Next →'));
      await waitFor(() => expect(texts(c, '.k-dv h4')[0]).toBe('f2.ts+2−0'));
      expect(c.querySelectorAll('.k-diff-file')).toHaveLength(2);
      expect(texts(c, '.k-dl.add')).toEqual(['+a2', '+b2', '+a3', '+b3']);
    });

    it('a full page renders at most LIMITS.diffLines lines', async () => {
      const lines = Array.from(
        { length: LIMITS.diffLines },
        (_, i) => ['add', `l${i}`] as ['add', string],
      );
      pages.set(0, {
        ...PAGE,
        filesTotal: 1,
        next: null,
        files: [{ path: 'x', kind: 'added', added: 1000, removed: 0, lines, clipped: 0 }],
      });
      const c = await openDiff();
      expect(c.querySelectorAll('.k-dl')).toHaveLength(LIMITS.diffLines);
    });

    it('the page buttons are off while a page loads', async () => {
      const c = await openDiff();
      let release: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      );
      fireEvent.click(button(c, 'Next →'));
      await waitFor(() =>
        expect(c.querySelector('.k-diff-msg')?.textContent).toBe('Loading the diff…'),
      );
      expect(c.querySelectorAll('.k-diff-file')).toHaveLength(0);
      expect(button(c, 'Next →').disabled).toBe(true);
      expect(button(c, '← Previous').disabled).toBe(true);
      release(new Response(JSON.stringify(pages.get(2)), { status: 200 }));
      await waitFor(() => expect(q(c, '.k-diff-count').textContent).toBe('Files 3–4 of 5'));
    });
  });

  describe('closing', () => {
    it('the footer shows Back to session with Esc, and the session actions stay', async () => {
      const c = await openDiff();
      expect(texts(c, '.k-foot .l button')).toEqual(['Back to sessionEsc']);
      expect(texts(c, '.k-foot .r button')).toEqual(['ArchiveE', 'Delete…']);
    });

    it('Back returns to the output and puts focus on View diff →', async () => {
      const c = await openDiff();
      fireEvent.click(button(c, 'Back to session'));
      await waitFor(() => expect(c.querySelector('.k-tr')).not.toBeNull());
      expect(mainView.value).toBe('output');
      expect(c.querySelector('.k-dv')).toBeNull();
      expect(document.activeElement).toBe(viewDiff(c));
      expect(texts(c, '.k-foot .l button')).toEqual(['TerminalT']);
    });

    it('Esc returns to the output; the session stays selected', async () => {
      const c = await openDiff();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(c.querySelector('.k-tr')).not.toBeNull());
      expect(selectedId.value).toBe('docs');
      expect(mainView.value).toBe('output');
    });

    it('Esc while typing does not close the diff', async () => {
      const c = await openDiff();
      const input = document.createElement('input');
      document.body.append(input);
      fireEvent.keyDown(input, { key: 'Escape' });
      await Promise.resolve();
      expect(c.querySelector('.k-dv')).not.toBeNull();
      input.remove();
    });

    it('selecting another session resets the view to the output and aborts the fetch', async () => {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const { container } = render(<Board />);
      fireEvent.click(row(container, 'docs'));
      fireEvent.click(viewDiff(container));
      await waitFor(() => expect(signal).toBeDefined());
      fireEvent.click(row(container, 'web'));
      await waitFor(() => expect(container.querySelector('.k-dv')).toBeNull());
      expect(mainView.value).toBe('output');
      expect(signal?.aborted).toBe(true);
    });

    it('J/K move through the list when the diff is not focused, and reset the view', async () => {
      const c = await openDiff();
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document, { key: 'k' });
      await waitFor(() => expect(c.querySelector('.k-dv')).toBeNull());
      expect(selectedId.value).not.toBe('docs');
      expect(mainView.value).toBe('output');
    });

    it('J/K inside the focused diff stay in the diff (they move between files)', async () => {
      const c = await openDiff();
      const body = q(c, '.k-diff-body');
      expect(document.activeElement).toBe(body);
      fireEvent.keyDown(body, { key: 'j' });
      fireEvent.keyDown(body, { key: 'k' });
      await Promise.resolve();
      expect(selectedId.value).toBe('docs');
      expect(c.querySelector('.k-dv')).not.toBeNull();
    });

    it('an automatic re-selection (the session went away) resets the view', async () => {
      await openDiff();
      applyEvent({ type: 'session.removed', id: 'docs' });
      expect(mainView.value).toBe('output');
    });

    it('select() of the same session also resets the view', async () => {
      await openDiff();
      select('docs');
      expect(mainView.value).toBe('output');
    });
  });

  describe('keys while the diff is open', () => {
    it('digits do not answer a question the diff hides', async () => {
      const c = await openDiff('web');
      fetchMock.mockClear();
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document, { key: '1' });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(c.querySelector('.k-dv')).not.toBeNull();
    });

    it('Delete… leaves the diff and shows the confirmation', async () => {
      const c = await openDiff();
      fireEvent.click(button(c, 'Delete…'));
      await waitFor(() => expect(c.querySelector('.k-confirm')).not.toBeNull());
      expect(c.querySelector('.k-dv')).toBeNull();
    });

    it('R leaves the diff for the follow-up field', async () => {
      const c = await openDiff();
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document, { key: 'r' });
      await waitFor(() => expect(c.querySelector('.k-follow input')).not.toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(q(c, '.k-follow input')));
    });
  });

  describe('the files changed', () => {
    it('a session.files event shows the reload link, which refetches the current page', async () => {
      pages.set(0, { ...PAGE, next: 5 });
      pages.set(5, {
        ...PAGE,
        from: 5,
        filesTotal: 6,
        next: null,
        files: [PAGE.files[0] as never],
      });
      const c = await openDiff();
      fireEvent.click(button(c, 'Next →'));
      await waitFor(() => expect(diffGets()).toHaveLength(2));
      await waitFor(() => expect(c.querySelector('.k-diff-msg')).toBeNull());
      expect(c.querySelector('.k-diff-stale')).toBeNull();
      applyEvent({
        type: 'session.files',
        id: 'docs',
        files: [{ path: 'README.md', added: 50, removed: 12 }],
        filesTotal: 1,
      });
      await waitFor(() => expect(c.querySelector('.k-diff-stale')).not.toBeNull());
      expect(q(c, '.k-diff-stale').textContent).toBe('The files changed. Reload the diff.');
      fireEvent.click(q(c, '.k-diff-stale'));
      await waitFor(() => expect(diffGets()).toHaveLength(3));
      expect(diffGets()[2]).toBe('/api/sessions/docs/diff?from=5');
      await waitFor(() => expect(c.querySelector('.k-diff-stale')).toBeNull());
    });

    it('another session’s files do not mark this diff stale', async () => {
      const c = await openDiff();
      applyEvent({ type: 'session.files', id: 'web', files: [], filesTotal: 0 });
      await Promise.resolve();
      expect(c.querySelector('.k-diff-stale')).toBeNull();
    });
  });

  describe('styles', () => {
    const rule = (sel: string) => {
      const m = new RegExp(
        `(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`,
      ).exec(board);
      if (!m) throw new Error(`no rule ${sel}`);
      return m[1] as string;
    };
    it('diff lines use the diff tokens, hunks --fg-3, context --fg-2; no red', () => {
      expect(rule('.k-dl.add')).toContain('var(--add)');
      expect(rule('.k-dl.del')).toContain('var(--del)');
      expect(rule('.k-dl.hunk')).toContain('var(--fg-3)');
      expect(rule('.k-diff-body')).toContain('var(--fg-2)');
      expect(rule('.k-diff-h')).toContain('var(--fg-strong)');
      expect(rule('.k-diff-top')).toContain('var(--fg-3)');
      const diffRules = [...board.matchAll(/\.k-d(?:v|l|iff-)[^{]*\{[^}]*\}/g)].map((m) => m[0]);
      expect(diffRules.length).toBeGreaterThan(5);
      for (const r of diffRules) {
        expect(r).not.toContain('--red');
        // Lime only as a link's hover and the shared focus ring (spec §6.3).
        if (r.includes('--lime'))
          expect(r.slice(0, r.indexOf('{'))).toMatch(/:hover|:focus-visible/);
      }
    });
  });
});
