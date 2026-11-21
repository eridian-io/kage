import { authRequired } from './store.ts';

/** Every state-changing request carries `X-Kage: 1`; the server refuses those without it. */
const HEADERS = { 'X-Kage': '1' };

/** Every API call goes through here: a 401 from any of them returns the board to the login screen. */
async function send(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status === 401) authRequired.value = true;
  return res;
}

export function apiDelete(path: string): Promise<Response> {
  return send(path, { method: 'DELETE', headers: HEADERS });
}

export function apiPost(
  path: string,
  body: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  return send(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
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
