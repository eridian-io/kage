import { HEX_COMMIT } from '../state/store.ts';
import { type GitExec, gitExec } from './exec.ts';

/**
 * A branch or base name Kage passes to git: no leading "-", no "..", no "@{", plain segments
 * (none empty, none starting with "." or ending in ".lock", no trailing "."), at most 200 chars.
 */
export const SAFE_REF =
  /^(?!-)(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*\.$)(?!(?:.*\/)?\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

export interface BranchState {
  unpushed: number;
  uncommitted: number;
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
  exec: GitExec = gitExec,
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
    { cwd },
  );
  return toCount(stdout);
}

/**
 * Entries of `status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=none` (§5.4;
 * a dirty submodule counts whatever `diff.ignoreSubmodules` or `.gitmodules` say): an untracked folder
 * counts once, ignored files don't count, and a rename or copy counts once (its old path follows
 * as an extra NUL-terminated field). Rejects when git fails.
 */
export async function uncommittedCount(worktree: string, exec: GitExec = gitExec): Promise<number> {
  const { stdout } = await exec(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'],
    {
      cwd: worktree,
    },
  );
  const fields = stdout.split('\0');
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string;
    if (f.length < 3) continue;
    n++;
    if (/^[RC]|^.[RC]/.test(f)) i++;
  }
  return n;
}

/** Runs a git command whose exit status is the answer: 0 is true, anything else false. */
async function exitsZero(exec: GitExec, args: string[], cwd: string): Promise<boolean> {
  try {
    await exec(args, { cwd });
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
async function changedPaths(exec: GitExec, cwd: string, from: string, to: string) {
  const { stdout } = await exec(['diff', ...DIFF_FLAGS, '--name-only', '-z', from, to], {
    cwd,
    encoding: 'latin1',
  });
  return stdout.split('\0').filter((p) => p !== '');
}

/**
 * The worktree is on the branch: its HEAD is `refs/heads/<b>`, or (detached) an ancestor of the
 * tip. A detached HEAD with commits of its own would lose them, so that is never merged.
 */
async function onBranch(exec: GitExec, cwd: string, tip: string): Promise<boolean> {
  const head = await exec(['symbolic-ref', '-q', 'HEAD'], { cwd }).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (head === tip) return true;
  return exitsZero(exec, ['merge-base', '--is-ancestor', 'HEAD', tip], cwd);
}

/**
 * The worktree (`cwd`) is on the branch, the branch has a commit past baseCommit, and its tip is
 * an ancestor of refs/heads/<base> or of refs/remotes/origin/<base>, or no path the branch
 * changed since baseCommit differs between the tip and that ref (a squash or rebase merge): the
 * driver-free path-equal check of host-integration §5.5 (R59/R65), never `merge-tree`, which can
 * run a repository's merge driver. The check intersects two tree diffs in JS (no pathspec, so no
 * argument limit). False for a null baseCommit or base, a name failing SAFE_REF (no git call),
 * and whenever git fails (closed).
 */
export async function isMerged(
  cwd: string,
  o: { branch: string; base: string | null; baseCommit: string | null },
  exec: GitExec = gitExec,
): Promise<boolean> {
  const { branch, base, baseCommit } = o;
  if (base === null || baseCommit === null) return false;
  if (!SAFE_REF.test(branch) || !SAFE_REF.test(base) || !HEX_COMMIT.test(baseCommit)) return false;
  const tip = `refs/heads/${branch}`;
  try {
    if (!(await onBranch(exec, cwd, tip))) return false;
    const past = await exec(['rev-list', '--count', tip, `^${baseCommit}`], { cwd });
    if (toCount(past.stdout) === 0) return false;
    const changed = new Set(await changedPaths(exec, cwd, baseCommit, tip));
    for (const target of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      // R66: an ancestor counts as merged even when the base later reverted the merge; nothing
      // is lost, because the branch's commits stay reachable from the base.
      if (await exitsZero(exec, ['merge-base', '--is-ancestor', tip, target], cwd)) return true;
      // No changed paths: nothing to compare ("n/a" in §5.5), so only ancestry can say merged.
      if (changed.size === 0) continue;
      let differs: string[];
      try {
        differs = await changedPaths(exec, cwd, tip, target);
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

/**
 * The branch's unpushed commits and the worktree's uncommitted entries, in parallel. A branch
 * failing SAFE_REF gives 0 and 0 with no git call. Rejects when either git run fails.
 */
export async function branchCounts(
  worktree: string,
  branch: string,
  exec: GitExec = gitExec,
): Promise<{ unpushed: number; uncommitted: number }> {
  if (!SAFE_REF.test(branch)) return { unpushed: 0, uncommitted: 0 };
  const [unpushed, uncommitted] = await Promise.all([
    unpushedCount(worktree, branch, exec),
    uncommittedCount(worktree, exec),
  ]);
  return { unpushed, uncommitted };
}

/**
 * branchCounts and isMerged, all three parts in parallel. A branch failing SAFE_REF gives
 * counts 0 and merged false with no git call. Rejects when a count fails; merged fails closed.
 */
export async function branchState(
  worktree: string,
  o: { branch: string; base: string | null; baseCommit: string | null },
  exec: GitExec = gitExec,
): Promise<BranchState> {
  if (!SAFE_REF.test(o.branch)) return { unpushed: 0, uncommitted: 0, merged: false };
  const [counts, merged] = await Promise.all([
    branchCounts(worktree, o.branch, exec),
    isMerged(worktree, o, exec),
  ]);
  return { ...counts, merged };
}
