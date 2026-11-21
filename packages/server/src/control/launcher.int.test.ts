import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitExec } from '../git/exec.ts';
import type { SessionRecord } from '../state/store.ts';
import { hasTmux, TmuxClient } from '../tmux/client.ts';
import { TaskLauncher } from './launcher.ts';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasTmux && hasGit && process.platform !== 'win32')(
  'TaskLauncher (real git and tmux, private socket)',
  () => {
    const sock = `kage-test-${randomBytes(4).toString('hex')}`;
    const tmp = mkdtempSync(join(tmpdir(), 'kage-launch-int-'));
    const root = join(tmp, 'projects');
    const repo = join(root, 'shop');
    const home = join(tmp, 'home');
    const bin = join(tmp, 'fake-claude');
    const saved: Record<string, string | undefined> = {};
    const tmux = (...a: string[]) =>
      execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' });
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...a], {
        cwd,
        encoding: 'utf8',
      });

    beforeAll(() => {
      mkdirSync(repo, { recursive: true });
      mkdirSync(home);
      const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home };
      for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
      // A stand-in for claude: whatever its arguments, it sleeps.
      writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n');
      chmodSync(bin, 0o755);
    });
    afterAll(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    });

    it('starts a tagged window running the program in a new worktree and branch', async () => {
      const client = new TmuxClient({ session: 'kage', socket: sock, configFile: '/dev/null' });
      await client.ensureSession();
      const records: SessionRecord[] = [];
      const claims: [string, string][] = [];
      const launcher = new TaskLauncher({
        projectsRoot: root,
        worktreeDir: '.worktrees',
        branchPrefix: 'kage/',
        git: gitExec,
        tmux: client,
        source: {
          adopt: async (r) => {
            records.push(r);
          },
          claim: (k, w) => {
            claims.push([k, w]);
          },
          abandon: async () => {},
          branchTaken: () => false,
        },
        claudeBin: bin,
        settingsPath: join(tmp, 'claude-settings.json'),
        hookSocket: join(tmp, 'kage.sock'),
        windowPath: process.env.PATH ?? null,
      });

      const { id } = await launcher.start({
        project: 'shop',
        base: 'main',
        task: 'Add a #(touch pwned) dark mode',
        acceptEdits: false,
      });
      const path = join(repo, '.worktrees', 'add-a-touch-pwned-dark-mode');
      expect(existsSync(path)).toBe(true);
      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
        'kage/add-a-touch-pwned-dark-mode',
      );
      expect(records.map((r) => r.kageId)).toEqual([id]);

      const [claimedId, windowId] = claims[0] ?? [];
      expect(claimedId).toBe(id);
      expect(await client.windowKageId(windowId as string)).toBe(id);
      const panes = tmux(
        'list-panes',
        '-t',
        windowId as string,
        '-F',
        '#{pane_current_command}\t#{pane_current_path}',
      ).trim();
      expect(panes).toBe(`sleep\t${path}`);
      // The window's environment: KAGE_SOCKET for hooks, and Kage's PATH.
      if (process.platform === 'linux') {
        const pid = tmux('list-panes', '-t', windowId as string, '-F', '#{pane_pid}').trim();
        const environ = execFileSync('cat', [`/proc/${pid}/environ`], { encoding: 'utf8' });
        expect(environ.split('\0')).toContain(`KAGE_SOCKET=${join(tmp, 'kage.sock')}`);
        expect(environ.split('\0')).toContain(`PATH=${process.env.PATH ?? ''}`);
      }
      // The task never ran as a shell job (#(...) in a format would).
      expect(existsSync(join(path, 'pwned'))).toBe(false);
      expect(existsSync(join(home, 'pwned'))).toBe(false);
    });
  },
);
