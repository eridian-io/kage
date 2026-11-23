import { demoSessions, type Session } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyApi, notifyState } from '../notify.ts';
import {
  applyEvent,
  archivedCount,
  archiveOpen,
  authRequired,
  busy,
  confirmingDelete,
  connection,
  focusList,
  mainView,
  newTaskOpen,
  select,
  selectedId,
  stopSent,
  toast,
  tokenSet,
} from '../store.ts';
import { type Command, commands, textOf } from './commands.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let fetchMock: ReturnType<typeof vi.fn>;

function load(list: Session[], archived = 0, auth = false) {
  applyEvent({
    type: 'snapshot',
    auth,
    demo: false,
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived,
    sessions: list,
  });
}
const titles = (g: Command['group']) =>
  commands(notifyApi)
    .filter((c) => c.group === g)
    .map((c) => c.title);
const find = (title: string) => {
  const c = commands(notifyApi).find((x) => x.title === title);
  if (!c) throw new Error(`no command ${title}`);
  return c;
};
const withSelected = (id: string, patch: Partial<Session> = {}) => {
  load(demoSessions(NOW).map((s) => (s.id === id ? { ...s, ...patch } : s)));
  select(id);
};

beforeEach(() => {
  busy.value = new Set();
  connection.value = 'live';
  stopSent.value = null;
  newTaskOpen.value = false;
  archiveOpen.value = false;
  confirmingDelete.value = false;
  mainView.value = 'output';
  notifyState.value = 'granted';
  selectedId.value = null;
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  // An empty snapshot first: a snapshot keeps a held session's files, and a test may change them.
  load([]);
  load(demoSessions(NOW));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('commands: sessions', () => {
  it('lists every session in board order, matched as project / task branch', () => {
    const list = commands(notifyApi).filter((c) => c.group === 'sessions');
    expect(list.map((c) => c.session?.id)).toEqual([
      'web',
      'shop',
      'infra',
      'rate',
      'footer',
      'docs',
    ]);
    expect(list[0]?.title).toBe('web / dark mode');
    expect(textOf(list[0] as Command)).toBe(`web / dark mode ${list[0]?.session?.branch}`);
    expect(textOf(find('New task'))).toBe('New task');
  });

  it('a jump selects the session and asks the list to focus its row', () => {
    const before = focusList.value;
    commands(notifyApi)
      .find((c) => c.session?.id === 'infra')
      ?.run();
    expect(selectedId.value).toBe('infra');
    expect(focusList.value).toBe(before + 1);
  });
});

describe('commands: this session', () => {
  it('a done Kage session offers Unpin/Pin, Archive and Delete…, but not Stop', () => {
    withSelected('rate');
    expect(titles('this session')).toEqual([
      'View diff',
      'Open the terminal',
      'Unpin',
      'Archive',
      'Delete…',
    ]);
    withSelected('docs');
    expect(titles('this session')).toContain('Pin');
    expect(titles('this session')).not.toContain('Stop');
    expect(find('Open the terminal').key).toBe('T');
    expect(find('Pin').key).toBe('S');
    expect(find('Archive').key).toBe('E');
    expect(find('Delete…').key).toBeUndefined();
  });

  it('a running one offers Stop (X), not Archive or Delete', () => {
    withSelected('shop');
    expect(titles('this session')).toEqual(['View diff', 'Open the terminal', 'Pin', 'Stop']);
    expect(find('Stop').key).toBe('X');
  });

  it('an external one offers no Pin, Archive, Resume, Stop or Delete', () => {
    withSelected('shop', { external: true });
    expect(titles('this session')).toEqual(['View diff', 'Open the terminal']);
    withSelected('docs', { external: true, status: 'ended' });
    expect(titles('this session')).toEqual(['View diff']);
  });

  it('an ended one offers Resume (U), but no terminal', () => {
    withSelected('docs', { status: 'ended' });
    expect(titles('this session')).toEqual(['View diff', 'Pin', 'Archive', 'Resume', 'Delete…']);
    expect(find('Resume').key).toBe('U');
  });

  it('no View diff while the diff is open; nothing without a selection', () => {
    withSelected('docs');
    mainView.value = 'diff';
    expect(titles('this session')).not.toContain('View diff');
    load([]);
    expect(titles('this session')).toEqual([]);
  });

  it('no View diff for a session with no files (R99), as the preview shows none', () => {
    // Files come in their own event; a snapshot keeps what that brought.
    const noFiles = (id: string) =>
      applyEvent({ type: 'session.files', id, files: [], filesTotal: 0 });
    withSelected('shop');
    noFiles('shop');
    expect(titles('this session')).toEqual(['Open the terminal', 'Pin', 'Stop']);
    withSelected('docs', { external: true, status: 'ended' });
    noFiles('docs');
    expect(titles('this session')).toEqual([]);
  });

  it('actions are disabled while busy or disconnected, and Stop while one is pending', () => {
    withSelected('shop');
    expect(find('Stop').disabled).toBeFalsy();
    busy.value = new Set(['shop']);
    expect(find('Stop').disabled).toBe(true);
    expect(find('Pin').disabled).toBe(true);
    // Moving around is never disabled.
    expect(find('View diff').disabled).toBeFalsy();
    busy.value = new Set();
    connection.value = 'reconnecting';
    expect(find('Pin').disabled).toBe(true);
    connection.value = 'live';
    stopSent.value = { id: 'shop', status: 'running' };
    expect(find('Stop').disabled).toBe(true);
  });

  it('Delete… opens the confirmation and sends nothing', () => {
    withSelected('docs');
    mainView.value = 'diff';
    find('Delete…').run();
    expect(confirmingDelete.value).toBe(true);
    expect(mainView.value).toBe('output');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('View diff and Open the terminal switch the view; Pin goes through the API', () => {
    withSelected('shop');
    find('View diff').run();
    expect(mainView.value).toBe('diff');
    find('Open the terminal').run();
    expect(mainView.value).toBe('terminal');
    find('Pin').run();
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/sessions/shop/pin']);
  });
});

describe('commands: general', () => {
  it('New task (N) opens the form', () => {
    expect(find('New task').key).toBe('N');
    find('New task').run();
    expect(newTaskOpen.value).toBe(true);
  });

  it('Show archived only with a count', () => {
    expect(titles('general')).not.toContain('Show archived');
    load(demoSessions(NOW), 2);
    expect(archivedCount.value).toBe(2);
    find('Show archived').run();
    expect(archiveOpen.value).toBe(true);
  });

  it('the notifications item follows notifyState', () => {
    for (const state of ['granted', 'denied', 'unsupported'] as const) {
      notifyState.value = state;
      expect(titles('general')).toEqual(['New task']);
    }
    notifyState.value = 'default';
    expect(titles('general')).toEqual(['New task', 'Turn on browser notifications']);
    expect(find('Turn on browser notifications').disabled).toBeFalsy();
    notifyState.value = 'insecure';
    expect(titles('general')).toEqual([
      'New task',
      'Browser notifications need HTTPS; use ntfy instead',
    ]);
    expect(find('Browser notifications need HTTPS; use ntfy instead').disabled).toBe(true);
  });

  it('Sign out is listed only when a token is set, and signing out shows the login screen', async () => {
    authRequired.value = false;
    expect(tokenSet.value).toBe(false);
    expect(titles('general')).not.toContain('Sign out');
    load(demoSessions(NOW), 0, true);
    expect(tokenSet.value).toBe(true);
    expect(titles('general').at(-1)).toBe('Sign out');
    find('Sign out').run();
    await vi.waitFor(() => expect(authRequired.value).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/logout',
      expect.objectContaining({ method: 'POST', headers: { 'X-Kage': '1' } }),
    );
    authRequired.value = false;
    // Only a 204 means the session ended. Offline, or any other answer, the session may live
    // on, so the board stays and says so instead of showing a login screen over it.
    for (const fail of [
      () => fetchMock.mockRejectedValueOnce(new TypeError('offline')),
      () => fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 })),
      () => fetchMock.mockResolvedValueOnce(new Response('Missing X-Kage header', { status: 403 })),
    ]) {
      toast.value = null;
      fail();
      find('Sign out').run();
      await vi.waitFor(() =>
        expect(toast.value).toEqual({ kind: 'note', text: "Couldn't sign out; try again." }),
      );
      expect(authRequired.value).toBe(false);
    }
    toast.value = null;
    load(demoSessions(NOW), 0, false);
    expect(titles('general')).not.toContain('Sign out');
  });
});
