import { execFile } from 'node:child_process';

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
