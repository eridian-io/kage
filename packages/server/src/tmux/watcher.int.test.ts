import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@kage/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { HookEvent } from '../hooks/event.ts';
import { LiveSource, type TailLike } from '../live-source.ts';
import { NOTIFY_DEFAULTS, Notifier } from '../notify/notifier.ts';
import type { SourceEvent } from '../source.ts';
import type { SessionRecord } from '../state/store.ts';
import { hasTmux, TmuxClient } from './client.ts';
import { testTmuxSocket } from './test-sockets.ts';
import { TmuxWatcher, type WatchEvent } from './watcher.ts';

/**
 * Reliability I1 against real tmux on a private socket: `tmux attach -d` at the PC detaches
 * Kage's control-mode client (it gets %exit) while the server lives. The watcher must re-attach
 * and report only `up`, so no session ends and the phone is not pinged again.
 */

function hasScript(): boolean {
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sock = testTmuxSocket();
const tmp = mkdtempSync(join(tmpdir(), 'kage-watcher-'));
const tmux = (...a: string[]) =>
  execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' }).trim();

/** Polls until `check` is true (or 10 s pass). */
async function until(check: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
  rmSync(tmp, { recursive: true, force: true });
});

const quietTail: TailLike = {
  start: async () => {},
  stop: () => {},
  setIdle: () => {},
  lines: () => [],
  question: () => null,
  now: () => null,
  on: () => () => {},
  onInterrupt: () => () => {},
  onTurnEnd: () => () => {},
};

describe.runIf(hasTmux && process.platform !== 'win32' && hasScript())(
  'TmuxWatcher (real tmux, private socket)',
  () => {
    it('tmux attach -d leaves the watcher up while has-session succeeds', async () => {
      // A window whose command reads as claude (a `claude` link to sleep), tagged as Kage's.
      const fakeClaude = join(tmp, 'claude');
      symlinkSync(
        execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(),
        fakeClaude,
      );
      tmux('new-session', '-d', '-s', 'kage', '-x', '120', '-y', '30');
      const [windowId, paneId] = tmux(
        'new-window',
        '-d',
        '-t',
        '=kage:',
        '-P',
        '-F',
        '#{window_id} #{pane_id}',
        fakeClaude,
        '600',
      ).split(' ') as [string, string];
      tmux('set-option', '-w', '-t', windowId, '@kage_id', 'k-1');

      const client = new TmuxClient({ session: 'kage', socket: sock, configFile: '/dev/null' });
      const watcher = new TmuxWatcher({ session: 'kage', socket: sock, configFile: '/dev/null' });
      const watched: WatchEvent[] = [];
      watcher.on((e) => watched.push(e));
      const hookFns = new Set<(e: HookEvent) => void>();
      const record: SessionRecord = {
        kageId: 'k-1',
        windowId,
        project: 'shop',
        task: 'Fix the cart total',
        branch: 'kage/fix-the-cart-total',
        worktree: join(tmp, 'shop'),
        createdAt: Date.now() - 60_000,
        pinned: false,
        archived: false,
        sessionId: null,
        transcriptPath: null,
        base: null,
        permissionMode: 'default',
        baseCommit: null,
        doneAt: null,
        archivedAt: null,
        restoredAt: null,
        unpinnedAt: null,
      };
      const touched: string[] = [];
      const source = new LiveSource({
        tmux: client,
        watcher,
        hooks: {
          on: (fn) => {
            hookFns.add(fn);
            return () => hookFns.delete(fn);
          },
        },
        store: { load: async () => [{ ...record }], save: async () => {} },
        tail: () => quietTail,
        projectsRoot: tmp,
        autoArchive: () => ({
          start: () => {},
          stop: () => {},
          sync: () => {},
          touch: (id) => touched.push(id),
        }),
      });
      const events: SourceEvent[] = [];
      source.subscribe((e) => events.push(e));
      const pings: string[] = [];
      const notifier = new Notifier({
        source,
        send: async (p) => {
          pings.push(p.title);
          return true;
        },
        link: () => null,
        hostName: 'box',
        options: { ...NOTIFY_DEFAULTS, holdMs: 50 },
        log: () => {},
      });
      let attacher: ReturnType<typeof spawn> | null = null;
      try {
        notifier.listen();
        await source.start();
        notifier.seeded();
        expect(await until(() => watched.some((e) => e.type === 'up'))).toBe(true);
        const fire = (event: HookEvent['event']) => {
          const e: HookEvent = {
            event,
            pane: paneId,
            sessionId: 's-1',
            transcriptPath: null,
            cwd: record.worktree,
            notification: null,
            message: null,
            toolName: event === 'SessionStart' ? null : 'Bash',
            toolInput: null,
            source: null,
            at: Date.now(),
          } as HookEvent;
          for (const fn of [...hookFns]) fn(e);
        };
        fire('SessionStart');
        fire('PreToolUse');
        fire('PermissionRequest');
        expect(await until(() => source.get('k-1')?.status === 'needs-you')).toBe(true);
        expect(await until(() => pings.length === 1)).toBe(true);
        events.length = 0;
        touched.length = 0;
        const ups = watched.filter((e) => e.type === 'up').length;

        // At the PC: attach and detach every other client, Kage's control client included.
        attacher = spawn(
          'script',
          ['-qec', `tmux -f /dev/null -L ${sock} attach -d -t =kage`, '/dev/null'],
          { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TERM: 'xterm-256color' } },
        );
        // The PC's client is attached, and Kage's control client came back beside it.
        const clients = () => tmux('list-clients', '-F', '#{client_control_mode}').split('\n');
        expect(
          await until(() => {
            const c = clients();
            return c.includes('0') && c.includes('1');
          }),
        ).toBe(true);
        expect(await until(() => watched.filter((e) => e.type === 'up').length > ups)).toBe(true);
        // Give a wrong `down` and a new episode time to show.
        await new Promise((r) => setTimeout(r, 500));

        expect(watched.some((e) => e.type === 'down')).toBe(false);
        tmux('has-session', '-t', '=kage');
        expect(source.get('k-1')?.status).toBe('needs-you');
        const ended = events.filter(
          (e): e is Extract<SourceEvent, { type: 'session.updated' }> =>
            e.type === 'session.updated' && (e.session as Session).status === 'ended',
        );
        expect(ended).toEqual([]);
        expect(events.filter((e) => e.type === 'session.removed')).toEqual([]);
        expect(touched).toEqual([]);
        expect(pings).toHaveLength(1);
      } finally {
        attacher?.kill();
        notifier.stop();
        await source.stop();
      }
    }, 30_000);
  },
);
