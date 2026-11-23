import type { Cause, Session, SessionStatus } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLazy, notifyChunk } from './lazy.tsx';
import { installLink } from './link.ts';
import { enableNotifications, installNotify, notifyState } from './notify.ts';
import { applyEvent, hadSnapshot, select, selectedId, selectWhenSeen } from './store.ts';

/** A fake `Notification`: records each one made, its close and its click handler. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static made: FakeNotification[] = [];
  static asked = 0;
  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.asked++;
    FakeNotification.permission = 'granted';
    return Promise.resolve('granted');
  }
  closed = false;
  onclick: ((e: Event) => void) | null = null;
  readonly title: string;
  readonly options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.made.push(this);
  }
  close() {
    this.closed = true;
  }
}

interface FakeWin {
  isSecureContext: boolean;
  Notification?: typeof FakeNotification;
  document: { title: string; hidden: boolean; hasFocus: () => boolean };
  location: { hash: string; pathname: string; search: string };
  history: { state: unknown; replaceState: (s: unknown, t: string, url: string) => void };
  focus: () => void;
  focused: number;
  focusedPage: boolean;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  dispatchEvent: EventTarget['dispatchEvent'];
}

function fakeWin(o: { secure?: boolean; notification?: boolean; hash?: string } = {}): FakeWin {
  const t = new EventTarget();
  const w: FakeWin = {
    isSecureContext: o.secure ?? true,
    document: { title: 'kage', hidden: false, hasFocus: () => w.focusedPage },
    location: { hash: o.hash ?? '', pathname: '/', search: '' },
    history: {
      state: null,
      replaceState: (_s, _t, url) => {
        w.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
      },
    },
    focused: 0,
    focusedPage: true,
    focus: () => {
      w.focused++;
    },
    addEventListener: t.addEventListener.bind(t),
    removeEventListener: t.removeEventListener.bind(t),
    dispatchEvent: t.dispatchEvent.bind(t),
  };
  if (o.notification ?? true) w.Notification = FakeNotification;
  return w;
}

const session = (id: string, status: SessionStatus, over: Partial<Session> = {}): Session =>
  ({
    id,
    project: `p-${id}`,
    task: `Task of ${id}`,
    status,
    external: false,
    archived: false,
    pinned: false,
    lines: [],
    ports: [],
    files: [],
    filesTotal: 0,
    ...over,
  }) as Session;

const snapshot = (list: Session[]) =>
  applyEvent({
    type: 'snapshot',
    auth: false,
    demo: false,
    host: 'my-pc',
    streamId: 'st',
    projectsRoot: '/p',
    sessions: list,
    archived: 0,
  });
/** A transition's frame, as the server sends it for a live move (F8: the helper gains `cause`). */
const update = (s: Session, cause: Cause = 'live') =>
  applyEvent({ type: 'session.updated', session: s, cause });
/** A frame that carries no transition (a now line, a count, a pin; the demo): no `cause`. */
const frame = (s: Session) => applyEvent({ type: 'session.updated', session: s });

let stop: (() => void) | null = null;
/** The link follow (first load, link.ts) and notify (its lazy chunk), as main.tsx has them. */
const install = (w: FakeWin) => {
  const unlink = installLink(w as unknown as Window);
  const unnotify = installNotify(w as unknown as Window);
  stop = () => {
    unlink();
    unnotify();
  };
  return w;
};
/** Lets the lazy notify-show chunk load and run. */
const settle = () => vi.dynamicImportSettled();
/** Hidden: the tab is in the background. */
const hide = (w: FakeWin) => {
  w.document.hidden = true;
  w.focusedPage = false;
};

beforeEach(() => {
  FakeNotification.permission = 'granted';
  FakeNotification.made = [];
  FakeNotification.asked = 0;
  snapshot([]);
  select(null);
  // A page load: no snapshot yet.
  hadSnapshot.value = false;
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe('support', () => {
  it('an insecure page is "insecure" and never makes a notification', async () => {
    const w = install(fakeWin({ secure: false }));
    expect(notifyState.value).toBe('insecure');
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
  });
  it('a page without Notification is "unsupported"', () => {
    install(fakeWin({ notification: false }));
    expect(notifyState.value).toBe('unsupported');
  });
  it('mirrors the permission, and enabling asks only from "default"', async () => {
    FakeNotification.permission = 'denied';
    install(fakeWin());
    expect(notifyState.value).toBe('denied');
    await enableNotifications();
    expect(FakeNotification.asked).toBe(0);
    stop?.();
    FakeNotification.permission = 'default';
    install(fakeWin());
    expect(notifyState.value).toBe('default');
    expect(FakeNotification.asked).toBe(0); // never on load
    await enableNotifications();
    expect(FakeNotification.asked).toBe(1);
    expect(notifyState.value).toBe('granted');
  });
  it('an insecure page never asks', async () => {
    FakeNotification.permission = 'default';
    install(fakeWin({ secure: false }));
    await enableNotifications();
    expect(FakeNotification.asked).toBe(0);
  });
});

describe('notifications', () => {
  it('a hidden page: a move into needs-you makes one notification', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(1);
    const n = FakeNotification.made[0];
    expect(n?.title).toBe('p-a needs you');
    expect(n?.options).toEqual({ body: 'Task of a', tag: 'kage-a' });
    // Another frame while still waiting carries no transition, so no cause: no new move.
    frame(session('a', 'needs-you', { now: 'x' }));
    await settle();
    expect(FakeNotification.made).toHaveLength(1);
  });
  it('a visible page without focus notifies too', async () => {
    const w = install(fakeWin());
    w.focusedPage = false;
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(1);
  });
  it('a visible, focused page makes none', async () => {
    install(fakeWin());
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
  });
  it('a snapshot with a waiting session makes none', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running')]);
    snapshot([session('a', 'needs-you')]);
    expect(FakeNotification.made).toHaveLength(0);
  });
  it('without permission, none', async () => {
    FakeNotification.permission = 'default';
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
  });
  it('a session answered while the chunk loads gets none', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    update(session('a', 'running'));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
  });
  it('a new session that arrives waiting is a move', async () => {
    const w = install(fakeWin());
    hide(w);
    update(session('b', 'needs-you'));
    await settle();
    expect(FakeNotification.made.map((n) => n.options.tag)).toEqual(['kage-b']);
  });
  it('leaving needs-you closes it, by an update, a snapshot or a removal', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running'), session('b', 'running'), session('c', 'running')]);
    for (const id of ['a', 'b', 'c']) update(session(id, 'needs-you'));
    await settle();
    const [na, nb, nc] = FakeNotification.made;
    update(session('a', 'running'));
    expect([na?.closed, nb?.closed, nc?.closed]).toEqual([true, false, false]);
    snapshot([session('b', 'done'), session('c', 'needs-you')]);
    expect([nb?.closed, nc?.closed]).toEqual([true, false]);
    applyEvent({ type: 'session.removed', id: 'c' });
    expect(nc?.closed).toBe(true);
  });
  it('clicking it focuses the window, selects the session and closes it', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running'), session('b', 'running')]);
    select('a');
    update(session('b', 'needs-you'));
    await settle();
    const n = FakeNotification.made[0];
    n?.onclick?.(new Event('click'));
    expect(w.focused).toBe(1);
    expect(selectedId.value).toBe('b');
    expect(n?.closed).toBe(true);
  });
  it('the body follows N2: one line, no control or bidi characters, at most 100 characters', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'running')]);
    const task = `Fix\nthe \u202eflag\u0007 ${'x'.repeat(200)}`;
    update(session('a', 'needs-you', { task }));
    await settle();
    const body = FakeNotification.made[0]?.options.body ?? '';
    expect(body.startsWith('Fix the flag xxx')).toBe(true);
    expect(body).toHaveLength(100);
    expect(body.endsWith('…')).toBe(true);
  });
  it('an external window gets the fixed text (F3b): never its window name or folder', async () => {
    const w = install(fakeWin());
    hide(w);
    update(
      session('ext-@3', 'needs-you', { external: true, project: 'secret', task: 'ssh prod-db' }),
    );
    await settle();
    const n = FakeNotification.made[0];
    expect(n?.title).toBe('Claude needs you');
    expect(n?.options.body).toBe('A Claude session needs you on my-pc');
  });
  it('a browser that throws on construction (Android) degrades quietly', async () => {
    const w = install(fakeWin());
    w.Notification = class extends FakeNotification {
      constructor(t: string, o: NotificationOptions) {
        super(t, o);
        throw new TypeError('Illegal constructor');
      }
    };
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    await expect(settle()).resolves.toBeUndefined();
    expect(FakeNotification.made).toHaveLength(1);
  });
});

describe('notifications follow the cause (transitions Task 8)', () => {
  it('a live session.updated into needs-you notifies; reconcile, act and frames without a cause do not', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([
      session('a', 'running'),
      session('b', 'running'),
      session('c', 'running'),
      session('d', 'running'),
    ]);
    update(session('b', 'needs-you'), 'reconcile');
    update(session('c', 'needs-you'), 'act');
    frame(session('d', 'needs-you'));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
    update(session('a', 'needs-you'), 'live');
    await settle();
    expect(FakeNotification.made.map((n) => n.options.tag)).toEqual(['kage-a']);
    // A live move into another status notifies nothing.
    update(session('b', 'done'), 'live');
    await settle();
    expect(FakeNotification.made).toHaveLength(1);
    // The title still counts every waiting session, whatever moved it.
    expect(w.document.title).toBe('(3) kage');
  });
  it('a snapshot with a session already waiting notifies nothing', async () => {
    const w = install(fakeWin());
    hide(w);
    snapshot([session('a', 'needs-you')]);
    // A later frame of that session without a transition is no move either.
    frame(session('a', 'needs-you', { now: 'still waiting' }));
    await settle();
    expect(FakeNotification.made).toHaveLength(0);
    expect(w.document.title).toBe('(1) kage');
  });
});

describe('title', () => {
  it('counts the sessions that need you', () => {
    const w = install(fakeWin());
    expect(w.document.title).toBe('kage');
    snapshot([session('a', 'needs-you'), session('b', 'needs-you'), session('c', 'running')]);
    expect(w.document.title).toBe('(2) kage');
    update(session('a', 'running'));
    expect(w.document.title).toBe('(1) kage');
    update(session('b', 'done'));
    expect(w.document.title).toBe('kage');
  });
  it('works on an insecure page', () => {
    const w = install(fakeWin({ secure: false }));
    snapshot([session('a', 'needs-you')]);
    expect(w.document.title).toBe('(1) kage');
  });
  it('is written only when the count changes', () => {
    const w = install(fakeWin());
    snapshot([session('a', 'needs-you'), session('b', 'running')]);
    let writes = 0;
    let t = w.document.title;
    Object.defineProperty(w.document, 'title', {
      get: () => t,
      set: (v: string) => {
        writes++;
        t = v;
      },
    });
    for (let i = 0; i < 20; i++) update(session('b', 'running', { now: `step ${i}` }));
    applyEvent({
      type: 'session.lines',
      id: 'b',
      lines: [{ kind: 'out', text: 'x' }],
      reset: false,
    });
    expect(writes).toBe(0);
    update(session('b', 'needs-you'));
    expect(writes).toBe(1);
    expect(t).toBe('(2) kage');
  });
  it('the stopper puts the plain title back', () => {
    const w = install(fakeWin());
    snapshot([session('a', 'needs-you')]);
    stop?.();
    stop = null;
    expect(w.document.title).toBe('kage');
  });
});

describe('notify as a lazy chunk (performance P6)', () => {
  it('the title count still follows needs-you once notify has loaded', async () => {
    const w = fakeWin();
    stop = installLazy(w as unknown as Window);
    // Nothing is loaded before the first snapshot.
    expect(w.document.title).toBe('kage');
    snapshot([session('a', 'needs-you'), session('b', 'running')]);
    await notifyChunk.load();
    expect(w.document.title).toBe('(1) kage');
    update(session('b', 'needs-you'));
    expect(w.document.title).toBe('(2) kage');
    update(session('a', 'done'));
    update(session('b', 'done'));
    expect(w.document.title).toBe('kage');
  });
});

describe('#s= links', () => {
  it('a #s= link still selects its session on the first snapshot, with notify not loaded', () => {
    const w = fakeWin({ hash: '#s=s1' });
    stop = installLink(w as unknown as Window);
    expect(w.location.hash).toBe('');
    snapshot([session('s0', 'running'), session('s1', 'done')]);
    expect(selectedId.value).toBe('s1');
    expect(selectWhenSeen.value).toBeNull();
  });

  it('#s=s1 at load selects s1 once it is seen, and the hash is gone', () => {
    const w = install(fakeWin({ hash: '#s=s1' }));
    expect(w.location.hash).toBe('');
    expect(selectWhenSeen.value).toBe('s1');
    snapshot([session('s0', 'running'), session('s1', 'done')]);
    expect(selectedId.value).toBe('s1');
  });
  it('decodes the id the server encoded', () => {
    install(fakeWin({ hash: `#s=${encodeURIComponent('ext-@12')}` }));
    snapshot([session('s0', 'running'), session('ext-@12', 'running', { external: true })]);
    expect(selectedId.value).toBe('ext-@12');
  });
  it('an unknown id is ignored quietly once the snapshot lacks it', () => {
    const w = install(fakeWin({ hash: '#s=nope' }));
    snapshot([session('s0', 'running')]);
    expect(selectedId.value).toBe('s0');
    expect(selectWhenSeen.value).toBeNull();
    expect(w.location.hash).toBe('');
    // A later session with that id doesn't grab the selection.
    update(session('nope', 'running'));
    expect(selectedId.value).toBe('s0');
  });
  it('a malformed id is dropped, and never selected', () => {
    for (const hash of ['#s=%3Cimg%20src%3Dx%3E', '#s=%E0%A4%A', '#s=', `#s=${'a'.repeat(101)}`]) {
      const w = install(fakeWin({ hash }));
      expect(selectWhenSeen.value).toBeNull();
      expect(w.location.hash).toBe('');
      stop?.();
      stop = null;
    }
  });
  it('another hash is left alone', () => {
    const w = install(fakeWin({ hash: '#top' }));
    expect(w.location.hash).toBe('#top');
    expect(selectWhenSeen.value).toBeNull();
  });
  it('a hashchange selects a present session at once', () => {
    const w = install(fakeWin());
    snapshot([session('s0', 'running'), session('s1', 'running')]);
    expect(selectedId.value).toBe('s0');
    w.location.hash = '#s=s1';
    w.dispatchEvent(new Event('hashchange'));
    expect(selectedId.value).toBe('s1');
    expect(w.location.hash).toBe('');
    w.location.hash = '#s=gone';
    w.dispatchEvent(new Event('hashchange'));
    expect(selectedId.value).toBe('s1');
    expect(selectWhenSeen.value).toBeNull();
  });
});

describe('idle cost', () => {
  it('holds no timer', () => {
    vi.useFakeTimers();
    const w = install(fakeWin({ hash: '#s=a' }));
    hide(w);
    snapshot([session('a', 'running')]);
    update(session('a', 'needs-you'));
    update(session('a', 'done'));
    // select() itself owns no timer either (store's digit hold is set only by a question change).
    expect(vi.getTimerCount()).toBe(0);
  });
});
