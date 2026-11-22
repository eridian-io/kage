import { describe, expect, it } from 'vitest';
import { realRun } from './run.ts';

describe('realRun', () => {
  it('a command that is not there is missing, with code -1', async () => {
    const r = await realRun('definitely-not-a-command', []);
    expect(r.missing).toBe(true);
    expect(r.code).toBe(-1);
  });

  it('gives the exit code and the output, with no shell', async () => {
    const r = await realRun(process.execPath, [
      '-e',
      'process.stdout.write("out $HOME"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect(r).toEqual({ code: 3, stdout: 'out $HOME', stderr: 'err', missing: false });
  });

  it('exit 0 is code 0', async () => {
    const r = await realRun(process.execPath, ['-e', '']);
    expect(r.code).toBe(0);
    expect(r.missing).toBe(false);
  });

  it('passes the environment it is given', async () => {
    const r = await realRun(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.KAGE_RUN_TEST ?? "unset")'],
      { env: { ...process.env, KAGE_RUN_TEST: 'yes' } },
    );
    expect(r.stdout).toBe('yes');
  });

  it('a run past its timeout is killed and gives code -1', async () => {
    const r = await realRun(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 300,
    });
    expect(r.code).toBe(-1);
    expect(r.missing).toBe(false);
  });

  it('output past 1 MiB is cut off and gives code -1', async () => {
    const r = await realRun(process.execPath, [
      '-e',
      'process.stdout.write("x".repeat(2 * 1024 * 1024))',
    ]);
    expect(r.code).toBe(-1);
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
