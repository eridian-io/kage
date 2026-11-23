/**
 * The release build (phase 6, Task 6): the single executable for this machine, the npm package,
 * VERSION and SHA256SUMS. The release workflow runs it on each runner (`--sea-only`), then once
 * more to stage the npm package and checksum the lot (`--no-sea`); `pnpm release:local` runs it
 * whole for this machine. It never publishes anything (R107): the only npm command is `npm pack`.
 *
 *   node packages/server/src/release/build.ts --out <dir> [--sea-only | --no-sea] [--node <path>]
 *     [--version-override <v>]   (--help for the details)
 *
 * Node integrity: the workflow passes `--node`, a Node it fetched from nodejs.org and checked
 * against SHASUMS256.txt and its signature (.github/node-release-keys.asc). `pnpm release:local`
 * uses the Node running it, trusted as it is.
 *
 * The single executable (host-integration §7.1 to §7.3, R110): esbuild's CommonJS entry, a blob
 * from `node --experimental-sea-config` with the code cache made here (so each target builds on
 * its own runner), injected into a copy of the same Node with postject, never stripped, gzipped.
 * The board rides along as SEA assets: `board/manifest.json` (a JSON array of URL paths) and
 * `board<path>` for each file (assets.ts seaFiles), the web build's precompressed sidecars and
 * their manifest included (boardMap).
 *
 * Determinism: the bundles, the manifest, the config, the npm tarball (npm fixes the mtimes) and
 * the gzip framing (no name, no mtime) depend only on their inputs. The blob's code cache is V8's
 * and is not promised to be byte-stable between runs; see the task report for what was measured.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs as parseCli, promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { dirFiles, PRECOMPRESSED, SEA_MANIFEST } from '../assets.ts';
import { bundleSeaEntry, bundleServer, packageVersion } from '../bundle.ts';
import {
  assetName,
  hostTarget,
  NPM_NAME,
  npmTarball,
  SUMS_FILE,
  TARGETS,
  type Target,
  VERSION_FILE,
} from '../install/targets.ts';

export { hostTarget, type Target };

const exec = promisify(execFile);
const gz = promisify(gzip);

/** The repository root (this file is packages/server/src/release/build.ts). */
export const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
/** The built board (`pnpm build`). */
export const WEB_DIST = join(REPO, 'packages', 'web', 'dist');

/** Node's SEA fuse (host-integration §7.1). */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** The Node version releases are built with: `.node-version`. */
export function releaseNode(): string {
  return readFileSync(join(REPO, '.node-version'), 'utf8').trim();
}

/** A release version: semver, optionally with a pre-release (`0.0.1-test.2`). */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The SEA config (R110): CommonJS main, the code cache, one V8 pool thread, no warning, and the
 * board as assets. `board` maps URL paths ('/index.html') to files; the manifest lives beside the
 * blob. Keys are sorted, so the same board gives the same config.
 */
export function seaConfig(entry: string, blob: string, board: Map<string, string>): object {
  const assets: Record<string, string> = { [SEA_MANIFEST]: join(dirname(blob), 'manifest.json') };
  for (const path of [...board.keys()].sort()) assets[`board${path}`] = board.get(path) as string;
  return {
    main: entry,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    execArgv: ['--v8-pool-size=1'],
    assets,
  };
}

/**
 * The board's files by URL path, sorted, as they ship in the SEA and the npm package; throws when
 * it hasn't been built. A .br or .gz rides along only when the build's manifest (PRECOMPRESSED)
 * names its file: a stale sidecar left in dist/ never ships (F16).
 */
export async function boardMap(web: string): Promise<Map<string, string>> {
  if (!existsSync(join(web, 'index.html'))) {
    throw new Error(`No board at ${web}: run pnpm build first.`);
  }
  let named: Set<string> = new Set();
  try {
    const m: unknown = JSON.parse(await readFile(join(web, PRECOMPRESSED), 'utf8'));
    if (typeof m === 'object' && m !== null && !Array.isArray(m)) named = new Set(Object.keys(m));
  } catch {
    // No manifest (a watch build): no sidecars.
  }
  const sidecar = /\.(br|gz)$/;
  const paths = (await dirFiles(web).list())
    .filter((p) => !sidecar.test(p) || named.has(p.replace(sidecar, '')))
    .sort();
  return new Map(paths.map((p) => [p, join(web, ...p.slice(1).split('/'))]));
}

/** The environment for the build's child processes: no NODE_OPTIONS reaches the blob or npm. */
function childEnv(): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _n, ...rest } = process.env;
  return rest;
}

/** npm without the network extras (F13): no update check, audit or funding call. */
export function npmEnv(): NodeJS.ProcessEnv {
  return {
    ...childEnv(),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

/**
 * npm as a program and its leading arguments. No shell (npm.cmd needs one on Windows), so on
 * Windows npm's own script runs under this Node.
 */
function npmCommand(): [string, string[]] {
  if (process.platform !== 'win32') return ['npm', []];
  return [
    process.execPath,
    [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
  ];
}

export interface SeaOptions {
  /** The release folder; the result is `<out>/kage-<target>.gz`. */
  out: string;
  /** The Node binary to build with and inject into (default: this one). */
  node?: string;
  /** `kage --version` (default: packages/server/package.json's; F16). */
  version?: string;
  /** The built board (default: packages/web/dist). */
  web?: string;
}

/** Builds the single executable for this machine and returns `<out>/kage-<target>.gz`. */
export async function buildSea(o: SeaOptions): Promise<string> {
  const target = hostTarget();
  if (target === null) throw new Error(`No single executable for ${process.platform}.`);
  const node = o.node ?? process.execPath;
  const board = await boardMap(o.web ?? WEB_DIST);
  const work = await mkdtemp(join(tmpdir(), 'kage-sea-'));
  try {
    // The main script's path as written in the config is stored in the blob, so the config names
    // it (and the blob and manifest) relative to the work folder: no temp path in the release.
    const entry = 'kage-sea.cjs';
    const blob = 'kage.blob';
    await bundleSeaEntry(join(work, entry), o.version === undefined ? {} : { version: o.version });
    await writeFile(join(work, 'manifest.json'), JSON.stringify([...board.keys()]));
    await writeFile(
      join(work, 'sea-config.json'),
      `${JSON.stringify(seaConfig(entry, blob, board), null, 2)}\n`,
    );
    await exec(node, ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      env: childEnv(),
    });

    const exe = join(work, 'kage');
    await copyFile(node, exe);
    await chmod(exe, 0o755);
    const darwin = process.platform === 'darwin';
    if (darwin) await exec('codesign', ['--remove-signature', exe]);
    const postject = createRequire(import.meta.url).resolve('postject/dist/cli.js');
    await exec(
      process.execPath,
      [
        postject,
        exe,
        'NODE_SEA_BLOB',
        join(work, blob),
        '--sentinel-fuse',
        SEA_FUSE,
        ...(darwin ? ['--macho-segment-name', 'NODE_SEA'] : []),
      ],
      { env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
    // Never strip an injected SEA (§7.1: it segfaults). macOS wants an ad-hoc signature.
    if (darwin) await exec('codesign', ['--sign', '-', exe]);

    await mkdir(o.out, { recursive: true });
    const file = join(o.out, assetName(target));
    await writeFile(file, await gz(await readFile(exe), { level: 9 }));
    return file;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface NpmOptions {
  out: string;
  version: string;
  /** The built board (default: packages/web/dist). */
  web?: string;
}

/**
 * Stages the npm package in `<out>/npm/` (kage.mjs, web/, README.md, LICENSE and package.json)
 * and packs it into `<out>/eridian-io-kage-<version>.tgz`.
 */
export async function stageNpm(o: NpmOptions): Promise<string> {
  const board = await boardMap(o.web ?? WEB_DIST);
  const dir = join(o.out, 'npm');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await bundleServer(join(dir, 'kage.mjs'), { version: o.version });
  for (const [path, src] of board) {
    const to = join(dir, 'web', ...path.slice(1).split('/'));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(src, to);
  }
  await copyFile(join(REPO, 'README.md'), join(dir, 'README.md'));
  await copyFile(join(REPO, 'LICENSE'), join(dir, 'LICENSE'));
  const pkg = {
    name: NPM_NAME,
    version: o.version,
    license: 'AGPL-3.0-only',
    // npm's provenance checks this against the repository that built it.
    repository: { type: 'git', url: 'git+https://github.com/eridian-io/kage.git' },
    bin: { kage: 'kage.mjs' },
    engines: { node: '>=24.2' },
    files: ['kage.mjs', 'web/'],
  };
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const [npm, pre] = npmCommand();
  const { stdout } = await exec(
    npm,
    [
      ...pre,
      'pack',
      '--json',
      '--offline',
      '--ignore-scripts',
      '--pack-destination',
      resolve(o.out),
    ],
    {
      cwd: dir,
      env: npmEnv(),
    },
  );
  const name = (JSON.parse(stdout) as { filename: string }[])[0]?.filename;
  if (name !== npmTarball(o.version)) throw new Error(`npm pack wrote ${name}.`);
  return join(o.out, name);
}

/** Writes `<dir>/VERSION`: the version and a newline. */
export async function writeVersion(dir: string, version: string): Promise<string> {
  const file = join(dir, VERSION_FILE);
  await writeFile(file, `${version}\n`);
  return file;
}

/**
 * Writes `<dir>/SHA256SUMS` for `files` (names in `dir`, or paths inside it): one
 * `<sha256>  <name>` line each, sorted by name, the format `sha256sum -c` reads.
 */
export async function writeSums(dir: string, files: string[]): Promise<string> {
  const lines: string[] = [];
  for (const f of files) {
    const name = relative(dir, isAbsolute(f) ? f : join(dir, f))
      .split('\\')
      .join('/');
    if (name === '' || name.startsWith('..') || isAbsolute(name)) {
      throw new Error(`${f} is not in the release folder.`);
    }
    const hash = createHash('sha256')
      .update(await readFile(join(dir, name)))
      .digest('hex');
    lines.push(`${hash}  ${name}`);
  }
  lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
  const file = join(dir, SUMS_FILE);
  await writeFile(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

export const USAGE = `Usage: node packages/server/src/release/build.ts --out <dir> [--sea-only | --no-sea]
         [--node <path>] [--version-override <version>]

  (default)     The single executable for this machine, the npm package, VERSION and SHA256SUMS.
  --sea-only    Only the single executable (each release runner).
  --no-sea      The four executables are in <dir> already: the npm package, VERSION, SHA256SUMS.
  --node        The Node binary to build the executable from (Node ${releaseNode()}, .node-version).
                The release workflow passes one it fetched from nodejs.org and checked against
                the signed SHASUMS256.txt. Without it (pnpm release:local), the Node running
                this script is used and trusted as it is: nothing downloads or checks it.
  --version-override  The version to build (for the install check only).

Before it writes, <dir> loses only the release's own files (kage-<target>.gz,
eridian-io-kage-*.tgz, VERSION, SHA256SUMS) and its npm/ folder. It refuses /, your home folder,
the repository and any folder that holds the repository.`;

export interface Args {
  out: string;
  /** all: SEA + npm + VERSION + SUMS; sea-only: the SEA; no-sea: the SEAs are in out already. */
  mode: 'all' | 'sea-only' | 'no-sea';
  version: string | undefined;
  /** The Node binary for the SEA (default: this process's). */
  node: string | undefined;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const { values } = parseCli({
    args: argv,
    options: {
      out: { type: 'string' },
      'sea-only': { type: 'boolean' },
      'no-sea': { type: 'boolean' },
      node: { type: 'string' },
      'version-override': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const help = values.help === true;
  if (!values.out && !help) throw new Error('--out <dir> is required. Try --help.');
  if (values['sea-only'] && values['no-sea']) throw new Error('--sea-only or --no-sea, not both.');
  if (values['no-sea'] && values.node)
    throw new Error('--node builds an executable; --no-sea does not.');
  const v = values['version-override'];
  if (v !== undefined && !VERSION_RE.test(v)) throw new Error(`Not a release version: ${v}`);
  return {
    out: values.out ?? '',
    mode: values['sea-only'] ? 'sea-only' : values['no-sea'] ? 'no-sea' : 'all',
    version: v,
    node: values.node,
    help,
  };
}

/** True when `a` is `b` or a folder that holds `b`. */
function holds(a: string, b: string): boolean {
  const r = relative(a, b);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * Refuses a release folder whose cleaning could hurt: a file-system root, the home folder, the
 * repository or any folder that holds it. `out` is resolved first.
 */
export function assertSafeOut(out: string, o: { home?: string; repo?: string } = {}): string {
  const dir = resolve(out);
  // Windows paths compare without case; elsewhere they are exact.
  const fold = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const d = fold(dir);
  if (
    dirname(dir) === dir ||
    d === fold(resolve(o.home ?? homedir())) ||
    holds(d, fold(resolve(o.repo ?? REPO)))
  ) {
    throw new Error(
      `Refusing to build into ${dir}: choose a folder of its own, such as dist/release.`,
    );
  }
  return dir;
}

/** A release file build.ts writes, by name. */
export function isReleaseName(name: string): boolean {
  return (
    TARGETS.some((t) => assetName(t) === name) ||
    /^eridian-io-kage-.+\.tgz$/.test(name) ||
    name === VERSION_FILE ||
    name === SUMS_FILE
  );
}

/** Removes the release's own files and npm/ from `dir`, nothing else. */
export async function cleanRelease(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const n of names) {
    if (isReleaseName(n)) await rm(join(dir, n), { force: true });
  }
  await rm(join(dir, 'npm'), { recursive: true, force: true });
}

/** `node --version` of a Node binary, without the v. */
async function versionOf(node: string): Promise<string> {
  const { stdout } = await exec(node, ['--version'], { env: childEnv() });
  // The first line only: a program that isn't Node may print a page.
  const [first = ''] = stdout.trim().split(/\r?\n/);
  return first.replace(/^v/, '');
}

export async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return;
  }
  const version = a.version ?? packageVersion();
  if (!VERSION_RE.test(version)) throw new Error(`Not a release version: ${version}`);
  const out = assertSafeOut(a.out);
  const node = a.node === undefined ? undefined : resolve(a.node);
  if (a.mode !== 'no-sea') {
    const v = node === undefined ? process.version.slice(1) : await versionOf(node);
    if (v !== releaseNode()) {
      throw new Error(
        `Build the single executable with Node ${releaseNode()} (.node-version); this is ${v}.`,
      );
    }
  }
  const sea = () => buildSea({ out, version, ...(node === undefined ? {} : { node }) });

  if (a.mode === 'sea-only') {
    console.log(await sea());
    return;
  }
  let seas: string[];
  if (a.mode === 'all') {
    // Only the release's own files go, so SHA256SUMS never covers a stale one.
    await cleanRelease(out);
    seas = [await sea()];
  } else {
    // The workflow's stage job: every target's SEA came from its own runner.
    const missing = TARGETS.map(assetName).filter((n) => !existsSync(join(out, n)));
    if (missing.length > 0) throw new Error(`Missing in ${out}: ${missing.join(', ')}`);
    seas = TARGETS.map((t) => join(out, assetName(t)));
  }
  const files = [...seas, await stageNpm({ out, version }), await writeVersion(out, version)];
  await writeSums(out, files);
  for (const f of [...files, join(out, SUMS_FILE)]) console.log(f);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
