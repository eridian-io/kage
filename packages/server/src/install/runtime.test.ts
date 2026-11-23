import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkoutOf,
  ENTRY,
  entryFor,
  hookArgv,
  installedExe,
  KAGE_VERSION,
  runMode,
  serviceArgv,
  serviceCleanEnv,
  serviceEnv,
  tmuxServerScope,
} from './runtime.ts';

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
const isWin = process.platform === 'win32';

describe('runMode', () => {
  it('a SEA is sea, with its exe', () => {
    expect(runMode({ isSea: true, execPath: '/home/u/.local/bin/kage', entry: '' })).toEqual({
      kind: 'sea',
      exe: '/home/u/.local/bin/kage',
    });
  });

  it('an .mjs script is bundle', () => {
    const probe = { isSea: false, execPath: '/usr/bin/node', entry: '/g/kage/dist/kage.mjs' };
    expect(runMode(probe)).toEqual({
      kind: 'bundle',
      node: '/usr/bin/node',
      script: '/g/kage/dist/kage.mjs',
    });
  });

  it('a .ts script is source', () => {
    const probe = {
      isSea: false,
      execPath: '/usr/bin/node',
      entry: '/r/packages/server/src/main.ts',
    };
    expect(runMode(probe)).toEqual({
      kind: 'source',
      node: '/usr/bin/node',
      script: '/r/packages/server/src/main.ts',
    });
  });

  it('from the sources (F3): ENTRY is src/main.ts, not runtime.ts, and the mode is source', () => {
    expect(ENTRY).toBe(MAIN);
    expect(runMode()).toEqual({ kind: 'source', node: process.execPath, script: MAIN });
    expect(hookArgv(runMode())).toEqual([process.execPath, '--no-warnings', MAIN]);
  });

  it('entryFor: runtime.ts in src/install names src/main.ts; a bundle names itself', () => {
    expect(entryFor('/r/packages/server/src/install/runtime.ts')).toBe(
      join('/r/packages/server/src/install', '..', 'main.ts'),
    );
    expect(entryFor('/g/kage/dist/kage.mjs')).toBe('/g/kage/dist/kage.mjs');
  });

  it('KAGE_VERSION from the sources is 0.0.0-dev', () => {
    expect(KAGE_VERSION).toBe('0.0.0-dev');
  });
});

describe('hookArgv', () => {
  it('the SEA is exactly its stable path', () => {
    expect(hookArgv({ kind: 'sea', exe: '/home/u/.local/bin/kage' })).toEqual([
      '/home/u/.local/bin/kage',
    ]);
  });

  it('hookArgv names kage-hook.mjs beside kage.mjs, and the bundle when it is missing', () => {
    const script = join('/g', 'kage', 'dist', 'kage.mjs');
    const light = join('/g', 'kage', 'dist', 'kage-hook.mjs');
    const asked: string[] = [];
    const bundle = { kind: 'bundle', node: '/n', script } as const;
    const exists = (p: string) => {
      asked.push(p);
      return p === light;
    };
    expect(hookArgv(bundle, exists)).toEqual(['/n', '--no-warnings', light]);
    expect(asked).toEqual([light]);
    expect(hookArgv(bundle, () => false)).toEqual(['/n', '--no-warnings', script]);
    // The SEA and the sources never look for it.
    const never = () => {
      throw new Error('not asked');
    };
    expect(hookArgv({ kind: 'sea', exe: '/b/kage' }, never)).toEqual(['/b/kage']);
    expect(hookArgv({ kind: 'source', node: '/n', script: '/m.ts' }, never)).toEqual([
      '/n',
      '--no-warnings',
      '/m.ts',
    ]);
  });

  it('by default, hookArgv looks for a regular file beside the bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kage-hookargv-'));
    try {
      const script = join(dir, 'kage.mjs');
      const light = join(dir, 'kage-hook.mjs');
      writeFileSync(script, '');
      const bundle = { kind: 'bundle', node: '/n', script } as const;
      expect(hookArgv(bundle)).toEqual(['/n', '--no-warnings', script]);
      mkdirSync(light);
      expect(hookArgv(bundle)).toEqual(['/n', '--no-warnings', script]);
      rmSync(light, { recursive: true });
      writeFileSync(light, '');
      expect(hookArgv(bundle)).toEqual(['/n', '--no-warnings', light]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the bundle and the source keep --no-warnings', () => {
    expect(hookArgv({ kind: 'bundle', node: '/n', script: '/k.mjs' }, () => false)).toEqual([
      '/n',
      '--no-warnings',
      '/k.mjs',
    ]);
    expect(hookArgv({ kind: 'source', node: '/n', script: '/m.ts' })).toEqual([
      '/n',
      '--no-warnings',
      '/m.ts',
    ]);
  });
});

describe('serviceArgv', () => {
  it('sea: [exe, serve]', () => {
    expect(serviceArgv({ kind: 'sea', exe: '/b/kage' })).toEqual(['/b/kage', 'serve']);
  });

  it('the service runs the bundle with --max-semi-space-size=1', () => {
    // R91's pool size, then the young generation at 1 MB (performance P4), before the script.
    expect(serviceArgv({ kind: 'bundle', node: '/n', script: '/k.mjs' })).toEqual([
      '/n',
      '--v8-pool-size=1',
      '--max-semi-space-size=1',
      '/k.mjs',
      'serve',
    ]);
  });

  it('source: refuses with the install hint', () => {
    expect(() => serviceArgv({ kind: 'source', node: '/n', script: '/m.ts' })).toThrow(
      'Install Kage from a release, or run "pnpm build" and use node packages/server/dist/kage.mjs.',
    );
  });
});

describe('serviceEnv', () => {
  it('has PATH, the arena limit and KAGE_SERVICE, and nothing from the process environment', () => {
    const before = process.env.KAGE_TEST_LEAK;
    process.env.KAGE_TEST_LEAK = 'x';
    try {
      for (const m of [
        { kind: 'sea', exe: '/b/kage' } as const,
        { kind: 'bundle', node: '/n', script: '/k.mjs' } as const,
      ]) {
        expect(serviceEnv(m, '/usr/bin:/bin')).toEqual({
          PATH: '/usr/bin:/bin',
          MALLOC_ARENA_MAX: '2',
          KAGE_SERVICE: '1',
        });
      }
    } finally {
      if (before === undefined) delete process.env.KAGE_TEST_LEAK;
      else process.env.KAGE_TEST_LEAK = before;
    }
  });

  it("adds setup's folder settings, claude and tmux socket when set (R124), never a secret", () => {
    const env: NodeJS.ProcessEnv = {
      KAGE_CLAUDE_BIN: '/opt/claude/bin/claude',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      XDG_CONFIG_HOME: '/home/u/conf',
      XDG_STATE_HOME: '/home/u/state',
      KAGE_TMUX_SOCKET: 'agents',
      ANTHROPIC_API_KEY: 'sk-ant-invented',
      HOME: '/home/u',
      SHELL: '/bin/bash',
      NODE_OPTIONS: '--inspect',
    };
    expect(serviceEnv({ kind: 'sea', exe: '/b/kage' }, '/usr/bin', env)).toEqual({
      PATH: '/usr/bin',
      MALLOC_ARENA_MAX: '2',
      KAGE_SERVICE: '1',
      KAGE_CLAUDE_BIN: '/opt/claude/bin/claude',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      XDG_CONFIG_HOME: '/home/u/conf',
      XDG_STATE_HOME: '/home/u/state',
      KAGE_TMUX_SOCKET: 'agents',
    });
  });

  it('serviceEnv carries an absolute KAGE_SOCKET', () => {
    const m = { kind: 'sea', exe: '/b/kage' } as const;
    expect(serviceEnv(m, '/usr/bin', { KAGE_SOCKET: '/home/u/run/kage.sock' })).toEqual({
      PATH: '/usr/bin',
      MALLOC_ARENA_MAX: '2',
      KAGE_SERVICE: '1',
      KAGE_SOCKET: '/home/u/run/kage.sock',
    });
    for (const v of ['', 'kage.sock', 'run/kage.sock']) {
      expect(serviceEnv(m, '/usr/bin', { KAGE_SOCKET: v })).not.toHaveProperty('KAGE_SOCKET');
    }
  });

  it('leaves out unset, empty and relative values (a name on PATH, a relative folder)', () => {
    const env: NodeJS.ProcessEnv = {
      KAGE_CLAUDE_BIN: 'claude',
      CLAUDE_CONFIG_DIR: '',
      XDG_CONFIG_HOME: 'conf',
      KAGE_TMUX_SOCKET: '',
    };
    expect(serviceEnv({ kind: 'sea', exe: '/b/kage' }, '/usr/bin', env)).toEqual({
      PATH: '/usr/bin',
      MALLOC_ARENA_MAX: '2',
      KAGE_SERVICE: '1',
    });
  });
});

describe('serviceCleanEnv', () => {
  it('with KAGE_SERVICE=1, deletes the three keys and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      KAGE_SERVICE: '1',
      MALLOC_ARENA_MAX: '2',
      NODE_OPTIONS: '--v8-pool-size=1',
      PATH: '/bin',
    };
    serviceCleanEnv(env);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it("without KAGE_SERVICE, a user's own MALLOC_ARENA_MAX and NODE_OPTIONS stay", () => {
    const env: NodeJS.ProcessEnv = { MALLOC_ARENA_MAX: '4', NODE_OPTIONS: '--x', PATH: '/bin' };
    serviceCleanEnv(env);
    expect(env).toEqual({ MALLOC_ARENA_MAX: '4', NODE_OPTIONS: '--x', PATH: '/bin' });
    const other: NodeJS.ProcessEnv = { KAGE_SERVICE: '0', MALLOC_ARENA_MAX: '4' };
    serviceCleanEnv(other);
    expect(other).toEqual({ KAGE_SERVICE: '0', MALLOC_ARENA_MAX: '4' });
  });
});

describe('installedExe (R110-5: the stable path, not the symlink target)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kage-runtime-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the program run by name through a PATH symlink is named by the symlink', () => {
    if (isWin) return; // symlinks need privileges on Windows
    const real = join(root, 'versions', 'kage');
    mkdirSync(join(root, 'versions'));
    writeFileSync(real, '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(real, join(bin, 'kage'));
    expect(installedExe('kage', `/nonexistent:${bin}`, real)).toBe(join(bin, 'kage'));
    // Run by a path: that path, made absolute.
    expect(installedExe(join(bin, 'kage'), '', real)).toBe(join(bin, 'kage'));
  });

  it('falls back to execPath when argv1 names something else', () => {
    const real = join(root, 'kage');
    writeFileSync(real, '');
    const other = join(root, 'other');
    writeFileSync(other, '');
    expect(installedExe('kage', '', real)).toBe(real);
    expect(installedExe(other, '', real)).toBe(real);
    expect(installedExe(undefined, root, real)).toBe(real);
  });

  it('the installed file run by name is its own PATH entry', () => {
    const real = join(root, 'kage');
    writeFileSync(real, '');
    expect(installedExe('kage', root, real)).toBe(real);
  });

  it('a PATH folder others can write to, or owned by someone else, is passed over for execPath', () => {
    if (isWin) return; // no symlinks or modes to speak of
    const real = join(root, 'versions', 'kage');
    mkdirSync(join(root, 'versions'));
    writeFileSync(real, '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(real, join(bin, 'kage'));
    const self = process.getuid?.() ?? 1000;
    // Safe: ours and not group- or world-writable.
    chmodSync(bin, 0o755);
    expect(installedExe('kage', bin, real, self)).toBe(join(bin, 'kage'));
    // Writable by the group or by everyone: someone else could swap the link later.
    chmodSync(bin, 0o775);
    expect(installedExe('kage', bin, real, self)).toBe(real);
    chmodSync(bin, 0o777);
    expect(installedExe('kage', bin, real, self)).toBe(real);
    // Owned by another user (root's own folders stay fine: test:linux runs as root).
    chmodSync(bin, 0o755);
    expect(installedExe('kage', bin, real, self + 4242)).toBe(
      self === 0 ? join(bin, 'kage') : real,
    );
  });
});

describe('tmuxServerScope (R122)', () => {
  it('under the service on Linux: systemd-run --user --scope, a new unit name each call', () => {
    const scope = tmuxServerScope(true, 'linux', 42);
    expect(scope?.()).toEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=kage-tmux-42-1',
    ]);
    expect(scope?.().at(-1)).toBe('--unit=kage-tmux-42-2');
  });

  it('from a terminal, or under launchd (AbandonProcessGroup instead): none', () => {
    expect(tmuxServerScope(false, 'linux')).toBeUndefined();
    expect(tmuxServerScope(true, 'darwin')).toBeUndefined();
  });
});

describe('checkoutOf (usability U3)', () => {
  const at = (...p: string[]) => join('/w', 'kage', ...p);
  const layout = (files: string[]) => (p: string) => files.includes(p);
  const git = at('.git');
  const dist = (name: string) => at('packages', 'server', 'dist', name);

  it.each([
    ['the bundle', { kind: 'bundle', node: '/n', script: dist('kage.mjs') }],
    ['the light hook entry (F17)', { kind: 'bundle', node: '/n', script: dist('kage-hook.mjs') }],
    [
      'the sources',
      { kind: 'source', node: '/n', script: at('packages', 'server', 'src', 'main.ts') },
    ],
  ] as const)('%s in <dir>/packages/server with <dir>/.git: <dir>', (_name, m) => {
    expect(checkoutOf(m, layout([git]))).toBe(at());
  });

  it('no .git two levels above packages/server: not a checkout (the npm package, a copy)', () => {
    expect(checkoutOf({ kind: 'bundle', node: '/n', script: dist('kage.mjs') }, layout([]))).toBe(
      null,
    );
  });

  it('a bundle elsewhere, or a SEA: null, whatever .git is near', () => {
    const npm = join('/g', 'node_modules', '@eridian-io', 'kage', 'kage.mjs');
    expect(checkoutOf({ kind: 'bundle', node: '/n', script: npm }, () => true)).toBeNull();
    const web = at('packages', 'web', 'dist', 'kage.mjs');
    expect(checkoutOf({ kind: 'bundle', node: '/n', script: web }, () => true)).toBeNull();
    expect(checkoutOf({ kind: 'sea', exe: at('kage') }, () => true)).toBeNull();
  });

  it('by default it looks at the file system: a checkout with .git, run from the sources', () => {
    // A temp fixture, not this repository: a copy without .git (the test:linux container) has none.
    const root = mkdtempSync(join(tmpdir(), 'kage-checkout-'));
    try {
      const src = join(root, 'packages', 'server', 'src');
      mkdirSync(src, { recursive: true });
      const script = join(src, 'main.ts');
      writeFileSync(script, '');
      const m = { kind: 'source', node: '/n', script } as const;
      expect(checkoutOf(m)).toBeNull();
      mkdirSync(join(root, '.git'));
      expect(checkoutOf(m)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
