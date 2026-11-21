import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { type FileChange, LIMITS } from '@kage/shared';
import { type GitExec, gitExec } from '../git/exec.ts';

/** Untracked files larger than this count 0 lines. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** A NUL within this many leading bytes marks a binary file (git's own heuristic). */
const BINARY_SNIFF = 8192;
/** At most this many untracked files are read to count their lines; the rest count 0. */
const MAX_UNTRACKED_READ = 100;

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename `added\tremoved\t\0old\0new\0`
 * (the new path is kept). A binary file shows `-` counts, read as 0.
 */
export function parseNumstat(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] as string);
    if (!m) continue;
    let path = m[3] as string;
    if (path === '') {
      // A rename: the old path, then the new one, follow as their own fields.
      path = parts[i + 2] ?? '';
      i += 2;
    }
    if (path === '') continue;
    const n = (s: string | undefined) => (s === '-' || s === undefined ? 0 : Number(s));
    files.push({ path, added: n(m[1]), removed: n(m[2]) });
  }
  return files;
}

const inside = (root: string, p: string): boolean =>
  p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The line count of an untracked file, or 0 when it is not a plain file inside the worktree
 * (a symlink is never followed), is over 1 MiB, or has a NUL in its first 8 KiB.
 */
async function untrackedLines(root: string, rel: string): Promise<number> {
  try {
    const full = resolve(root, rel);
    if (!inside(root, full)) return 0;
    const st = await lstat(full);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return 0;
    // A parent folder that is a link could still lead outside.
    if (!inside(root, await realpath(full))) return 0;
    const fh = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // One byte past the size seen: a file that grew since is caught by the limit below.
      const buf = Buffer.alloc(Math.min(st.size, MAX_UNTRACKED_BYTES) + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_UNTRACKED_BYTES) return 0;
      const data = buf.subarray(0, bytesRead);
      if (data.subarray(0, BINARY_SNIFF).includes(0)) return 0;
      let lines = 0;
      for (const b of data) if (b === 0x0a) lines++;
      if (bytesRead > 0 && data[bytesRead - 1] !== 0x0a) lines++;
      return lines;
    } finally {
      await fh.close();
    }
  } catch {
    return 0;
  }
}

/**
 * The worktree's changes against the merge base of `base` and HEAD (or HEAD when the base is
 * null or missing): commits on the branch plus uncommitted work (`git diff <mb>`), and untracked
 * files, sorted by path. This is the form phase 4's diff view must match (spec §5.7, amended).
 * `files` holds at most LIMITS.files entries; `total` counts them all. Paths are relative to
 * `worktree`. Rejects when git fails (not a repository, no HEAD).
 */
export async function changedFiles(
  worktree: string,
  base: string | null,
  exec: GitExec = gitExec,
): Promise<{ files: FileChange[]; total: number }> {
  const opts = { cwd: worktree };
  let mb = 'HEAD';
  if (base !== null) {
    try {
      const out = (await exec(['merge-base', `refs/heads/${base}`, 'HEAD'], opts)).stdout.trim();
      if (/^[0-9a-f]{7,64}$/.test(out)) mb = out;
    } catch {
      // A deleted base: diff against HEAD.
    }
  }
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
        mb,
        '--',
      ],
      opts,
    ),
    exec(['ls-files', '--others', '--exclude-standard', '-z'], opts),
  ]);
  const files = parseNumstat(diff.stdout);
  const untracked = others.stdout.split('\0').filter((p) => p !== '');
  if (untracked.length > 0) {
    const root = await realpath(worktree).catch(() => resolve(worktree));
    const counts = await Promise.all(
      untracked.map((p, i) => (i < MAX_UNTRACKED_READ ? untrackedLines(root, p) : 0)),
    );
    untracked.forEach((path, i) => {
      files.push({ path, added: counts[i] ?? 0, removed: 0 });
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, LIMITS.files), total: files.length };
}
