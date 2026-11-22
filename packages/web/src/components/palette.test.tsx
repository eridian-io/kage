import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoSessions, type Session } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Board } from '../main.tsx';
import { installNotify, notifyState } from '../notify.ts';
import {
  applyEvent,
  authRequired,
  busy,
  closeDiff,
  confirmingDelete,
  connection,
  hadSnapshot,
  mainView,
  newTaskOpen,
  paletteOpen,
  releaseDigits,
  select,
  selectedId,
  sessions,
  stopSent,
} from '../store.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let fetchMock: ReturnType<typeof vi.fn>;

/** The demo sessions plus two whose names test the ranking. */
function list(): Session[] {
  const base = demoSessions(NOW);
  const docs = base.find((s) => s.id === 'docs') as Session;
  return [
    ...base,
    { ...docs, id: 'notes', task: 'Write notes', branch: 'docs/notes', statusSince: NOW - 1 },
    { ...docs, id: 'wl', project: 'web', task: 'wonderland', branch: 'feat/wl', statusSince: NOW },
  ];
}

function load(l: Session[] = list(), archived = 0) {
  applyEvent({
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived,
    sessions: l,
  });
}

/** A Ctrl+K keydown on the focused element (or the document); returns it to read defaultPrevented. */
function ctrlK(init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', {
    key: 'k',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(document.activeElement ?? document, e);
  return e;
}
const combo = () => document.querySelector<HTMLInputElement>('[role="combobox"]');
async function open(): Promise<HTMLInputElement> {
  ctrlK();
  await waitFor(() => expect(combo()).not.toBeNull());
  return combo() as HTMLInputElement;
}
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  fireEvent.input(input);
};
const key = (input: HTMLInputElement, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  fireEvent(input, e);
  return e;
};
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const optionTexts = () => options().map((o) => o.querySelector('.k-name')?.textContent);
const live = () => document.querySelector('.k-pal-live')?.textContent;

beforeEach(() => {
  authRequired.value = false;
  hadSnapshot.value = false;
  busy.value = new Set();
  connection.value = 'live';
  stopSent.value = null;
  newTaskOpen.value = false;
  paletteOpen.value = false;
  confirmingDelete.value = false;
  mainView.value = 'output';
  notifyState.value = 'granted';
  sessions.value = [];
  selectedId.value = null;
  releaseDigits();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  load();
});
afterEach(() => {
  paletteOpen.value = false;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the command palette', () => {
  it('Ctrl+K opens it with the input focused and the combobox and listbox ARIA', async () => {
    render(<Board />);
    const input = await open();
    expect(document.activeElement).toBe(input);
    const dialog = document.querySelector('.k-pal') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Command palette');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('k-pal-list');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-activedescendant')).toBe('k-pal-o0');
    expect(input.placeholder).toBe('Jump to a session or run a command…');
    const listbox = document.getElementById('k-pal-list') as HTMLElement;
    expect(listbox.getAttribute('role')).toBe('listbox');
    const groups = [...listbox.querySelectorAll('[role="group"]')];
    expect(
      groups.map(
        (g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent,
      ),
    ).toEqual(['sessions', 'this session', 'general']);
    expect(options()[0]?.id).toBe('k-pal-o0');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('false');
    expect(live()).toBe(`${options().length} results`);
    expect(document.querySelector('.k-pal-live')?.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('.k-pal-foot')?.textContent).toBe(
      '↑↓ to move · Enter to open · Esc to close',
    );
  });

  it('shows a session as project /, the task and its status word', async () => {
    render(<Board />);
    await open();
    const first = options()[0] as HTMLElement;
    expect(first.querySelector('.pj')?.textContent).toBe('web /');
    expect(first.querySelector('.k-name')?.textContent).toBe('web / dark mode');
    expect(first.querySelector('.k-pal-st')?.textContent).toBe('needs you');
    expect(first.querySelector('.k-pal-st')?.className).toBe('k-pal-st k-pal-wait');
    expect(options()[1]?.querySelector('.k-pal-st')?.className).toBe('k-pal-st k-pal-run');
  });

  it('typing wn makes the first option docs / Write notes, its hits as text spans', async () => {
    render(<Board />);
    const input = await open();
    type(input, 'wn');
    expect(optionTexts()[0]).toBe('docs / Write notes');
    expect([...(options()[0]?.querySelectorAll('b') ?? [])].map((b) => b.textContent)).toEqual([
      'W',
      'n',
    ]);
    expect(optionTexts()).toContain('web / wonderland');
    expect(input.getAttribute('aria-activedescendant')).toBe('k-pal-o0');
  });

  it('never injects HTML from a task', async () => {
    const l = list();
    l.push({ ...(l[0] as Session), id: 'evil', task: '<img src=x onerror=alert(1)>' });
    load(l);
    render(<Board />);
    const input = await open();
    type(input, 'img');
    expect(optionTexts()[0]).toBe('web / <img src=x onerror=alert(1)>');
    expect(document.querySelector('.k-pal img')).toBeNull();
  });

  it('↓ moves aria-activedescendant (wrapping); Enter selects that session, closes and focuses its row', async () => {
    render(<Board />);
    const input = await open();
    expect(selectedId.value).toBe('web');
    key(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('k-pal-o1');
    key(input, 'ArrowUp');
    key(input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(`k-pal-o${options().length - 1}`);
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(key(input, 'Enter').defaultPrevented).toBe(true);
    expect(selectedId.value).toBe('shop');
    await waitFor(() => expect(combo()).toBeNull());
    expect(paletteOpen.value).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('.k-it[data-id="shop"]')),
    );
  });

  it('Esc closes it and returns focus to what had it', async () => {
    render(<Board />);
    const before = document.querySelector<HTMLElement>('[data-act="term"]') as HTMLElement;
    before.focus();
    const input = await open();
    const esc = key(input, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    await waitFor(() => expect(combo()).toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it('Ctrl+K again closes it, and focus returns too', async () => {
    render(<Board />);
    const before = document.querySelector<HTMLElement>('.k-it[data-id="infra"]') as HTMLElement;
    before.focus();
    await open();
    expect(ctrlK().defaultPrevented).toBe(true);
    await waitFor(() => expect(combo()).toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it('Esc with the diff view open closes only the palette', async () => {
    render(<Board />);
    mainView.value = 'diff';
    const input = await open();
    key(input, 'Escape');
    await waitFor(() => expect(combo()).toBeNull());
    expect(mainView.value).toBe('diff');
  });

  it('closeDiff with no View diff → focuses the selected session row, never a palette row', async () => {
    sessions.value = sessions.value.map((s) =>
      s.id === 'docs' ? { ...s, files: [], filesTotal: 0 } : s,
    );
    const noFiles = sessions.value.find((s) => s.id === 'docs') as Session;
    render(<Board />);
    select(noFiles.id);
    mainView.value = 'diff';
    await open();
    expect(document.querySelector('.k-diff')).toBeNull();
    expect(document.querySelector('.k-pal-o.on')).not.toBeNull();
    // Even with the palette first in the document, its active row (k-it on) is not the target.
    const first = (document.querySelector('.k-pal') as HTMLElement).cloneNode(true) as HTMLElement;
    document.body.prepend(first);
    onTestFinished(() => first.remove());
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    closeDiff();
    expect(focus.mock.contexts).toEqual([
      document.querySelector(`.k-side .k-it[data-id="${noFiles.id}"]`),
    ]);
  });

  it('Esc over the New task form leaves the form open', async () => {
    render(<Board />);
    newTaskOpen.value = true;
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.k-nt-task')));
    const input = await open();
    key(input, 'Escape');
    await waitFor(() => expect(combo()).toBeNull());
    expect(newTaskOpen.value).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.k-nt-task'));
  });

  it('j typed in the input does not move the board selection; Tab stays in the input', async () => {
    render(<Board />);
    const input = await open();
    expect(key(input, 'j').defaultPrevented).toBe(false);
    type(input, 'j');
    expect(selectedId.value).toBe('web');
    expect(key(input, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('a held Esc or Enter does nothing; IME composition keeps its keys', async () => {
    render(<Board />);
    const input = await open();
    key(input, 'Escape', { repeat: true });
    key(input, 'Enter', { repeat: true });
    key(input, 'ArrowDown', { isComposing: true });
    key(input, 'Enter', { isComposing: true });
    await Promise.resolve();
    expect(paletteOpen.value).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe('k-pal-o0');
    expect(selectedId.value).toBe('web');
  });

  it('Ctrl+K with the terminal open does nothing and is not prevented', async () => {
    render(<Board />);
    fireEvent.click(document.querySelector('.k-it[data-id="shop"]') as HTMLElement);
    mainView.value = 'terminal';
    expect(ctrlK().defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(paletteOpen.value).toBe(false);
    expect(combo()).toBeNull();
  });

  it('Ctrl+K on the login screen is not prevented', async () => {
    authRequired.value = true;
    render(<Board />);
    expect(ctrlK().defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
  });

  it('a click on the top bar’s hint opens it', async () => {
    render(<Board />);
    const hint = document.querySelector('.k-k') as HTMLButtonElement;
    expect(hint.tagName).toBe('BUTTON');
    expect(hint.getAttribute('aria-label')).toBe('Command palette');
    fireEvent.click(hint);
    await waitFor(() => expect(combo()).not.toBeNull());
    expect(document.activeElement).toBe(combo());
  });

  it('a press outside closes it', async () => {
    render(<Board />);
    await open();
    fireEvent.pointerDown(document.querySelector('.k-main') as HTMLElement);
    await waitFor(() => expect(combo()).toBeNull());
  });

  it('hover sets the active option and a click runs it', async () => {
    render(<Board />);
    const input = await open();
    const third = options()[2] as HTMLElement;
    fireEvent.pointerMove(third);
    expect(input.getAttribute('aria-activedescendant')).toBe('k-pal-o2');
    expect(fireEvent.mouseDown(third)).toBe(false);
    fireEvent.click(third);
    expect(selectedId.value).toBe('infra');
    await waitFor(() => expect(combo()).toBeNull());
  });

  it('New task opens the form with its field focused', async () => {
    render(<Board />);
    const input = await open();
    type(input, 'new task');
    expect(optionTexts()[0]).toBe('New task');
    key(input, 'Enter');
    expect(newTaskOpen.value).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.k-nt-task')));
  });

  it('Delete… opens the confirmation and calls no API', async () => {
    render(<Board />);
    fireEvent.click(document.querySelector('.k-it[data-id="docs"]') as HTMLElement);
    fetchMock.mockClear();
    const input = await open();
    type(input, 'delete');
    expect(optionTexts()[0]).toBe('Delete…');
    key(input, 'Enter');
    expect(confirmingDelete.value).toBe(true);
    await waitFor(() => expect(document.querySelector('.k-confirm')).not.toBeNull());
    expect(
      (fetchMock.mock.calls as [string, RequestInit][]).filter(([, i]) => i?.method === 'DELETE'),
    ).toEqual([]);
  });

  it('a disabled item runs nothing and keeps the palette open', async () => {
    notifyState.value = 'insecure';
    render(<Board />);
    const input = await open();
    type(input, 'https');
    expect(optionTexts()[0]).toBe('Browser notifications need HTTPS; use ntfy instead');
    expect(options()[0]?.getAttribute('aria-disabled')).toBe('true');
    key(input, 'Enter');
    fireEvent.click(options()[0] as HTMLElement);
    expect(paletteOpen.value).toBe(true);
  });

  it('the live region reads No matches. for zzzz', async () => {
    render(<Board />);
    const input = await open();
    type(input, 'zzzz');
    expect(options()).toHaveLength(0);
    expect(live()).toBe('No matches.');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.querySelector('.k-pal-none')?.textContent).toBe('No matches.');
    // Enter with nothing to run does nothing.
    key(input, 'Enter');
    expect(paletteOpen.value).toBe(true);
    type(input, 'a');
    expect(live()).toMatch(/^\d+ results?$/);
  });

  it('past 50 results: Keep typing to see more.', async () => {
    const base = demoSessions(NOW)[0] as Session;
    load(Array.from({ length: 60 }, (_, i) => ({ ...base, id: `s${i}`, task: `task ${i}` })));
    render(<Board />);
    const input = await open();
    expect(options()).toHaveLength(50);
    expect(document.querySelector('.k-pal-more')?.textContent).toBe('Keep typing to see more.');
    type(input, 'task 5');
    expect(document.querySelector('.k-pal-more')).toBeNull();
  });

  it('re-reads the notification permission when it opens', async () => {
    const N = { permission: 'default' as NotificationPermission };
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Notification', N);
    notifyState.value = 'unsupported';
    render(<Board />);
    const input = await open();
    expect(notifyState.value).toBe('default');
    type(input, 'browser');
    expect(optionTexts()[0]).toBe('Turn on browser notifications');
  });

  it('holds no timer once settled', async () => {
    render(<Board />);
    const input = await open();
    vi.useFakeTimers();
    type(input, 'do');
    key(input, 'ArrowDown');
    key(input, 'Escape');
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a chunk that fails to load closes it again; the next open tries again', async () => {
    // The real chunk may already be cached from earlier tests: start from a fresh loader.
    vi.resetModules();
    const fresh = await import('../palette-loader.tsx');
    const spy = vi.spyOn(fresh.paletteImport, 'load').mockRejectedValueOnce(new Error('offline'));
    await expect(fresh.loadPalette()).rejects.toThrow('offline');
    await expect(fresh.loadPalette()).resolves.toHaveProperty('Palette');
    expect(spy.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });
});

describe('the selected row comes into view (R95)', () => {
  it('a #s= link scrolls its session into view in the list', async () => {
    const seen: Element[] = [];
    const proto = Element.prototype as Element & { scrollIntoView?: unknown };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    try {
      render(<Board />);
      window.history.replaceState(null, '', '/#s=docs');
      const stop = installNotify(window);
      try {
        expect(selectedId.value).toBe('docs');
        await waitFor(() =>
          expect(seen).toContain(document.querySelector('.k-it[data-id="docs"]')),
        );
      } finally {
        stop();
      }
    } finally {
      proto.scrollIntoView = had;
    }
  });
});

describe('the command palette: fix round 1', () => {
  const mac = () => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');

  it('the panel carries the focus ring (WCAG 2.4.7); the input does not', () => {
    const css = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');
    expect(css).toMatch(
      /\.k-pal:focus-within \{\s*outline: 2px solid color-mix\(in srgb, var\(--lime\) 45%, transparent\);\s*outline-offset: 2px;\s*\}/,
    );
    expect(css).toMatch(/\.k-pal-in:focus-visible \{\s*outline: none;\s*\}/);
  });

  it('the notifications item says what a notification shows, quietly on the right', async () => {
    notifyState.value = 'default';
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Notification', { permission: 'default' });
    render(<Board />);
    const input = await open();
    type(input, 'browser');
    const o = options()[0] as HTMLElement;
    expect(o.querySelector('.k-name')?.textContent).toBe('Turn on browser notifications');
    expect(o.querySelector('.k-pal-st')?.textContent).toBe('shows project and task');
  });

  it('the live region reads 50+ results when capped; group labels are presentational', async () => {
    const base = demoSessions(NOW)[0] as Session;
    load(Array.from({ length: 60 }, (_, i) => ({ ...base, id: `s${i}`, task: `task ${i}` })));
    render(<Board />);
    await open();
    expect(live()).toBe('50+ results');
    for (const label of document.querySelectorAll('.k-pal .k-g')) {
      expect(label.getAttribute('role')).toBe('presentation');
    }
  });

  it('the hint shows Ctrl+K off a Mac, with its title and aria-keyshortcuts', () => {
    render(<Board />);
    const hint = document.querySelector('.k-k') as HTMLButtonElement;
    expect(hint.textContent).toBe('Ctrl+K');
    expect(hint.getAttribute('title')).toBe('Command palette (Ctrl+K)');
    expect(hint.getAttribute('aria-keyshortcuts')).toBe('Control+K');
  });

  it('on a Mac the hint is ⌘K (Meta+K), and only ⌘K opens it: Ctrl+K stays kill-line (R97)', async () => {
    mac();
    render(<Board />);
    const hint = document.querySelector('.k-k') as HTMLButtonElement;
    expect(hint.textContent).toBe('⌘K');
    expect(hint.getAttribute('title')).toBe('Command palette (⌘K)');
    expect(hint.getAttribute('aria-keyshortcuts')).toBe('Meta+K');
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    expect(ctrlK().defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
    expect(ctrlK({ ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
    await waitFor(() => expect(combo()).not.toBeNull());
  });

  it('a command gone stale while open runs nothing (Stop after the session finished)', async () => {
    render(<Board />);
    fireEvent.click(document.querySelector('.k-it[data-id="shop"]') as HTMLElement);
    const input = await open();
    type(input, 'stop');
    expect(optionTexts()[0]).toBe('Stop');
    const shop = sessions.value.find((s) => s.id === 'shop') as Session;
    applyEvent({ type: 'session.updated', session: { ...shop, status: 'done' } });
    fetchMock.mockClear();
    key(input, 'Enter');
    await Promise.resolve();
    expect((fetchMock.mock.calls as [string][]).map(([u]) => u)).not.toContain(
      '/api/sessions/shop/stop',
    );
    // The list on screen stays the snapshot.
    expect(optionTexts()[0]).toBe('Stop');
  });

  it('Delete… does nothing once the selection has moved to another session', async () => {
    render(<Board />);
    fireEvent.click(document.querySelector('.k-it[data-id="docs"]') as HTMLElement);
    const input = await open();
    type(input, 'delete');
    expect(optionTexts()[0]).toBe('Delete…');
    select('rate');
    key(input, 'Enter');
    expect(confirmingDelete.value).toBe(false);
    expect(selectedId.value).toBe('rate');
  });

  it('Delete… still opens the confirmation for the session selected when it was chosen', async () => {
    render(<Board />);
    fireEvent.click(document.querySelector('.k-it[data-id="docs"]') as HTMLElement);
    const input = await open();
    type(input, 'delete');
    key(input, 'Enter');
    expect(confirmingDelete.value).toBe(true);
    expect(selectedId.value).toBe('docs');
  });

  for (const [platform, hint] of [
    [undefined, 'Ctrl+K'],
    ['MacIntel', '⌘K'],
  ] as const) {
    it(`a chunk that fails to load says so in the toast (${hint})`, async () => {
      if (platform) mac();
      vi.resetModules();
      const loader = await import('../palette-loader.tsx');
      const store = await import('../store.ts');
      const { Toast } = await import('./Toast.tsx');
      vi.spyOn(loader.paletteImport, 'load').mockRejectedValueOnce(new Error('offline'));
      render(
        <>
          <loader.PaletteHost />
          <Toast />
        </>,
      );
      store.paletteOpen.value = true;
      await waitFor(() => expect(store.paletteOpen.value).toBe(false));
      await waitFor(() =>
        expect(document.querySelector('.k-toast')?.textContent).toBe(
          `Couldn't open the palette. Press ${hint} to try again.`,
        ),
      );
      expect(document.querySelector('.k-toast')?.getAttribute('role')).toBe('status');
      // The next open loads it, and the note goes.
      store.paletteOpen.value = true;
      await waitFor(() => expect(document.querySelector('[role="combobox"]')).not.toBeNull());
      expect(store.toast.value).toBeNull();
    });
  }
});
