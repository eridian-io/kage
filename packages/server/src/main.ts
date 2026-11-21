#!/usr/bin/env node
/**
 * The `kage` command. This file stays light: `kage hook` runs on every Claude hook and must start
 * fast and print nothing, so the server code is imported only by `kage serve`.
 */
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Asset } from './assets.ts';
import { runHookCli } from './hooks/cli.ts';
import { writeHooksSettings } from './hooks/settings.ts';
import { stateDir } from './state/store.ts';
import type { ExecFn } from './tmux/client.ts';

export const USAGE = `Usage:
  kage serve [--demo] [--unsafe-listen-all] [--port N]
      Run the board: live tmux sessions, or the demo sessions with --demo.
  kage hooks-path
      Write the Claude settings that send hook events to Kage, and print the file's path.
      Start Claude with: claude --settings "$(kage hooks-path)"
  kage hook <Event>
      Forward one hook event to Kage (Claude runs this; it prints nothing).

Environment:
  KAGE_SOCKET       The hook socket path. Its directory must be owned by you:
                    Kage refuses a directory that belongs to another user.
  KAGE_TMUX_SOCKET  Use a separate tmux server (tmux -L <name>).
  KAGE_HOST, KAGE_PORT, KAGE_NAME  Override the config's host, port and name.`;

/** This file: the hook command runs it again with `hook <Event>`. */
export const ENTRY = fileURLToPath(import.meta.url);

export interface Io {
  env: NodeJS.ProcessEnv;
  stdin: Readable;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Test seams; by default the real platform and `tmux -V` output. */
  platform?: NodeJS.Platform | undefined;
  /** `tmux -V` output, or null when tmux doesn't run. */
  tmuxVersion?: string | null | undefined;
  /** The built board (default: packages/web/dist). */
  dist?: string | undefined;
  /** A tmux config file for the tmux server Kage may start (tests pass /dev/null). */
  tmuxConfigFile?: string | undefined;
  /** Aborted by the first SIGINT or SIGTERM: `kage serve` stops starting up (B15). */
  signal?: AbortSignal | undefined;
  /** Test seams: how serve runs tmux for its session, and how it reads the built board. */
  tmuxExec?: ExecFn | undefined;
  loadAssets?: ((dist: string) => Promise<Map<string, Asset>>) | undefined;
}

/** A started `kage serve`; stop() shuts everything down in reverse start order. */
export interface Running {
  stop(): Promise<void>;
}

/**
 * The command Claude runs for each hook (before `hook <Event>`). `--no-warnings` keeps Node's
 * experimental-feature notices off stderr: a hook must print nothing.
 */
export function hookCommandBase(): string[] {
  return [process.execPath, '--no-warnings', ENTRY];
}

/** Writes the hooks settings file and returns its path (`kage hooks-path` and `kage serve`). */
export function writeSettings(env: NodeJS.ProcessEnv): Promise<string> {
  return writeHooksSettings(stateDir(env), hookCommandBase());
}

/** Runs one command; a number is the exit code, a Running is a server still up. */
export async function main(argv: string[], io: Io): Promise<number | Running> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      // Never disturb Claude: no output, exit 0, whatever happens.
      const event = rest[0];
      if (!event) return 0;
      return runHookCli(event, { stdin: io.stdin, env: io.env });
    }
    case 'hooks-path': {
      try {
        io.out(await writeSettings(io.env));
        return 0;
      } catch (err) {
        io.err(`Couldn't write the Claude settings file: ${(err as Error).message}`);
        return 1;
      }
    }
    case 'serve': {
      const { serveCommand } = await import('./serve.ts');
      // serve.ts must not import this file at runtime: this module is still evaluating.
      return serveCommand(rest, io, { usage: USAGE, writeSettings });
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    default:
      io.err(`Unknown command "${command}".`);
      io.err(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook') {
    // Silent whatever happens, including an unexpected throw.
    try {
      await main(argv, { env: process.env, stdin: process.stdin, out: () => {}, err: () => {} });
    } catch {}
    process.exit(0);
  }
  // Installed before serve starts anything (B15). The first signal aborts a startup in progress,
  // or stops a running server; a second one exits at once.
  const startup = new AbortController();
  let running: Running | null = null;
  let signals = 0;
  const shutdown = (r: Running) => {
    setTimeout(() => process.exit(0), 5000).unref();
    r.stop().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    if (running) shutdown(running);
    else startup.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const result = await main(argv, {
    env: process.env,
    stdin: process.stdin,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    signal: startup.signal,
  });
  if (typeof result === 'number') process.exit(result);
  running = result;
  if (startup.signal.aborted) shutdown(result);
}
