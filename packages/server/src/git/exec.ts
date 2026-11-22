import { type ChildProcess, execFile, spawn } from 'node:child_process';

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
 * repository; it never prompts, takes no optional locks and speaks the C locale.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
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
        env: gitEnv(),
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
  o: { cwd: string; maxBytes: number; timeoutMs?: number },
): Promise<{ stdout: string; clipped: boolean }> {
  const child = spawn('git', gitArgs(args), {
    cwd: o.cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return collectStream(child, o.maxBytes, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
