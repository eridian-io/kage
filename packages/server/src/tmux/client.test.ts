import { describe, expect, it } from 'vitest';
import { type ExecFn, TmuxClient, tmuxArgs } from './client.ts';

const fail = (stderr: string): Error => Object.assign(new Error('failed'), { stderr });

function client(exec: ExecFn, extra: { configFile?: string } = {}) {
  return new TmuxClient({ session: 'kage', socket: 'sock', exec, ...extra });
}

describe('TmuxClient.listWindows', () => {
  it.each([
    'no server running on /tmp/tmux-1000/sock',
    'error connecting to /tmp/tmux-1000/sock (No such file or directory)',
    "can't find session: kage",
    'No Server Running on x',
  ])('returns [] for "%s"', async (stderr) => {
    const c = client(async () => {
      throw fail(stderr);
    });
    expect(await c.listWindows()).toEqual([]);
  });

  it('rethrows any other failure', async () => {
    const c = client(async () => {
      throw fail('server exited unexpectedly');
    });
    await expect(c.listWindows()).rejects.toThrow('failed');
  });

  it('rethrows an error without stderr (e.g. ENOENT)', async () => {
    const c = client(async () => {
      throw new Error('spawn tmux ENOENT');
    });
    await expect(c.listWindows()).rejects.toThrow('ENOENT');
  });
});

describe('TmuxClient.ensureSession', () => {
  it('treats "duplicate session" from new-session as success', async () => {
    const c = client(async (_cmd, args) => {
      if (args.includes('has-session')) throw fail("can't find session: kage");
      throw fail('duplicate session: kage');
    });
    await expect(c.ensureSession()).resolves.toBeUndefined();
  });

  it('rethrows other new-session failures', async () => {
    const c = client(async (_cmd, args) => {
      if (args.includes('has-session')) throw fail("can't find session: kage");
      throw fail('open terminal failed');
    });
    await expect(c.ensureSession()).rejects.toThrow('failed');
  });
});

describe('configFile', () => {
  it('adds -f <file> before -L to every invocation when set', async () => {
    const seen: string[][] = [];
    const c = client(
      async (_cmd, args) => {
        seen.push(args);
        return { stdout: '', stderr: '' };
      },
      { configFile: '/dev/null' },
    );
    await c.ensureSession();
    await c.listWindows();
    await c.capturePane('%1', 5);
    await c.setKageId('@1', 'x');
    expect(seen.length).toBe(4);
    for (const a of seen) expect(a.slice(0, 4)).toEqual(['-f', '/dev/null', '-L', 'sock']);
  });

  it('omits -f when unset', () => {
    expect(tmuxArgs({ socket: null }, ['x'])).toEqual(['x']);
  });
});
