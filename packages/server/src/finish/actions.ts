import { ActionError, ActionLock, GONE_RE, isExecError } from '../control/actions.ts';
import { firstLine } from '../git/exec.ts';
import type { LiveSource } from '../live-source.ts';
import type { TmuxClient } from '../tmux/client.ts';

export type FinishTmux = Pick<TmuxClient, 'killOwnedWindow' | 'windowKageId'>;
export type FinishSource = Pick<LiveSource, 'finishTarget' | 'setFlags' | 'markStopped'>;

const BUSY = 'Kage is still finishing the last action on this session.';
const NOT_KAGES = "That window isn't Kage's any more.";

/**
 * Pin, archive and restore (spec §5.8). They need a record (external sessions are 403). Archive
 * closes a finished session's window through killOwnedWindow, which re-reads `@kage_id` right
 * before the kill; it never archives a running or needs-you session. One action at a time per
 * session, on the lock shared with SessionControls, delete and resume (F5).
 */
export class FinishActions {
  readonly #tmux: FinishTmux;
  readonly #source: FinishSource;
  readonly #lock: ActionLock;

  constructor(d: { tmux: FinishTmux; source: FinishSource; lock?: ActionLock }) {
    this.#tmux = d.tmux;
    this.#source = d.source;
    this.#lock = d.lock ?? new ActionLock();
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
      if (t.status === 'running' || t.status === 'needs-you') {
        throw new ActionError(409, 'Stop the session before archiving it.');
      }
      if (t.windowId !== null && (await this.#close(t.windowId, record.kageId))) {
        this.#source.markStopped(id);
      }
      await this.#source.setFlags(id, { archived: true });
    });
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
