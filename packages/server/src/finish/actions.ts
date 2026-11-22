import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DeleteBody } from '@kage/shared';
import { ActionError, ActionLock, GONE_RE, isExecError } from '../control/actions.ts';
import { SAFE_REF, worktreeCounts } from '../git/branch.ts';
import { firstLine, type GitExec } from '../git/exec.ts';
import { findProject } from '../git/projects.ts';
import type { LiveSource } from '../live-source.ts';
import type { SessionRecord } from '../state/store.ts';
import type { TmuxClient } from '../tmux/client.ts';

export type FinishTmux = Pick<TmuxClient, 'killOwnedWindow' | 'windowKageId' | 'capturePane'>;
export type FinishSource = Pick<LiveSource, 'finishTarget' | 'setFlags' | 'markStopped' | 'forget'>;

type Counts = { unpushed: number; uncommitted: number; ignored: number };

export interface FinishDeps {
  tmux: FinishTmux;
  source: FinishSource;
  lock?: ActionLock;
  /** Delete's git (gitExec: fsmonitor off, no prompts, no optional locks). */
  git: GitExec;
  projectsRoot: string;
  worktreeDir: string;
  /** R74: delete only touches branches with this prefix (a hand-edited record can't name others). */
  branchPrefix: string;
  /** A record's unpushed commits, uncommitted and ignored entries (branchCounts), in its worktree. */
  counts: (worktree: string, branch: string) => Promise<Counts>;
  /** Fresh counts after a mismatch, so the board shows them (LiveSource.setPreview). */
  publish: (id: string, patch: Counts) => void;
  /** The project folder of a record; null when it is gone (default findProject). */
  findProject?: (name: string) => Promise<{ path: string } | null>;
}

export const BUSY = 'Kage is still finishing the last action on this session.';
const NOT_KAGES = "That window isn't Kage's any more.";
const ACTIVE = 'Stop the session before archiving it.';
const ACTIVE_DELETE = 'Stop the session before deleting it.';
const CHANGED = 'The branch changed since you looked. Look again before deleting.';
export const notKageWorktree = (worktree: string) =>
  `Kage won't delete ${worktree}: it isn't one of Kage's worktrees.`;
/** R71: git lists the record's worktree, but on another branch or a detached HEAD. */
export const OFF_BRANCH =
  "This worktree isn't on its branch any more. Switch it back in the terminal, or remove it there.";
/** Claude's footer while a turn runs (integration §7). */
const BUSY_FOOTER = /esc to interrupt/i;
/** `git worktree remove` may delete a large tree: 60 s, like `worktree add`. */
const WORKTREE_REMOVE_TIMEOUT_MS = 60_000;

/** True when `child` is strictly below `parent` (both absolute). */
function below(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The path with every link resolved: realpath of the nearest folder that exists, plus the rest,
 * so a folder that is gone still compares with git's listing and with the repo.
 */
async function canonical(path: string): Promise<string> {
  let probe = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(probe), ...rest);
    } catch {
      const up = dirname(probe);
      if (up === probe) return resolve(path);
      rest.unshift(basename(probe));
      probe = up;
    }
  }
}

/** On Windows paths compare without case (git prints `C:/…` with forward slashes). */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Delete's containment check, shared with resume: the record's branch passes SAFE_REF, carries
 * the branch prefix (R74) and isn't its base, and its absolute worktree path resolves (links
 * too) strictly inside `<project>/<worktreeDir>/`. Gives the canonical repo and worktree, or null
 * when the record doesn't describe one of Kage's worktrees. Read-only; no git.
 */
export async function kageWorktree(
  r: Pick<SessionRecord, 'branch' | 'base' | 'worktree'>,
  projectPath: string,
  worktreeDir: string,
  branchPrefix: string,
): Promise<{ repo: string; worktree: string } | null> {
  if (!SAFE_REF.test(r.branch) || r.branch === r.base) return null;
  if (!r.branch.startsWith(branchPrefix) || r.branch === branchPrefix) return null;
  if (!isAbsolute(r.worktree)) return null;
  const repo = await canonical(projectPath);
  const root = await canonical(resolve(projectPath, worktreeDir));
  const worktree = await canonical(r.worktree);
  if (!below(repo, root) || !below(root, worktree)) return null;
  return { repo, worktree };
}

interface WorktreeEntry {
  path: string;
  /** `refs/heads/<b>`, or null when detached. */
  branch: string | null;
}

/** `git worktree list --porcelain`: the entries in order, the main worktree first. */
function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      entries.push(cur);
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch '.length);
  }
  return entries;
}

/** What delete found on disk and in git, read before the kill and again after it. */
interface DeletePlan {
  /** The project folder (git's cwd). */
  repo: string;
  /** The worktree's canonical path, the one checked and the one handed to git. */
  worktree: string;
  /** git lists the record's worktree, on its branch, not as the main worktree. */
  listed: boolean;
  folder: boolean;
  branch: boolean;
}

/**
 * Pin, archive, restore and delete (spec §5.8). They need a record (external sessions are 403).
 * Archive and delete close a finished session's window through killOwnedWindow, which re-reads
 * `@kage_id` right before the kill; neither acts on a running or needs-you session. One action at
 * a time per session, on the lock shared with SessionControls and resume (F5, R68).
 */
export class FinishActions {
  readonly #tmux: FinishTmux;
  readonly #source: FinishSource;
  readonly #lock: ActionLock;
  readonly #d: FinishDeps;

  constructor(d: FinishDeps) {
    this.#tmux = d.tmux;
    this.#source = d.source;
    this.#lock = d.lock ?? new ActionLock();
    this.#d = d;
  }

  /** Any record session, in any status. */
  pin(id: string, pinned: boolean): Promise<void> {
    return this.#locked(id, async () => {
      const t = this.#source.finishTarget(id);
      if (!t?.record) throw new ActionError(403, 'Kage only pins sessions it started.');
      await this.#source.setFlags(id, { pinned });
    });
  }

  /** `archived: true` archives (closing a done session's window); false restores. */
  archive(id: string, archived: boolean): Promise<void> {
    return this.#locked(id, async () => {
      const t = this.#source.finishTarget(id);
      const record = t?.record;
      if (!t || !record) throw new ActionError(403, 'Kage only archives sessions it started.');
      if (record.archived === archived) return;
      if (!archived) {
        await this.#source.setFlags(id, { archived: false });
        return;
      }
      if (t.status === 'running' || t.status === 'needs-you') throw new ActionError(409, ACTIVE);
      if (t.windowId !== null) {
        await this.#stillIdle(id, t.paneId);
        if (await this.#close(t.windowId, record.kageId)) this.#source.markStopped(id);
      }
      await this.#source.setFlags(id, { archived: true });
    });
  }

  /**
   * Deletes a Kage session's window, worktree, branch and record (spec §5.8, B10), only as
   * `seen` (the counts the confirmation showed) still describes the branch:
   * 1. 403 for an external session, 409 while it runs or needs you;
   * 2. the record's branch passes SAFE_REF, carries the branch prefix (R74) and isn't its base,
   *    and its absolute worktree path resolves (links too) strictly inside `<repo>/<worktreeDir>/`
   *    and, when git lists it, isn't the main worktree; else 409 with nothing touched. Listed on
   *    another branch or detached is 409 too (R71);
   * 3. a recount (unpushed, uncommitted, ignored: R73) differing from `seen` publishes the
   *    fresh counts and answers 409;
   * 4. the window is killed (only while it holds the record's kage id), then 2 and 3 run again
   *    (F10: an idle claude could take a follow-up before the kill);
   * 5. `git worktree remove [--force]` on the canonical path when git lists it (--force only for
   *    confirmed uncommitted entries; confirmed ignored files go with a plain remove). Never
   *    `worktree prune` (R72): it would unregister other worktrees too;
   * 6. `git branch -D` (the counts were confirmed);
   * 7. the record is forgotten.
   * A git failure is a 422 naming what stays. When the project folder is gone, only the window
   * is killed and the record forgotten.
   */
  remove(id: string, seen: DeleteBody): Promise<void> {
    return this.#locked(id, async () => {
      const t = this.#source.finishTarget(id);
      const record = t?.record;
      if (!t || !record) throw new ActionError(403, 'Kage only deletes sessions it started.');
      if (t.status === 'running' || t.status === 'needs-you') {
        throw new ActionError(409, ACTIVE_DELETE);
      }
      const find =
        this.#d.findProject ?? ((name) => findProject(this.#d.projectsRoot, name, this.#d.git));
      const project = await find(record.project);
      if (project) await this.#check(id, record, project.path, seen);
      if (t.windowId !== null) {
        await this.#stillIdle(id, t.paneId, ACTIVE_DELETE);
        if (await this.#close(t.windowId, record.kageId)) this.#source.markStopped(id);
      }
      if (project) {
        const plan = await this.#check(id, record, project.path, seen);
        await this.#removeWorktree(plan, seen);
        if (plan.branch) {
          try {
            await this.#d.git(['branch', '-D', '--', record.branch], { cwd: plan.repo });
          } catch (e) {
            const what = `git couldn't delete the branch: ${firstLine(e)}`;
            throw new ActionError(422, plan.listed ? `Removed the worktree, but ${what}` : what);
          }
        }
      }
      await this.#source.forget(id);
    });
  }

  /** Steps 2 and 3 of remove: the record's worktree and branch are Kage's, and `seen` matches. */
  async #check(id: string, r: SessionRecord, repo: string, seen: Counts): Promise<DeletePlan> {
    const plan = await this.#plan(r, repo);
    let fresh: Counts;
    try {
      if (plan.folder && plan.branch) fresh = await this.#d.counts(plan.worktree, r.branch);
      else {
        const w = plan.folder
          ? await worktreeCounts(plan.worktree, this.#d.git)
          : { uncommitted: 0, ignored: 0 };
        fresh = { unpushed: plan.branch ? await this.#unpushedInRepo(repo, r.branch) : 0, ...w };
      }
    } catch (e) {
      throw new ActionError(422, `git couldn't count the work on the branch: ${firstLine(e)}`);
    }
    if (
      fresh.unpushed !== seen.unpushed ||
      fresh.uncommitted !== seen.uncommitted ||
      fresh.ignored !== seen.ignored
    ) {
      const { unpushed, uncommitted, ignored } = fresh;
      this.#d.publish(id, { unpushed, uncommitted, ignored });
      throw new ActionError(409, CHANGED);
    }
    return plan;
  }

  /** Step 2 of remove (read-only): refuses with 409 unless the worktree and branch are Kage's. */
  async #plan(r: SessionRecord, projectPath: string): Promise<DeletePlan> {
    const refuse = () => new ActionError(409, notKageWorktree(r.worktree));
    const contained = await kageWorktree(r, projectPath, this.#d.worktreeDir, this.#d.branchPrefix);
    if (!contained) throw refuse();
    const wt = contained.worktree;
    const git = (args: string[]) => this.#d.git(args, { cwd: projectPath });
    let entries: WorktreeEntry[];
    try {
      entries = parseWorktrees((await git(['worktree', 'list', '--porcelain'])).stdout);
    } catch (e) {
      throw new ActionError(422, `git couldn't list the worktrees: ${firstLine(e)}`);
    }
    let listed = false;
    for (const [i, e] of entries.entries()) {
      if (!samePath(await canonical(e.path), wt)) continue;
      if (i === 0) throw refuse();
      if (e.branch !== `refs/heads/${r.branch}`) throw new ActionError(409, OFF_BRANCH);
      listed = true;
    }
    const folder = await exists(wt);
    if (!listed && folder) throw refuse();
    let branch: boolean;
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/heads/${r.branch}`]);
      branch = true;
    } catch (e) {
      if ((e as { code?: unknown }).code !== 1) {
        throw new ActionError(422, `git couldn't read the branch: ${firstLine(e)}`);
      }
      branch = false;
    }
    return { repo: projectPath, worktree: wt, listed, folder, branch };
  }

  /**
   * Unpushed commits when the worktree folder is gone: host-integration §5.3 run in the repo,
   * without the worktree's HEAD (the repo's own HEAD isn't this session's).
   */
  async #unpushedInRepo(repo: string, branch: string): Promise<number> {
    const { stdout } = await this.#d.git(
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
      { cwd: repo },
    );
    const n = Number(stdout.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`git gave no count: ${stdout.trim()}`);
    return n;
  }

  /**
   * Step 5 of remove: `git worktree remove` on the canonical path git lists. Not listed (and,
   * from #plan, the folder gone): nothing to remove; never `worktree prune` (R72).
   */
  async #removeWorktree(plan: DeletePlan, seen: Counts): Promise<void> {
    if (!plan.listed) return;
    // --force only for uncommitted entries the user confirmed; else git refuses dirty trees.
    // Ignored files go with a plain remove, so their confirmed count is what allows it (R73).
    const force = seen.uncommitted > 0 ? ['--force'] : [];
    try {
      await this.#d.git(['worktree', 'remove', ...force, '--', plan.worktree], {
        cwd: plan.repo,
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      });
    } catch (e) {
      throw new ActionError(422, `git couldn't remove the worktree: ${firstLine(e)}`);
    }
  }

  /**
   * Right before the kill (Task 4 review, auto-archive): the pane's visible screen shows no busy
   * footer, and the session is still neither running nor needs you, read again after that
   * capture. Otherwise 409 with `active`. A pane already gone passes (the kill then finds the
   * window gone).
   */
  async #stillIdle(id: string, paneId: string | null, active = ACTIVE): Promise<void> {
    if (paneId !== null) {
      let screen = '';
      try {
        screen = await this.#tmux.capturePane(paneId, 0);
      } catch (e) {
        if (!isExecError(e)) throw e;
        if (!GONE_RE.test(firstLine(e))) {
          throw new ActionError(422, `tmux couldn't read the window: ${firstLine(e)}`);
        }
      }
      if (BUSY_FOOTER.test(screen)) throw new ActionError(409, active);
    }
    // TODO(Task 12): F11 — once the terminal bridge exists, re-check isTerminalOpen(id) here,
    // inside the lock after the capture await, and refuse (409) an automatic archive while a
    // terminal is open on the session; auto-archive's candidate re-read happens before this await.
    const now = this.#source.finishTarget(id);
    if (!now) throw new ActionError(404, `No session with id ${id}`);
    if (now.status === 'running' || now.status === 'needs-you') throw new ActionError(409, active);
  }

  /**
   * Kills the session's window when it still holds the record's kage id: true when killed, false
   * when it was gone already. A window that now holds another id, or none, is 403.
   */
  async #close(windowId: string, kageId: string): Promise<boolean> {
    try {
      if (await this.#tmux.killOwnedWindow(windowId, kageId)) return true;
      // False is "gone" or "not ours": only the live tag tells which.
      const held = await this.#tmux.windowKageId(windowId);
      if (held !== kageId) throw new ActionError(403, NOT_KAGES);
      throw new ActionError(422, "tmux couldn't close the window.");
    } catch (e) {
      if (e instanceof ActionError || !isExecError(e)) throw e;
      if (GONE_RE.test(firstLine(e))) return false;
      throw new ActionError(422, `tmux couldn't close the window: ${firstLine(e)}`);
    }
  }

  /** 404 for an unknown id, then 409 while another action on the session runs. */
  async #locked(id: string, run: () => Promise<void>): Promise<void> {
    if (!this.#source.finishTarget(id)) throw new ActionError(404, `No session with id ${id}`);
    const release = this.#lock.tryAcquire(id);
    if (!release) throw new ActionError(409, BUSY);
    try {
      await run();
    } finally {
      release();
    }
  }
}
