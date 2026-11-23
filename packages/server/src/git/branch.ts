import { HEX_COMMIT } from '../state/store.ts';
import { type GitExec, type GitPin, gitExec, requirePin } from './exec.ts';

/**
 * A branch or base name Kage passes to git: no leading "-", no "..", no "@{", plain segments
 * (none empty, none starting with "." or ending in ".lock", no trailing "."), at most 200 chars.
 */
export const SAFE_REF =
  /^(?!-)(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*\.$)(?!(?:.*\/)?\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

export interface BranchState {
  unpushed: number;
  uncommitted: number;
  ignored: number;
  merged: boolean;
}

const toCount = (out: string): number => {
  const n = Number(out.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`git gave no count: ${out.trim()}`);
  return n;
};

/**
 * Commits only this branch, or the worktree's HEAD, reaches (host-integration §5.3, plus HEAD):
 * `rev-list --count refs/heads/<b> HEAD --not --exclude=<b> --branches --remotes --tags`, run in
 * the session's worktree, so work on a detached HEAD counts too. `--exclude` takes the short
 * name: with `--branches` a `refs/heads/` pattern matches nothing (checked on git 2.56). A
 * branch failing SAFE_REF counts 0 with no git call. Rejects when git fails.
 */
export async function unpushedCount(
  cwd: string,
  branch: string,
  exec: GitExec,
  pin: GitPin | undefined,
): Promise<number> {
  if (!SAFE_REF.test(branch)) return 0;
  const { stdout } = await exec(
    [
      'rev-list',
      '--count',
      `refs/heads/${branch}`,
      'HEAD',
      '--not',
      `--exclude=${branch}`,
      '--branches',
      '--remotes',
      '--tags',
    ],
    { cwd, pin },
  );
  return toCount(stdout);
}

/**
 * The worktree's entries from one `status --porcelain=v1 -z --untracked-files=normal
 * --ignored=matching --ignore-submodules=all` (§5.4). Submodules count nothing (R131): with any
 * other mode git runs `git status` inside each one, or reads its `.git`, and the session can
 * rewrite that file (security M4):
 * - uncommitted: every entry but `!!`; an untracked folder counts once, and a rename or copy
 *   counts once (its old path follows as an extra NUL-terminated field);
 * - ignored (R73): the `!!` entries, which `worktree remove` deletes too; an ignored folder
 *   (`node_modules/`) counts once and git doesn't walk into it.
 * Rejects when git fails.
 */
export async function worktreeCounts(
  worktree: string,
  exec: GitExec,
  pin: GitPin | undefined,
): Promise<{ uncommitted: number; ignored: number }> {
  const { stdout } = await exec(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignored=matching',
      // R131: =all, so git never runs in a submodule or reads its .git (both writable by Claude).
      '--ignore-submodules=all',
    ],
    { cwd: worktree, pin },
  );
  const fields = stdout.split('\0');
  let uncommitted = 0;
  let ignored = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string;
    if (f.length < 3) continue;
    if (f.startsWith('!! ')) {
      ignored++;
      continue;
    }
    uncommitted++;
    if (/^[RC]|^.[RC]/.test(f)) i++;
  }
  return { uncommitted, ignored };
}

/** Where a worktree's git runs: its folder, and the pin when it has a record (security M4). */
type At = { cwd: string; pin?: GitPin | undefined };

/** Runs a git command whose exit status is the answer: 0 is true, anything else false. */
async function exitsZero(exec: GitExec, args: string[], at: At): Promise<boolean> {
  try {
    await exec(args, at);
    return true;
  } catch {
    return false;
  }
}

/**
 * The flags that keep a diff from running repository-configured programs (R65, F7), and from
 * hiding a submodule pointer change (`diff.ignoreSubmodules`, `.gitmodules` `ignore = all`).
 */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];

/**
 * The paths a tree-to-tree diff lists, as raw bytes (latin1: one char per byte), so non-UTF-8
 * names compare exactly.
 */
async function changedPaths(exec: GitExec, at: At, from: string, to: string) {
  const { stdout } = await exec(['diff', ...DIFF_FLAGS, '--name-only', '-z', from, to], {
    ...at,
    encoding: 'latin1',
  });
  return stdout.split('\0').filter((p) => p !== '');
}

/**
 * The worktree is on the branch: its HEAD is `refs/heads/<b>`, or (detached) an ancestor of the
 * tip. A detached HEAD with commits of its own would lose them, so that is never merged.
 */
async function onBranch(exec: GitExec, at: At, tip: string): Promise<boolean> {
  const head = await exec(['symbolic-ref', '-q', 'HEAD'], at).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (head === tip) return true;
  return exitsZero(exec, ['merge-base', '--is-ancestor', 'HEAD', tip], at);
}

/**
 * The worktree (`cwd`) is on the branch, the branch has a commit past baseCommit, and its tip is
 * an ancestor of refs/heads/<base> or of refs/remotes/origin/<base>, or no path the branch
 * changed since baseCommit differs between the tip and that ref (a squash or rebase merge): the
 * driver-free path-equal check of host-integration §5.5 (R59/R65), never `merge-tree`, which can
 * run a repository's merge driver. The check intersects two tree diffs in JS (no pathspec, so no
 * argument limit). False for a null baseCommit or base, a name failing SAFE_REF (no git call),
 * and whenever git fails (closed). Every call carries `pin` (worktreePin); undefined, written
 * out, runs git's own discovery (an external window's folder).
 */
export async function isMerged(
  cwd: string,
  o: { branch: string; base: string | null; baseCommit: string | null },
  exec: GitExec,
  pin: GitPin | undefined,
): Promise<boolean> {
  const { branch, base, baseCommit } = o;
  if (base === null || baseCommit === null) return false;
  if (!SAFE_REF.test(branch) || !SAFE_REF.test(base) || !HEX_COMMIT.test(baseCommit)) return false;
  const tip = `refs/heads/${branch}`;
  const at: At = { cwd, pin };
  try {
    if (!(await onBranch(exec, at, tip))) return false;
    const past = await exec(['rev-list', '--count', tip, `^${baseCommit}`], at);
    if (toCount(past.stdout) === 0) return false;
    const changed = new Set(await changedPaths(exec, at, baseCommit, tip));
    for (const target of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      // R66: an ancestor counts as merged even when the base later reverted the merge; nothing
      // is lost, because the branch's commits stay reachable from the base.
      if (await exitsZero(exec, ['merge-base', '--is-ancestor', tip, target], at)) return true;
      // No changed paths: nothing to compare ("n/a" in §5.5), so only ancestry can say merged.
      if (changed.size === 0) continue;
      let differs: string[];
      try {
        differs = await changedPaths(exec, at, tip, target);
      } catch {
        continue; // no such ref (no origin), or git failed: this target says nothing
      }
      if (!differs.some((p) => changed.has(p))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** branchCounts' two parts with a pin already looked up. */
async function countsAt(
  worktree: string,
  branch: string,
  exec: GitExec,
  pin: GitPin | undefined,
): Promise<{ unpushed: number; uncommitted: number; ignored: number }> {
  const [unpushed, w] = await Promise.all([
    unpushedCount(worktree, branch, exec, pin),
    worktreeCounts(worktree, exec, pin),
  ]);
  return { unpushed, ...w };
}

/**
 * The branch's unpushed commits and the worktree's uncommitted and ignored entries, in parallel.
 * With `repo` (a record's project folder) every call is pinned to it (requirePin): a redirected
 * `.git` rejects with UNPINNED and runs no git in the worktree. A branch failing SAFE_REF gives
 * zeros with no git call. Rejects when either git run fails.
 */
export async function branchCounts(
  worktree: string,
  branch: string,
  exec: GitExec = gitExec,
  repo: string | null = null,
): Promise<{ unpushed: number; uncommitted: number; ignored: number }> {
  if (!SAFE_REF.test(branch)) return { unpushed: 0, uncommitted: 0, ignored: 0 };
  return countsAt(worktree, branch, exec, await requirePin(repo, worktree, exec));
}

/**
 * branchCounts and isMerged, all three parts in parallel, pinned to `o.repo` as branchCounts is
 * (one lookup for all three). A branch failing SAFE_REF gives counts 0 and merged false with no
 * git call. Rejects when a count fails or the pin is refused; merged fails closed.
 */
export async function branchState(
  worktree: string,
  o: { branch: string; base: string | null; baseCommit: string | null; repo?: string | null },
  exec: GitExec = gitExec,
): Promise<BranchState> {
  if (!SAFE_REF.test(o.branch)) return { unpushed: 0, uncommitted: 0, ignored: 0, merged: false };
  const pin = await requirePin(o.repo, worktree, exec);
  const [counts, merged] = await Promise.all([
    countsAt(worktree, o.branch, exec, pin),
    isMerged(worktree, o, exec, pin),
  ]);
  return { ...counts, merged };
}
