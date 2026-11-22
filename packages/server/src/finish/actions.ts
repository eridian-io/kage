import { ActionError, ActionLock, GONE_RE, isExecError } from '../control/actions.ts';
import { firstLine } from '../git/exec.ts';
import type { LiveSource } from '../live-source.ts';
import type { TmuxClient } from '../tmux/client.ts';

export type FinishTmux = Pick<TmuxClient, 'killOwnedWindow' | 'windowKageId' | 'capturePane'>;
export type FinishSource = Pick<LiveSource, 'finishTarget' | 'setFlags' | 'markStopped'>;

const BUSY = 'Kage is still finishing the last action on this session.';
const NOT_KAGES = "That window isn't Kage's any more.";
const ACTIVE = 'Stop the session before archiving it.';
/** Claude's footer while a turn runs (integration §7). */
const BUSY_FOOTER = /esc to interrupt/i;

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
      if (t.status === 'running' || t.status === 'needs-you') throw new ActionError(409, ACTIVE);
      if (t.windowId !== null) {
        await this.#stillIdle(id, t.paneId);
        if (await this.#close(t.windowId, record.kageId)) this.#source.markStopped(id);
      }
      await this.#source.setFlags(id, { archived: true });
    });
  }

  /**
   * Right before the kill (Task 4 review, auto-archive): the pane's visible screen shows no busy
   * footer, and the session is still neither running nor needs you, read again after that
   * capture. Otherwise 409. A pane already gone passes (the kill then finds the window gone).
   */
  async #stillIdle(id: string, paneId: string | null): Promise<void> {
    if (paneId !== null) {
      let screen = '';
      try {
        screen = await this.#tmux.capturePane(paneId, 0);
      } catch (e) {
        if (!isExecError(e)) throw e;
        if (!GONE_RE.test(firstLine(e))) {
          throw new ActionError(422, `tmux couldn't read the window: ${firstLine(e)}`);
        }
      }
      if (BUSY_FOOTER.test(screen)) throw new ActionError(409, ACTIVE);
    }
    // TODO(Task 12): F11 — once the terminal bridge exists, re-check isTerminalOpen(id) here,
    // inside the lock after the capture await, and refuse (409) an automatic archive while a
    // terminal is open on the session; auto-archive's candidate re-read happens before this await.
    const now = this.#source.finishTarget(id);
    if (!now) throw new ActionError(404, `No session with id ${id}`);
    if (now.status === 'running' || now.status === 'needs-you') throw new ActionError(409, ACTIVE);
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
