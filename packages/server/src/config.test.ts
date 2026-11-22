import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, startupWarnings } from './config.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kage-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(content: string): Promise<string> {
  const path = join(dir, 'config.json');
  await writeFile(path, content);
  return path;
}

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: dir, ...extra });

describe('loadConfig', () => {
  it('returns the defaults for a missing file', async () => {
    const c = await loadConfig({ path: join(dir, 'none.json'), env: env() });
    expect(c.port).toBe(8080);
    expect(c.tmuxSession).toBe('kage');
    expect(c.worktreeDir).toBe('.worktrees');
    expect(c.branchPrefix).toBe('kage/');
    expect(c.autoArchive).toEqual({ onMerge: true, afterDays: 14 });
    expect(c.host).toBeNull();
    expect(c.projectsRoot).toBe(join(dir, 'projects'));
    expect(DEFAULT_CONFIG.port).toBe(8080);
  });

  it('expands ~ in projectsRoot to the home directory', async () => {
    const path = await write('{"projectsRoot":"~/code"}');
    const c = await loadConfig({ path, env: env() });
    expect(c.projectsRoot).toBe(join(dir, 'code'));
  });

  it('ignores unknown keys', async () => {
    const path = await write('{"bogus":1,"port":9000}');
    const c = await loadConfig({ path, env: env() });
    expect(c.port).toBe(9000);
    expect('bogus' in c).toBe(false);
  });

  it('merges autoArchive partially', async () => {
    const path = await write('{"autoArchive":{"afterDays":3}}');
    const c = await loadConfig({ path, env: env() });
    expect(c.autoArchive).toEqual({ onMerge: true, afterDays: 3 });
  });

  it('rejects an out-of-range port', async () => {
    const path = await write('{"port":70000}');
    const err = await loadConfig({ path, env: env() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('port');
    expect((err as Error).message).toContain('1–65535');
  });

  it('rejects a wrongly typed projectsRoot', async () => {
    const path = await write('{"projectsRoot":5}');
    const err = await loadConfig({ path, env: env() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('projectsRoot');
  });

  it('rejects wrongly typed other keys', async () => {
    for (const bad of [
      '{"host":5}',
      '{"autoArchive":{"onMerge":"yes"}}',
      '{"autoArchive":[]}',
      '[]',
    ]) {
      const path = await write(bad);
      await expect(loadConfig({ path, env: env() })).rejects.toBeInstanceOf(ConfigError);
    }
  });

  it('defaults the path to $XDG_CONFIG_HOME/kage/config.json', async () => {
    await mkdir(join(dir, 'xdg', 'kage'), { recursive: true });
    await writeFile(join(dir, 'xdg', 'kage', 'config.json'), '{"port":1111}');
    const c = await loadConfig({ env: env({ XDG_CONFIG_HOME: join(dir, 'xdg') }) });
    expect(c.port).toBe(1111);
  });

  it('falls back to ~/.config/kage/config.json', async () => {
    await mkdir(join(dir, '.config', 'kage'), { recursive: true });
    await writeFile(join(dir, '.config', 'kage', 'config.json'), '{"port":2222}');
    const c = await loadConfig({ env: env() });
    expect(c.port).toBe(2222);
  });

  it('names the file path for malformed JSON', async () => {
    const path = await write('{nope');
    const err = await loadConfig({ path, env: env() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(path);
  });

  it('defaults name to the short hostname', async () => {
    const c = await loadConfig({ path: join(dir, 'none.json'), env: env() });
    expect(c.name).toBe(hostname().split('.')[0]);
  });

  it('lets KAGE_NAME, KAGE_HOST and KAGE_PORT override the file', async () => {
    const path = await write('{"name":"a","host":"1.2.3.4","port":9000}');
    const c = await loadConfig({
      path,
      env: env({ KAGE_NAME: 'b', KAGE_HOST: '127.0.0.1', KAGE_PORT: '4321' }),
    });
    expect(c.name).toBe('b');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(4321);
  });

  it('defaults tmuxSocket to null and lets KAGE_TMUX_SOCKET set it', async () => {
    const none = join(dir, 'none.json');
    expect((await loadConfig({ path: none, env: env() })).tmuxSocket).toBeNull();
    const c = await loadConfig({ path: none, env: env({ KAGE_TMUX_SOCKET: 'kage-test-1' }) });
    expect(c.tmuxSocket).toBe('kage-test-1');
  });

  it('rejects an invalid KAGE_PORT', async () => {
    const err = await loadConfig({
      path: join(dir, 'none.json'),
      env: env({ KAGE_PORT: 'abc' }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('KAGE_PORT');
  });
});

describe('startupWarnings', () => {
  it('is quiet without a token', () => {
    expect(startupWarnings(DEFAULT_CONFIG)).toEqual([]);
  });
  it('no longer mentions the token: token login enforces it (B13)', () => {
    expect(startupWarnings({ ...DEFAULT_CONFIG, token: 'x'.repeat(16) })).toEqual([]);
  });
});

describe('token', () => {
  it('accepts "" and 16 or more characters, and refuses 1 to 15', async () => {
    const load = async (token: unknown) =>
      loadConfig({ path: await write(JSON.stringify({ token })), env: env() });
    expect((await load('')).token).toBe('');
    expect((await load('a'.repeat(16))).token).toBe('a'.repeat(16));
    for (const bad of ['a'.repeat(15), 'x']) {
      const err = await load(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toBe('token must be at least 16 characters');
      // The message never repeats the token.
      expect((err as Error).message).not.toContain(bad);
    }
    await expect(load(42)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('worktreeDir and branchPrefix', () => {
  const load = async (obj: object) =>
    loadConfig({ path: await write(JSON.stringify(obj)), env: env() });

  it('refuses unsafe worktreeDir values', async () => {
    for (const v of [
      '../out',
      '/abs',
      'a/../b',
      '.',
      '',
      'a b',
      'x;y',
      '.git',
      'a/.git/b',
      '.GIT',
    ]) {
      await expect(load({ worktreeDir: v })).rejects.toThrow(ConfigError);
    }
  });
  it('accepts safe worktreeDir values', async () => {
    for (const v of ['.worktrees', 'tmp/wt'])
      expect((await load({ worktreeDir: v })).worktreeDir).toBe(v);
  });
  it('refuses unsafe branchPrefix values', async () => {
    for (const v of ['-x/', 'a..b/', 'x.lock/', 'a b/', '.hid/', '/x', 'a//b/', '-x']) {
      await expect(load({ branchPrefix: v })).rejects.toThrow(ConfigError);
    }
  });
  it('accepts safe branchPrefix values', async () => {
    for (const v of ['kage/', '', 'team/kage/'])
      expect((await load({ branchPrefix: v })).branchPrefix).toBe(v);
  });
});

describe('ntfy keys (N4)', () => {
  const load = async (obj: object) =>
    loadConfig({ path: await write(JSON.stringify(obj)), env: env() });
  const refused = async (obj: object): Promise<string> => {
    const err = await load(obj).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  };
  const LONG_TOPIC = 'kage-topic-0123456789';

  it('defaults: ntfy.sh, no token, no done pings, no topic', async () => {
    const c = await loadConfig({ path: join(dir, 'none.json'), env: env() });
    expect(c.ntfyServer).toBe('https://ntfy.sh');
    expect(c.ntfyToken).toBe('');
    expect(c.ntfyOnDone).toBe(false);
    expect(c.ntfyTopic).toBe('');
  });

  it('ntfyTopic: "" or 1 to 64 letters, digits, - or _', async () => {
    expect((await load({ ntfyTopic: '' })).ntfyTopic).toBe('');
    expect((await load({ ntfyTopic: LONG_TOPIC })).ntfyTopic).toBe(LONG_TOPIC);
    const t64 = 'A_-9'.repeat(16);
    expect((await load({ ntfyTopic: t64 })).ntfyTopic).toBe(t64);
    for (const bad of [
      'secret topic xyz',
      'secret/topic/xyzzz',
      `secretTopic${'x'.repeat(60)}`,
      'secrét-topic-xyzzz',
      'secret\ntopic-xyzzz',
    ]) {
      const msg = await refused({ ntfyTopic: bad });
      expect(msg).toBe('ntfyTopic must be up to 64 letters, digits, - or _');
      expect(msg).not.toContain('secret');
    }
    await refused({ ntfyTopic: 42 });
  });

  it('on ntfy.sh with no token, the topic must be at least 16 characters', async () => {
    const msg = await refused({ ntfyTopic: 'secretTopic15ch' });
    expect(msg).toBe(
      'ntfyTopic must be at least 16 letters, digits, - or _ on ntfy.sh: anyone who guesses it can read your pings',
    );
    expect(msg).not.toContain('secretTopic');
    expect((await load({ ntfyTopic: 'k'.repeat(16) })).ntfyTopic).toBe('k'.repeat(16));
    // A token, or another server, lifts the rule.
    expect((await load({ ntfyTopic: 'short', ntfyToken: 'tk_abc' })).ntfyTopic).toBe('short');
    expect(
      (await load({ ntfyTopic: 'short', ntfyServer: 'https://ntfy.example.invalid' })).ntfyTopic,
    ).toBe('short');
    await refused({ ntfyTopic: 'short', ntfyServer: 'https://NTFY.SH/' });
  });

  it('ntfyServer: https anywhere; http only on loopback or the tailnet', async () => {
    for (const ok of [
      'https://ntfy.sh',
      'https://ntfy.example.invalid:8443',
      'https://ntfy.example.invalid/prefix',
      'http://127.0.0.1:2586',
      'http://localhost:2586',
      'http://[::1]:2586',
      'http://100.101.102.103',
      'http://[fd7a:115c:a1e0::1]:80',
      'http://ntfy.tail1.ts.net',
    ]) {
      expect((await load({ ntfyServer: ok })).ntfyServer).toBe(ok);
    }
    const expected =
      'ntfyServer must be an https: URL (http: only on this machine or your tailnet), with no user name, query or fragment';
    for (const bad of [
      'http://secret.example.com',
      'http://192.168.1.10',
      'http://100.128.0.1',
      'ftp://secret.example.com',
      'https://user:secret@ntfy.example.invalid',
      'https://ntfy.example.invalid/?secret=1',
      'https://ntfy.example.invalid/?',
      'https://ntfy.example.invalid/#secret',
      'not a url secret',
      '',
    ]) {
      const msg = await refused({ ntfyServer: bad });
      expect(msg).toBe(expected);
      expect(msg).not.toContain('secret');
    }
    await refused({ ntfyServer: 7 });
  });

  it('ntfyServer: a trailing / is dropped', async () => {
    expect((await load({ ntfyServer: 'https://ntfy.example.invalid/' })).ntfyServer).toBe(
      'https://ntfy.example.invalid',
    );
    expect((await load({ ntfyServer: 'https://ntfy.example.invalid/p//' })).ntfyServer).toBe(
      'https://ntfy.example.invalid/p',
    );
  });

  it('ntfyToken: "" or 1 to 128 letters, digits, - or _', async () => {
    expect((await load({ ntfyToken: '' })).ntfyToken).toBe('');
    expect((await load({ ntfyToken: 'tk_AbC-123' })).ntfyToken).toBe('tk_AbC-123');
    expect((await load({ ntfyToken: 't'.repeat(128) })).ntfyToken).toBe('t'.repeat(128));
    for (const bad of [
      'tk_secret xyz',
      'tk_secret\nxyz',
      'tk_secrét',
      `tk_secret${'x'.repeat(120)}`,
      'tk_secret!',
    ]) {
      const msg = await refused({ ntfyToken: bad });
      expect(msg).toBe('ntfyToken must be up to 128 letters, digits, - or _');
      expect(msg).not.toContain('secret');
    }
    await refused({ ntfyToken: null });
  });

  it('ntfyOnDone: a boolean', async () => {
    expect((await load({ ntfyOnDone: true })).ntfyOnDone).toBe(true);
    expect(await refused({ ntfyOnDone: 'yes' })).toBe('ntfyOnDone must be true or false');
  });

  it('malformed JSON never repeats the file’s text (a secret may be in it)', async () => {
    const path = await write('{"ntfyToken": tk_secretvalue}');
    const err = await loadConfig({ path, env: env() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(path);
    expect((err as Error).message).not.toContain('secret');
  });
});
