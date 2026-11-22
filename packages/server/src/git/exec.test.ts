import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectStream, gitArgs, gitEnv, gitExec, gitStream } from './exec.ts';

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

describe('gitStream', () => {
  it('stops at maxBytes: a 10 MiB output with maxBytes 1 MiB resolves clipped', async () => {
    await writeFile(join(repo, 'big.bin'), Buffer.alloc(10 * 1024 * 1024, 0x61));
    const hash = execFileSync('git', ['hash-object', '-w', 'big.bin'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const r = await gitStream(['cat-file', '-p', hash], { cwd: repo, maxBytes: 1024 * 1024 });
    expect(r.clipped).toBe(true);
    expect(r.stdout.length).toBe(1024 * 1024);
  });

  it('a short output resolves whole and unclipped, with gitArgs (fsmonitor off)', async () => {
    execFileSync('git', ['config', 'core.fsmonitor', 'touch /tmp/kage-pwned'], {
      cwd: repo,
      stdio: 'pipe',
    });
    const r = await gitStream(['config', '--get', 'core.fsmonitor'], { cwd: repo, maxBytes: 1024 });
    expect(r).toEqual({ stdout: 'false\n', clipped: false });
  });

  it('rejects with stderr when git fails', async () => {
    await expect(
      gitStream(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo, maxBytes: 1024 }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('fatal') });
  });

  it('kills a child that never stops writing and resolves only once it has exited', async () => {
    // Writes forever, waiting for drain (a synchronous loop would never flush a full pipe on Linux).
    const forever =
      'const b = "x".repeat(65536); const w = () => { while (process.stdout.write(b)); process.stdout.once("drain", w); }; w();';
    const child = spawn(process.execPath, ['-e', forever]);
    const r = await collectStream(child, 256 * 1024, 10_000);
    expect(r).toEqual({ stdout: 'x'.repeat(256 * 1024), clipped: true });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('kills a child past the timeout and rejects', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    await expect(collectStream(child, 1024, 200)).rejects.toThrow(/timed out/);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
