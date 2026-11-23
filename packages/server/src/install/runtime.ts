/**
 * How this `kage` runs, and the commands that run it again: the hook command Claude runs, and
 * the service's command and environment (phase 6, Task 2). This module is on `kage hook`'s path,
 * so it stays light: built-ins only, and nothing touches the file system until asked.
 *
 * Three run modes:
 * - sea: the single executable a release installs (`~/.local/bin/kage`);
 * - bundle: `node dist/kage.mjs`, the npm package and `pnpm build`;
 * - source: `node src/main.ts`, for development only.
 */
import { realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export type RunMode =
  | { kind: 'sea'; exe: string }
  | { kind: 'bundle'; node: string; script: string }
  | { kind: 'source'; node: string; script: string };

/** Set by esbuild's `define` in both bundles; undefined when run from the sources. */
declare const KAGE_BUILD_VERSION: string | undefined;

/** packages/server/package.json's version in a build; "0.0.0-dev" from the sources. */
export const KAGE_VERSION: string =
  typeof KAGE_BUILD_VERSION === 'string' ? KAGE_BUILD_VERSION : '0.0.0-dev';

/**
 * The program's script for a given file of this module (F3): from the sources, this file is
 * src/install/runtime.ts and the program is src/main.ts; in a bundle, everything is the bundle.
 */
export function entryFor(self: string): string {
  return /[\\/]src[\\/]install[\\/]runtime\.ts$/.test(self)
    ? join(dirname(self), '..', 'main.ts')
    : self;
}

/** This program's script, which the hook command runs again; "" in a SEA. */
export const ENTRY: string = isSea() ? '' : entryFor(fileURLToPath(import.meta.url));

/** True for a regular file (no throw). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * A PATH folder whose entries can be trusted to stay put: owned by this user (or root) and not
 * writable by the group or others, so no one else can swap the link the hooks will name. Without
 * a uid (Windows) any folder passes.
 */
function trustedDir(dir: string, uid: number | undefined): boolean {
  if (uid === undefined) return true;
  try {
    const s = statSync(dir);
    return (s.uid === uid || s.uid === 0) && (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * The SEA's stable path (R110-5). `process.execPath` is a symlink's target, which an update may
 * replace; what the user ran (`argv1`: a path, or a name found on `PATH`) stays valid. It is
 * used when it leads to the same file as `execPath`, else `execPath` is. A name found on `PATH`
 * counts only in a folder trustedDir accepts.
 */
export function installedExe(
  argv1: string | undefined,
  path: string,
  execPath: string,
  uid: number | undefined = process.getuid?.(),
): string {
  if (!argv1) return execPath;
  const target = real(execPath);
  if (target === null) return execPath;
  if (argv1.includes('/') || argv1.includes('\\')) {
    const c = resolve(argv1);
    return isFile(c) && real(c) === target ? c : execPath;
  }
  for (const d of path.split(delimiter)) {
    if (d === '' || !isAbsolute(d)) continue;
    const c = join(d, argv1);
    // The first one on PATH is what the user ran; if it isn't safe to name, don't look further.
    if (isFile(c)) return real(c) === target && trustedDir(d, uid) ? c : execPath;
  }
  return execPath;
}

/** How this process runs; the probe is a test seam (by default, this process). */
export function runMode(probe?: { isSea: boolean; execPath: string; entry: string }): RunMode {
  const sea = probe ? probe.isSea : isSea();
  if (sea) {
    const exe = probe
      ? probe.execPath
      : installedExe(process.argv[1], process.env.PATH ?? '', process.execPath);
    return { kind: 'sea', exe };
  }
  const node = probe ? probe.execPath : process.execPath;
  const script = probe ? probe.entry : ENTRY;
  return script.endsWith('.ts')
    ? { kind: 'source', node, script }
    : { kind: 'bundle', node, script };
}

/**
 * The command Claude runs for each hook (before `hook <Event>`). `--no-warnings` keeps Node's
 * experimental-feature notices off stderr: a hook must print nothing. The SEA's own config turns
 * its warning off.
 */
export function hookArgv(m: RunMode): string[] {
  return m.kind === 'sea' ? [m.exe] : [m.node, '--no-warnings', m.script];
}

/** The service's command line (R91: one V8 pool thread; the SEA has it in its execArgv). */
export function serviceArgv(m: RunMode): string[] {
  switch (m.kind) {
    case 'sea':
      return [m.exe, 'serve'];
    case 'bundle':
      return [m.node, '--v8-pool-size=1', m.script, 'serve'];
    case 'source':
      throw new Error(
        'Install Kage from a release, or run "pnpm build" and use node packages/server/dist/kage.mjs.',
      );
  }
}

/**
 * The folder settings setup carries from its own environment into the service's (R124), when
 * set: where Claude and Kage keep their files. They count only when absolute (a relative one
 * would mean another folder under the service).
 */
const CARRIED_FOLDERS = ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const;

/**
 * What the service adds to the user manager's environment: the PATH captured at setup, R91's
 * arena limit, KAGE_SERVICE so serve can take the tuning back off before tmux starts Claude
 * (R105), and from setup's environment (`env`) an absolute KAGE_CLAUDE_BIN, CLAUDE_CONFIG_DIR,
 * XDG_CONFIG_HOME, XDG_STATE_HOME and KAGE_TMUX_SOCKET when set (R124), so the service reads
 * the same config and state, and runs the same claude and tmux server, as setup and doctor did.
 * Nothing else, and never a secret: the token and ntfy keys stay in the config, and an
 * ANTHROPIC_API_KEY set only in the shell stays there (doctor says so). The SEA's pool size is
 * in its execArgv, so NODE_OPTIONS isn't needed (host-integration §7.1). The unit and the plist
 * quote each value and refuse one they can't hold (service-files.ts assertWritable).
 */
export function serviceEnv(
  _m: RunMode,
  path: string,
  env: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const out: Record<string, string> = { PATH: path, MALLOC_ARENA_MAX: '2', KAGE_SERVICE: '1' };
  const claude = env.KAGE_CLAUDE_BIN ?? '';
  if (posix.isAbsolute(claude)) out.KAGE_CLAUDE_BIN = claude;
  for (const key of CARRIED_FOLDERS) {
    const v = env[key] ?? '';
    if (posix.isAbsolute(v)) out[key] = v;
  }
  if (env.KAGE_TMUX_SOCKET) out.KAGE_TMUX_SOCKET = env.KAGE_TMUX_SOCKET;
  return out;
}

/** Under the service (KAGE_SERVICE=1): removes the tuning so the windows Kage starts don't inherit it. */
export function serviceCleanEnv(env: NodeJS.ProcessEnv): void {
  if (env.KAGE_SERVICE !== '1') return;
  delete env.MALLOC_ARENA_MAX;
  delete env.NODE_OPTIONS;
  delete env.KAGE_SERVICE;
}

/**
 * R122: under the systemd service (`KAGE_SERVICE=1` on Linux), the command that starts a new tmux
 * server in a user scope of its own, so stopping or restarting kage.service (update, setup again,
 * uninstall) never takes the tmux server or Claude with it. The unit keeps systemd's default
 * KillMode=control-group for Kage itself. Each call names a new scope. Undefined elsewhere:
 * launchd's plist sets AbandonProcessGroup instead, and a `kage serve` from a terminal needs none.
 */
export function tmuxServerScope(
  underService: boolean,
  platform: NodeJS.Platform,
  pid: number = process.pid,
): (() => string[]) | undefined {
  if (!underService || platform !== 'linux') return undefined;
  let n = 0;
  return () => {
    n += 1;
    return [
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=kage-tmux-${pid}-${n}`,
    ];
  };
}
