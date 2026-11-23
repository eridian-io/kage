/**
 * `kage uninstall` (phase 6, Task 7): removes what Kage installed (its service, its program and
 * its hooks file, R119-6) and, with --purge, its config and state folders. Never a project, a worktree, a branch or the
 * tmux session "kage": nothing here runs git or tmux, and the user's windows keep running.
 * Linger is left as it is (other programs may need it); uninstall says how to turn it off.
 */
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { configPath, displayPath } from '../config.ts';
import { socketPath } from '../hooks/cli.ts';
import { SETTINGS_FILE } from '../hooks/settings.ts';
import type { Io } from '../main.ts';
import { stateDir } from '../state/store.ts';
import { isStopped, type Prompter } from './prompt.ts';
import type { RunMode } from './runtime.ts';
import type { ServiceManager } from './service.ts';
import { NPM_NAME } from './targets.ts';

export interface UninstallDeps {
  mode: RunMode;
  manager: ServiceManager | null;
  /** The confirmation; null without a terminal. */
  prompt: Prompter | null;
  uid: number | undefined;
  home: string;
  env: NodeJS.ProcessEnv;
}

export const NEEDS_TTY_UNINSTALL =
  'kage uninstall needs a terminal to ask first. Run it in one, or pass --yes to remove Kage without asking.';
const QUESTION = 'Remove the Kage service and program?';
const KEPT_WORK =
  'Kept: your projects, their worktrees and branches, and the tmux session "kage" with its windows.';

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split(/\r?\n/)[0] ?? '';
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** kage uninstall [--yes] [--purge]; see the file comment. */
export async function uninstallCommand(
  args: string[],
  io: Io,
  deps: UninstallDeps,
): Promise<number> {
  let yes = false;
  let purge = false;
  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--purge') purge = true;
    else {
      io.err(`kage uninstall has no option "${arg}". Run kage --help to see its options.`);
      return 1;
    }
  }
  if (deps.uid === 0) {
    io.err('Run Kage as your own user, not root.');
    return 1;
  }
  if (!yes) {
    if (deps.prompt === null) {
      io.err(NEEDS_TTY_UNINSTALL);
      return 1;
    }
    let sure: boolean;
    try {
      sure = await deps.prompt.confirm(QUESTION, false);
    } catch (err) {
      if (!isStopped(err)) throw err;
      io.err('Uninstall stopped. Nothing was removed.');
      return 130;
    } finally {
      deps.prompt.close?.();
    }
    if (!sure) {
      io.out('Nothing was removed.');
      return 1;
    }
  }

  const shown = (p: string) => displayPath(p, deps.home);
  const removed: string[] = [];
  const notes: string[] = [];

  // 1. The service first, so nothing runs the program while it goes. remove() refuses a file
  // kage setup didn't write; then nothing else is touched.
  const m = deps.manager;
  if (m !== null) {
    const had = await exists(m.file);
    try {
      await m.remove();
    } catch (err) {
      io.err(`Couldn't remove the ${m.name}: ${firstLine(err)}`);
      io.err('Kage removed nothing else.');
      return 1;
    }
    if (had && !(await exists(m.file))) removed.push(`the ${m.name} (${shown(m.file)})`);
  }

  // 2. The program.
  if (deps.mode.kind === 'sea') {
    // The stable path (R110-5); when it is a link, the program it leads to too (runtime.ts's
    // installedExe names a link only when it leads to this program's own execPath); and the
    // program an update kept for going back, next to the file itself.
    const exe = deps.mode.exe;
    const real = await realpath(exe).catch(() => exe);
    for (const file of new Set([exe, real, `${exe}.previous`, `${real}.previous`])) {
      const st = await lstat(file).catch(() => null);
      if (st === null) continue;
      if (file === real && file !== exe && !st.isFile()) continue;
      try {
        await rm(file, { force: true });
        removed.push(shown(file));
      } catch (err) {
        notes.push(`Couldn't remove ${shown(file)}: ${firstLine(err)}`);
      }
    }
  } else if (deps.mode.kind === 'bundle') {
    notes.push(`Remove the program with: npm uninstall -g ${NPM_NAME}`);
  }

  // 3. Kage's own hooks file (R119-6): Claude never reads it once the program is gone.
  const state = stateDir(deps.env);
  const hooks = join(state, SETTINGS_FILE);
  if (!purge && (await exists(hooks))) {
    try {
      await rm(hooks, { force: true });
      removed.push(shown(hooks));
    } catch (err) {
      notes.push(`Couldn't remove ${shown(hooks)}: ${firstLine(err)}`);
    }
  }

  // 4. With --purge, Kage's own folders: the config, and the state (records, the hooks file,
  // the socket). Each is a folder named kage, never anything above it.
  const cfgFile = configPath(deps.env);
  const cfgDir = dirname(cfgFile);
  if (purge) {
    for (const folder of [cfgDir, state]) {
      if (basename(folder) !== 'kage' || !(await exists(folder))) continue;
      try {
        await rm(folder, { recursive: true, force: true });
        removed.push(shown(folder));
      } catch (err) {
        notes.push(`Couldn't remove ${shown(folder)}: ${firstLine(err)}`);
      }
    }
    // A socket outside the state folder (XDG_RUNTIME_DIR): only if it is one.
    const socket = socketPath(deps.env, io.platform ?? process.platform);
    const s = await lstat(socket).catch(() => null);
    if (s?.isSocket()) await rm(socket, { force: true }).catch(() => {});
  }

  if (removed.length === 0) io.out("Removed: nothing. Kage's service and program weren't there.");
  for (const r of removed) io.out(`Removed: ${r}.`);
  for (const n of notes) (n.startsWith("Couldn't") ? io.err : io.out)(n);
  io.out(KEPT_WORK);
  if (!purge) {
    io.out(`Kept: ${shown(cfgFile)} and ${shown(state)} (kage uninstall --purge removes them).`);
  }
  if (m?.lingerEnabled && (await m.lingerEnabled().catch(() => false))) {
    io.out(
      'Linger is still on. If nothing else needs it, turn it off with: loginctl disable-linger',
    );
  }
  return notes.some((n) => n.startsWith("Couldn't")) ? 1 : 0;
}
