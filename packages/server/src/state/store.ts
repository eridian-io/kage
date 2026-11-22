import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Kage's state directory: `$XDG_STATE_HOME/kage`, else `~/.local/state/kage`. */
export function stateDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'kage');
  return join(env.HOME || homedir(), '.local', 'state', 'kage');
}

/** Directories can't be opened or fsynced on Windows (and some filesystems); that's fine. */
const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'ENOTSUP']);

/** Makes a rename in `dir` durable where the platform supports it. */
async function syncDir(dir: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch (err) {
    if (!DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** What tmux and git can't tell Kage about a session it created (spec §5.1, §5.2). */
export interface SessionRecord {
  /** The window's `@kage_id`; ownership is this UUID, not the window id. */
  kageId: string;
  /** The tmux window id last seen with this kageId (`@12`), or null. */
  windowId: string | null;
  project: string;
  task: string;
  branch: string;
  worktree: string;
  /** Epoch ms. */
  createdAt: number;
  pinned: boolean;
  archived: boolean;
  /** Claude's session id and transcript, learned from SessionStart. */
  sessionId: string | null;
  transcriptPath: string | null;
  /** The branch the task started from; null for records saved before phase 3. */
  base: string | null;
  /** The permission mode Claude was started with; 'default' for records saved before phase 3. */
  permissionMode: 'default' | 'acceptEdits';
  /** The commit the worktree was cut from; null for records saved before phase 4. */
  baseCommit: string | null;
  /** Epoch ms of the last move into done or ended; null while active. */
  doneAt: number | null;
  /** Epoch ms of the last archive; null when not archived. */
  archivedAt: number | null;
  /** Epoch ms of the last restore; auto-archive skips the session until its next done (F2). */
  restoredAt: number | null;
  /** Epoch ms of the last unpin; the age rule of auto-archive counts from it too (R69). */
  unpinnedAt: number | null;
}

const VERSION = 1;

const isStr = (v: unknown): v is string => typeof v === 'string';
/** A full commit id (sha1 or sha256), as Kage records `baseCommit`. */
export const HEX_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const timeOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function toRecord(v: unknown): SessionRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    !isStr(o.kageId) ||
    o.kageId === '' ||
    !isStrOrNull(o.windowId) ||
    !isStr(o.project) ||
    !isStr(o.task) ||
    !isStr(o.branch) ||
    !isStr(o.worktree) ||
    typeof o.createdAt !== 'number' ||
    !Number.isFinite(o.createdAt) ||
    typeof o.pinned !== 'boolean' ||
    typeof o.archived !== 'boolean' ||
    !isStrOrNull(o.sessionId ?? null) ||
    !isStrOrNull(o.transcriptPath ?? null) ||
    !isStrOrNull(o.base ?? null) ||
    (o.permissionMode !== undefined &&
      o.permissionMode !== 'default' &&
      o.permissionMode !== 'acceptEdits')
  ) {
    return null;
  }
  return {
    kageId: o.kageId,
    windowId: o.windowId,
    project: o.project,
    task: o.task,
    branch: o.branch,
    worktree: o.worktree,
    createdAt: o.createdAt,
    pinned: o.pinned,
    archived: o.archived,
    sessionId: (o.sessionId as string | null | undefined) ?? null,
    transcriptPath: (o.transcriptPath as string | null | undefined) ?? null,
    base: (o.base as string | null | undefined) ?? null,
    permissionMode: o.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default',
    baseCommit: isStr(o.baseCommit) && HEX_COMMIT.test(o.baseCommit) ? o.baseCommit : null,
    doneAt: timeOrNull(o.doneAt),
    // Only an archived record has an archive time; one without gets its creation time.
    archivedAt: o.archived ? (timeOrNull(o.archivedAt) ?? o.createdAt) : null,
    restoredAt: timeOrNull(o.restoredAt),
    unpinnedAt: timeOrNull(o.unpinnedAt),
  };
}

/**
 * The state file (`$XDG_STATE_HOME/kage/state.json`): `{version, records}`. Saves write a temp
 * file and rename it over the old one, so a crash leaves either the old or the new file.
 */
export class StateStore {
  readonly path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /** The saved records; [] when the file is missing. A corrupt file is set aside and gives []. */
  async load(): Promise<SessionRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return this.#setAside();
    }
    const records = (data as { records?: unknown } | null)?.records;
    if (
      typeof data !== 'object' ||
      data === null ||
      Array.isArray(data) ||
      !Array.isArray(records)
    ) {
      return this.#setAside();
    }
    return records.flatMap((r) => {
      const ok = toRecord(r);
      return ok ? [ok] : [];
    });
  }

  /** Writes all records atomically. Saves run one at a time, in call order. */
  save(records: SessionRecord[]): Promise<void> {
    const text = `${JSON.stringify({ version: VERSION, records }, null, 2)}\n`;
    const run = this.#queue.then(() => this.#write(text));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(text: string): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    // The data reaches the disk before the rename makes it the state file.
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    await syncDir(dir);
  }

  async #setAside(): Promise<SessionRecord[]> {
    try {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
    } catch {
      // Gone already or not renameable: the next save replaces it.
    }
    return [];
  }
}
