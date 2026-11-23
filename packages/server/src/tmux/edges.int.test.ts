import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { hasTmux, SessionMissing, TmuxClient } from './client.ts';
import { testTmuxSocket } from './test-sockets.ts';
import { serverPid } from './watcher.ts';

/** Hardening Task 10 (reliability M4, Task 6's pid minor) against a real tmux, private socket. */
const sock = testTmuxSocket();
const target = { socket: sock, configFile: '/dev/null' };
const tmux = (...a: string[]) =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' });

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
});

describe.runIf(hasTmux)('tmux edges (real tmux, private socket)', () => {
  const client = new TmuxClient({ session: 'kage', ...target });

  it('with no server: a strict listing is [] and there is no server pid', async () => {
    expect(await client.listWindows(undefined, { strict: true })).toEqual([]);
    expect(await serverPid(target, 'kage')).toBeNull();
  });

  it('a renamed session: a strict listing throws SessionMissing, a plain one lists nothing', async () => {
    await client.ensureSession();
    expect((await client.listWindows(undefined, { strict: true })).length).toBe(1);
    tmux('rename-session', '-t', '=kage', 'work');
    const err = await client.listWindows(undefined, { strict: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionMissing);
    expect((err as SessionMissing).session).toBe('kage');
    // Not strict, as before: [] for "can't find session", a throw for tmux 3.4's "can't find
    // window" (which LiveSource never asks for any more).
    const plain = await client.listWindows().catch(() => 'threw');
    expect(plain === 'threw' || (Array.isArray(plain) && plain.length === 0)).toBe(true);
    // Nothing holds "kage" now, so there is no pid for it either.
    expect(await serverPid(target, 'kage')).toBeNull();
    tmux('rename-session', '-t', '=work', 'kage');
    expect((await client.listWindows(undefined, { strict: true })).length).toBe(1);
  });

  it("serverPid is the server's pid, and a new server under the same name has another", async () => {
    const first = await serverPid(target, 'kage');
    expect(first).toMatch(/^\d+$/);
    expect(first).toBe(tmux('display-message', '-p', '#{pid}').trim());
    tmux('kill-server');
    await client.ensureSession();
    const second = await serverPid(target, 'kage');
    expect(second).toMatch(/^\d+$/);
    expect(second).not.toBe(first);
  });
});
