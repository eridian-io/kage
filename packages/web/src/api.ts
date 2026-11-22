import type { Session } from '@kage/shared';
import {
  actionError,
  authRequired,
  busy,
  connection,
  isAnswered,
  markAnswered,
  stopPending,
  stopSent,
} from './store.ts';

export const NO_ANSWER = "Kage didn't answer.";

/** Every state-changing request carries `X-Kage: 1`; the server refuses those without it. */
const HEADERS = { 'X-Kage': '1' };

/** Every API call goes through here: a 401 from any of them returns the board to the login screen. */
async function send(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status === 401) authRequired.value = true;
  return res;
}

/** A read, such as GET /api/projects (fetched only when the New task form opens). */
export function apiGet(path: string): Promise<Response> {
  return send(path, { method: 'GET' });
}

/** A DELETE with a JSON body: a session delete carries the counts its confirmation showed. */
export function apiDelete(path: string, body: unknown): Promise<Response> {
  return send(path, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A POST with a JSON body; without a body (Stop) it sends none. */
export function apiPost(
  path: string,
  body?: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  return send(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

/** The server's one-sentence error, or a fallback naming the status. */
export async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON: fall through.
  }
  return `Kage answered ${res.status}.`;
}

/**
 * GET /api/auth: 204 when signed in (or no token is set), 401 when not. Unlike the other calls it
 * leaves `authRequired` to its caller (the stream), which ignores the answer once it has stopped.
 */
export function authStatus(): Promise<number> {
  return fetch('/api/auth').then((r) => r.status);
}

export async function login(token: string): Promise<'ok' | 'wrong' | 'limited' | 'error'> {
  try {
    const { status } = await apiPost('/api/login', { token });
    if (status === 204) return 'ok';
    if (status === 401) return 'wrong';
    return status === 429 ? 'limited' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * Sends an answer, reply or stop for a session. One action per session at a time, and only while
 * live: the result arrives as an event. True on success; otherwise the server's sentence goes to
 * actionError (a 401 has sent the board to the login screen instead).
 */
export async function act(
  id: string,
  path: 'answer' | 'reply' | 'stop',
  body?: unknown,
): Promise<boolean> {
  if (busy.value.has(id) || connection.value !== 'live') return false;
  busy.value = new Set(busy.value).add(id);
  actionError.value = null;
  let error: string | null = null;
  try {
    const res = await apiPost(`/api/sessions/${encodeURIComponent(id)}/${path}`, body);
    if (res.ok) return true;
    if (res.status !== 401) error = await errorOf(res);
  } catch {
    error = NO_ANSWER;
  } finally {
    const left = new Set(busy.value);
    left.delete(id);
    busy.value = left;
  }
  if (error !== null) actionError.value = { id, text: `Couldn't send: ${error}` };
  return false;
}

/**
 * Answers option n (1-based) of the session's question, with the question text the card showed
 * (R36): the server answers only that question. Options it lacks or disables (R39), and a
 * question already answered from here, send nothing.
 */
export async function answer(s: Session, n: number): Promise<boolean> {
  const q = s.question;
  if (!q || isAnswered(s) || n < 1 || n > q.options.length) return false;
  if (q.disabledOptions?.includes(n)) return false;
  const ok = await act(s.id, 'answer', { option: n, question: q.text });
  if (ok) markAnswered(s);
  return ok;
}

/** Stops the session; once the server accepts, Stop stays off until the status changes. */
export async function stop(s: Session): Promise<boolean> {
  if (stopPending(s)) return false;
  const ok = await act(s.id, 'stop');
  if (ok) stopSent.value = { id: s.id, status: s.status };
  return ok;
}
