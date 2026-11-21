import { demoSessions } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeys } from './keys.ts';
import {
  answered,
  applyEvent,
  busy,
  confirmingDelete,
  connection,
  newTaskOpen,
  releaseDigits,
  replyOpen,
  select,
  selectedId,
  sessions,
  stopArmed,
  stopSent,
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
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
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
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
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
