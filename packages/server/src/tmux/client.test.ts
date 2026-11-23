import { describe, expect, it } from 'vitest';
import {
  EXEC_OPTIONS,
  type ExecFn,
  type Key,
  parseTmuxVersion,
  SEND_TEXT_MAX_BYTES,
  TmuxClient,
  tmuxArgs,
} from './client.ts';

const fail = (stderr: string): Error => Object.assign(new Error('failed'), { stderr });

function client(
  exec: ExecFn,
  extra: { configFile?: string; env?: Record<string, string>; warn?: (m: string) => void } = {},
) {
  return new TmuxClient({ session: 'kage', socket: 'sock', exec, launchCheckMs: 0, ...extra });
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

describe('TmuxClient.listWindows (list-panes, B14)', () => {
  const TAB = '\t';
  const paneLine = (pane: string, cmd: string, active: string) =>
    ['@1', '', pane, '10', '5', active, '0', '', cmd, 'w', '/tmp'].join(TAB);

  it('lists every pane of the session with list-panes -s and picks one per window', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(3));
      return {
        stdout: `${paneLine('%1', 'bash', '1')}\n${paneLine('%2', 'bash', '0')}\n`,
        stderr: '',
      };
    });
    expect((await c.listWindows()).map((w) => w.paneId)).toEqual(['%1']);
    expect((await c.listWindows(new Set(['%2']))).map((w) => w.paneId)).toEqual(['%2']);
    expect(seen[0]?.slice(0, 5)).toEqual(['list-panes', '-s', '-t', '=kage', '-F']);
    expect(seen[0]?.[5]).toContain(`#{pane_active}${TAB}#{pane_dead}`);
  });
});

/** A fake tmux that answers each subcommand and records the argument arrays (after -u -L sock). */
function scripted(answers: Record<string, string | Error> = {}) {
  const seen: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    const a = args.slice(3);
    seen.push(a);
    const answer = answers[a[0] as string];
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? '', stderr: '' };
  };
  return { seen, c: client(exec) };
}

const LAUNCH = {
  'new-window': '@3\t%4\n',
  'list-panes': '%4\t0\tclaude\n',
};

const hostileArgv = [
  '/x/claude',
  '--settings',
  '/s',
  '--permission-mode',
  'default',
  '--',
  '$(rm -rf ~); echo',
];

const launch = (o: { argv?: string[]; env?: Record<string, string> } = {}) => ({
  name: 'x',
  cwd: '/x',
  env: o.env ?? {},
  argv: o.argv ?? ['sleep', '1'],
  kageId: 'k',
});

describe('TmuxClient.newWindow', () => {
  it('runs new-window with argument arrays, the argv after --, then tags in a second call (K1)', async () => {
    const { seen, c } = scripted(LAUNCH);
    const r = await c.newWindow({
      name: 'fix-login',
      cwd: '/repo/.worktrees/fix login',
      env: { KAGE_SOCKET: '/run/k.sock', PATH: '/usr/bin:/bin' },
      argv: hostileArgv,
      kageId: '0b7e5f0e-1111-2222-3333-444455556666',
    });
    expect(r).toEqual({ windowId: '@3', paneId: '%4' });
    expect(seen[0]).toEqual([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}\t#{pane_id}',
      '-t',
      '=kage:',
      '-n',
      'fix-login',
      '-c',
      '/repo/.worktrees/fix login',
      '-e',
      'KAGE_SOCKET=/run/k.sock',
      '-e',
      'PATH=/usr/bin:/bin',
      '--',
      ...hostileArgv,
    ]);
    // The format holds a real tab, not a backslash-t (F16).
    expect(seen[0]?.[4]).toBe(`#{window_id}${String.fromCharCode(9)}#{pane_id}`);
    // The hostile last element is one argument, after the `--` that ends tmux's options.
    expect(seen[0]?.at(-1)).toBe('$(rm -rf ~); echo');
    expect(seen[0]?.indexOf('--')).toBe(15);
    expect(seen[1]).toEqual([
      'set-option',
      '-w',
      '-t',
      '@3',
      '@kage_id',
      '0b7e5f0e-1111-2222-3333-444455556666',
    ]);
    // K4: then it checks that the window is still there and its pane alive.
    expect(seen[2]).toEqual([
      'list-panes',
      '-t',
      '@3',
      '-F',
      '#{pane_id}\t#{pane_dead}\t#{pane_current_command}',
    ]);
    expect(seen).toHaveLength(3);
  });

  it.each(['A=B', 'lower', '1ABC', '', 'A-B', 'A B'])('an env key %j throws', async (key) => {
    const { seen, c } = scripted(LAUNCH);
    await expect(c.newWindow(launch({ env: { [key]: 'v' } }))).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('an argv of fewer than two elements throws (tmux runs a lone argv[0] through $SHELL -c)', async () => {
    const { seen, c } = scripted(LAUNCH);
    await expect(c.newWindow(launch({ argv: [] }))).rejects.toThrow(TypeError);
    await expect(c.newWindow(launch({ argv: ['claude'] }))).rejects.toThrow(TypeError);
    await expect(c.newWindow(launch({ argv: ['rm -rf ~'] }))).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it.each([
    ['#(touch x)', '##(touch x)'],
    ['#{pane_id}', '##{pane_id}'],
    ['a##b', 'a####b'],
    ['plain', 'plain'],
  ])('escapes # in -n and -c (tmux expands both as formats): %j', async (raw, escaped) => {
    const { seen, c } = scripted(LAUNCH);
    await c.newWindow({
      name: raw,
      cwd: `/r/${raw}`,
      env: { K: raw },
      argv: ['sleep', raw],
      kageId: raw,
    });
    const nw = seen[0] as string[];
    expect(nw[nw.indexOf('-n') + 1]).toBe(escaped);
    expect(nw[nw.indexOf('-c') + 1]).toBe(`/r/${escaped}`);
    // -e values, argv and set-option values are not format-expanded (checked on tmux 3.4).
    expect(nw[nw.indexOf('-e') + 1]).toBe(`K=${raw}`);
    expect(nw.at(-1)).toBe(raw);
    expect(seen[1]?.at(-1)).toBe(raw);
  });

  it.each(['@3', '%4', '@3\t', 'x\ty', '@a\t%4', '@3\t%4\t%5'])(
    'a malformed new-window result %j throws',
    async (out) => {
      const { c } = scripted({ ...LAUNCH, 'new-window': out });
      await expect(c.newWindow(launch())).rejects.toThrow(/unexpected/);
    },
  );

  it('K4: a window that closed at once (argv[0] missing) throws', async () => {
    const { seen, c } = scripted({
      ...LAUNCH,
      'list-panes': Object.assign(new Error('failed'), { stderr: "can't find window: @3" }),
    });
    await expect(c.newWindow(launch({ argv: ['/no/such', '--version'] }))).rejects.toThrow(
      "the window closed at once: /no/such didn't start",
    );
    // Best-effort cleanup of whatever is left.
    expect(seen.at(-1)).toEqual(['kill-window', '-t', '@3']);
  });

  it('K4: a dead pane throws and the window is killed', async () => {
    const { seen, c } = scripted({ ...LAUNCH, 'list-panes': '%4\t1\tclaude\n' });
    await expect(c.newWindow(launch({ argv: ['/x/claude', '--version'] }))).rejects.toThrow(
      "the window closed at once: /x/claude didn't start",
    );
    expect(seen.at(-1)).toEqual(['kill-window', '-t', '@3']);
  });

  it('a failed tag on a live window kills the window and rethrows', async () => {
    const tagErr = Object.assign(new Error('failed'), { stderr: 'invalid option: @kage_id' });
    const { seen, c } = scripted({ ...LAUNCH, 'set-option': tagErr });
    await expect(c.newWindow(launch())).rejects.toBe(tagErr);
    expect(seen.at(-1)).toEqual(['kill-window', '-t', '@3']);
  });

  it('K4: a tag that fails because the window already closed reports the failed start', async () => {
    const { seen, c } = scripted({
      ...LAUNCH,
      'set-option': Object.assign(new Error('failed'), { stderr: 'no such window: @3' }),
      'list-panes': Object.assign(new Error('failed'), { stderr: "can't find window: @3" }),
    });
    await expect(c.newWindow(launch({ argv: ['/no/such', '--version'] }))).rejects.toThrow(
      "the window closed at once: /no/such didn't start",
    );
    expect(seen.at(-1)).toEqual(['kill-window', '-t', '@3']);
  });
});

describe('TmuxClient.sendKeys', () => {
  it('sends allowed keys as separate arguments', async () => {
    const { seen, c } = scripted();
    await c.sendKeys('%1', ['Escape', '2', 'Down', 'Up', 'Enter']);
    expect(seen).toEqual([['send-keys', '-t', '%1', 'Escape', '2', 'Down', 'Up', 'Enter']]);
  });

  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter', 'Escape', 'Up', 'Down'])(
    'allows %s',
    async (k) => {
      const { seen, c } = scripted();
      await c.sendKeys('%12', [k as Key]);
      expect(seen).toEqual([['send-keys', '-t', '%12', k]]);
    },
  );

  it.each(['C-c', 'C-u', '0', '10', 'Tab', 'enter', 'Left', '-l', ';', 'Escape Escape', ''])(
    'throws on the key %j',
    async (k) => {
      const { seen, c } = scripted();
      await expect(c.sendKeys('%1', [k as Key])).rejects.toThrow(TypeError);
      expect(seen).toEqual([]);
    },
  );

  it('throws on a bad pane id', async () => {
    const { seen, c } = scripted();
    await expect(c.sendKeys('1; kill-server', ['1'])).rejects.toThrow(TypeError);
    await expect(c.sendKeys('@1', ['1'])).rejects.toThrow(TypeError);
    await expect(c.sendKeys('%1 ', ['1'])).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('K8: never sends Escape twice in one call', async () => {
    const { seen, c } = scripted();
    await expect(c.sendKeys('%1', ['Escape', 'Escape'])).rejects.toThrow(TypeError);
    await expect(c.sendKeys('%1', ['Escape', '1', 'Escape'])).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('an empty key list sends nothing', async () => {
    const { seen, c } = scripted();
    await c.sendKeys('%1', []);
    expect(seen).toEqual([]);
  });
});

describe('TmuxClient.sendText', () => {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

  it('sends text literally with -l --', async () => {
    const { seen, c } = scripted();
    const text = '-x $(rm -rf ~); `echo` "q" \\ é';
    await c.sendText('%1', text);
    expect(seen).toEqual([['send-keys', '-t', '%1', '-l', '--', text]]);
  });

  it('4,500 bytes of mixed ASCII and emoji go in one -l -- call (ruling K10)', async () => {
    const { seen, c } = scripted();
    let text = '';
    while (bytes(text) < 4500) text += bytes(text) % 7 === 0 ? '🙂' : 'a';
    await c.sendText('%1', text);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 5)).toEqual(['send-keys', '-t', '%1', '-l', '--']);
    expect(seen[0]?.[5]).toBe(text);
  });

  it(`over ${SEND_TEXT_MAX_BYTES} bytes splits on code points into calls that join back`, async () => {
    const { seen, c } = scripted();
    let text = '';
    // Mixed widths push the 4-byte emoji across the chunk boundaries.
    while (bytes(text) < SEND_TEXT_MAX_BYTES * 2 + 500) text += 'abc🙂é🚀';
    await c.sendText('%1', text);
    expect(seen).toHaveLength(3);
    for (const a of seen) {
      expect(a.slice(0, 5)).toEqual(['send-keys', '-t', '%1', '-l', '--']);
      expect(bytes(a[5] as string)).toBeLessThanOrEqual(SEND_TEXT_MAX_BYTES);
      expect(a[5]).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(a[5]).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(seen.map((a) => a[5]).join('')).toBe(text);
  });

  it.each(['\n', '\r', '\t', '\x1b', '\x03', '\x00', '\x7f', 'yes\nrm -rf ~'])(
    'refuses the control character in %j (only sendKeys sends Enter or Escape)',
    async (text) => {
      const { seen, c } = scripted();
      await expect(c.sendText('%1', text)).rejects.toThrow(TypeError);
      expect(seen).toEqual([]);
    },
  );

  it('empty text sends nothing', async () => {
    const { seen, c } = scripted();
    await c.sendText('%1', '');
    expect(seen).toEqual([]);
  });

  it('throws on a bad pane id', async () => {
    const { seen, c } = scripted();
    await expect(c.sendText('1; kill-server', 'hi')).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });
});

describe('TmuxClient.windowKageId and killOwnedWindow', () => {
  it('reads @kage_id with show-options -q (K5)', async () => {
    const { seen, c } = scripted({ 'show-options': '0b7e5f0e-1111\n' });
    expect(await c.windowKageId('@3')).toBe('0b7e5f0e-1111');
    expect(seen).toEqual([['show-options', '-w', '-q', '-v', '-t', '@3', '@kage_id']]);
  });

  it('returns null for empty output', async () => {
    expect(await scripted({ 'show-options': '' }).c.windowKageId('@3')).toBeNull();
    expect(await scripted({ 'show-options': '\n' }).c.windowKageId('@3')).toBeNull();
  });

  it('killOwnedWindow re-reads @kage_id and kills only on an exact match', async () => {
    const { seen, c } = scripted({ 'show-options': 'k-1\n' });
    expect(await c.killOwnedWindow('@3', 'k-1')).toBe(true);
    expect(seen).toEqual([
      ['show-options', '-w', '-q', '-v', '-t', '@3', '@kage_id'],
      ['kill-window', '-t', '@3'],
    ]);
  });

  it.each(['k-2', '', 'K-1', 'k-10'])(
    'killOwnedWindow does not kill when the window holds %j',
    async (held) => {
      const { seen, c } = scripted({ 'show-options': `${held}\n` });
      expect(await c.killOwnedWindow('@3', 'k-1')).toBe(false);
      expect(seen.map((a) => a[0])).toEqual(['show-options']);
    },
  );

  it('killOwnedWindow is false for a window that is gone', async () => {
    const { seen, c } = scripted({
      'show-options': Object.assign(new Error('failed'), { stderr: 'no such window: @3' }),
    });
    expect(await c.killOwnedWindow('@3', 'k-1')).toBe(false);
    expect(seen.map((a) => a[0])).toEqual(['show-options']);
  });

  it('killOwnedWindow is false when the window vanishes between the re-read and the kill', async () => {
    const { seen, c } = scripted({
      'show-options': 'k-1\n',
      'kill-window': Object.assign(new Error('failed'), { stderr: "can't find window: @3" }),
    });
    expect(await c.killOwnedWindow('@3', 'k-1')).toBe(false);
    expect(seen.map((a) => a[0])).toEqual(['show-options', 'kill-window']);
  });

  it('killOwnedWindow rethrows other kill-window failures', async () => {
    const { c } = scripted({
      'show-options': 'k-1\n',
      'kill-window': Object.assign(new Error('failed'), { stderr: 'server exited unexpectedly' }),
    });
    await expect(c.killOwnedWindow('@3', 'k-1')).rejects.toThrow('failed');
  });

  it('killOwnedWindow rethrows other tmux failures', async () => {
    const { c } = scripted({
      'show-options': Object.assign(new Error('failed'), { stderr: 'server exited unexpectedly' }),
    });
    await expect(c.killOwnedWindow('@3', 'k-1')).rejects.toThrow('failed');
  });

  it('killOwnedWindow refuses an empty kage id', async () => {
    const { seen, c } = scripted({ 'show-options': '\n' });
    await expect(c.killOwnedWindow('@3', '')).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('killUntaggedWindow re-reads @kage_id and kills only a window with none', async () => {
    const { seen, c } = scripted({ 'show-options': '\n' });
    expect(await c.killUntaggedWindow('@3')).toBe(true);
    expect(seen).toEqual([
      ['show-options', '-w', '-q', '-v', '-t', '@3', '@kage_id'],
      ['kill-window', '-t', '@3'],
    ]);
    const tagged = scripted({ 'show-options': 'k-1\n' });
    expect(await tagged.c.killUntaggedWindow('@3')).toBe(false);
    expect(tagged.seen.map((a) => a[0])).toEqual(['show-options']);
    await expect(tagged.c.killUntaggedWindow('%3')).rejects.toThrow(TypeError);
  });

  it('both refuse a bad window id', async () => {
    const { seen, c } = scripted();
    await expect(c.windowKageId('=kage')).rejects.toThrow(TypeError);
    await expect(c.killOwnedWindow('@3; kill-server', 'k')).rejects.toThrow(TypeError);
    await expect(c.killOwnedWindow('%3', 'k')).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('has no public unchecked killWindow', () => {
    expect('killWindow' in scripted().c).toBe(false);
  });
});

describe('TmuxClient.ensureSession: the server in a scope of its own (R122)', () => {
  const SCOPE = ['systemd-run', '--user', '--scope', '--quiet', '--unit=kage-tmux-1'];
  function scoped(has: string, created: (cmd: string, args: string[]) => Promise<void> | void) {
    const calls: { cmd: string; args: string[] }[] = [];
    const warnings: string[] = [];
    const c = new TmuxClient({
      session: 'kage',
      socket: 'sock',
      launchCheckMs: 0,
      serverScope: () => SCOPE,
      warn: (m) => warnings.push(m),
      exec: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args.includes('has-session')) throw fail(has);
        if (args.includes('new-session')) await created(cmd, args);
        return { stdout: args.includes('new-session') ? '@0\n' : '', stderr: '' };
      },
    });
    return { c, calls, warnings };
  }

  it('no server: new-session runs through the scope command, then the tag through tmux', async () => {
    const { c, calls, warnings } = scoped('no server running on /tmp/tmux-1000/sock', () => {});
    await c.ensureSession();
    expect(calls[1]).toEqual({
      cmd: 'systemd-run',
      args: [
        ...SCOPE.slice(1),
        'tmux',
        '-u',
        '-L',
        'sock',
        'new-session',
        '-d',
        '-s',
        'kage',
        '-P',
        '-F',
        '#{window_id}',
      ],
    });
    expect(calls[2]?.cmd).toBe('tmux');
    expect(calls[2]?.args).toContain('@kage_placeholder');
    expect(warnings).toEqual([]);
  });

  it('a server that runs (only the session is missing): plain tmux, no scope', async () => {
    const { c, calls } = scoped("can't find session: kage", () => {});
    await c.ensureSession();
    expect(calls[1]?.cmd).toBe('tmux');
    expect(calls.some((x) => x.cmd === 'systemd-run')).toBe(false);
  });

  it('a scope that fails: one warning, then the plain way', async () => {
    const { c, calls, warnings } = scoped('error connecting to /tmp/tmux-1000/sock', (cmd) => {
      if (cmd === 'systemd-run') throw fail('Failed to connect to bus: No such file or directory');
    });
    await c.ensureSession();
    expect(calls.map((x) => x.cmd)).toEqual(['tmux', 'systemd-run', 'tmux', 'tmux']);
    expect(calls[2]?.args.slice(0, 4)).toEqual(['-u', '-L', 'sock', 'new-session']);
    expect(warnings).toEqual([
      "kage: couldn't start tmux in a scope of its own (Failed to connect to bus: No such file or directory), so a restart of the service will close its windows.",
    ]);
  });

  it('"duplicate session" through the scope: another caller won, nothing more', async () => {
    const { c, calls, warnings } = scoped('no server running on x', (cmd) => {
      if (cmd === 'systemd-run') throw fail('duplicate session: kage');
    });
    await c.ensureSession();
    expect(calls.map((x) => x.cmd)).toEqual(['tmux', 'systemd-run']);
    expect(warnings).toEqual([]);
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
      seen.push(args.slice(3));
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

  it('gives the first window the session env (KAGE_SOCKET) with new-session -e', async () => {
    const seen: string[][] = [];
    const c = client(
      async (_cmd, args) => {
        seen.push(args.slice(3));
        if (args.includes('has-session')) throw fail("can't find session: kage");
        if (args.includes('new-session')) return { stdout: '@7\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      { env: { KAGE_SOCKET: "/run/user/1000/it's kage.sock" } },
    );
    await c.ensureSession();
    expect(seen[1]).toEqual([
      'new-session',
      '-d',
      '-s',
      'kage',
      '-e',
      "KAGE_SOCKET=/run/user/1000/it's kage.sock",
      '-P',
      '-F',
      '#{window_id}',
    ]);
  });

  it('a failed placeholder tag is logged once and does not fail ensureSession', async () => {
    const warnings: string[] = [];
    const c = client(
      async (_cmd, args) => {
        if (args.includes('has-session')) throw fail("can't find session: kage");
        if (args.includes('new-session')) return { stdout: '@7\n', stderr: '' };
        throw fail('invalid option: @kage_placeholder');
      },
      { warn: (m) => warnings.push(m) },
    );
    await expect(c.ensureSession()).resolves.toBeUndefined();
    await expect(c.ensureSession()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('@kage_placeholder');
    expect(warnings[0]).toContain('invalid option');
  });

  it('a failed placeholder tag without a logger still does not fail ensureSession', async () => {
    const c = client(async (_cmd, args) => {
      if (args.includes('has-session')) throw fail("can't find session: kage");
      if (args.includes('new-session')) return { stdout: '@7\n', stderr: '' };
      throw fail('server exited unexpectedly');
    });
    await expect(c.ensureSession()).resolves.toBeUndefined();
  });

  it('does not tag anything when the session exists', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(3));
      return { stdout: '', stderr: '' };
    });
    await c.ensureSession();
    expect(seen).toEqual([['has-session', '-t', '=kage']]);
  });

  it('clearPlaceholder unsets the option on that window', async () => {
    const seen: string[][] = [];
    const c = client(async (_cmd, args) => {
      seen.push(args.slice(3));
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
      seen.push(args.slice(3));
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
    for (const a of seen) expect(a.slice(0, 5)).toEqual(['-u', '-f', '/dev/null', '-L', 'sock']);
  });

  it('omits -f when unset', () => {
    expect(tmuxArgs({ socket: null }, ['x'])).toEqual(['-u', 'x']);
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
