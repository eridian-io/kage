import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoSessions, type Session } from '@kage/shared';
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
  selectedId,
  sessions,
  stopArmed,
  termNote,
  toast,
} from '../store.ts';
import { termImport } from '../term-loader.ts';
import type { TerminalModule, TermOptions } from '../terminal/index.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

/** happy-dom loads no stylesheet here: a disabled load counts as a success. */
const settings = (
  window as unknown as {
    happyDOM: {
      settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
    };
  }
).happyDOM.settings;

interface Mounted {
  el: HTMLElement;
  o: TermOptions;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
let mounts: Mounted[];
const fake: TerminalModule = {
  mountTerminal: (el, o) => {
    const m = { el, o, focus: vi.fn(), dispose: vi.fn() };
    mounts.push(m);
    return m;
  },
};
let load: ReturnType<typeof vi.fn>;
let authAnswer: number;
let fetchMock: ReturnType<typeof vi.fn>;

function reset(list: Session[] = demoSessions(NOW)) {
  hadSnapshot.value = false;
  authRequired.value = false;
  busy.value = new Set();
  actionError.value = null;
  termNote.value = null;
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
    auth: false,
    demo: false,
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
const row = (c: Element, id: string) => q(c, `.k-it[data-id="${id}"]`);
const footLeft = (c: Element) => (q(c, '.k-foot .l').textContent ?? '').trim();
const key = (init: KeyboardEventInit, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
const last = () => mounts.at(-1) as Mounted;

/** Renders the board, selects the session, presses T and waits for the mount. */
async function open(id = 'shop') {
  const r = render(<Board />);
  fireEvent.click(row(r.container, id));
  key({ key: 't' });
  const n = mounts.length;
  await waitFor(() => expect(mounts.length).toBe(n + 1));
  return r.container;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  mounts = [];
  authAnswer = 204;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
  load = vi.fn(async () => fake);
  termImport.load = load as unknown as typeof termImport.load;
  fetchMock = vi.fn(async (url: string) =>
    url === '/api/auth'
      ? new Response(null, { status: authAnswer })
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  if (!document.querySelector('meta[name="kage-term"]')) {
    const meta = document.createElement('meta');
    meta.name = 'kage-term';
    meta.content = '/term-AAA.js /term-BBB.css';
    document.head.append(meta);
  }
  reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The loader caches its module for the page's life: the failure comes first, before any success.
describe('loading the terminal', () => {
  it('a chunk that fails to load shows the error line and returns to the output', async () => {
    load.mockRejectedValueOnce(new Error('404'));
    const r = render(<Board />);
    fireEvent.click(row(r.container, 'shop'));
    key({ key: 't' });
    await waitFor(() => expect(mainView.value).toBe('output'));
    await waitFor(() =>
      expect(q(r.container, '.k-err').textContent).toBe("Couldn't load the terminal."),
    );
    expect(mounts).toHaveLength(0);
  });

  it('a stylesheet that fails to load is a load failure too, and is removed again', async () => {
    // The first test's stylesheet loaded; this one starts without it.
    for (const l of document.querySelectorAll('link[href="/term-BBB.css"]')) l.remove();
    // The stylesheet's load turns into an error, as a browser's failed load would. (happy-dom's own
    // failure path prints a stack trace on a console the test can't reach.)
    const dispatch = HTMLLinkElement.prototype.dispatchEvent;
    const failed = vi
      .spyOn(HTMLLinkElement.prototype, 'dispatchEvent')
      .mockImplementation(function (this: HTMLLinkElement, e: Event) {
        return dispatch.call(this, e.type === 'load' ? new Event('error') : e);
      });
    try {
      const r = render(<Board />);
      fireEvent.click(row(r.container, 'shop'));
      key({ key: 't' });
      await waitFor(() => expect(termNote.value).toBe("Couldn't load the terminal."));
      expect(failed).toHaveBeenCalled();
    } finally {
      // A failed wait must not leave every later link load turned into an error.
      failed.mockRestore();
    }
    expect(document.querySelectorAll('link[href="/term-BBB.css"]')).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('T on a running session shows Loading, loads the chunk named by the meta once, and mounts it in the output area', async () => {
    let resolve: (m: TerminalModule) => void = () => {};
    load.mockImplementationOnce(() => new Promise<TerminalModule>((ok) => (resolve = ok)));
    const r = render(<Board />);
    fireEvent.click(row(r.container, 'shop'));
    key({ key: 't' });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith('/term-AAA.js');
    const c = r.container;
    expect(mainView.value).toBe('terminal');
    expect(q(c, '.k-term-msg').textContent).toBe('Loading the terminal…');
    expect(c.querySelector('.k-tr')).toBeNull();
    resolve(fake);
    await waitFor(() => expect(mounts).toHaveLength(1));
    const region = q(c, '.k-term');
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('aria-label')).toBe('Terminal');
    expect(last().el).toBe(q(c, '.k-term-x'));
    expect(last().o.id).toBe('shop');
    expect(last().focus).toHaveBeenCalled();
    await waitFor(() => expect(c.querySelector('.k-term-msg')).toBeNull());
    expect(document.querySelectorAll('link[rel="stylesheet"][href="/term-BBB.css"]')).toHaveLength(
      1,
    );
    expect(footLeft(c)).toBe('Back to session⇧EscShift+Esc (or Ctrl+Shift+X) to leave');
    expect(q(c, '.k-foot .l kbd').textContent).toBe('⇧Esc');
  });

  it('a second open reuses the loaded module and the stylesheet', async () => {
    const c = await open();
    fireEvent.click(q(c, '[data-act="term"]'));
    expect(mainView.value).toBe('output');
    fireEvent.click(q(c, '[data-act="term"]'));
    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelectorAll('link[href="/term-BBB.css"]')).toHaveLength(1);
  });
});

describe('the terminal view', () => {
  it('the footer Terminal opens it like T', async () => {
    const r = render(<Board />);
    fireEvent.click(row(r.container, 'web'));
    fireEvent.click(q(r.container, '[data-act="term"]'));
    await waitFor(() => expect(mounts).toHaveLength(1));
    expect(last().o.id).toBe('web');
  });

  it('T while typing does nothing', async () => {
    const r = render(<Board />);
    fireEvent.click(row(r.container, 'docs'));
    key({ key: 't' }, q(r.container, '.k-follow input'));
    await Promise.resolve();
    expect(mainView.value).toBe('output');
    expect(r.container.querySelector('.k-term')).toBeNull();
  });

  it('T on an ended session does nothing; its footer offers Resume', async () => {
    reset(demoSessions(NOW).map((s) => (s.id === 'docs' ? { ...s, status: 'ended' as const } : s)));
    const r = render(<Board />);
    fireEvent.click(row(r.container, 'docs'));
    key({ key: 't' });
    await Promise.resolve();
    expect(mainView.value).toBe('output');
    expect(footLeft(r.container)).toBe('ResumeU');
  });

  it('Shift+Esc disposes it and returns to the output', async () => {
    const c = await open();
    key({ key: 'Escape', shiftKey: true });
    expect(mainView.value).toBe('output');
    await waitFor(() => expect(last().dispose).toHaveBeenCalledTimes(1));
    expect(c.querySelector('.k-term')).toBeNull();
    expect(c.querySelector('.k-tr')).not.toBeNull();
  });

  it('Ctrl+Shift+X and Back to session do the same', async () => {
    const c = await open();
    key({ key: 'X', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(last().dispose).toHaveBeenCalledTimes(1));
    fireEvent.click(q(c, '[data-act="term"]'));
    await waitFor(() => expect(mounts).toHaveLength(2));
    fireEvent.click(q(c, '[data-act="term"]'));
    expect(mainView.value).toBe('output');
    await waitFor(() => expect(last().dispose).toHaveBeenCalledTimes(1));
  });

  it('plain Esc stays with the terminal', async () => {
    await open();
    key({ key: 'Escape' });
    expect(mainView.value).toBe('terminal');
    expect(last().dispose).not.toHaveBeenCalled();
  });

  it('selecting another session disposes it', async () => {
    const c = await open();
    fireEvent.click(row(c, 'web'));
    await waitFor(() => expect(last().dispose).toHaveBeenCalledTimes(1));
    expect(mainView.value).toBe('output');
    expect(c.querySelector('.k-term')).toBeNull();
  });

  it("the end's reason shows in the error line, back on the output", async () => {
    const c = await open();
    last().o.onEnd('This session has ended.');
    await waitFor(() => expect(q(c, '.k-err').textContent).toBe('This session has ended.'));
    expect(mainView.value).toBe('output');
    expect(c.querySelector('.k-tr')).not.toBeNull();
    // The next open clears it.
    fireEvent.click(q(c, '[data-act="term"]'));
    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(c.querySelector('.k-err')).toBeNull();
  });

  it('a handshake failure asks /api/auth: signed in, the error line', async () => {
    const c = await open();
    last().o.onEnd(null);
    await waitFor(() => expect(q(c, '.k-err').textContent).toBe("Couldn't open the terminal."));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth');
    expect(authRequired.value).toBe(false);
  });

  it('a handshake failure while signed out shows the login screen', async () => {
    authAnswer = 401;
    await open();
    last().o.onEnd(null);
    await waitFor(() => expect(authRequired.value).toBe(true));
    expect(termNote.value).toBeNull();
  });

  it('a quiet end (the tab was hidden) returns to the output with no line', async () => {
    const c = await open();
    last().o.onEnd('');
    await waitFor(() => expect(mainView.value).toBe('output'));
    expect(c.querySelector('.k-err')).toBeNull();
  });

  it('the view-only line shows when the module reports ro, above the footer', async () => {
    const c = await open('web');
    expect(c.querySelector('.k-term-ro')).toBeNull();
    last().o.onMode?.('ro');
    await waitFor(() =>
      expect(q(c, '.k-term-ro').textContent).toBe(
        "View only: Kage didn't start this window, so it doesn't type into it.",
      ),
    );
    // Announced when it appears.
    expect(q(c, '.k-term-ro').getAttribute('role')).toBe('status');
  });

  it('a pane larger than the area is clipped, never spilled over the footer', () => {
    const css = readFileSync(join(import.meta.dirname, '../styles/board.css'), 'utf8');
    const rule = /.k-term-x {([^}]*)}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overflow: hidden;');
  });

  it('the selected session ending disposes its terminal and returns to the output', async () => {
    const c = await open();
    const shop = sessions.value.find((s) => s.id === 'shop') as Session;
    applyEvent({ type: 'session.updated', session: { ...shop, status: 'ended' } });
    await waitFor(() => expect(last().dispose).toHaveBeenCalledTimes(1));
    expect(mainView.value).toBe('output');
    expect(c.querySelector('.k-term')).toBeNull();
    // The board's keys work again.
    key({ key: 'k' });
    expect(selectedId.value).not.toBe('shop');
  });

  it('hides the question, the follow-up and the delete confirmation', async () => {
    const c = await open('web');
    expect(c.querySelector('.k-ask')).toBeNull();
    fireEvent.click(row(c, 'docs'));
    expect(c.querySelector('.k-follow')).not.toBeNull();
    key({ key: 't' });
    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(c.querySelector('.k-follow')).toBeNull();
    expect(c.querySelector('.k-confirm')).toBeNull();
  });

  it('focus goes back to Terminal when it was inside the terminal', async () => {
    const c = await open();
    const inner = document.createElement('textarea');
    q(c, '.k-term-x').append(inner);
    inner.focus();
    key({ key: 'Escape', shiftKey: true }, inner);
    await waitFor(() => expect(document.activeElement).toBe(q(c, '[data-act="term"]')));
    expect(footLeft(c)).toBe('TerminalT');
  });
});
