import { watch as fsWatch } from 'node:fs';
import { resolve } from 'node:path';
import type { BranchState } from '../git/branch.ts';
import { firstLine, type GitExec, gitExec } from '../git/exec.ts';

/** A record session auto-archive may archive: done or ended, not pinned, not archived (§5.8). */
export interface AutoCandidate {
  id: string;
  /** The project's main checkout (`<projectsRoot>/<project>`). */
  repo: string;
  worktree: string;
  branch: string;
  base: string | null;
  baseCommit: string | null;
  /** Epoch ms of the session's last move into done or ended. */
  doneAt: number;
  /** Where the age rule counts from (R69): the latest of doneAt, restoredAt and unpinnedAt. */
  ageFrom: number;
}

export interface AutoArchiveDeps {
  /** afterDays 0 turns the age rule off; onMerge false the merge rule. */
  config: { onMerge: boolean; afterDays: number };
  /**
   * Record sessions: done or ended, not pinned, not archived, not restored since their last done
   * (F2), no open terminal (F11).
   */
  candidates: () => AutoCandidate[];
  state: (c: AutoCandidate) => Promise<BranchState>;
  archive: (id: string) => Promise<void>;
  /** `rev-parse --git-common-dir`, made absolute. */
  gitDir: (repo: string) => Promise<string>;
  /**
   * Default fs.watch, not recursive, not keeping the process alive. `onError` reports a watcher
   * that broke later (its directory deleted, for example).
   */
  watch?: (
    dir: string,
    onChange: (name: string | null) => void,
    onError?: (e: unknown) => void,
  ) => { close(): void };
  now?: () => number;
  /** Quiet time after the last relevant change in a git dir before its candidates are checked (5000). */
  debounceMs?: number;
  log?: (line: string) => void;
}

const DAY_MS = 86_400_000;
/** setTimeout's longest delay; a later deadline wakes early and re-arms. */
const MAX_DELAY_MS = 2_147_483_647;
/** Git checks in flight at once (never two of one project). */
const MAX_CHECKS = 2;
const DEBOUNCE_MS = 5000;
/**
 * Top-level names of the git common dir that a merge, pull, fetch or rebase changes
 * (host-integration §5.7), with or without `.lock`: a `git merge --no-ff` shows only
 * `ORIG_HEAD.lock` and `HEAD.lock` of these. `index` and the MERGE_* files are left out: they
 * change on every commit or merge attempt, and the lock names of the same operation cover it.
 */
const WATCH_NAMES = new Set(['FETCH_HEAD', 'ORIG_HEAD', 'packed-refs', 'HEAD']);

/** Logged once per directory when fs.watch throws. */
export const watchFailed = (dir: string): string =>
  `Auto-archive can't watch ${dir}; merges there are seen at the next turn end or restart.`;

/** The git common directory of `repo`, absolute. */
export async function gitCommonDir(repo: string, exec: GitExec = gitExec): Promise<string> {
  const { stdout } = await exec(['rev-parse', '--git-common-dir'], { cwd: repo });
  const out = stdout.replace(/\r?\n$/, '');
  if (out === '') throw new Error(`git gave no common dir for ${repo}`);
  return resolve(repo, out);
}

const defaultWatch = (
  dir: string,
  onChange: (name: string | null) => void,
  onError?: (e: unknown) => void,
) => {
  const w = fsWatch(dir, { persistent: false }, (_event, name) =>
    onChange(name === null ? null : String(name)),
  );
  w.on('error', (e) => onError?.(e));
  return w;
};

/**
 * Auto-archive (spec §5.8 as amended): a candidate is archived when its branch is merged into
 * its base and its worktree is clean (onMerge), or `afterDays` after its last done. Driven only by
 * events: `touch` (a turn end, a move into ended), `start`, an fs.watch per git common dir with
 * candidates (debounced), and one timer for the nearest age deadline. Nothing runs with no
 * candidates. Checks run at most MAX_CHECKS at a time, one per project at a time.
 */
export class AutoArchiver {
  readonly #d: AutoArchiveDeps;
  readonly #now: () => number;
  readonly #watch: NonNullable<AutoArchiveDeps['watch']>;
  readonly #debounceMs: number;
  #running = false;
  /** repo → its git common dir; null when rev-parse failed (not watched until restart). */
  readonly #dirOf = new Map<string, string | null>();
  readonly #resolving = new Set<string>();
  readonly #watchers = new Map<string, { close(): void }>();
  readonly #failedDirs = new Set<string>();
  readonly #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Ids waiting for a check, in order. */
  readonly #queue: string[] = [];
  /** id → repo of checks in flight. */
  readonly #inFlight = new Map<string, string>();
  /** Re-triggered during their check: one more check follows. */
  readonly #again = new Set<string>();
  #pumpQueued = false;
  /** Due by age and queued since their last trigger: the timer leaves them out (no busy loop). */
  readonly #ageTried = new Set<string>();
  /** Ids whose refusal or failure was logged (until they stop being candidates). */
  readonly #logged = new Set<string>();

  constructor(d: AutoArchiveDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.#watch = d.watch ?? defaultWatch;
    this.#debounceMs = d.debounceMs ?? DEBOUNCE_MS;
  }

  /** One pass over every candidate (at most MAX_CHECKS git checks at once). */
  start(): void {
    const { onMerge, afterDays } = this.#d.config;
    if (this.#running || (!onMerge && afterDays <= 0)) return;
    this.#running = true;
    // Queued first, so the deadline timer leaves out the ones already due.
    for (const c of this.#d.candidates()) this.#enqueue(c);
    this.sync();
  }

  /** A session turned done or ended (or took a Stop): check it. */
  touch(id: string): void {
    if (!this.#running) return;
    this.sync();
    const c = this.#candidate(id);
    if (!c) return;
    this.#ageTried.delete(id);
    this.#enqueue(c);
  }

  /** Candidates changed: re-arm the deadline timer, open and close the watchers. */
  sync(): void {
    if (!this.#running) return;
    const cands = this.#d.candidates();
    const ids = new Set(cands.map((c) => c.id));
    for (const set of [this.#ageTried, this.#logged]) {
      for (const id of set) if (!ids.has(id)) set.delete(id);
    }
    this.#arm(cands);
    this.#syncWatchers(cands);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
    this.#queue.length = 0;
    this.#again.clear();
  }

  // ------------------------------------------------------------ the deadline timer

  #deadline(c: AutoCandidate): number {
    return c.ageFrom + this.#d.config.afterDays * DAY_MS;
  }

  #ageDue(c: AutoCandidate): boolean {
    return this.#d.config.afterDays > 0 && this.#now() >= this.#deadline(c);
  }

  /**
   * One timer for the earliest age deadline not yet tried, only while there is one. Deadlines are
   * wall-clock (epoch) times, but setTimeout counts monotonic time, so the delay is recomputed
   * from the wall clock on every call: a suspend or a wall-clock jump is corrected at the next
   * event (sync, touch, or the timer itself). A timer that wakes before its deadline (clamped,
   * or the clock went back) finds nothing due and re-arms; one that wakes late archives late.
   * A forward jump can archive early by the size of the jump.
   */
  #arm(cands: AutoCandidate[]): void {
    let at = Number.POSITIVE_INFINITY;
    if (this.#d.config.afterDays > 0) {
      for (const c of cands) if (!this.#ageTried.has(c.id)) at = Math.min(at, this.#deadline(c));
    }
    if (at === Number.POSITIVE_INFINITY) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, at - this.#now()));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#running) return;
      const cands = this.#d.candidates();
      for (const c of cands) if (!this.#ageTried.has(c.id) && this.#ageDue(c)) this.#enqueue(c);
      this.#arm(cands);
    }, delay);
  }

  // ------------------------------------------------------------ watchers

  /** One watcher per git common dir that has candidates (onMerge only). */
  #syncWatchers(cands: AutoCandidate[]): void {
    const wanted = new Set<string>();
    if (this.#d.config.onMerge) {
      for (const c of cands) {
        const dir = this.#dirOf.get(c.repo);
        if (dir === undefined) this.#resolveDir(c.repo);
        else if (dir !== null && !this.#failedDirs.has(dir)) wanted.add(dir);
      }
    }
    for (const [dir, w] of this.#watchers) {
      if (wanted.has(dir)) continue;
      w.close();
      this.#watchers.delete(dir);
      const t = this.#debounce.get(dir);
      if (t) clearTimeout(t);
      this.#debounce.delete(dir);
    }
    for (const dir of wanted) {
      if (this.#watchers.has(dir)) continue;
      try {
        const w = this.#watch(
          dir,
          (name) => this.#onChange(dir, name),
          () => this.#watchBroke(dir, w),
        );
        this.#watchers.set(dir, w);
      } catch {
        this.#failedDirs.add(dir);
        this.#log(watchFailed(dir));
      }
    }
  }

  /**
   * A watcher broke after it opened (its directory deleted, for example): logged once, dropped,
   * and its dir not watched again until restart; touch and start still check its candidates.
   */
  #watchBroke(dir: string, w: { close(): void }): void {
    if (this.#watchers.get(dir) !== w) return;
    this.#watchers.delete(dir);
    this.#failedDirs.add(dir);
    const t = this.#debounce.get(dir);
    if (t) clearTimeout(t);
    this.#debounce.delete(dir);
    try {
      w.close();
    } catch {}
    this.#log(watchFailed(dir));
  }

  /** Looks up a repo's git common dir once; a failure is logged once and never retried. */
  #resolveDir(repo: string): void {
    if (this.#resolving.has(repo)) return;
    this.#resolving.add(repo);
    this.#d.gitDir(repo).then(
      (dir) => {
        this.#resolving.delete(repo);
        this.#dirOf.set(repo, dir);
        if (this.#running) this.#syncWatchers(this.#d.candidates());
      },
      (e: unknown) => {
        this.#resolving.delete(repo);
        this.#dirOf.set(repo, null);
        this.#log(
          `Auto-archive can't find the git directory of ${repo} (${firstLine(e)}); merges there are seen at the next turn end or restart.`,
        );
      },
    );
  }

  #onChange(dir: string, name: string | null): void {
    if (!this.#running || !this.#watchers.has(dir)) return;
    if (name !== null && !WATCH_NAMES.has(name.replace(/\.lock$/, ''))) return;
    const t = this.#debounce.get(dir);
    if (t) clearTimeout(t);
    this.#debounce.set(
      dir,
      setTimeout(() => {
        this.#debounce.delete(dir);
        if (!this.#running) return;
        for (const c of this.#d.candidates()) {
          if (this.#dirOf.get(c.repo) === dir) this.#enqueue(c);
        }
      }, this.#debounceMs),
    );
  }

  // ------------------------------------------------------------ checks

  #candidate(id: string): AutoCandidate | undefined {
    return this.#d.candidates().find((c) => c.id === id);
  }

  #enqueue(c: AutoCandidate): void {
    if (!this.#running) return;
    if (this.#ageDue(c)) this.#ageTried.add(c.id);
    if (this.#inFlight.has(c.id)) this.#again.add(c.id);
    else if (!this.#queue.includes(c.id)) this.#queue.push(c.id);
    // Checks start on a microtask, so triggers in the same tick share one check.
    if (this.#pumpQueued) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      this.#pump();
    });
  }

  /** Starts queued checks: at most MAX_CHECKS in flight, never two of one project. */
  #pump(): void {
    if (!this.#running) return;
    const cands = new Map(this.#d.candidates().map((c) => [c.id, c]));
    const busy = new Set(this.#inFlight.values());
    for (let i = 0; i < this.#queue.length && this.#inFlight.size < MAX_CHECKS; ) {
      const id = this.#queue[i] as string;
      const c = cands.get(id);
      if (!c) {
        this.#queue.splice(i, 1); // stopped being a candidate: skipped
        continue;
      }
      if (busy.has(c.repo)) {
        i++;
        continue;
      }
      this.#queue.splice(i, 1);
      busy.add(c.repo);
      this.#inFlight.set(id, c.repo);
      void this.#check(c).finally(() => {
        this.#inFlight.delete(id);
        if (this.#again.delete(id)) {
          const fresh = this.#candidate(id);
          if (fresh) this.#enqueue(fresh);
        }
        this.#pump();
      });
    }
  }

  /**
   * The age rule (no git), else the merge rule: merged and a clean worktree. The candidate is
   * read again right before the archive. A refusal or a failed check is logged once per session.
   */
  async #check(c: AutoCandidate): Promise<void> {
    try {
      let due = this.#ageDue(c);
      if (!due && this.#d.config.onMerge) {
        const s = await this.#d.state(c);
        due = s.merged && s.uncommitted === 0;
      }
      // Pinned, archived, restored, active again or a terminal opened meanwhile: skipped. A new
      // doneAt means a turn ran during the check, so its result is stale; the touch of that turn
      // queued a fresh check.
      const fresh = this.#candidate(c.id);
      if (!due || !this.#running || !fresh || fresh.doneAt !== c.doneAt) return;
      await this.#d.archive(c.id);
      this.#logged.delete(c.id);
    } catch (e) {
      if (this.#logged.has(c.id)) return;
      this.#logged.add(c.id);
      this.#log(`Auto-archive skipped ${c.branch}: ${firstLine(e)}`);
    }
  }

  #log(line: string): void {
    try {
      this.#d.log?.(line);
    } catch {}
  }
}
