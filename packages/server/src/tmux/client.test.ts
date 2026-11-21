import { describe, expect, it } from 'vitest';
import { EXEC_OPTIONS, type ExecFn, parseTmuxVersion, TmuxClient, tmuxArgs } from './client.ts';

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

describe('TmuxClient.ensureSession placeholder (R22)', () => {
  it('tags the first window of a session it creates with @kage_placeholder', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(2));
      if (args.includes('has-session')) throw fail("can't find session: kage");
      if (args.includes('new-session')) return { stdout: '@7\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await c.ensureSession();
    expect(seen).toEqual([
      ['has-session', '-t', '=kage'],
      ['new-session', '-d', '-s', 'kage', '-P', '-F', '#{window_id}'],
      ['set-option', '-w', '-t', '@7', '@kage_placeholder', '1'],
    ]);
  });

  it('does not tag anything when the session exists', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(2));
      return { stdout: '', stderr: '' };
    });
    await c.ensureSession();
    expect(seen).toEqual([['has-session', '-t', '=kage']]);
  });

  it('clearPlaceholder unsets the option on that window', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(2));
      return { stdout: '', stderr: '' };
    });
    await c.clearPlaceholder('@7');
    expect(seen).toEqual([['set-option', '-w', '-u', '-t', '@7', '@kage_placeholder']]);
  });
});

describe('TmuxClient.setEnvironment', () => {
  it('sets a session environment variable as separate arguments', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(2));
      return { stdout: '', stderr: '' };
    });
    await c.setEnvironment('KAGE_SOCKET', "/run/user/1000/it's kage.sock");
    expect(seen).toEqual([
      ['set-environment', '-t', '=kage', 'KAGE_SOCKET', "/run/user/1000/it's kage.sock"],
    ]);
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

describe('exec options', () => {
  it('bounds every tmux call at 5 s', () => {
    expect(EXEC_OPTIONS.timeout).toBe(5000);
  });
});

describe('parseTmuxVersion', () => {
  it.each([
    ['tmux 3.4', '3.4', false],
    ['tmux 3.2', '3.2', false],
    ['tmux 3.3a', '3.3a', false],
    ['tmux next-3.6', 'next-3.6', false],
    ['tmux 10.0', '10.0', false],
    ['tmux 3.1c', '3.1c', true],
    ['tmux 2.9', '2.9', true],
    ['tmux openbsd-7.5', 'openbsd-7.5', false],
    ['tmux master', 'master', false],
  ])('%s → %s, too old: %s', (out, version, tooOld) => {
    expect(parseTmuxVersion(`${out}\n`)).toEqual({ version, tooOld });
  });
});
