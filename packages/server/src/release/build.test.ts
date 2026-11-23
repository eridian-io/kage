import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetName, npmTarball, TARGETS } from '../install/targets.ts';
import {
  assertSafeOut,
  buildSea,
  cleanRelease,
  hostTarget,
  isReleaseName,
  npmEnv,
  parseArgs,
  REPO,
  releaseNode,
  seaConfig,
  stageNpm,
  USAGE,
  writeSums,
  writeVersion,
} from './build.ts';

const run = promisify(execFile);
const roots: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** An invented board: index.html, one hashed script and one font. */
function fakeBoard(): string {
  const dir = temp('kage-board-');
  mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Kage test board</title>\n');
  writeFileSync(join(dir, 'app-TESTHASH1.js'), 'console.log("test board");\n');
  writeFileSync(join(dir, 'fonts', 'test.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  return dir;
}

/** A temp HOME, XDG dirs and KAGE_SOCKET for every kage a test runs (F12). */
function kageEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const r = temp('kage-env-');
  for (const d of ['home', 'config', 'state', 'run']) mkdirSync(join(r, d), { mode: 0o700 });
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(r, 'home'),
    XDG_CONFIG_HOME: join(r, 'config'),
    XDG_STATE_HOME: join(r, 'state'),
    XDG_RUNTIME_DIR: join(r, 'run'),
    KAGE_SOCKET: join(r, 'run', 'kage.sock'),
    ...extra,
  };
}

/** Runs a program with stdin from /dev/null; resolves its exit and output. */
function runProgram(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => {
      stdout += d;
    });
    c.stderr.on('data', (d) => {
      stderr += d;
    });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

describe('hostTarget', () => {
  it('names each supported platform and architecture', () => {
    expect(hostTarget('linux', 'x64')).toBe('linux-x64');
    expect(hostTarget('linux', 'arm64')).toBe('linux-arm64');
    expect(hostTarget('darwin', 'x64')).toBe('darwin-x64');
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('is null where no single executable ships', () => {
    expect(hostTarget('win32', 'x64')).toBeNull();
    expect(hostTarget('win32', 'arm64')).toBeNull();
    expect(hostTarget('linux', 'ia32')).toBeNull();
    expect(hostTarget('freebsd', 'x64')).toBeNull();
  });

  it('the release file names install.sh and kage update rely on', () => {
    expect(TARGETS.map(assetName)).toEqual([
      'kage-linux-x64.gz',
      'kage-linux-arm64.gz',
      'kage-darwin-x64.gz',
      'kage-darwin-arm64.gz',
    ]);
    expect(npmTarball('1.2.3')).toBe('eridian-io-kage-1.2.3.tgz');
  });
});

describe('seaConfig', () => {
  const board = new Map([
    ['/index.html', '/b/index.html'],
    ['/fonts/a.woff2', '/b/fonts/a.woff2'],
    ['/app-X1.js', '/b/app-X1.js'],
  ]);

  it('lists every board file under board/ plus the manifest beside the blob', () => {
    const c = seaConfig('/w/kage-sea.cjs', '/w/kage.blob', board) as Record<string, unknown>;
    expect(c.main).toBe('/w/kage-sea.cjs');
    expect(c.output).toBe('/w/kage.blob');
    expect(c.assets).toEqual({
      'board/manifest.json': join('/w', 'manifest.json'),
      'board/app-X1.js': '/b/app-X1.js',
      'board/fonts/a.woff2': '/b/fonts/a.woff2',
      'board/index.html': '/b/index.html',
    });
  });

  it('turns the warning off, keeps the code cache, and runs one V8 pool thread (R110)', () => {
    const c = seaConfig('/w/e.cjs', '/w/kage.blob', board) as Record<string, unknown>;
    expect(c.disableExperimentalSEAWarning).toBe(true);
    expect(c.useCodeCache).toBe(true);
    expect(c.useSnapshot).toBe(false);
    expect(c.execArgv).toEqual(['--v8-pool-size=1']);
  });

  it('is the same object for the same board in any order (deterministic blobs)', () => {
    const reversed = new Map([...board].reverse());
    expect(JSON.stringify(seaConfig('/e', '/w/b', reversed))).toBe(
      JSON.stringify(seaConfig('/e', '/w/b', board)),
    );
  });
});

describe('writeVersion and writeSums', () => {
  it('VERSION is the version and a newline', async () => {
    const dir = temp('kage-rel-');
    const p = await writeVersion(dir, '1.2.3');
    expect(p).toBe(join(dir, 'VERSION'));
    expect(readFileSync(p, 'utf8')).toBe('1.2.3\n');
  });

  it('SHA256SUMS: "<sha256>  <name>" lines sorted by name', async () => {
    const dir = temp('kage-rel-');
    writeFileSync(join(dir, 'b.gz'), 'bee');
    writeFileSync(join(dir, 'a.tgz'), 'ay');
    writeFileSync(join(dir, 'VERSION'), '1.2.3\n');
    const p = await writeSums(dir, ['b.gz', join(dir, 'a.tgz'), 'VERSION']);
    expect(p).toBe(join(dir, 'SHA256SUMS'));
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(readFileSync(p, 'utf8')).toBe(
      `${sha('1.2.3\n')}  VERSION\n${sha('ay')}  a.tgz\n${sha('bee')}  b.gz\n`,
    );
  });

  it('refuses a file outside the folder', async () => {
    const dir = temp('kage-rel-');
    await expect(writeSums(dir, ['../x'])).rejects.toThrow(/in the release folder/);
  });

  it.runIf(process.platform !== 'win32')('sha256sum -c accepts it in its folder', async () => {
    const dir = temp('kage-rel-');
    writeFileSync(join(dir, 'kage-linux-x64.gz'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'VERSION'), '0.1.0\n');
    await writeSums(dir, ['kage-linux-x64.gz', 'VERSION']);
    const { stdout } = await run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir });
    expect(stdout).toBe('VERSION: OK\nkage-linux-x64.gz: OK\n');
  });
});

describe('the CLI arguments', () => {
  it('--out is required; the flags are read', () => {
    expect(() => parseArgs([])).toThrow(/--out/);
    expect(parseArgs(['--out', 'dist/release'])).toEqual({
      out: 'dist/release',
      mode: 'all',
      version: undefined,
      node: undefined,
      help: false,
    });
    expect(parseArgs(['--out', 'o', '--sea-only', '--node', '/opt/node/bin/node']).node).toBe(
      '/opt/node/bin/node',
    );
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--out', 'o', '--sea-only']).mode).toBe('sea-only');
    expect(parseArgs(['--out', 'o', '--no-sea']).mode).toBe('no-sea');
    expect(parseArgs(['--out', 'o', '--version-override', '0.0.1-test.2']).version).toBe(
      '0.0.1-test.2',
    );
  });

  it('refuses --sea-only with --no-sea, unknown flags and a version that is not semver', () => {
    expect(() => parseArgs(['--out', 'o', '--sea-only', '--no-sea'])).toThrow();
    expect(() => parseArgs(['--out', 'o', '--publish'])).toThrow();
    expect(() => parseArgs(['--out', 'o', '--no-sea', '--node', 'n'])).toThrow(/--node/);
    expect(() => parseArgs(['--out', 'o', '--version-override', 'v1.2'])).toThrow(/version/);
    expect(() => parseArgs(['--out', 'o', '--version-override', '1.2.3; rm'])).toThrow(/version/);
  });

  it('the release Node is .node-version', () => {
    expect(releaseNode()).toBe(readFileSync(join(REPO, '.node-version'), 'utf8').trim());
  });

  it('the release workflow restores no cache (security M5: cache poisoning)', () => {
    const yml = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
    // F26: a YAML `cache:` key at any indent, not the word in a comment.
    expect(yml).not.toMatch(/^\s*cache:/m);
    expect(yml).not.toMatch(/^\s*-?\s*uses:\s*actions\/cache\b/m);
    expect(yml).not.toMatch(/for its cache/);
  });

  it('--help says the local Node is trusted as it is, and what --node is for', () => {
    expect(USAGE).toContain('trusted as it is');
    expect(USAGE).toContain('SHASUMS256.txt');
    expect(USAGE).toContain(`Node ${releaseNode()}`);
  });
});

describe('the release folder (R118)', () => {
  const home = resolve(tmpdir(), 'kage-fake-home');
  const repo = resolve(home, 'src', 'kage');
  const safe = (out: string) => assertSafeOut(out, { home, repo });

  it('refuses a file-system root, the home folder, the repository and what holds it', () => {
    expect(() => safe(parse(process.cwd()).root)).toThrow(/Refusing/);
    expect(() => safe(home)).toThrow(/Refusing/);
    expect(() => safe(`${home}/.`)).toThrow(/Refusing/);
    expect(() => safe(repo)).toThrow(/Refusing/);
    expect(() => safe(join(repo, '..'))).toThrow(/Refusing/);
    expect(() => safe(join(home, 'src'))).toThrow(/Refusing/);
  });

  it('accepts a folder of its own, inside the repository or elsewhere', () => {
    expect(safe(join(repo, 'dist', 'release'))).toBe(join(repo, 'dist', 'release'));
    expect(safe(join(home, 'kage-release'))).toBe(join(home, 'kage-release'));
    expect(safe(join(home, 'src', 'kage-other'))).toBe(join(home, 'src', 'kage-other'));
  });

  it('the real defaults refuse the real repository and home folder', () => {
    expect(() => assertSafeOut(REPO)).toThrow(/Refusing/);
    expect(() => assertSafeOut(homedir())).toThrow(/Refusing/);
    expect(assertSafeOut(join(REPO, 'dist', 'release'))).toBe(join(REPO, 'dist', 'release'));
  });

  it('cleaning removes only the release files and npm/, nothing else', async () => {
    const dir = temp('kage-clean-');
    const keep = ['notes.txt', 'kage-linux-x64', 'kage-windows-x64.gz', 'other.tgz', 'VERSION.bak'];
    const gone = [
      ...TARGETS.map(assetName),
      'eridian-io-kage-0.0.1.tgz',
      'eridian-io-kage-1.0.0-rc.1.tgz',
      'VERSION',
      'SHA256SUMS',
    ];
    for (const n of [...keep, ...gone]) writeFileSync(join(dir, n), n);
    mkdirSync(join(dir, 'npm', 'web'), { recursive: true });
    writeFileSync(join(dir, 'npm', 'web', 'index.html'), 'x');
    mkdirSync(join(dir, 'mine'));
    await cleanRelease(dir);
    expect(readdirSync(dir).sort()).toEqual([...keep, 'mine'].sort());
    for (const n of gone) expect(isReleaseName(n)).toBe(true);
    for (const n of keep) expect(isReleaseName(n)).toBe(false);
  });

  it('cleaning a folder that does not exist is fine', async () => {
    await expect(cleanRelease(join(temp('kage-clean-'), 'nope'))).resolves.toBeUndefined();
  });
});

describe.runIf(process.platform !== 'win32')('stageNpm (npm offline, F13)', () => {
  let out = '';
  let tgz = '';
  const version = '0.0.1-test.1';

  beforeAll(async () => {
    out = temp('kage-npm-');
    tgz = await stageNpm({ out, version, web: fakeBoard() });
  }, 120_000);

  it('packs eridian-io-kage-<version>.tgz into the folder', () => {
    expect(tgz).toBe(join(out, 'eridian-io-kage-0.0.1-test.1.tgz'));
    expect(readFileSync(tgz).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("package.json has exactly the package's fields and no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(out, 'npm', 'package.json'), 'utf8'));
    expect(pkg).toEqual({
      name: '@eridian-io/kage',
      version,
      license: 'AGPL-3.0-only',
      repository: { type: 'git', url: 'git+https://github.com/eridian-io/kage.git' },
      bin: { kage: 'kage.mjs' },
      engines: { node: '>=24.2' },
      files: ['kage.mjs', 'web/'],
    });
  });

  it('npm pack --dry-run lists only kage.mjs, web/, package.json, README.md and LICENSE', async () => {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--offline'], {
      cwd: join(out, 'npm'),
      env: npmEnv(),
    });
    const files = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]?.files.map(
      (f) => f.path,
    );
    expect(files?.sort()).toEqual([
      'LICENSE',
      'README.md',
      'kage.mjs',
      'package.json',
      'web/app-TESTHASH1.js',
      'web/fonts/test.woff2',
      'web/index.html',
    ]);
  });

  it('the staged kage.mjs prints the version, and has a node shebang for npm bin', async () => {
    const file = join(out, 'npm', 'kage.mjs');
    expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(await runProgram(process.execPath, [file, '--version'], kageEnv())).toEqual({
      code: 0,
      stdout: `${version}\n`,
      stderr: '',
    });
  });
});

/**
 * The real single executable (about 60 s): only on Linux, and only on the release Node (F20), since
 * the blob and the injected binary must be the same Node. test:install is the authoritative run.
 */
const seaReason =
  process.platform !== 'linux'
    ? 'Linux only'
    : process.version !== `v${releaseNode()}`
      ? `needs Node ${releaseNode()} (.node-version), this is ${process.version}`
      : '';
describe.runIf(seaReason === '')('buildSea (the release Node on Linux)', () => {
  let exe = '';
  let gz = '';
  const version = '0.0.1-test.1';

  beforeAll(async () => {
    const out = temp('kage-sea-');
    gz = await buildSea({ out, version, web: fakeBoard() });
    exe = join(out, 'kage');
    writeFileSync(exe, gunzipSync(readFileSync(gz)), { mode: 0o755 });
  }, 180_000);

  it('writes kage-<target>.gz', () => {
    expect(gz.endsWith(`/${assetName(hostTarget() ?? 'linux-x64')}`)).toBe(true);
  });

  it('names no build folder inside (the blob stores the main script as the config names it)', () => {
    expect(readFileSync(exe).includes(`${tmpdir()}/kage-`)).toBe(false);
  });

  it('--version prints the version', async () => {
    expect(await runProgram(exe, ['--version'], kageEnv())).toEqual({
      code: 0,
      stdout: `${version}\n`,
      stderr: '',
    });
  });

  it('hook Stop </dev/null prints nothing and exits 0', async () => {
    expect(await runProgram(exe, ['hook', 'Stop'], kageEnv())).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('serve --demo serves the embedded board: / and the hashed script, immutable', async () => {
    const port = await freePort();
    const c = spawn(exe, ['serve', '--demo'], {
      env: kageEnv({ KAGE_HOST: '127.0.0.1', KAGE_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let log = '';
      await new Promise<void>((resolve, reject) => {
        const onData = (d: Buffer) => {
          log += d;
          if (log.includes('Kage is running at')) resolve();
        };
        c.stdout.on('data', onData);
        c.stderr.on('data', onData);
        c.once('exit', (code) => reject(new Error(`serve exited (${code}):\n${log}`)));
      });
      // One V8 pool thread (execArgv): the threads of a running SEA, by name.
      const names = readdirSync(`/proc/${c.pid}/task`).map((t) =>
        readFileSync(`/proc/${c.pid}/task/${t}/comm`, 'utf8').trim(),
      );
      expect(names.filter((n) => n === 'V8Worker')).toHaveLength(1);

      const index = await fetch(`http://127.0.0.1:${port}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<title>Kage test board</title>');
      const app = await fetch(`http://127.0.0.1:${port}/app-TESTHASH1.js`);
      expect(app.status).toBe(200);
      expect(app.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await app.text()).toBe('console.log("test board");\n');
    } finally {
      c.kill('SIGTERM');
    }
  });
});
