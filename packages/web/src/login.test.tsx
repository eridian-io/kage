import { demoSessions, type Session } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answer, apiDelete, login } from './api.ts';
import { Board } from './main.tsx';
import { applyEvent, authRequired, connection, hadSnapshot, sessions } from './store.ts';

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readonly url: string;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

const TOKEN = 'a-secret-of-16-chars';
let replies: number[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  replies = [];
  fetchMock = vi.fn(async () => {
    const status = replies.shift() ?? 204;
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify({ error: 'x' }), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  hadSnapshot.value = false;
  sessions.value = [];
  authRequired.value = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  authRequired.value = false;
});

const q = <T extends Element>(c: Element, sel: string): T => {
  const el = c.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  return el as T;
};

function signIn(c: Element, token = TOKEN) {
  fireEvent.input(q<HTMLInputElement>(c, 'input'), { target: { value: token } });
  fireEvent.submit(q(c, 'form'));
}

describe('the login screen', () => {
  it('shows the top bar with the logo and wordmark only, and the form', () => {
    // A 401 after a snapshot (an expired cookie) shows the same screen: nothing of the board.
    applyEvent({
      type: 'snapshot',
      host: 'my-pc',
      streamId: 's',
      projectsRoot: '/p',
      sessions: demoSessions(Date.UTC(2026, 10, 21, 12)),
    });
    const { container } = render(<Board />);
    const top = q(container, '.k-top');
    expect(top.textContent).toBe('kage');
    expect(top.querySelector('.k-host, .k-counts, .k-k')).toBeNull();
    expect(container.querySelector('.k-side, .k-reconnect, .k-aside')).toBeNull();
    const form = q(container, 'form.k-login');
    expect(form.textContent).toContain('This Kage needs its access token.');
    const input = q<HTMLInputElement>(form, 'input');
    expect(input.type).toBe('password');
    expect(input.placeholder).toBe('Access token');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    const button = q<HTMLButtonElement>(form, 'button');
    expect(button.textContent).toBe('Sign in');
    expect(button.type).toBe('submit');
  });

  it('focuses the token field', async () => {
    const { container } = render(<Board />);
    const field = q<HTMLInputElement>(container, 'form.k-login input');
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('posts the token once to /api/login with X-Kage', async () => {
    const { container } = render(<Board />);
    signIn(container);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/login');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Kage']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });

  it("a wrong token shows That token isn't right.", async () => {
    replies = [401];
    const { container } = render(<Board />);
    signIn(container, 'wrong-token-but-long');
    await waitFor(() => expect(container.textContent).toContain("That token isn't right."));
    expect(authRequired.value).toBe(true);
    expect(FakeEventSource.all).toHaveLength(0);
  });

  it('429 shows Too many tries. Wait a minute and try again.', async () => {
    replies = [429];
    const { container } = render(<Board />);
    signIn(container);
    await waitFor(() =>
      expect(container.textContent).toContain('Too many tries. Wait a minute and try again.'),
    );
  });

  it('success sets authRequired false and reconnects the stream', async () => {
    replies = [204];
    const { container } = render(<Board />);
    signIn(container);
    await waitFor(() => expect(authRequired.value).toBe(false));
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0]?.url).toBe('/api/events');
    expect(container.querySelector('form.k-login')).toBeNull();
  });
});

describe('api', () => {
  it('login maps 204, 401, 429, other statuses and network errors', async () => {
    replies = [204, 401, 429, 500];
    expect(await login(TOKEN)).toBe('ok');
    expect(await login(TOKEN)).toBe('wrong');
    expect(await login(TOKEN)).toBe('limited');
    expect(await login(TOKEN)).toBe('error');
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await login(TOKEN)).toBe('error');
  });

  it('answer posts the option and the question text the card showed (R36)', async () => {
    replies = [204];
    connection.value = 'live';
    const s = {
      ...demoSessions(0)[0],
      id: 'ext-@3',
      question: { text: 'Do you want to proceed? — npm test', options: ['Yes', 'No'] },
    } as Session;
    expect(await answer(s, 2)).toBe(true);
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('/api/sessions/ext-%403/answer');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Kage']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({
      option: 2,
      question: 'Do you want to proceed? — npm test',
    });
  });

  it('a 401 from any call returns the board to the login screen (F18)', async () => {
    authRequired.value = false;
    replies = [401];
    expect((await apiDelete('/api/sessions/x')).status).toBe(401);
    expect(authRequired.value).toBe(true);
  });
});
