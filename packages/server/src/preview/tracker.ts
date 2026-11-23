import type { FileChange, Port } from '@kage/shared';
import { type Listener, type Proc, portsFor } from './ports.ts';

/** What the tracker needs to know about one session (LiveSource's `previewTarget`). */
export interface PreviewTarget {
  id: string;
  /** The record's worktree, or an external window's pane cwd. */
  worktree: string;
  /**
   * The record's project folder, which its worktree's git is pinned to (security M4); null for an
   * external window, whose own folder runs git as it is (F12).
   */
  repo: string | null;
  /** The branch the task started from; null for external sessions and old records. */
  base: string | null;
  /** The record's branch; null for external sessions (they get no branch counts). */
  branch: string | null;
  /** The commit the record's worktree was cut from; null for external sessions and old records. */
  baseCommit: string | null;
  /** The window's pane process; null without a live window. */
  panePid: number | null;
  /** Running or needs you: its ports are scanned every 5 s while viewed. */
  active: boolean;
}

export interface PreviewPatch {
  ports?: Port[];
  files?: FileChange[];
  filesTotal?: number;
  /** Why the list is empty though there may be work (UNPINNED); sent with every files value. */
  filesNote?: string;
  /** Commits only the branch reaches; with uncommitted, refreshed with the files (records only). */
  unpushed?: number;
  uncommitted?: number;
  ignored?: number;
}

export interface BranchCounts {
  unpushed: number;
  uncommitted: number;
  ignored: number;
}

export type TouchReason = 'edit' | 'turn-end';

/** One file-list value: the files, how many in all, and a note when git was refused (M4). */
export interface FilesResult {
  files: FileChange[];
  total: number;
  note?: string;
}

export interface PreviewTrackerDeps {
  target: (id: string) => PreviewTarget | null;
  /**
   * A new value for a session. `always` is set for the first value after a view (R32): the tab
   * must get it even when it equals the last one, because the web store keeps held values.
   */
  publish: (id: string, patch: PreviewPatch, always: boolean) => void;
  /** One scan of every listener and process; null where Kage can't scan (not Linux or macOS). */
  scan: (() => Promise<{ listeners: Listener[]; procs: Proc[] }>) | null;
  /** The list, pinned to `repo` when there is one; `note` says why a refused pin listed nothing. */
  files: (worktree: string, base: string | null, repo: string | null) => Promise<FilesResult>;
  /** The session is gone and no other refreshed this worktree: drop its untracked cache (B37). */
  forgetFiles?: (worktree: string) => void;
  /** A record's unpushed commits and uncommitted entries; rejects when git fails. */
  branch: (
    worktree: string,
    o: { branch: string; base: string | null; baseCommit: string | null; repo: string | null },
  ) => Promise<BranchCounts>;
  /** Port scan period while a viewed session is active (default 5000). */
  portEveryMs?: number;
  /** Quiet time after the last edit before the files refresh (default 500). */
  filesDebounceMs?: number;
  /** Longest wait from the first edit of a burst to its refresh (default 3000). */
  filesMaxWaitMs?: number;
}

/**
 * A git failure that means the folder is gone or no repository (an empty list is then the
 * truth), as opposed to a timeout or a full buffer (the last good list stays).
 */
export function worktreeGone(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown } | null;
  if (e?.code === 'ENOENT') return true;
  return /not a git repository/i.test(`${String(e?.stderr ?? '')} ${String(e?.message ?? '')}`);
}

interface FileState {
  timer: ReturnType<typeof setTimeout> | null;
  /** Date.now() of the first touch of the burst the timer waits for. */
  firstAt: number | null;
  running: boolean;
  again: boolean;
}

/**
 * Preview data (spec §5.7) only for sessions a tab is viewing (Review Focus 5): listening ports
 * in the pane's process tree, scanned once on view and every 5 s while some viewed session is
 * running or needs you (one scan serves them all, never two at once); changed files on view and
 * after edits and turn ends, debounced, one git run at a time per session. No viewed session
 * means no timers.
 */
export class PreviewTracker {
  readonly #d: PreviewTrackerDeps;
  readonly #portEveryMs: number;
  readonly #filesDebounceMs: number;
  readonly #filesMaxWaitMs: number;
  #viewed = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #scanning = false;
  #scanAgain = false;
  readonly #fileStates = new Map<string, FileState>();
  readonly #lastPorts = new Map<string, string>();
  readonly #lastFiles = new Map<string, string>();
  readonly #lastCounts = new Map<string, string>();
  /** The worktree each session's files were last read from (B37: forget drops its cache). */
  readonly #worktrees = new Map<string, string>();
  /** Sessions whose next ports or files value is published even when unchanged (R32). */
  readonly #forcePorts = new Set<string>();
  readonly #forceFiles = new Set<string>();
  #stopped = false;

  constructor(d: PreviewTrackerDeps) {
    this.#d = d;
    this.#portEveryMs = d.portEveryMs ?? 5000;
    this.#filesDebounceMs = d.filesDebounceMs ?? 500;
    this.#filesMaxWaitMs = d.filesMaxWaitMs ?? 3000;
  }

  /** The sessions some tab views. Newly viewed ones get their ports and files now. */
  setViewed(ids: ReadonlySet<string>): void {
    if (this.#stopped) return;
    const before = this.#viewed;
    this.#viewed = new Set(ids);
    for (const id of before) if (!this.#viewed.has(id)) this.#unview(id);
    const fresh = [...this.#viewed].filter((id) => !before.has(id));
    for (const id of fresh) this.#refreshNow(id);
    if (fresh.length > 0) void this.#scanPorts();
    this.#arm();
  }

  /** R32: one more tab views a session that was viewed already; it gets both values again. */
  refresh(id: string): void {
    if (this.#stopped || !this.#viewed.has(id)) return;
    this.#refreshNow(id);
    void this.#scanPorts();
  }

  /** An edit hook (files, debounced) or a turn end (files, debounced, and ports now). */
  touch(id: string, reason: TouchReason): void {
    if (this.#stopped || !this.#viewed.has(id)) return;
    this.#filesSoon(id);
    if (reason === 'turn-end') void this.#scanPorts();
  }

  /**
   * The session's status changed: the port timer follows; one arming it scans at once. A session
   * without a live pane (ended) has no ports: `[]` goes out, viewed or not (the publisher drops
   * an unchanged value).
   */
  statusChanged(id: string): void {
    if (this.#stopped) return;
    const t = this.#d.target(id);
    if (t && t.panePid === null) {
      if (this.#viewed.has(id)) this.#publishPorts(id, []);
      else this.#d.publish(id, { ports: [] }, false);
    }
    if (!this.#viewed.has(id)) return;
    const armed = this.#timer !== null;
    this.#arm();
    if (!armed && this.#timer !== null) void this.#scanPorts();
  }

  /** The session is gone. */
  forget(id: string): void {
    this.#viewed.delete(id);
    this.#unview(id);
    this.#fileStates.delete(id);
    this.#lastPorts.delete(id);
    this.#lastFiles.delete(id);
    this.#lastCounts.delete(id);
    const worktree = this.#worktrees.get(id);
    this.#worktrees.delete(id);
    if (worktree !== undefined && ![...this.#worktrees.values()].includes(worktree)) {
      this.#d.forgetFiles?.(worktree);
    }
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const st of this.#fileStates.values()) if (st.timer) clearTimeout(st.timer);
    this.#fileStates.clear();
    this.#viewed.clear();
  }

  // ------------------------------------------------------------ ports

  /** The 5 s timer runs only while some viewed session is active (and a scanner exists). */
  #arm(): void {
    const want =
      !this.#stopped &&
      this.#d.scan !== null &&
      [...this.#viewed].some((id) => this.#d.target(id)?.active === true);
    if (want && !this.#timer) {
      this.#timer = setInterval(() => {
        if (!this.#scanning) void this.#scanPorts();
      }, this.#portEveryMs);
    } else if (!want && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #scanPorts(): Promise<void> {
    if (this.#stopped) return;
    if (this.#scanning) {
      this.#scanAgain = true;
      return;
    }
    const scan = this.#d.scan;
    const withPane = [...this.#viewed].some((id) => (this.#d.target(id)?.panePid ?? null) !== null);
    this.#scanning = true;
    let result: { listeners: Listener[]; procs: Proc[] } | null = null;
    let failed = false;
    if (scan && withPane) {
      try {
        result = await scan();
      } catch {
        failed = true;
      }
    }
    this.#scanning = false;
    if (this.#stopped) return;
    if (failed) {
      // R32: a view still gets a ports event, the last good value or none.
      for (const id of this.#viewed) {
        if (!this.#forcePorts.has(id)) continue;
        const last = this.#lastPorts.get(id);
        this.#publishPorts(id, last ? (JSON.parse(last) as Port[]) : []);
      }
    } else {
      for (const id of this.#viewed) {
        const t = this.#d.target(id);
        if (!t) continue;
        if (t.panePid !== null && scan && !result) continue; // got a pane after the scan began
        const ports =
          t.panePid !== null && result ? portsFor(t.panePid, result.listeners, result.procs) : [];
        this.#publishPorts(id, ports);
      }
    }
    this.#arm();
    if (this.#scanAgain) {
      this.#scanAgain = false;
      void this.#scanPorts();
    }
  }

  #publishPorts(id: string, ports: Port[]): void {
    const key = JSON.stringify(ports);
    const always = this.#forcePorts.delete(id);
    if (!always && this.#lastPorts.get(id) === key) return;
    this.#lastPorts.set(id, key);
    this.#d.publish(id, { ports }, always);
  }

  // ------------------------------------------------------------ files

  #refreshNow(id: string): void {
    this.#forcePorts.add(id);
    this.#forceFiles.add(id);
    const st = this.#fileState(id);
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.firstAt = null;
    void this.#runFiles(id, st);
  }

  #unview(id: string): void {
    const st = this.#fileStates.get(id);
    if (st?.timer) clearTimeout(st.timer);
    if (st) {
      st.timer = null;
      st.again = false;
      if (!st.running) this.#fileStates.delete(id);
    }
    this.#forcePorts.delete(id);
    this.#forceFiles.delete(id);
    // A later view starts from nothing: no stale value suppresses or stands in for a new one.
    this.#lastPorts.delete(id);
    this.#lastFiles.delete(id);
    this.#lastCounts.delete(id);
  }

  #fileState(id: string): FileState {
    let st = this.#fileStates.get(id);
    if (!st) {
      st = { timer: null, firstAt: null, running: false, again: false };
      this.#fileStates.set(id, st);
    }
    return st;
  }

  #filesSoon(id: string): void {
    const st = this.#fileState(id);
    if (st.timer) clearTimeout(st.timer);
    const now = Date.now();
    st.firstAt ??= now;
    // Debounced, but a long burst of edits still refreshes every 3 s.
    const wait = Math.max(
      0,
      Math.min(this.#filesDebounceMs, st.firstAt + this.#filesMaxWaitMs - now),
    );
    st.timer = setTimeout(() => {
      st.timer = null;
      st.firstAt = null;
      void this.#runFiles(id, st);
    }, wait);
  }

  async #runFiles(id: string, st: FileState): Promise<void> {
    if (st.running) {
      st.again = true;
      return;
    }
    const t = this.#d.target(id);
    if (!t) return;
    st.running = true;
    this.#worktrees.set(id, t.worktree);
    // A record's branch counts run beside the files; a failed count keeps the last value.
    const branch = t.branch;
    const counts =
      branch === null
        ? null
        : this.#d
            .branch(t.worktree, { branch, base: t.base, baseCommit: t.baseCommit, repo: t.repo })
            .catch(() => null);
    let r: FilesResult | null;
    try {
      r = await this.#d.files(t.worktree, t.base, t.repo);
    } catch (err) {
      // Gone or no repository: nothing to show. A timeout or similar keeps the last good list.
      r = worktreeGone(err) ? { files: [], total: 0 } : null;
    }
    // No extra await without counts: an external session's values go out exactly as before.
    const c = counts ? await counts : null;
    st.running = false;
    // Stopped, forgotten or no longer viewed: the result goes nowhere.
    if (this.#stopped || this.#fileStates.get(id) !== st) return;
    if (!this.#viewed.has(id)) {
      this.#fileStates.delete(id);
      return;
    }
    if (c) this.#publishCounts(id, c);
    if (r) this.#publishFiles(id, r);
    else if (this.#forceFiles.has(id)) {
      // R32: a view still gets a files event, the last good value or none.
      const last = this.#lastFiles.get(id);
      this.#publishFiles(id, last ? JSON.parse(last) : { files: [], total: 0 });
    }
    if (st.again) {
      st.again = false;
      void this.#runFiles(id, st);
    }
  }

  #publishCounts(id: string, c: BranchCounts): void {
    const key = `${c.unpushed},${c.uncommitted},${c.ignored}`;
    if (this.#lastCounts.get(id) === key) return;
    this.#lastCounts.set(id, key);
    const patch = { unpushed: c.unpushed, uncommitted: c.uncommitted, ignored: c.ignored };
    this.#d.publish(id, patch, false);
  }

  #publishFiles(id: string, r: FilesResult): void {
    const key = JSON.stringify(r);
    const always = this.#forceFiles.delete(id);
    if (!always && this.#lastFiles.get(id) === key) return;
    this.#lastFiles.set(id, key);
    const note = r.note !== undefined ? { filesNote: r.note } : {};
    this.#d.publish(id, { files: r.files, filesTotal: r.total, ...note }, always);
  }
}
