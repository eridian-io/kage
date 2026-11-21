import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
}

const VERSION = 1;

const isStr = (v: unknown): v is string => typeof v === 'string';
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
    !isStrOrNull(o.transcriptPath ?? null)
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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, this.path);
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
