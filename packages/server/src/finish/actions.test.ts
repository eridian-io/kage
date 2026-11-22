import type { SessionStatus } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { ActionError, ActionLock } from '../control/actions.ts';
import type { FinishTarget } from '../live-source.ts';
import type { SessionRecord } from '../state/store.ts';
import { FinishActions } from './actions.ts';

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  kageId: 'k-1',
  windowId: '@2',
  project: 'shop',
  task: 'Fix the cart total',
  branch: 'kage/fix-the-cart-total',
  worktree: '/home/dev/projects/shop/.worktrees/fix-the-cart-total',
  createdAt: 1_800_000_000_000,
  pinned: false,
  archived: false,
  sessionId: null,
  transcriptPath: null,
  base: 'main',
  permissionMode: 'default',
  baseCommit: null,
  doneAt: null,
  archivedAt: null,
  restoredAt: null,
  ...over,
});

const target = (over: Partial<FinishTarget> = {}): FinishTarget => ({
  id: 'k-1',
  record: rec(),
  windowId: '@2',
  paneId: '%2',
  status: 'done',
  external: false,
  ...over,
});

/** tmux error as execFile gives it (stderr attached). */
const execError = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });

class FakeTmux {
  log: string[] = [];
  /** The live @kage_id of each window; absent means the window is gone. */
  held = new Map<string, string | null>([['@2', 'k-1']]);
  killError: Error | null = null;
  /** Runs inside killOwnedWindow (to interleave a second action). */
  during: (() => Promise<void>) | null = null;
  /** The pane's visible screen, as capturePane gives it. */
  screen = ['Done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts', ''].join('\n');
  /** Each capture as `<pane> <lines>`, in order (kept apart from `log`). */
  captures: string[] = [];
  captureError: Error | null = null;
  /** Runs inside capturePane (to change the session's status meanwhile). */
  onCapture: (() => void) | null = null;
  async capturePane(paneId: string, lines: number): Promise<string> {
    this.captures.push(`${paneId} ${lines}`);
    this.onCapture?.();
    if (this.captureError) throw this.captureError;
    return this.screen;
  }
  async killOwnedWindow(windowId: string, kageId: string): Promise<boolean> {
    this.log.push(`kill ${windowId} ${kageId}`);
    if (this.during) await this.during();
    if (this.killError) throw this.killError;
    if (!this.held.has(windowId) || this.held.get(windowId) !== kageId) return false;
    this.held.delete(windowId);
    return true;
  }
  async windowKageId(windowId: string): Promise<string | null> {
    this.log.push(`read ${windowId}`);
    if (!this.held.has(windowId)) throw execError(`can't find window: ${windowId}`);
    return this.held.get(windowId) ?? null;
  }
}

class FakeSource {
  log: string[] = [];
  targets = new Map<string, FinishTarget>([['k-1', target()]]);
  saveError: Error | null = null;
  finishTarget(id: string): FinishTarget | null {
    const t = this.targets.get(id);
    return t ? { ...t, record: t.record ? { ...t.record } : null } : null;
  }
  async setFlags(id: string, f: { pinned?: boolean; archived?: boolean }): Promise<void> {
    this.log.push(`flags ${id} ${JSON.stringify(f)}`);
    if (this.saveError) throw this.saveError;
    const t = this.targets.get(id);
    if (t?.record) t.record = { ...t.record, ...f };
  }
  markStopped(id: string): void {
    this.log.push(`stopped ${id}`);
    const t = this.targets.get(id);
    if (t) t.status = 'ended';
  }
}

function setup(t: FinishTarget | null = target(), lock = new ActionLock()) {
  const tmux = new FakeTmux();
  const source = new FakeSource();
  if (t) source.targets.set(t.id, t);
  else source.targets.clear();
  const finish = new FinishActions({ tmux, source, lock });
  return { tmux, source, finish, lock };
}

async function refusal(p: Promise<void>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    return e as ActionError;
  }
  throw new Error('expected the action to be refused');
}

describe('FinishActions.pin', () => {
  it('sets pinned on a record session, in any status', async () => {
    for (const status of ['running', 'needs-you', 'done', 'ended'] as SessionStatus[]) {
      const { finish, source, tmux } = setup(target({ status }));
      await finish.pin('k-1', true);
      await finish.pin('k-1', false);
      expect(source.log).toEqual(['flags k-1 {"pinned":true}', 'flags k-1 {"pinned":false}']);
      expect(tmux.log).toEqual([]);
    }
  });

  it('an external session → 403 with no save', async () => {
    const { finish, source } = setup(target({ id: 'ext-@3', record: null, external: true }));
    const e = await refusal(finish.pin('ext-@3', true));
    expect([e.status, e.message]).toEqual([403, 'Kage only pins sessions it started.']);
    expect(source.log).toEqual([]);
  });

  it('an unknown id → 404', async () => {
    const { finish } = setup(null);
    const e = await refusal(finish.pin('nope', true));
    expect([e.status, e.message]).toEqual([404, 'No session with id nope']);
  });
});

describe('FinishActions.archive', () => {
  it('a done session with a live window: kills it with the record kage id, markStopped, then archives', async () => {
    const { finish, source, tmux } = setup();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('while running or needs you → 409, with no kill', async () => {
    for (const status of ['running', 'needs-you'] as SessionStatus[]) {
      const { finish, source, tmux } = setup(target({ status }));
      const e = await refusal(finish.archive('k-1', true));
      expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
      expect(tmux.log).toEqual([]);
      expect(source.log).toEqual([]);
    }
  });

  it('killOwnedWindow false while the window holds another @kage_id → 403, nothing archived', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.set('@2', 'k-other');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([403, "That window isn't Kage's any more."]);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual([]);
  });

  it('killOwnedWindow false on an untagged window → 403 too', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.set('@2', null);
    expect((await refusal(finish.archive('k-1', true))).status).toBe(403);
    expect(source.log).toEqual([]);
  });

  it('killOwnedWindow false because the window is gone: archived anyway, no markStopped', async () => {
    const { finish, source, tmux } = setup();
    tmux.held.clear();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it('an ended session with no window: archived with no tmux call', async () => {
    const { finish, source, tmux } = setup(target({ status: 'ended', windowId: null }));
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it('archiving an archived session is a no-op', async () => {
    const { finish, source, tmux } = setup(
      target({ status: 'ended', windowId: null, record: rec({ archived: true, archivedAt: 5 }) }),
    );
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('restore: setFlags({archived: false}); restoring one that is not archived is a no-op', async () => {
    const a = setup(
      target({ status: 'ended', windowId: null, record: rec({ archived: true, archivedAt: 5 }) }),
    );
    await a.finish.archive('k-1', false);
    expect(a.source.log).toEqual(['flags k-1 {"archived":false}']);
    expect(a.tmux.log).toEqual([]);
    const b = setup(target({ status: 'ended', windowId: null }));
    await b.finish.archive('k-1', false);
    expect(b.source.log).toEqual([]);
  });

  it('an external session → 403 "Kage only archives sessions it started.", no tmux call', async () => {
    const { finish, source, tmux } = setup(
      target({ id: 'ext-@3', record: null, external: true, windowId: '@3' }),
    );
    for (const archived of [true, false]) {
      const e = await refusal(finish.archive('ext-@3', archived));
      expect([e.status, e.message]).toEqual([403, 'Kage only archives sessions it started.']);
    }
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('two concurrent archive calls: the second is 409 and does nothing', async () => {
    const { finish, source, tmux } = setup();
    let second: Promise<ActionError> | null = null;
    tmux.during = async () => {
      tmux.during = null;
      second = refusal(finish.archive('k-1', true));
      await second;
    };
    await finish.archive('k-1', true);
    const e = await (second as unknown as Promise<ActionError>);
    expect([e.status, e.message]).toEqual([
      409,
      'Kage is still finishing the last action on this session.',
    ]);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('the lock is shared: held by another holder (resume, delete) → 409; released after an action, even a failed one', async () => {
    const lock = new ActionLock();
    const { finish, source } = setup(target(), lock);
    const release = lock.tryAcquire('k-1');
    expect(release).not.toBeNull();
    expect((await refusal(finish.pin('k-1', true))).status).toBe(409);
    expect((await refusal(finish.archive('k-1', true))).status).toBe(409);
    release?.();
    source.saveError = new Error('disk full');
    await expect(finish.pin('k-1', true)).rejects.toThrow('disk full');
    source.saveError = null;
    await finish.pin('k-1', true);
    expect(lock.tryAcquire('k-1')).not.toBeNull();
  });

  it('a failed tmux kill (not "gone") → 422 with tmux\'s first line, nothing archived', async () => {
    const { finish, source, tmux } = setup();
    tmux.killError = execError('server exited unexpectedly\nmore');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([
      422,
      "tmux couldn't close the window: server exited unexpectedly",
    ]);
    expect(source.log).toEqual([]);
  });

  it('an unknown id → 404', async () => {
    const { finish } = setup(null);
    expect((await refusal(finish.archive('nope', true))).status).toBe(404);
  });
});

describe('FinishActions.archive: the live re-check right before the kill (Task 4 carry)', () => {
  const BUSY = [
    '● Bash(npm test)',
    '',
    '─'.repeat(40),
    '❯ ',
    '─'.repeat(40),
    '  ⏸ manual mode on · esc to interrupt',
    '',
  ].join('\n');

  it("captures the pane's visible screen, then kills", async () => {
    const { finish, tmux, source } = setup();
    const order: string[] = [];
    tmux.onCapture = () => order.push(`capture (kills so far: ${tmux.log.length})`);
    await finish.archive('k-1', true);
    expect(tmux.captures).toEqual(['%2 0']);
    expect(order).toEqual(['capture (kills so far: 0)']);
    expect(tmux.log).toEqual(['kill @2 k-1']);
    expect(source.log).toEqual(['stopped k-1', 'flags k-1 {"archived":true}']);
  });

  it('a busy footer ("esc to interrupt") on the pane → 409, no kill, nothing archived', async () => {
    const { finish, tmux, source } = setup();
    tmux.screen = BUSY;
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('the session turned running or needs you while the pane was captured → 409, no kill', async () => {
    for (const status of ['running', 'needs-you'] as SessionStatus[]) {
      const { finish, tmux, source } = setup();
      tmux.onCapture = () => {
        const t = source.targets.get('k-1');
        if (t) t.status = status;
      };
      const e = await refusal(finish.archive('k-1', true));
      expect([e.status, e.message]).toEqual([409, 'Stop the session before archiving it.']);
      expect(tmux.log).toEqual([]);
      expect(source.log).toEqual([]);
    }
  });

  it('the pane is gone at the capture: the kill finds it gone, archived anyway', async () => {
    const { finish, tmux, source } = setup();
    tmux.captureError = execError("can't find pane: %2");
    tmux.held.clear();
    await finish.archive('k-1', true);
    expect(tmux.log).toEqual(['kill @2 k-1', 'read @2']);
    expect(source.log).toEqual(['flags k-1 {"archived":true}']);
  });

  it("another capture failure → 422 with tmux's first line, no kill", async () => {
    const { finish, tmux, source } = setup();
    tmux.captureError = execError('server exited unexpectedly');
    const e = await refusal(finish.archive('k-1', true));
    expect([e.status, e.message]).toEqual([
      422,
      "tmux couldn't read the window: server exited unexpectedly",
    ]);
    expect(tmux.log).toEqual([]);
    expect(source.log).toEqual([]);
  });

  it('no window or no pane: no capture', async () => {
    const a = setup(target({ status: 'ended', windowId: null, paneId: null }));
    await a.finish.archive('k-1', true);
    expect(a.tmux.captures).toEqual([]);
  });
});

describe('ActionLock', () => {
  it('one holder per id; release frees it once', () => {
    const lock = new ActionLock();
    const a = lock.tryAcquire('k-1');
    expect(a).not.toBeNull();
    expect(lock.tryAcquire('k-1')).toBeNull();
    expect(lock.tryAcquire('k-2')).not.toBeNull();
    a?.();
    const b = lock.tryAcquire('k-1');
    expect(b).not.toBeNull();
    // A stale release must not free the new holder's lock.
    a?.();
    expect(lock.tryAcquire('k-1')).toBeNull();
  });
});
