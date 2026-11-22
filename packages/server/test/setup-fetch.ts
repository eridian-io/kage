/**
 * vitest setup (ruling N0, R85): tests never reach a real host. Any fetch to a host other than
 * loopback rejects with "Tests may not call <host>", so a bug in a guard or a config can't make
 * a live call to ntfy or anything else. Unit tests inject their own fetch; integration tests use
 * the fake ntfy server on 127.0.0.1.
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);
const realFetch = globalThis.fetch;

function hostOf(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname;
  } catch {
    return 'an unparsable URL';
  }
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const host = hostOf(input);
  if (!LOOPBACK.has(host)) throw new Error(`Tests may not call ${host}`);
  return realFetch(input, init);
};

export {};
