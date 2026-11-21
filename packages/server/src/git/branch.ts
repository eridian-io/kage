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
 * Commits only this branch reaches (host-integration §5.3):
 * `rev-list --count refs/heads/<b> --not --exclude=<b> --branches --remotes --tags`. A branch
 * failing SAFE_REF counts 0 with no git call. Rejects when git fails.
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
 * Entries of `status --porcelain=v1 -z --untracked-files=normal` (§5.4): an untracked folder
 * counts once, ignored files don't count, and a rename or copy counts once (its old path follows
 * as an extra NUL-terminated field). Rejects when git fails.
 */
export async function uncommittedCount(worktree: string, exec: GitExec = gitExec): Promise<number> {
  const { stdout } = await exec(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
    cwd: worktree,
  });
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

/** The flags that keep a diff from running repository-configured programs (R65, F7). */
const NO_PROGRAMS = ['--no-ext-diff', '--no-textconv', '--no-renames'];

/**
 * The branch has a commit past baseCommit, and its tip is an ancestor of refs/heads/<base> or of
 * refs/remotes/origin/<base>, or every path the branch changed since baseCommit is the same in
 * that ref (a squash or rebase merge): the driver-free path-equal check of host-integration §5.5
 * (R59/R65), never `merge-tree`, which can run a repository's merge driver. False for a null
 * baseCommit or base, a name failing SAFE_REF (no git call), and whenever git fails (closed).
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
    const past = await exec(['rev-list', '--count', tip, `^${baseCommit}`], { cwd });
    if (toCount(past.stdout) === 0) return false;
    const changed = await exec(['diff', ...NO_PROGRAMS, '--name-only', '-z', baseCommit, tip], {
      cwd,
    });
    const paths = changed.stdout.split('\0').filter((p) => p !== '');
    for (const target of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      if (await exitsZero(exec, ['merge-base', '--is-ancestor', tip, target], cwd)) return true;
      // No changed paths: nothing to compare ("n/a" in §5.5), so only ancestry can say merged.
      if (paths.length === 0) continue;
      // Literal pathspecs: a file named "*" or ":(glob)x" stands for itself, not for a pattern.
      const same = await exitsZero(
        exec,
        ['--literal-pathspecs', 'diff', '--quiet', ...NO_PROGRAMS, tip, target, '--', ...paths],
        cwd,
      );
      if (same) return true;
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
