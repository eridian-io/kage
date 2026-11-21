import type { DisplayLine, Session } from '@kage/shared';

export class NotFoundError extends Error {}

/** Thrown (as a rejection) by actions that arrive in a later phase; the API answers 501. */
export class NotImplementedError extends Error {}

export type SourceEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; id: string }
  /** Appended lines; with `reset`, the session's whole line list (a pane snapshot, a new transcript). */
  | { type: 'session.lines'; id: string; lines: DisplayLine[]; reset?: boolean };

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
  /** Never emits 'snapshot'. */
  subscribe(fn: (e: SourceEvent) => void): () => void;
}
