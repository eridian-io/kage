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
    for (const v of ['../out', '/abs', 'a/../b', '.', '', 'a b', 'x;y']) {
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
