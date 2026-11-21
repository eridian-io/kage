import { demoSessions, type ServerEvent, type Session } from '@kage/shared';
import { NotFoundError, type SessionSource } from './source.ts';

export class DemoSource implements SessionSource {
  private readonly now: number;
  private sessions = new Map<string, Session>();
  private readonly listeners = new Set<(e: ServerEvent) => void>();

  constructor(now: number = Number(process.env.KAGE_DEMO_NOW) || Date.now()) {
    this.now = now;
    this.load();
  }

  private load(): Session[] {
    const fresh = demoSessions(this.now);
    this.sessions = new Map(fresh.map((s) => [s.id, s]));
    return fresh;
  }

  private emit(e: ServerEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  list(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.archived);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async remove(id: string): Promise<void> {
    if (!this.sessions.delete(id)) throw new NotFoundError(`No session "${id}"`);
    this.emit({ type: 'session.removed', id });
  }

  /** Restores the original demo sessions and announces each one. */
  reset(): void {
    for (const s of this.load()) this.emit({ type: 'session.updated', session: s });
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
