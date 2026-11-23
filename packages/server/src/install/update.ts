/**
 * `kage update` (phase 6, Task 7): replaces the single executable with the latest release's, then
 * restarts the service. Only when asked: Kage never checks for updates in the background.
 *
 * Safe at every step:
 * - downloads over HTTPS only (plain http only on loopback, for tests), from KAGE_RELEASE_BASE or
 *   the latest GitHub release, which never points at a pre-release (R118: pre-releases ship with
 *   --prerelease, so they are reached only by pointing KAGE_RELEASE_BASE at their tag);
 * - checks the download's SHA-256 against its line in SHA256SUMS, unpacks it next to the old
 *   program (the same folder, so the same file system), checks the new program answers
 *   `--version` with the release's version, and only then renames it over the old one;
 * - any failure before that rename leaves the old program and the running service as they were.
 *
 * Release names and targets come from targets.ts, never release/build.ts (F4: no esbuild here).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { socketPath } from '../hooks/cli.ts';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import { LAUNCHD_LABEL } from './launchd.ts';
import { KAGE_VERSION, type RunMode } from './runtime.ts';
import type { ServiceManager } from './service.ts';
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
const TIMEOUT_MS = 120_000;
const TEXT_TIMEOUT_MS = 30_000;
const VERSION_CHECK_MS = 10_000;
const WAIT_MS = 15_000;
const POLL_MS = 250;
const ROOT = 'Run Kage as your own user, not root.';
const BUNDLE = `This Kage came from npm or a build. Update it with: npm install -g ${NPM_NAME}@latest`;
const SOURCE = 'This Kage runs from a checkout. Update it with git pull and pnpm build.';

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

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

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

/**
 * One GET, read to the end within `maxBytes` and `timeoutMs` (the whole request, body included).
 * Every doubt is a ReleaseError with fixed words; a redirect may only land on another allowed URL.
 */
async function get(
  doFetch: typeof fetch,
  url: URL,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { signal: ac.signal, redirect: 'follow' });
    } catch {
      throw new ReleaseError(timedOut ? 'timed out' : "couldn't reach the release server");
    }
    if (res.url && !allowed(new URL(res.url))) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError('a redirect away from HTTPS');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseError(`HTTP ${res.status}`);
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
    clearTimeout(timer);
  }
}

/**
 * Downloads `name` from the release and returns it only if its SHA-256 matches its line in
 * `sums` (checked before any byte is fetched: no line, no download). 200 MiB and 120 s at most.
 */
export async function downloadVerified(
  doFetch: typeof fetch,
  base: URL,
  name: string,
  sums: Map<string, string>,
  o: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const want = sums.get(name);
  if (want === undefined) throw new ReleaseError(`no checksum for ${name}`);
  const body = await get(
    doFetch,
    new URL(name, base),
    o.maxBytes ?? MAX_DOWNLOAD,
    o.timeoutMs ?? TIMEOUT_MS,
  );
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
  rename?: (from: string, to: string) => Promise<void>;
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
    io.err(mode.kind === 'bundle' ? BUNDLE : SOURCE);
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

  const old = KAGE_VERSION;
  let exe: string;
  let next: string;
  try {
    const base = releaseBase(io.env);
    const versionText = new TextDecoder().decode(
      await get(deps.fetch, new URL(VERSION_FILE, base), MAX_TEXT, TEXT_TIMEOUT_MS),
    );
    next = versionText.trim();
    if (!isVersion(next)) throw new ReleaseError("the release's VERSION isn't a version");
    if (!force && compareVersions(next, old) <= 0) {
      io.out(`Kage ${old} is the latest.`);
      return 0;
    }
    const sums = parseSums(
      new TextDecoder().decode(
        await get(deps.fetch, new URL(SUMS_FILE, base), MAX_TEXT, TEXT_TIMEOUT_MS),
      ),
    );
    const name = assetName(target);
    io.out(`Downloading Kage ${next} for ${target}.`);
    const gz = await downloadVerified(deps.fetch, base, name, sums, {
      ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    // The file itself, not a link to it: a link (the stable path hooks name, R110-5) stays put.
    exe = await realpath(mode.exe);
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
          throw new ReleaseError(`couldn't replace ${mode.exe} (${code})`);
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
      `Update failed: couldn't write next to ${mode.exe} (${code ?? firstLine(err)}). Nothing was changed.`,
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
  let installed = false;
  if (m !== null && (await m.unavailable()) === null) {
    try {
      installed = (await m.state()) !== 'missing';
    } catch {
      installed = false;
    }
  }
  if (m === null || !installed) {
    io.out('Restart Kage to use it.');
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
