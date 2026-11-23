import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';

/**
 * Where git runs for a session's worktree (security M4): the worktree's admin folder in the
 * record's repository and the worktree itself, passed as GIT_DIR and GIT_WORK_TREE, so a `.git`
 * file the session rewrote can't bring in a config of its own.
 */
export interface GitPin {
  gitDir: string;
  workTree: string;
}

export type GitExec = (
  args: string[],
  opts?: {
    cwd?: string;
    timeoutMs?: number;
    /**
     * 'latin1' maps each output byte to one char (U+0000–U+00FF), so names git prints compare
     * byte for byte: nothing is decoded as UTF-8, and no two names collapse into U+FFFD.
     */
    encoding?: 'utf8' | 'latin1';
    /** GIT_DIR and GIT_WORK_TREE from the record (worktreePin) in place of git's discovery. */
    pin?: GitPin;
  },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Every git call's arguments: fsmonitor off first, whatever the repo says (a repo's
 * `core.fsmonitor` names a program git would run). The one copy, for gitExec and any stream.
 */
export function gitArgs(args: readonly string[]): string[] {
  return ['-c', 'core.fsmonitor=false', ...args];
}

/**
 * Every git call's environment: the process's minus variables that would point git at another
 * repository; it never prompts, takes no optional locks and speaks the C locale. With a pin,
 * GIT_DIR and GIT_WORK_TREE come from it (never from the process).
 */
export function gitEnv(pin?: GitPin): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const pinned = pin ? { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree } : {};
  return { ...env, ...pinned, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

/** git with an argument array (never a shell), with gitArgs and gitEnv. */
export const gitExec: GitExec = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs(args),
      {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: opts.encoding ?? 'utf8',
        env: gitEnv(opts.pin),
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
        } else resolve({ stdout, stderr });
      },
    );
  });

/** The first line of git's stderr, or of the error's message. */
export function firstLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = String((e?.stderr && String(e.stderr).trim()) || e?.message || err);
  return text.split(/\r?\n/)[0] ?? text;
}

/** Most stderr kept from a streamed git call (for its error's first line). */
const MAX_STDERR = 64 * 1024;

/**
 * A child's stdout up to `maxBytes`: past it the child is killed and `clipped` is set. Resolves
 * (or rejects) only once the child has exited and its pipes have closed, so no child outlives the
 * call. A non-zero exit without a clip rejects with `stdout`, `stderr` and `code` on the error,
 * like execFile; past `timeoutMs` the child is killed and the call rejects. Output decodes as
 * UTF-8 (a clip may cut the last character, which then reads as U+FFFD).
 */
export function collectStream(
  child: ChildProcess,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ stdout: string; clipped: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let clipped = false;
    let timedOut = false;
    let err = '';
    let spawnError: Error | null = null;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (clipped) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        // Exactly maxBytes is a clip too: more may follow, and reading on is what the cap prevents.
        clipped = true;
        kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < MAX_STDERR) err += chunk.toString('utf8').slice(0, MAX_STDERR - err.length);
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (spawnError) {
        reject(Object.assign(spawnError, { stdout, stderr: err }));
      } else if (timedOut && !clipped) {
        reject(
          Object.assign(new Error(`git timed out after ${timeoutMs} ms`), { stdout, stderr: err }),
        );
      } else if (!clipped && code !== 0) {
        const first = err.trim().split(/\r?\n/)[0] ?? '';
        reject(
          Object.assign(new Error(`Command failed: git (exit ${code}) ${first}`), {
            stdout,
            stderr: err,
            code,
          }),
        );
      } else {
        resolve({ stdout, clipped });
      }
    });
  });
}

/** git through spawn: stdout up to maxBytes, then the child is killed; `clipped` says so. Same environment as gitExec. */
export function gitStream(
  args: string[],
  o: { cwd: string; maxBytes: number; timeoutMs?: number; pin?: GitPin },
): Promise<{ stdout: string; clipped: boolean }> {
  const child = spawn('git', gitArgs(args), {
    cwd: o.cwd,
    env: gitEnv(o.pin),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return collectStream(child, o.maxBytes, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** The git common directory of `repo`, absolute (`rev-parse --git-common-dir`, run in the repo). */
export async function gitCommonDir(repo: string, exec: GitExec = gitExec): Promise<string> {
  const { stdout } = await exec(['rev-parse', '--git-common-dir'], { cwd: repo });
  const out = stdout.replace(/\r?\n$/, '');
  if (out === '') throw new Error(`git gave no common dir for ${repo}`);
  return resolvePath(repo, out);
}

/** The refusal when a worktree's `.git` no longer leads to the record's repository (§6.9). */
export const UNPINNED =
  "This worktree's .git file no longer points at its repository, so Kage won't run git there.";

/** Thrown in place of a git run that worktreePin refused; its message is UNPINNED. */
export class UnpinnedError extends Error {
  readonly code = 'UNPINNED';
  constructor() {
    super(UNPINNED);
  }
}

/** On Windows paths compare without case. */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Most bytes read from a `.git` file or an admin folder's `gitdir` file. */
const MAX_POINTER = 4096;

/**
 * A small regular file's text, or null: a link at the last step is refused (lstat, and
 * O_NOFOLLOW where the OS has it), a FIFO never blocks (O_NONBLOCK, then fstat), and at most
 * MAX_POINTER bytes are read.
 */
async function readPointer(path: string): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile()) return null;
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(path, flags).catch(() => null);
  if (!fh) return null;
  try {
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(MAX_POINTER);
    const { bytesRead } = await fh.read(buf, 0, MAX_POINTER, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

const real = (p: string): Promise<string | null> => realpath(p).catch(() => null);

/**
 * Each repository's common dir, realpath'd, once per repo path (R131): it comes from the repo,
 * the trust root, so it can be kept. A failed lookup isn't kept. The worktree's `.git` and the
 * admin folder's `gitdir` are never cached.
 */
const commonDirs = new Map<string, Promise<string | null>>();

function commonDirOf(repo: string, exec: GitExec): Promise<string | null> {
  const key = resolvePath(repo);
  const hit = commonDirs.get(key);
  if (hit) return hit;
  const p = gitCommonDir(repo, exec).then(real);
  commonDirs.set(key, p);
  // Not kept when it fails or finds nothing, so the next call asks again.
  p.then(
    (dir) => {
      if (dir === null) commonDirs.delete(key);
    },
    () => commonDirs.delete(key),
  );
  return p;
}

/**
 * The worktree's admin folder in `repo`, found by content, not by name (F3): git may suffix the
 * name (`x1` after an unpruned `x`), and the repo may keep its git dir elsewhere
 * (`--separate-git-dir`).
 * 1. `<common>` is `rev-parse --git-common-dir`, run in the repo (the trust root, R67), looked
 *    up once per repo path;
 * 2. `<worktree>/.git` is a regular file whose `gitdir:` line resolves (links too) to a folder
 *    directly under `<common>/worktrees/`;
 * 3. that folder's `gitdir` file names `<worktree>/.git`.
 * Anything else is null: the `.git` was redirected, or git no longer knows this worktree.
 * Relative paths (`worktree.useRelativePaths`) resolve from the file's own folder. The two
 * pointer files are read on every call, never cached, so a `.git` rewritten between two refreshes is caught at the next one.
 */
export async function worktreePin(
  repo: string,
  worktree: string,
  exec: GitExec = gitExec,
): Promise<GitPin | null> {
  const realWorktree = await real(worktree);
  if (realWorktree === null) return null;
  const line = (await readPointer(join(worktree, '.git')))?.match(/^gitdir: *(.+?)\s*$/m)?.[1];
  if (!line) return null;
  const common = await commonDirOf(repo, exec);
  if (common === null) return null;
  const admin = await real(resolvePath(worktree, line));
  if (admin === null || !samePath(dirname(admin), join(common, 'worktrees'))) return null;
  const back = (await readPointer(join(admin, 'gitdir')))?.trim();
  if (!back) return null;
  // The admin folder names a `.git` file; the folder holding it must be this worktree.
  const named = await real(dirname(resolvePath(admin, back)));
  if (named === null || !samePath(named, realWorktree)) return null;
  return { gitDir: admin, workTree: resolvePath(worktree) };
}

/**
 * The pin for a session's worktree: undefined with no repository (an external window's own
 * folder runs as it always did: F12, R67), else worktreePin, or UnpinnedError when that is
 * refused. A worktree folder that is gone rejects with ENOENT (a list then shows nothing).
 */
export async function requirePin(
  repo: string | null | undefined,
  worktree: string,
  exec: GitExec = gitExec,
): Promise<GitPin | undefined> {
  if (repo === null || repo === undefined) return undefined;
  await lstat(worktree); // ENOENT: the folder is gone, which is not a redirect
  const pin = await worktreePin(repo, worktree, exec);
  if (!pin) throw new UnpinnedError();
  return pin;
}
