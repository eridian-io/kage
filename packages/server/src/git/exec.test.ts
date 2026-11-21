import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitArgs, gitEnv, gitExec } from './exec.ts';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'kage-gitexec-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('gitExec', () => {
  it('turns fsmonitor off on every call, whatever the repo says (a repo hook can run code)', async () => {
    execFileSync('git', ['config', 'core.fsmonitor', 'touch /tmp/kage-pwned'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const { stdout } = await gitExec(['config', '--get', 'core.fsmonitor'], { cwd: repo });
    expect(stdout.trim()).toBe('false');
  });
});

describe('gitArgs and gitEnv (one copy, used by gitExec)', () => {
  it('gitArgs puts fsmonitor off before the caller’s arguments', () => {
    expect(gitArgs(['status', '-z'])).toEqual(['-c', 'core.fsmonitor=false', 'status', '-z']);
  });

  it('gitEnv drops repository pointers and sets no prompt, no optional locks, C locale', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/elsewhere/.git';
    try {
      const env = gitEnv();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
