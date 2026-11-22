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
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
 * The SEA's stable path (R110-5). `process.execPath` is a symlink's target, which an update may
 * replace; what the user ran (`argv1`: a path, or a name found on `PATH`) stays valid. It is
 * used when it leads to the same file as `execPath`, else `execPath` is.
 */
export function installedExe(argv1: string | undefined, path: string, execPath: string): string {
  if (!argv1) return execPath;
  const target = real(execPath);
  if (target === null) return execPath;
  let candidates: string[];
  if (argv1.includes('/') || argv1.includes('\\')) candidates = [resolve(argv1)];
  else
    candidates = path
      .split(delimiter)
      .filter((d) => d !== '' && isAbsolute(d))
      .map((d) => join(d, argv1));
  for (const c of candidates) {
    if (isFile(c)) return real(c) === target ? c : execPath;
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
 * The service's whole environment: the PATH captured at setup, R91's arena limit, and
 * KAGE_SERVICE so serve can take the tuning back off before tmux starts Claude (R105). Nothing
 * else from the process environment; secrets stay in the config. The SEA's pool size is in its
 * execArgv, so NODE_OPTIONS isn't needed (host-integration §7.1).
 */
export function serviceEnv(_m: RunMode, path: string): Record<string, string> {
  return { PATH: path, MALLOC_ARENA_MAX: '2', KAGE_SERVICE: '1' };
}

/** Under the service (KAGE_SERVICE=1): removes the tuning so the windows Kage starts don't inherit it. */
export function serviceCleanEnv(env: NodeJS.ProcessEnv): void {
  if (env.KAGE_SERVICE !== '1') return;
  delete env.MALLOC_ARENA_MAX;
  delete env.NODE_OPTIONS;
  delete env.KAGE_SERVICE;
}
