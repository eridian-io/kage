/** Every state-changing request carries `X-Kage: 1`; the server refuses those without it. */
const HEADERS = { 'X-Kage': '1' };

export function apiDelete(path: string): Promise<Response> {
  return fetch(path, { method: 'DELETE', headers: HEADERS });
}

export function apiPost(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
