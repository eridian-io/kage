import type { ServerEvent, Session } from '@kage/shared';

export class NotFoundError extends Error {}

export interface SessionSource {
  /** Excludes archived sessions. */
  list(): Session[];
  get(id: string): Session | undefined;
  /** Throws NotFoundError for an unknown id. */
  remove(id: string): Promise<void>;
  /** Never emits 'snapshot'. */
  subscribe(fn: (e: ServerEvent) => void): () => void;
}
