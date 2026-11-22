import { type DisplayLine, demoSessions, type Session } from '@kage/shared';
import { NotFoundError, type SessionSource, type SourceEvent } from './source.ts';

export class DemoSource implements SessionSource {
  private readonly now: number;
  private sessions = new Map<string, Session>();
  private transcripts = new Map<string, DisplayLine[]>();
  private readonly listeners = new Set<(e: SourceEvent) => void>();
  private viewed = new Set<string>();

  constructor(now: number = Number(process.env.KAGE_DEMO_NOW) || Date.now()) {
    this.now = now;
    this.load();
  }

  private load(): Session[] {
    const fresh = demoSessions(this.now);
    this.transcripts = new Map(fresh.map((s) => [s.id, s.lines]));
    const bare = fresh.map((s) => ({ ...s, lines: [] }));
    this.sessions = new Map(bare.map((s) => [s.id, s]));
    return bare;
  }

  private emit(e: SourceEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  list(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.archived);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  lines(id: string): DisplayLine[] {
    return (this.transcripts.get(id) ?? []).slice(-200).map((l) => ({ ...l }));
  }

  async remove(id: string): Promise<void> {
    if (!this.sessions.delete(id)) throw new NotFoundError(`No session "${id}"`);
    this.transcripts.delete(id);
    this.emit({ type: 'session.removed', id });
  }

  /** Sessions some tab views: a newly viewed one gets its files, like live mode's first value after a view. */
  setViewed(ids: ReadonlySet<string>): void {
    for (const id of ids) if (!this.viewed.has(id)) this.sendFiles(id);
    this.viewed = new Set(ids);
  }

  /** Another stream views a session already viewed: its files again. */
  refreshView(id: string): void {
    this.sendFiles(id);
  }

  private sendFiles(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.emit({
      type: 'session.files',
      id,
      files: s.files.map((f) => ({ ...f })),
      filesTotal: s.filesTotal,
    });
  }

  /** Restores the original demo sessions and announces each one. */
  reset(): void {
    for (const s of this.load()) this.emit({ type: 'session.updated', session: s });
  }

  subscribe(fn: (e: SourceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
