import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitExec } from './exec.ts';

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
