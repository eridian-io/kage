import type { DisplayLine, FileChange, Port, Session, Transition } from '@kage/shared';

export class NotFoundError extends Error {}

/** Thrown (as a rejection) by actions that arrive in a later phase; the API answers 501. */
export class NotImplementedError extends Error {}

export type SourceEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; id: string }
  /** Appended lines; with `reset`, the session's whole line list (a pane snapshot, a new transcript). */
  | { type: 'session.lines'; id: string; lines: DisplayLine[]; reset?: boolean }
  | { type: 'session.ports'; id: string; ports: Port[] }
  | { type: 'session.files'; id: string; files: FileChange[]; filesTotal: number; note?: string }
  /** The number of archived sessions changed. */
  | { type: 'archive'; count: number }
  /** A session's status moved (live/status.ts): for the server's own consumers, never a stream. */
  | { type: 'session.transition'; transition: Transition };

export interface SessionSource {
  /** Excludes archived sessions. Each session's `lines` is []. */
  list(): Session[];
  get(id: string): Session | undefined;
  /** The last 200 lines or fewer. */
  lines(id: string): DisplayLine[];
  /** Throws NotFoundError for an unknown id. */
  remove(id: string): Promise<void>;
  /** The sessions some tab is viewing (the hub calls it whenever that set changes). */
  setViewed?(ids: ReadonlySet<string>): void;
  /** One more stream views a session another stream already views (R32: its preview again). */
  refreshView?(id: string): void;
  /** How many sessions are archived; absent means 0. */
  archivedCount?(): number;
  /** Never emits 'snapshot'. */
  subscribe(fn: (e: SourceEvent) => void): () => void;
}
