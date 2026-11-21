import { execFile } from 'node:child_process';

export type GitExec = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** The environment minus variables that would point git at another repository. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

/**
 * git with an argument array (never a shell); it never prompts and takes no optional locks.
 * Every call turns fsmonitor off: a repo's `core.fsmonitor` names a program git would run.
 */
export const gitExec: GitExec = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
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
