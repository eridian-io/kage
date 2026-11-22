import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { type FileChange, LIMITS } from '@kage/shared';
import { type GitExec, gitExec } from '../git/exec.ts';
import { stripAnsi } from '../text/ansi.ts';

/** Untracked files larger than this count 0 lines. */
export const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** A NUL within this many leading bytes marks a binary file (git's own heuristic). */
export const BINARY_SNIFF = 8192;
/** At most this many untracked files are read to count their lines; the rest count 0. */
const MAX_UNTRACKED_READ = 100;

/** One entry of the list: `oldPath` is a rename's source; `untracked` files come from ls-files. */
export interface Change extends FileChange {
  oldPath?: string;
  untracked: boolean;
}

/** The numstat records with a rename's source kept as `oldPath`. */
function parseNumstatChanges(out: string): Change[] {
  const parts = out.split('\0');
  const files: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] as string);
    if (!m) continue;
    let path = m[3] as string;
    let oldPath: string | undefined;
    if (path === '') {
      // A rename: the old path, then the new one, follow as their own fields.
      oldPath = parts[i + 1] ?? '';
      path = parts[i + 2] ?? '';
      i += 2;
    }
    if (path === '') continue;
    const n = (s: string | undefined) => (s === '-' || s === undefined ? 0 : Number(s));
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      added: n(m[1]),
      removed: n(m[2]),
      untracked: false,
    });
  }
  return files;
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename `added\tremoved\t\0old\0new\0`
 * (the new path is kept). A binary file shows `-` counts, read as 0.
 */
export function parseNumstat(out: string): FileChange[] {
  return parseNumstatChanges(out).map(({ path, added, removed }) => ({ path, added, removed }));
}

/** True when `p` lies inside `root` (both absolute, resolved). */
export const inside = (root: string, p: string): boolean =>
  p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * An untracked file's bytes, read with the phase 3 safety rules, or why it wasn't read: `link`
 * for a symlink or a path that leads outside the worktree (never followed), `big` over 1 MiB,
 * `special` for anything but a plain file (a FIFO is never opened), `gone` when it vanished.
 * `root` is the worktree's real path.
 */
export async function readUntracked(
  root: string,
  rel: string,
): Promise<{ data: Buffer } | { skip: 'link' | 'big' | 'special' | 'gone' }> {
  try {
    const full = resolve(root, rel);
    if (!inside(root, full)) return { skip: 'link' };
    const st = await lstat(full);
    if (st.isSymbolicLink()) return { skip: 'link' };
    if (!st.isFile()) return { skip: 'special' };
    if (st.size > MAX_UNTRACKED_BYTES) return { skip: 'big' };
    // A parent folder that is a link could still lead outside.
    if (!inside(root, await realpath(full))) return { skip: 'link' };
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const fh = await open(full, flags);
    try {
      // One byte past the size seen: a file that grew since is caught by the limit below.
      const buf = Buffer.alloc(Math.min(st.size, MAX_UNTRACKED_BYTES) + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_UNTRACKED_BYTES) return { skip: 'big' };
      return { data: buf.subarray(0, bytesRead) };
    } finally {
      await fh.close();
    }
  } catch {
    return { skip: 'gone' };
  }
}

/** A NUL within the first 8 KiB: git's own binary heuristic. */
export const looksBinary = (data: Buffer): boolean => data.subarray(0, BINARY_SNIFF).includes(0);

/**
 * The line count of an untracked file, or 0 when it is not a plain file inside the worktree
 * (a symlink is never followed), is over 1 MiB, or has a NUL in its first 8 KiB.
 */
async function untrackedLines(
  root: string,
  rel: string,
  read: typeof readUntracked,
): Promise<number> {
  const r = await read(root, rel);
  if (!('data' in r) || looksBinary(r.data)) return 0;
  const data = r.data;
  let lines = 0;
  for (const b of data) if (b === 0x0a) lines++;
  if (data.length > 0 && data[data.length - 1] !== 0x0a) lines++;
  return lines;
}

/** The untracked line-count cache holds at most this many files in all (B37). */
export const UNTRACKED_CACHE_MAX = 2000;

/** An entry recorded less than this long after its file's mtime is racy: never trusted. */
const RACY_MS = 2000;

/**
 * Untracked files' line counts by worktree and path, valid while the file's size and mtimeMs are
 * the ones seen (B37): a refresh re-reads only what changed. Bounded; the least recently used
 * entry goes first. The session's removal forgets its worktree. An entry recorded within 2 s of its
 * file's mtime is racy (git's rule) and is read again.
 */
export class UntrackedCache {
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<
    string,
    { size: number; mtimeMs: number; lines: number; recordedAt: number }
  >();
  constructor(max = UNTRACKED_CACHE_MAX, now: () => number = Date.now) {
    this.#max = max;
    this.#now = now;
  }
  get size(): number {
    return this.#entries.size;
  }
  get(worktree: string, path: string, size: number, mtimeMs: number): number | undefined {
    const key = `${worktree}\0${path}`;
    const e = this.#entries.get(key);
    if (!e || e.size !== size || e.mtimeMs !== mtimeMs) return undefined;
    // Git's racy rule: a file changed within RACY_MS of its read may have changed again since,
    // at the same size, without its mtime moving (coarse timestamps). Read it again.
    if (e.recordedAt - e.mtimeMs < RACY_MS) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, e);
    return e.lines;
  }
  /** The cache's clock: callers take it before their stat, so an entry is judged by when it was seen. */
  now(): number {
    return this.#now();
  }
  set(
    worktree: string,
    path: string,
    size: number,
    mtimeMs: number,
    lines: number,
    seenAt: number = this.#now(),
  ): void {
    const key = `${worktree}\0${path}`;
    this.#entries.delete(key);
    this.#entries.set(key, { size, mtimeMs, lines, recordedAt: seenAt });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }
  forget(worktree: string): void {
    const prefix = `${worktree}\0`;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }
}

/** How listChanges reads untracked files: the cache (B37) and the reader (tests count reads). */
export interface ListOptions {
  cache?: UntrackedCache;
  read?: typeof readUntracked;
}

/** An untracked file's line count, from the cache while its size and mtime are unchanged. */
async function cachedLines(
  worktree: string,
  root: string,
  rel: string,
  o: ListOptions,
): Promise<number> {
  const read = o.read ?? readUntracked;
  const cache = o.cache;
  if (!cache) return untrackedLines(root, rel, read);
  const full = resolve(root, rel);
  if (!inside(root, full)) return 0;
  const seenAt = cache.now();
  const st = await lstat(full).catch(() => null);
  if (!st) return 0;
  const hit = cache.get(worktree, rel, st.size, st.mtimeMs);
  if (hit !== undefined) return hit;
  const lines = await untrackedLines(root, rel, read);
  // Keyed by the stat taken before the read: a write in between changes the mtime, so the next
  // refresh reads the file again.
  cache.set(worktree, rel, st.size, st.mtimeMs, lines, seenAt);
  return lines;
}

/**
 * The merge base of `refs/heads/<base>` and HEAD, or 'HEAD' when the base is null, missing or
 * has no common history: what the list and the diff compare against.
 */
export async function mergeBase(
  worktree: string,
  base: string | null,
  exec: GitExec = gitExec,
): Promise<string> {
  if (base === null) return 'HEAD';
  try {
    const out = (
      await exec(['merge-base', `refs/heads/${base}`, 'HEAD'], { cwd: worktree })
    ).stdout.trim();
    if (/^[0-9a-f]{7,64}$/.test(out)) return out;
  } catch {
    // A deleted base: diff against HEAD.
  }
  return 'HEAD';
}

/**
 * The worktree's changes against the merge base of `base` and HEAD (or HEAD when the base is
 * null or missing): commits on the branch plus uncommitted work (`git diff <mb>`), and untracked
 * files, sorted by path and uncapped. The one source of the form the file list and the diff share
 * (spec §5.7, amended). Paths are relative to `worktree`. Rejects when git fails (not a
 * repository, no HEAD).
 */
export async function listChanges(
  worktree: string,
  base: string | null,
  exec: GitExec = gitExec,
  o: ListOptions = {},
): Promise<{ mb: string; changes: Change[] }> {
  const opts = { cwd: worktree };
  const mb = await mergeBase(worktree, base, exec);
  const [diff, others] = await Promise.all([
    exec(
      [
        'diff',
        '--numstat',
        '-z',
        '-M',
        '--relative',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        mb,
        '--',
      ],
      opts,
    ),
    exec(['ls-files', '--others', '--exclude-standard', '-z'], opts),
  ]);
  const changes = parseNumstatChanges(diff.stdout);
  const untracked = others.stdout.split('\0').filter((p) => p !== '');
  if (untracked.length > 0) {
    const root = await realpath(worktree).catch(() => resolve(worktree));
    const counts = await Promise.all(
      untracked.map((p, i) => (i < MAX_UNTRACKED_READ ? cachedLines(worktree, root, p, o) : 0)),
    );
    untracked.forEach((path, i) => {
      changes.push({ path, added: counts[i] ?? 0, removed: 0, untracked: true });
    });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { mb, changes };
}

/**
 * The file list (spec §5.7): `listChanges` capped at LIMITS.files, so the right column and the
 * diff list the same paths in the same order. `total` counts them all. Each path is shown, so
 * it is stripped of escapes, control and bidi characters (B36) as the diff strips its own; the
 * shared `listChanges` keeps git's raw path, which the diff passes back to git.
 */
export async function changedFiles(
  worktree: string,
  base: string | null,
  exec: GitExec = gitExec,
  o: ListOptions = {},
): Promise<{ files: FileChange[]; total: number }> {
  const { changes } = await listChanges(worktree, base, exec, o);
  return {
    files: changes.slice(0, LIMITS.files).map(({ path, added, removed }) => ({
      path: stripAnsi(path, { oneLine: true }),
      added,
      removed,
    })),
    total: changes.length,
  };
}
