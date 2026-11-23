/**
 * `kage restart` and `kage logs` (hardening Task 16; usability U9): one answer to "how do I
 * restart Kage" and "where is its log", for the service kage setup installed.
 *
 * - restart asks the service manager to restart the unit or agent (it starts a stopped one too),
 *   then waits for `GET /status` on the hook socket to answer from the new process, as setup does.
 * - logs prints the last 100 lines of `journalctl --user -u kage` (systemd) or of
 *   ~/Library/Logs/kage.log (launchd) and exits; with -f it keeps following (R144). This terminal
 *   is its output. Kage's log holds no secret: the token and the
 *   ntfy keys never reach it, and ntfy errors are redacted (N1).
 *
 * Both are argument arrays, never a shell; nothing runs as root.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { socketPath } from '../hooks/cli.ts';
import type { Io } from '../main.ts';
import { type CheckDeps, logHint } from './checks.ts';
import type { ServiceManager } from './service.ts';

export const RESTART_NO_ARGS = 'kage restart takes no arguments.';
export const LOGS_ONLY_FOLLOW = 'kage logs takes only -f (or --follow).';
const NOT_INSTALLED = "Kage's service isn't installed. Run kage setup, or run kage serve yourself.";
/** How long the restarted service has to answer (as setup's last check). */
const WAIT_MS = 15_000;
const POLL_MS = 200;
/** The lines `kage logs` shows (before it follows, with -f). */
const LOG_LINES = '100';

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split(/\r?\n/)[0] ?? '';
}

/** kage restart; see the file comment. 0 once the new process answers, else 1. */
export async function restartCommand(
  args: string[],
  io: Io,
  deps: Pick<CheckDeps, 'manager' | 'env' | 'platform' | 'status' | 'uid'> & { waitMs?: number },
): Promise<number> {
  if (args.length > 0) {
    io.err(RESTART_NO_ARGS);
    return 1;
  }
  if (deps.uid === 0) {
    io.err('Run Kage as your own user, not root.');
    return 1;
  }
  const m = deps.manager;
  if (m === null) {
    io.err(NOT_INSTALLED);
    return 1;
  }
  // R112: state() throws without a user manager, so ask first; the reason carries its own fix.
  const why = await m.unavailable();
  if (why !== null) {
    io.err(why);
    return 1;
  }
  // A state that can't be read isn't "not installed": the restart itself says what's wrong.
  const state = await m.state().catch(() => null);
  if (state === 'missing') {
    io.err(NOT_INSTALLED);
    return 1;
  }
  const socket = socketPath(deps.env, deps.platform);
  const before = await deps.status(socket);
  try {
    await m.restart();
  } catch (err) {
    io.err(`Couldn't restart the ${m.name}: ${firstLine(err)}`);
    io.err('Run kage setup again, or run kage doctor to see why.');
    return 1;
  }
  io.out('Restarted Kage.');
  // The new process, not the old one still on its way out: another pid, or any answer after none.
  const deadline = Date.now() + (deps.waitMs ?? WAIT_MS);
  for (;;) {
    const now = await deps.status(socket);
    if (now !== null && (before === null || now.pid !== before.pid)) {
      io.out(`Kage is running at ${now.url}`);
      return 0;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  io.err(`Kage didn't answer after the restart. See: ${logHint(m)}`);
  return 1;
}

/**
 * The command that shows the service's log: the last lines of journalctl for the unit (no pager,
 * so it prints and exits) or tail of the agent's file; `follow` adds -f.
 */
export function logsArgv(
  m: ServiceManager,
  home: string,
  follow = false,
): [cmd: string, args: string[]] {
  const f = follow ? ['-f'] : [];
  return m.kind === 'systemd'
    ? ['journalctl', ['--user', '-u', 'kage', '-n', LOG_LINES, '--no-pager', ...f]]
    : ['tail', ['-n', LOG_LINES, ...f, join(home, 'Library', 'Logs', 'kage.log')]];
}

/** kage logs' arguments: { follow } for none, -f or --follow (either, any number of times); null otherwise. */
export function parseLogsArgs(args: string[]): { follow: boolean } | null {
  if (args.some((a) => a !== '-f' && a !== '--follow')) return null;
  return { follow: args.length > 0 };
}

/**
 * Runs a program with this terminal as its input and output; its exit code. Ctrl+C stops the
 * program, and kage with it, as a normal end (0).
 */
function spawnInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    // The terminal sends Ctrl+C to both; kage waits for the program to finish instead of dying first.
    process.on('SIGINT', ignore);
    const child = spawnChild(cmd, args, { stdio: 'inherit' });
    child.once('error', (err) => {
      process.off('SIGINT', ignore);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      process.off('SIGINT', ignore);
      resolve(signal === 'SIGINT' ? 0 : (code ?? 1));
    });
  });
}

/** kage logs [-f]; see the file comment. */
export async function logsCommand(
  args: string[],
  io: Io,
  deps: {
    manager: ServiceManager | null;
    home: string;
    spawn?: (cmd: string, args: string[]) => Promise<number>;
  },
): Promise<number> {
  const parsed = parseLogsArgs(args);
  if (parsed === null) {
    io.err(LOGS_ONLY_FOLLOW);
    return 1;
  }
  const m = deps.manager;
  // Without the unit or plist there is no service log to follow (a kage serve logs to its terminal).
  if (m === null || !existsSync(m.file)) {
    io.err(NOT_INSTALLED);
    return 1;
  }
  const [cmd, argv] = logsArgv(m, deps.home, parsed.follow);
  try {
    return await (deps.spawn ?? spawnInherit)(cmd, argv);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? firstLine(err);
    io.err(`Couldn't run ${[cmd, ...argv].join(' ')} (${code}).`);
    io.err('Run kage doctor to see why.');
    return 1;
  }
}
