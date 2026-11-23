import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepTestTmuxServers, testTmuxSocket } from './test-sockets.ts';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('testTmuxSocket', () => {
  it("names the socket after this process, so the sweep can tell when it's gone", () => {
    expect(testTmuxSocket()).toMatch(new RegExp(`^kage-test-${process.pid}-[0-9a-f]{8}$`));
    expect(testTmuxSocket()).not.toBe(testTmuxSocket());
  });

  it('no socket folder (or Windows): sweeps nothing', () => {
    expect(sweepTestTmuxServers({ dir: null })).toEqual([]);
    expect(sweepTestTmuxServers({ dir: join(tmpdir(), 'kage-no-such-folder') })).toEqual([]);
  });
});

// Real servers on sockets in a temp folder (tmux -S), never the user's /tmp/tmux-<uid>.
describe.runIf(hasTmux && process.platform !== 'win32')('sweepTestTmuxServers (real tmux)', () => {
  let dir: string;
  const start = (name: string) =>
    execFileSync('tmux', [
      '-f',
      '/dev/null',
      '-S',
      join(dir, name),
      'new-session',
      '-d',
      'sleep 60',
    ]);
  const running = (name: string) => {
    try {
      execFileSync('tmux', ['-S', join(dir, name), 'has-session'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const names = {
    gone: 'kage-test-2222-0a1b2c3d',
    harness: 'kage-test-2223-k3x9q1',
    live: 'kage-test-1111-0a1b2c3d',
    other: 'kage-rss-2222',
    mine: 'kage',
    default: 'default',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kage-sweep-'));
    for (const n of Object.values(names)) start(n);
  });
  afterEach(() => {
    for (const n of Object.values(names)) {
      try {
        execFileSync('tmux', ['-S', join(dir, n), 'kill-server'], { stdio: 'ignore' });
      } catch {
        // already ended
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('ends only test servers whose process is gone; every other name is left alone', () => {
    const killed = sweepTestTmuxServers({ dir, isAlive: (pid) => pid === 1111 });
    expect(killed.sort()).toEqual([names.gone, names.harness].sort());
    expect(running(names.gone)).toBe(false);
    expect(running(names.harness)).toBe(false);
    for (const n of [names.live, names.other, names.mine, names.default]) {
      expect(running(n), n).toBe(true);
    }
  });

  it("at the end of a run, also its own process's servers (also)", () => {
    const killed = sweepTestTmuxServers({ dir, isAlive: () => true, also: 1111 });
    expect(killed).toEqual([names.live]);
    expect(running(names.gone)).toBe(true);
  });
});
