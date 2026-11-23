import { demoSessions, type Session } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeys } from './keys.ts';
import {
  answered,
  applyEvent,
  authRequired,
  busy,
  confirmingDelete,
  connection,
  mainView,
  newTaskOpen,
  paletteOpen,
  releaseDigits,
  replyOpen,
  select,
  selectedId,
  sessions,
  stopArmed,
  stopSent,
  termNote,
  viewGen,
} from './store.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let uninstall: () => void = () => {};
let fetchMock: ReturnType<typeof vi.fn>;
/** The URLs posted so far. */
const posted = () => (fetchMock.mock.calls as [string][]).map(([url]) => url);
const flush = () => new Promise((r) => setTimeout(r, 0));

const press = (key: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(() => {
  sessions.value = [];
  selectedId.value = null;
  confirmingDelete.value = false;
  newTaskOpen.value = false;
  paletteOpen.value = false;
  authRequired.value = false;
  mainView.value = 'output';
  replyOpen.value = false;
  stopArmed.value = null;
  stopSent.value = null;
  answered.value = null;
  releaseDigits();
  busy.value = new Set();
  connection.value = 'live';
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  applyEvent({
    type: 'snapshot',
    auth: false,
    demo: false,
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived: 0,
    sessions: demoSessions(NOW),
  });
  uninstall = installKeys(document);
});
afterEach(() => {
  uninstall();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('installKeys', () => {
  it('j and k move the selection', () => {
    expect(selectedId.value).toBe('web');
    press('j');
    expect(selectedId.value).toBe('shop');
    press('k');
    expect(selectedId.value).toBe('web');
  });

  it('stops at the ends of the list', () => {
    press('k');
    expect(selectedId.value).toBe('web');
    for (let i = 0; i < 10; i++) press('j');
    expect(selectedId.value).toBe('docs');
  });

  it('at an end of the list, J/K do nothing: no new view, the delete confirmation stays', () => {
    const gen = viewGen.value;
    confirmingDelete.value = true;
    press('k');
    expect(viewGen.value).toBe(gen);
    expect(confirmingDelete.value).toBe(true);
  });

  it('ignores keys typed in an input or a textarea', () => {
    for (const tag of ['input', 'textarea']) {
      const field = document.createElement(tag);
      document.body.append(field);
      press('j', field);
      expect(selectedId.value).toBe('web');
    }
  });

  it('ignores j with a modifier', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    expect(selectedId.value).toBe('web');
  });

  it('Escape cancels the delete confirmation', () => {
    confirmingDelete.value = true;
    press('Escape');
    expect(confirmingDelete.value).toBe(false);
  });

  it('stops listening once uninstalled', () => {
    uninstall();
    press('j');
    expect(selectedId.value).toBe('web');
  });
});

describe('installKeys: the New task form', () => {
  it('n opens the form, and is ignored while typing', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    press('n', field);
    expect(newTaskOpen.value).toBe(false);
    press('n');
    expect(newTaskOpen.value).toBe(true);
    press('N');
    expect(newTaskOpen.value).toBe(true);
  });

  it('N with a modifier does nothing', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));
    expect(newTaskOpen.value).toBe(false);
  });

  it('while the form is open, j, k and Escape leave the board alone (the form owns its keys)', () => {
    newTaskOpen.value = true;
    confirmingDelete.value = true;
    press('j');
    expect(selectedId.value).toBe('web');
    press('Escape');
    expect(confirmingDelete.value).toBe(true);
  });
});

const holdKey = (key: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true }));

describe('installKeys: held keys', () => {
  it('a repeated X after the first X sends nothing (R26)', async () => {
    select('shop');
    press('x');
    for (let i = 0; i < 5; i++) holdKey('x');
    await flush();
    expect(posted()).toEqual([]);
    expect(stopArmed.value).toBe('shop');
  });

  it('a repeated digit sends nothing', async () => {
    holdKey('1');
    await flush();
    expect(posted()).toEqual([]);
  });

  it('J and K still repeat', () => {
    holdKey('j');
    holdKey('j');
    expect(selectedId.value).toBe('infra');
  });
});

describe('installKeys: after the selection changes by itself', () => {
  /** web and shop both wait; web is selected, then removed, so shop is picked automatically. */
  const pickShop = () => {
    applyEvent({
      type: 'snapshot',
      auth: false,
      demo: false,
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      archived: 0,
      sessions: demoSessions(NOW).map((s) =>
        s.id === 'shop'
          ? {
              ...s,
              status: 'needs-you' as const,
              question: { text: 'Run it?', options: ['Yes', 'No'] },
            }
          : s,
      ),
    });
    select('web');
    applyEvent({ type: 'session.removed', id: 'web' });
    expect(selectedId.value).toBe('shop');
  };

  it('digits wait 1 s', async () => {
    vi.useFakeTimers();
    pickShop();
    press('1');
    await vi.advanceTimersByTimeAsync(999);
    expect(posted()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    press('1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual(['/api/sessions/shop/answer']);
  });

  it('or until the user selects', async () => {
    pickShop();
    press('1');
    press('k');
    press('1');
    await flush();
    expect(posted()).toEqual(['/api/sessions/shop/answer']);
  });

  it('the first selection on load does not hold digits', async () => {
    press('1');
    await flush();
    expect(posted()).toEqual(['/api/sessions/web/answer']);
  });
});

describe('installKeys: after the selected question changes (R51)', () => {
  const change = (text: string, options = ['Yes', 'No']) => {
    const web = sessions.value.find((s) => s.id === 'web');
    if (!web) throw new Error('no web');
    applyEvent({ type: 'session.updated', session: { ...web, question: { text, options } } });
  };

  it('a digit within 800 ms of a new question text sends nothing; after it works', async () => {
    vi.useFakeTimers();
    change('Delete the cache?');
    press('1');
    await vi.advanceTimersByTimeAsync(799);
    press('1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    press('1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual(['/api/sessions/web/answer']);
  });

  it('new options alone also hold the digits', async () => {
    vi.useFakeTimers();
    const web = sessions.value.find((s) => s.id === 'web');
    change(web?.question?.text ?? '', ['Yes', 'Yes, always', 'No']);
    press('1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual([]);
  });

  it('an update that keeps the same question does not hold', async () => {
    const web = sessions.value.find((s) => s.id === 'web');
    if (!web) throw new Error('no web');
    applyEvent({ type: 'session.updated', session: { ...web, unpushed: web.unpushed + 1 } });
    press('1');
    await flush();
    expect(posted()).toEqual(['/api/sessions/web/answer']);
  });

  it('a change on another session does not hold the selected one', async () => {
    const shop = sessions.value.find((s) => s.id === 'shop');
    if (!shop) throw new Error('no shop');
    applyEvent({
      type: 'session.updated',
      session: {
        ...shop,
        status: 'needs-you',
        question: { text: 'Run it?', options: ['Yes', 'No'] },
      },
    });
    press('1');
    await flush();
    expect(posted()).toEqual(['/api/sessions/web/answer']);
  });
});

describe('installKeys: answering and Stop', () => {
  it('1–9 answer the selected needs-you session, only options it has', async () => {
    press('3');
    press('0');
    await flush();
    expect(posted()).toEqual([]);
    press('1');
    await flush();
    expect(posted()).toEqual(['/api/sessions/web/answer']);
  });

  it('digits do nothing for a session without a question', async () => {
    select('shop');
    press('1');
    await flush();
    expect(posted()).toEqual([]);
  });

  it('R opens the reply field for a question; Esc closes it', () => {
    press('r');
    expect(replyOpen.value).toBe(true);
    press('Escape');
    expect(replyOpen.value).toBe(false);
  });

  it('a single X sends nothing; a second within 2 s stops (R26)', async () => {
    vi.useFakeTimers();
    select('shop');
    press('x');
    expect(stopArmed.value).toBe('shop');
    await vi.advanceTimersByTimeAsync(1900);
    expect(posted()).toEqual([]);
    press('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual(['/api/sessions/shop/stop']);
    expect(stopArmed.value).toBeNull();
  });

  it('an X after 2 s arms again instead of stopping', async () => {
    vi.useFakeTimers();
    select('shop');
    press('x');
    await vi.advanceTimersByTimeAsync(2000);
    expect(stopArmed.value).toBeNull();
    press('x');
    expect(stopArmed.value).toBe('shop');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual([]);
    press('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toEqual(['/api/sessions/shop/stop']);
  });

  it('selecting another session disarms X', async () => {
    select('shop');
    press('x');
    select('infra');
    expect(stopArmed.value).toBeNull();
    press('x');
    await flush();
    expect(posted()).toEqual([]);
    expect(stopArmed.value).toBe('infra');
  });

  it('X stops a needs-you session too, but not a done one', async () => {
    press('x');
    press('x');
    await flush();
    expect(posted()).toEqual(['/api/sessions/web/stop']);
    select('docs');
    press('x');
    press('x');
    await flush();
    expect(posted()).toHaveLength(1);
  });

  it('the form and the login screen own the keyboard', async () => {
    newTaskOpen.value = true;
    press('1');
    press('x');
    press('x');
    press('r');
    await flush();
    expect(posted()).toEqual([]);
    expect(replyOpen.value).toBe(false);
  });
});

describe('installKeys: pin, archive and resume (S, E, U)', () => {
  /** Each request: URL, method and parsed body. */
  const sent = () =>
    (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => [
      url,
      init.method,
      init.body === undefined ? undefined : JSON.parse(String(init.body)),
    ]);
  const patch = (id: string, p: Partial<Session>) => {
    const s = sessions.value.find((x) => x.id === id) as Session;
    applyEvent({ type: 'session.updated', session: { ...s, ...p } });
  };

  it('S pins an unpinned done session, then unpins it once pinned', async () => {
    select('footer');
    press('s');
    await flush();
    expect(sent()).toEqual([['/api/sessions/footer/pin', 'POST', { pinned: true }]]);
    patch('footer', { pinned: true });
    press('S');
    await flush();
    expect(sent()[1]).toEqual(['/api/sessions/footer/pin', 'POST', { pinned: false }]);
  });

  it('S does nothing for an external session', async () => {
    patch('footer', { external: true });
    select('footer');
    press('s');
    await flush();
    expect(sent()).toEqual([]);
  });

  it('E archives a done or ended session it started; not a running or external one', async () => {
    select('shop');
    press('e');
    await flush();
    expect(sent()).toEqual([]);
    select('docs');
    press('e');
    await flush();
    expect(sent()).toEqual([['/api/sessions/docs/archive', 'POST', { archived: true }]]);
    patch('footer', { status: 'ended' });
    select('footer');
    press('e');
    await flush();
    expect(sent()[1]).toEqual(['/api/sessions/footer/archive', 'POST', { archived: true }]);
    patch('rate', { external: true });
    select('rate');
    press('e');
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it('U resumes an ended session it started, and nothing else', async () => {
    select('docs');
    press('u');
    await flush();
    expect(sent()).toEqual([]);
    patch('docs', { status: 'ended', external: true });
    press('u');
    await flush();
    expect(sent()).toEqual([]);
    patch('docs', { status: 'ended', external: false });
    press('u');
    await flush();
    expect(sent()).toEqual([['/api/sessions/docs/resume', 'POST', undefined]]);
  });

  it('S, E and U do nothing while typing, repeated, busy or disconnected', async () => {
    patch('docs', { status: 'ended' });
    select('docs');
    const field = document.createElement('input');
    document.body.append(field);
    for (const k of ['s', 'e', 'u']) press(k, field);
    for (const k of ['s', 'e', 'u']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, repeat: true }));
    }
    busy.value = new Set(['docs']);
    for (const k of ['s', 'e', 'u']) press(k);
    busy.value = new Set();
    connection.value = 'reconnecting';
    for (const k of ['s', 'e', 'u']) press(k);
    await flush();
    expect(sent()).toEqual([]);
  });
});

describe('installKeys: the diff view (Task 10)', () => {
  beforeEach(() => {
    select('web');
    mainView.value = 'diff';
  });
  afterEach(() => {
    mainView.value = 'output';
  });

  it('Esc closes the diff and keeps the session selected', () => {
    press('Escape');
    expect(mainView.value).toBe('output');
    expect(selectedId.value).toBe('web');
  });

  it('a held Esc does nothing', () => {
    holdKey('Escape');
    expect(mainView.value).toBe('diff');
  });

  it('Esc while typing leaves the diff open', () => {
    const field = document.createElement('input');
    document.body.append(field);
    press('Escape', field);
    expect(mainView.value).toBe('diff');
  });

  it('digits answer nothing while the diff hides the question', async () => {
    expect(sessions.value.find((s) => s.id === 'web')?.status).toBe('needs-you');
    press('1');
    await flush();
    expect(posted()).toEqual([]);
  });

  it('J and K on the page move the list (and the view resets)', () => {
    press('j');
    expect(selectedId.value).not.toBe('web');
    expect(mainView.value).toBe('output');
  });

  it('J and K inside the diff are left to the diff', () => {
    const view = document.createElement('section');
    view.className = 'k-dv';
    const body = document.createElement('div');
    view.append(body);
    document.body.append(view);
    press('j', body);
    press('k', body);
    expect(selectedId.value).toBe('web');
    expect(mainView.value).toBe('diff');
  });

  it('R leaves the diff', () => {
    press('r');
    expect(mainView.value).toBe('output');
  });
});

describe('installKeys: the terminal (Task 13)', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  const ended = () => {
    const list = demoSessions(NOW).map((s) =>
      s.id === 'docs' ? { ...s, status: 'ended' as const } : s,
    );
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
  };

  it('T opens the terminal for a session with a window', () => {
    select('shop');
    press('t');
    expect(mainView.value).toBe('terminal');
  });

  it('T does nothing while typing, with a modifier, or for an ended session', () => {
    select('shop');
    const field = document.createElement('input');
    document.body.append(field);
    press('t', field);
    key({ key: 't', ctrlKey: true });
    expect(mainView.value).toBe('output');
    ended();
    select('docs');
    press('t');
    expect(mainView.value).toBe('output');
  });

  it('Shift+Esc and Ctrl+Shift+X leave it; plain Esc does not (it is Claude’s)', () => {
    select('shop');
    for (const leave of [
      { key: 'Escape', shiftKey: true },
      { key: 'X', ctrlKey: true, shiftKey: true },
    ]) {
      press('t');
      press('Escape');
      expect(mainView.value).toBe('terminal');
      key(leave);
      expect(mainView.value).toBe('output');
    }
  });

  it('they leave from inside the terminal’s own textarea too', () => {
    select('shop');
    press('t');
    const ta = document.createElement('textarea');
    document.body.append(ta);
    key({ key: 'Escape', shiftKey: true }, ta);
    expect(mainView.value).toBe('output');
  });

  it('a held Shift+Esc acts once only on the first press', () => {
    select('shop');
    press('t');
    key({ key: 'Escape', shiftKey: true, repeat: true });
    expect(mainView.value).toBe('terminal');
  });

  it('every board key is ignored while it is open (F9)', async () => {
    select('web');
    press('t');
    for (const k of ['j', 'k', '1', 'x', 'x', 's', 'e', 'u', 'n', 'r', 't']) press(k);
    await flush();
    expect(selectedId.value).toBe('web');
    expect(stopArmed.value).toBeNull();
    expect(newTaskOpen.value).toBe(false);
    expect(replyOpen.value).toBe(false);
    expect(posted()).toEqual([]);
    expect(mainView.value).toBe('terminal');
  });

  it('Ctrl+Shift+X leaves on a non-Latin layout too (matched by its physical key)', () => {
    select('shop');
    press('t');
    key({ key: 'Ч', code: 'KeyX', ctrlKey: true, shiftKey: true });
    expect(mainView.value).toBe('output');
  });

  it('the selected session ending closes its terminal view, keeps the note, and gives the keys back', () => {
    select('shop');
    press('t');
    termNote.value = "The session's window has closed.";
    const shop = sessions.value.find((s) => s.id === 'shop') as Session;
    applyEvent({ type: 'session.updated', session: { ...shop, status: 'ended' } });
    expect(mainView.value).toBe('output');
    expect(termNote.value).toBe("The session's window has closed.");
    // Ended, shop moves to the end of the list; K moves on from it.
    press('k');
    expect(selectedId.value).not.toBe('shop');
  });

  it('a terminal view left on an ended session never swallows the keys', () => {
    ended();
    select('docs');
    mainView.value = 'terminal';
    press('k');
    expect(selectedId.value).toBe('footer');
  });

  it('the selected session going away picks another, with the output and no old note', () => {
    select('shop');
    press('t');
    termNote.value = "The session's window has closed.";
    applyEvent({ type: 'session.removed', id: 'shop' });
    expect(selectedId.value).not.toBe('shop');
    expect(mainView.value).toBe('output');
    expect(termNote.value).toBeNull();
    press('j');
    expect(selectedId.value).not.toBe('web');
  });
});

describe('installKeys: the command palette (⌘K / Ctrl+K)', () => {
  /** Dispatches a keydown and returns it, to read defaultPrevented. */
  const key = (init: KeyboardEventInit, target: EventTarget = document) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it('⌘K (metaKey) and Ctrl+K both toggle it, and the browser does not get them', () => {
    expect(key({ key: 'k', metaKey: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(true);
    key({ key: 'k', metaKey: true });
    expect(paletteOpen.value).toBe(false);
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(true);
    key({ key: 'K', ctrlKey: true });
    expect(paletteOpen.value).toBe(false);
  });

  it('Ctrl+Shift+K and Ctrl+Alt+K do nothing', () => {
    expect(key({ key: 'K', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: 'k', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
  });

  it('a held Ctrl+K toggles once (the repeats are still kept from the browser)', () => {
    key({ key: 'k', ctrlKey: true });
    expect(key({ key: 'k', ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(true);
  });

  it('works while typing, and on a non-Latin layout by its physical key', () => {
    const input = document.body.appendChild(document.createElement('input'));
    key({ key: 'k', ctrlKey: true }, input);
    expect(paletteOpen.value).toBe(true);
    key({ key: 'л', code: 'KeyK', ctrlKey: true });
    expect(paletteOpen.value).toBe(false);
  });

  it('does nothing during IME composition', () => {
    key({ key: 'k', ctrlKey: true, isComposing: true });
    expect(paletteOpen.value).toBe(false);
  });

  it('in the open terminal Ctrl+K is Claude’s: not toggled, not prevented (F14)', () => {
    select('shop');
    mainView.value = 'terminal';
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
  });

  it('on the login screen the browser keeps Ctrl+K', () => {
    authRequired.value = true;
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
  });

  it('opens over the New task form', () => {
    newTaskOpen.value = true;
    key({ key: 'k', ctrlKey: true });
    expect(paletteOpen.value).toBe(true);
  });

  it('board shortcuts are off while it is open', async () => {
    paletteOpen.value = true;
    select('web');
    press('j');
    press('n');
    press('Escape');
    expect(selectedId.value).toBe('web');
    expect(newTaskOpen.value).toBe(false);
    select('shop');
    press('x');
    press('x');
    await flush();
    expect(posted()).toEqual([]);
  });
});

describe('installKeys: the palette key per platform (R97) and over the terminal', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it('on a Mac only ⌘K toggles: Ctrl+K passes through, so a field keeps kill-line', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      const input = document.body.appendChild(document.createElement('input'));
      expect(key({ key: 'k', ctrlKey: true }, input).defaultPrevented).toBe(false);
      expect(paletteOpen.value).toBe(false);
      expect(key({ key: 'k', ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false);
      expect(key({ key: 'k', metaKey: true }, input).defaultPrevented).toBe(true);
      expect(paletteOpen.value).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('off a Mac Ctrl+K stays', () => {
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(true);
  });

  it('a palette open over the terminal: its key closes it (prevented), a held one does nothing', () => {
    select('shop');
    mainView.value = 'terminal';
    paletteOpen.value = true;
    expect(key({ key: 'k', ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(true);
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(paletteOpen.value).toBe(false);
    // Closed, the key is Claude's again: it never opens one over the terminal.
    expect(key({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(paletteOpen.value).toBe(false);
  });
});
