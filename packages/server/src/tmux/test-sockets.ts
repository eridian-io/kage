/**
 * For tests only (nothing in Kage imports this): the private tmux servers tests start, and the
 * sweep that ends the ones a test run left behind.
 *
 * Every test tmux server runs on `tmux -L kage-test-<pid>-<random>`, where <pid> is the process
 * that named it (a vitest worker, or a Playwright worker for e2e/harness.ts). Each test kills
 * its own server in its teardown, which runs on failure too. A worker that dies (killed for
 * memory, a run stopped half-way) runs no teardown, so the sweep ends any server whose naming
 * process is gone. It never touches another name: not the default socket, not the user's own
 * servers, not a test server whose process is still running (another checkout's run).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** `kage-test-<pid>-<hex>`, and the e2e harness's `kage-test-<pid>-<base36>`. */
const TEST_SOCKET = /^kage-test-(\d+)-[0-9a-z]+$/;

/** A new private socket name for one test tmux server. */
export function testTmuxSocket(): string {
  return `kage-test-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The folder tmux keeps this user's sockets in: `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`. */
export function tmuxSocketDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  return join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`);
}

/**
 * Kills the tmux server of every test socket whose naming process is gone (or is `also`, the
 * calling process at the end of its own run), and returns those names. Quiet and safe without
 * tmux, without the folder, and on Windows.
 */
export function sweepTestTmuxServers(
  o: { dir?: string | null; also?: number; isAlive?: (pid: number) => boolean } = {},
): string[] {
  const dir = o.dir === undefined ? tmuxSocketDir() : o.dir;
  if (dir === null) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const isAlive = o.isAlive ?? alive;
  const killed: string[] = [];
  for (const name of names) {
    const m = TEST_SOCKET.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== o.also && isAlive(pid)) continue;
    try {
      execFileSync('tmux', ['-S', join(dir, name), 'kill-server'], { stdio: 'ignore' });
      killed.push(name);
    } catch {
      // No server behind the socket (a stale file), or no tmux: nothing to end.
    }
  }
  return killed;
}
