/**
 * `kage update` (phase 6, Task 7): replaces the single executable with the latest release's, then
 * restarts the service. Only when asked: Kage never checks for updates in the background.
 *
 * Safe at every step:
 * - downloads over HTTPS only (plain http only on loopback, for tests), from KAGE_RELEASE_BASE or
 *   the latest GitHub release, which never points at a pre-release (R118: pre-releases ship with
 *   --prerelease, so they are reached only by pointing KAGE_RELEASE_BASE at their tag);
 * - reads VERSION, SHA256SUMS and the asset from one release: the tag latest/download's first
 *   redirect names (pinRelease), so a release published mid-update can't mix files;
 * - checks the download's SHA-256 against its line in SHA256SUMS, unpacks it next to the old
 *   program (the same folder, so the same file system), checks the new program answers
 *   `--version` with the release's version, and only then renames it over the old one;
 * - any failure before that rename leaves the old program and the running service as they were;
 * - one update at a time: a lock file in the program's folder (a stale one, whose process is gone,
 *   is taken over).
 *
 * SHA256SUMS over HTTPS protects against corruption and truncation, not against a compromised
 * release host; `gh attestation verify` checks a release's authenticity by hand.
 *
 * Release names and targets come from targets.ts, never release/build.ts (F4: no esbuild here).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { socketPath } from '../hooks/cli.ts';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import { LAUNCHD_LABEL } from './launchd.ts';
import { checkoutOf, KAGE_VERSION, type RunMode } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';
import { fetchStatus } from './status.ts';
import { SYSTEMD_UNIT } from './systemd.ts';
import {
  hostTarget,
  NPM_NAME,
  SUMS_FILE,
  type Target,
  assetName as targetAsset,
  VERSION_FILE,
} from './targets.ts';

export const RELEASE_BASE = 'https://github.com/eridian-io/kage/releases/latest/download';

/** A reason the update stopped before anything changed; its message is the fixed words. */
export class ReleaseError extends Error {
  override name = 'ReleaseError';
}

const MAX_DOWNLOAD = 200 * 1024 * 1024;
const MAX_PROGRAM = 512 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
/** A download stops after this long without a byte (the idle limit)... */
const IDLE_MS = 30_000;
/** ...and after this long in all, however it trickles. */
const TOTAL_MS = 15 * 60_000;
const LOCK_FILE = '.kage-update.lock';
const VERSION_CHECK_MS = 10_000;
const WAIT_MS = 15_000;
const POLL_MS = 250;
const ROOT = 'Run Kage as your own user, not root.';
const BUNDLE = `This Kage came from npm or a build. Update it with: npm install -g ${NPM_NAME}@latest`;
/** Usability U3: a checkout updates with git and a build, then restarts the service. */
const checkoutUpdate = (dir: string) =>
  `This Kage runs from a checkout in ${dir}. Update it with: cd ${shellWord(dir)} && git pull && pnpm install && pnpm build, then kage restart.`;

/**
 * The folder a non-SEA Kage updates in: its checkout; for the sources without `.git`, the
 * folder that holds packages/ all the same; null for a bundle outside a checkout (npm).
 */
function checkoutFor(mode: Exclude<RunMode, { kind: 'sea' }>): string | null {
  const dir = checkoutOf(mode);
  if (dir !== null || mode.kind === 'bundle') return dir;
  return join(dirname(mode.script), '..', '..', '..');
}

function loopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

/** https anywhere, or plain http on loopback (tests and Task 9's local release). */
function allowed(u: URL): boolean {
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname));
}

/** KAGE_RELEASE_BASE, or RELEASE_BASE; always ending in `/`, so names resolve inside it. */
export function releaseBase(env: NodeJS.ProcessEnv): URL {
  const raw = env.KAGE_RELEASE_BASE?.trim() || RELEASE_BASE;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ReleaseError('KAGE_RELEASE_BASE must be an https URL');
  }
  if (!allowed(u)) throw new ReleaseError('KAGE_RELEASE_BASE must be an https URL');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/** The single executable's release file: `kage-<target>.gz`. */
export function assetName(t: Target): string {
  return targetAsset(t);
}

/** SHA256SUMS: name → lowercase hex. Malformed lines are ignored; a name listed with two sums is dropped. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const doubtful = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](\S(?:.*\S)?)$/.exec(line);
    if (!m) continue;
    const hex = (m[1] ?? '').toLowerCase();
    const name = m[2] ?? '';
    const had = sums.get(name);
    if (had !== undefined && had !== hex) doubtful.add(name);
    sums.set(name, hex);
  }
  for (const name of doubtful) sums.delete(name);
  return sums;
}

/** A semver version without the `v`: major, minor, patch, then pre-release parts (groups 1 to 4). */
const SEMVER_CORE =
  '(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z.-]+)?';
const SEMVER = new RegExp(`^v?${SEMVER_CORE}$`);

/** True for a version compareVersions understands. */
export function isVersion(v: string): boolean {
  return SEMVER.test(v);
}

function parts(v: string): { main: number[]; pre: string[] } {
  const m = SEMVER.exec(v);
  if (!m) throw new ReleaseError(`"${v}" isn't a version`);
  return { main: [m[1], m[2], m[3]].map(Number), pre: m[4] ? m[4].split('.') : [] };
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Semver order: numeric parts; a pre-release sorts below its release, and its parts compare as semver says. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = sign((x.main[i] ?? 0) - (y.main[i] ?? 0));
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    return sign((x.pre.length === 0 ? 1 : 0) - (y.pre.length === 0 ? 1 : 0));
  }
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = sign(Number(p) - Number(q));
      if (d !== 0) return d;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

export interface DownloadLimits {
  maxBytes?: number;
  /** Idle limit: this long without a byte (or without the headers) stops it. Default 30 s. */
  timeoutMs?: number;
  /** Total limit for the whole request. Default 15 min. */
  totalMs?: number;
}

/**
 * One GET, read to the end within `maxBytes`, the idle limit and the total limit. Every doubt is
 * a ReleaseError with fixed words; a redirect may only land on another allowed URL. It asks for
 * the bytes as stored (`accept-encoding: identity`) and refuses a compressed reply: fetch would
 * decode it, so the bytes checked would not be the bytes the release lists.
 */
async function get(
  doFetch: typeof fetch,
  url: URL,
  maxBytes: number,
  o: DownloadLimits = {},
): Promise<Uint8Array> {
  const r = await request(doFetch, url, maxBytes, o, false);
  if (r instanceof URL) throw new ReleaseError('HTTP 302'); // not reached: fetch follows
  return r;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * get, or with `manual` the first hop only: a redirect comes back as the URL it names (resolved,
 * and only an allowed one), anything else is read as get reads it.
 */
async function request(
  doFetch: typeof fetch,
  url: URL,
  maxBytes: number,
  o: DownloadLimits,
  manual: boolean,
): Promise<Uint8Array | URL> {
  const ac = new AbortController();
  let timedOut = false;
  const stop = () => {
    timedOut = true;
    ac.abort();
  };
  const idleMs = o.timeoutMs ?? IDLE_MS;
  let idle = setTimeout(stop, idleMs);
  const poke = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, idleMs);
  };
  const total = setTimeout(stop, o.totalMs ?? TOTAL_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        signal: ac.signal,
        redirect: manual ? 'manual' : 'follow',
        headers: { 'accept-encoding': 'identity' },
      });
    } catch {
      throw new ReleaseError(timedOut ? 'timed out' : "couldn't reach the release server");
    }
    poke();
    const location = manual && REDIRECTS.has(res.status) ? res.headers.get('location') : null;
    if (location !== null) {
      await res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new ReleaseError(`HTTP ${res.status}`);
      }
      if (!allowed(next)) throw new ReleaseError('a redirect away from HTTPS');
      return next;
    }
    if (res.url && !allowed(new URL(res.url))) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError('a redirect away from HTTPS');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError(`HTTP ${res.status}`);
    }
    const encoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity') {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError('the server sent a compressed reply');
    }
    const length = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError('download too large');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let r: Awaited<ReturnType<typeof reader.read>>;
        try {
          r = await reader.read();
        } catch {
          throw new ReleaseError(timedOut ? 'timed out' : 'the download was cut short');
        }
        if (r.done) break;
        poke();
        size += r.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ReleaseError('download too large');
        }
        chunks.push(r.value);
      }
    }
    if (Number.isFinite(length) && size !== length) {
      throw new ReleaseError('the download was cut short');
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

/**
 * A release folder's path: `<repo>/releases/download/v<semver>/VERSION`, the tag one segment.
 * `URL` has already resolved `.` and `..`, and keeps `%2F` encoded, so neither can reach in.
 */
const RELEASE_VERSION_PATH = new RegExp(
  `^(.*)/releases/download/(v${SEMVER_CORE})/${VERSION_FILE}$`,
);

/** The repository part of a base's path, before its `/releases/`; null when it has none. */
function repoOf(base: URL): string | null {
  const i = base.pathname.lastIndexOf('/releases/');
  return i < 0 ? null : base.pathname.slice(0, i);
}

/**
 * The release folder this update reads every file from, and its VERSION (R124, R125). GitHub
 * answers `…/releases/latest/download/VERSION` with a redirect to `…/releases/download/<tag>/VERSION`:
 * that tag's folder is then the base for SHA256SUMS and the asset too, so a release published
 * mid-update can't mix the files of two. Only such a first hop is pinned: to the base's own
 * origin, the same repository when the base names one (the path before `/releases/`), a path
 * ending in `/releases/download/v<semver>/VERSION` and no query. That release's VERSION must
 * then be its tag without the `v`, or the update stops. Any other hop (a CDN's signed URL) is
 * followed for VERSION only, and the other names resolve against the base. Without a redirect
 * (KAGE_RELEASE_BASE at a tag's folder, a test server) the base stays as it is, and VERSION's
 * bytes are the first answer's.
 */
export async function pinRelease(
  doFetch: typeof fetch,
  base: URL,
  o: DownloadLimits = {},
): Promise<{ base: URL; version: string }> {
  const first = await request(doFetch, new URL(VERSION_FILE, base), MAX_TEXT, o, true);
  if (!(first instanceof URL)) return { base, version: new TextDecoder().decode(first) };
  const m =
    first.origin === base.origin && first.search === ''
      ? RELEASE_VERSION_PATH.exec(first.pathname)
      : null;
  const repo = repoOf(base);
  const tag = m !== null && (repo === null || m[1] === repo) ? (m[2] ?? null) : null;
  if (tag === null) {
    const body = await get(doFetch, new URL(VERSION_FILE, base), MAX_TEXT, o);
    return { base, version: new TextDecoder().decode(body) };
  }
  const version = new TextDecoder().decode(await get(doFetch, first, MAX_TEXT, o));
  if (version.trim() !== tag.slice(1)) {
    throw new ReleaseError("the release's VERSION doesn't match its tag");
  }
  return { base: new URL('.', first), version };
}

/**
 * Downloads `name` from the release and returns it only if its SHA-256 matches its line in
 * `sums` (checked before any byte is fetched: no line, no download). 200 MiB at most; 30 s
 * without a byte or 15 min in all stops it.
 */
export async function downloadVerified(
  doFetch: typeof fetch,
  base: URL,
  name: string,
  sums: Map<string, string>,
  o: DownloadLimits = {},
): Promise<Uint8Array> {
  const want = sums.get(name);
  if (want === undefined) throw new ReleaseError(`no checksum for ${name}`);
  const body = await get(doFetch, new URL(name, base), o.maxBytes ?? MAX_DOWNLOAD, o);
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== want) throw new ReleaseError('checksum mismatch');
  return body;
}

/** Makes a rename in `dir` durable where the platform allows a folder to be synced. */
async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r').catch(() => null);
  if (fh === null) return;
  await fh.sync().catch(() => {});
  await fh.close().catch(() => {});
}

export interface ReplaceOptions {
  /** The rename (a test seam; default fs.rename). */
  rename?: (from: string, to: string) => Promise<void>;
  /** Checks the unpacked program before it replaces the old one; throws to stop. */
  verify?: (tmp: string) => Promise<void>;
  /** After a swap, the old program stays at this path (a hard link, else a copy; skipped if neither works). */
  keepPrevious?: string;
}

/**
 * gunzip → `<dir>/.kage-new-<pid>` (0755, fsync) → rename over `target`. The temporary files are
 * removed on any failure, and the old program stays as it was.
 */
export async function replaceBinary(
  target: string,
  gz: Uint8Array,
  o: ReplaceOptions = {},
): Promise<void> {
  let program: Buffer;
  try {
    program = await promisify(gunzip)(gz, { maxOutputLength: MAX_PROGRAM });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof RangeError || code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ReleaseError('download too large');
    }
    throw new ReleaseError("the download didn't decompress");
  }
  if (program.length === 0) throw new ReleaseError("the download didn't decompress");
  const dir = dirname(target);
  const tmp = join(dir, `.kage-new-${process.pid}`);
  const prevTmp = join(dir, `.kage-prev-${process.pid}`);
  const doRename = o.rename ?? rename;
  try {
    await rm(tmp, { force: true });
    const fh = await open(tmp, 'wx', 0o755);
    try {
      await fh.writeFile(program);
      await fh.chmod(0o755);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await o.verify?.(tmp);
    let kept = false;
    if (o.keepPrevious !== undefined) {
      await rm(prevTmp, { force: true });
      kept = await link(target, prevTmp).then(
        () => true,
        () =>
          copyFile(target, prevTmp).then(
            () => true,
            () => false,
          ),
      );
    }
    await doRename(tmp, target);
    if (kept && o.keepPrevious !== undefined) {
      await rename(prevTmp, o.keepPrevious).catch(() => rm(prevTmp, { force: true }));
    }
    await syncDir(dir);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    await rm(prevTmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** A word for a command line: as it is when plain, else single-quoted. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command that restarts the service by hand, for the way back. */
function restartCommand(m: ServiceManager, uid: number | undefined): string {
  return m.kind === 'systemd'
    ? `systemctl --user restart ${SYSTEMD_UNIT}`
    : `launchctl kickstart -k gui/${uid ?? '$(id -u)'}/${LAUNCHD_LABEL}`;
}

/** The command that starts a stopped service by hand. */
function startCommand(m: ServiceManager, uid: number | undefined): string {
  return m.kind === 'systemd'
    ? `systemctl --user start ${SYSTEMD_UNIT}`
    : `launchctl kickstart gui/${uid ?? '$(id -u)'}/${LAUNCHD_LABEL}`;
}

/** `<exe> --version`'s first line, or null when it doesn't run or says nothing. */
function runVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['--version'],
      {
        timeout: VERSION_CHECK_MS,
        encoding: 'utf8',
        windowsHide: true,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
      },
      (err, stdout) => resolve(err ? null : (String(stdout).trim().split(/\r?\n/)[0] ?? null)),
    );
  });
}

export interface UpdateDeps {
  fetch: typeof fetch;
  mode: RunMode;
  manager: ServiceManager | null;
  uid: number | undefined;
  /** Test seams: */
  /** The machine's architecture (default process.arch); the platform is io.platform's. */
  arch?: string;
  /** The new program's `--version` (default: runs it, 10 s at most, with only PATH and HOME). */
  programVersion?: (exe: string) => Promise<string | null>;
  /** The running server's status over the hook socket (default fetchStatus). */
  status?: (socket: string) => Promise<ServerStatus | null>;
  /** How long to wait for the restarted service to answer with the new version (default 15 s). */
  waitMs?: number;
  maxBytes?: number;
  timeoutMs?: number;
  totalMs?: number;
  rename?: (from: string, to: string) => Promise<void>;
}

/** True while a process with this pid exists (EPERM: it exists, but isn't ours). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock file this young without a pid in it may be one another update is still writing. */
const LOCK_FRESH_MS = 10_000;

/**
 * Takes `<dir>/.kage-update.lock` without waiting: the release function, or null when another
 * update holds it. A lock whose process is gone (or an old one without a pid) is stale and taken over.
 */
export async function takeUpdateLock(dir: string): Promise<(() => Promise<void>) | null> {
  const file = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid}
`);
      } finally {
        await fh.close();
      }
      return () => rm(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue; // removed meanwhile: try again
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid > 0) {
      if (alive(pid)) return null;
    } else {
      const age = await stat(file).then(
        (st) => Date.now() - st.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );
      if (age < LOCK_FRESH_MS) return null;
    }
    await rm(file, { force: true });
  }
  return null;
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split(/\r?\n/)[0] ?? '';
}

/** kage update [--force]; see the file comment. */
export async function updateCommand(args: string[], io: Io, deps: UpdateDeps): Promise<number> {
  let force = false;
  for (const arg of args) {
    if (arg === '--force') force = true;
    else {
      io.err(`kage update has no option "${arg}". Run kage --help to see its options.`);
      return 1;
    }
  }
  // Not a SEA: nothing to replace here, so this comes before anything else.
  const mode = deps.mode;
  if (mode.kind !== 'sea') {
    const dir = checkoutFor(mode);
    io.err(dir === null ? BUNDLE : checkoutUpdate(dir));
    return 1;
  }
  if (deps.uid === 0) {
    io.err(ROOT);
    return 1;
  }
  const target = hostTarget(io.platform ?? process.platform, deps.arch ?? process.arch);
  if (target === null) {
    io.err('Kage has no single program for this machine, so kage update has nothing to install.');
    return 1;
  }

  // The file itself, not a link to it: a link (the stable path hooks name, R110-5) stays put.
  let exe: string;
  try {
    exe = await realpath(mode.exe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? firstLine(err);
    io.err(`Update failed: couldn't find the installed program (${code}). Nothing was changed.`);
    return 1;
  }
  let release: (() => Promise<void>) | null;
  try {
    release = await takeUpdateLock(dirname(exe));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? firstLine(err);
    io.err(`Update failed: couldn't write next to ${mode.exe} (${code}). Nothing was changed.`);
    return 1;
  }
  if (release === null) {
    io.err('Another kage update is running.');
    return 1;
  }
  try {
    return await update(io, deps, { force, target, exe, shown: mode.exe });
  } finally {
    await release().catch(() => {});
  }
}

async function update(
  io: Io,
  deps: UpdateDeps,
  o: { force: boolean; target: Target; exe: string; shown: string },
): Promise<number> {
  const { force, target, exe } = o;
  const limits: DownloadLimits = {
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.totalMs !== undefined ? { totalMs: deps.totalMs } : {}),
  };
  const old = KAGE_VERSION;
  let next: string;
  try {
    // One release folder for all three files (R124), pinned by VERSION's first redirect.
    const pinned = await pinRelease(deps.fetch, releaseBase(io.env), limits);
    const base = pinned.base;
    next = pinned.version.trim();
    if (!isVersion(next)) throw new ReleaseError("the release's VERSION isn't a version");
    if (!force && compareVersions(next, old) <= 0) {
      io.out(`Kage ${old} is the latest.`);
      return 0;
    }
    const sums = parseSums(
      new TextDecoder().decode(await get(deps.fetch, new URL(SUMS_FILE, base), MAX_TEXT, limits)),
    );
    const name = assetName(target);
    io.out(`Downloading Kage ${next} for ${target}.`);
    const gz = await downloadVerified(deps.fetch, base, name, sums, {
      ...limits,
      ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
    });
    const programVersion = deps.programVersion ?? runVersion;
    const want = next;
    const doRename = deps.rename ?? rename;
    await replaceBinary(exe, gz, {
      verify: async (tmp) => {
        if ((await programVersion(tmp)) !== want) {
          throw new ReleaseError("the new program didn't run");
        }
      },
      rename: async (from, to) => {
        try {
          await doRename(from, to);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? firstLine(err);
          throw new ReleaseError(`couldn't replace ${o.shown} (${code})`);
        }
      },
      keepPrevious: `${exe}.previous`,
    });
  } catch (err) {
    if (err instanceof ReleaseError) {
      io.err(`Update failed: ${err.message}. Nothing was changed.`);
      return 1;
    }
    const code = (err as NodeJS.ErrnoException).code;
    io.err(
      `Update failed: couldn't write next to ${o.shown} (${code ?? firstLine(err)}). Nothing was changed.`,
    );
    return 1;
  }
  io.out(`Updated Kage ${old} → ${next}.`);
  return restartAfter(io, deps, { exe, old, next });
}

/** Restarts an installed service and checks it answers with the new version. */
async function restartAfter(
  io: Io,
  deps: UpdateDeps,
  v: { exe: string; old: string; next: string },
): Promise<number> {
  const m = deps.manager;
  // R112: state() needs a user manager, so ask unavailable() first.
  let state: ServiceState = 'missing';
  if (m !== null && (await m.unavailable()) === null) {
    try {
      state = await m.state();
    } catch {
      state = 'missing';
    }
  }
  if (m === null || state === 'missing') {
    io.out('Restart Kage to use it.');
    return 0;
  }
  // R119-5: only a running (or starting) service is restarted; a stopped one stays stopped.
  if (state !== 'active' && state !== 'starting') {
    io.out(
      `The service isn't running, so it stays stopped. To start it: ${startCommand(m, deps.uid)}`,
    );
    return 0;
  }
  const status = deps.status ?? ((socket: string) => fetchStatus(socket));
  const socket = socketPath(io.env, io.platform ?? process.platform);
  const before = await status(socket);
  try {
    await m.restart();
  } catch (err) {
    io.err(`Couldn't restart the ${m.name}: ${firstLine(err)}`);
    io.err('Restart Kage to use it.');
    return 1;
  }
  const deadline = Date.now() + (deps.waitMs ?? WAIT_MS);
  for (;;) {
    const now = await status(socket);
    if (now?.version === v.next) {
      io.out('Restarted the service.');
      return 0;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (before === null) {
    // It wasn't answering before either (no Tailscale address yet, say): not the update's doing.
    io.out('Restarted the service.');
    io.out("Kage wasn't answering before the update either. kage doctor says why.");
    return 0;
  }
  io.err(`Restarted the service, but Kage ${v.next} isn't answering.`);
  const prev = `${v.exe}.previous`;
  const kept = await stat(prev).then(
    (s) => s.isFile(),
    () => false,
  );
  io.err(
    kept
      ? `To go back to Kage ${v.old}: mv ${shellWord(prev)} ${shellWord(v.exe)} && ${restartCommand(m, deps.uid)}`
      : 'Run kage doctor to see why.',
  );
  return 1;
}
