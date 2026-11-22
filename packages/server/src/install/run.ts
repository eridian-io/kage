/**
 * The one way the install commands run a program (systemctl, launchctl, loginctl): execFile with
 * an argument array, never a shell. Tests pass a fake `Run` instead, so no test reaches the real
 * service managers.
 */
import { execFile } from 'node:child_process';

export interface RunResult {
  /** The exit code; -1 when the program is missing, timed out, or printed too much. */
  code: number;
  stdout: string;
  stderr: string;
  /** The program isn't there (ENOENT). */
  missing: boolean;
}

export type Run = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

/** execFile, no shell, a 10 s default timeout and 1 MiB of output at most. Never rejects. */
export const realRun: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
      },
      (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
        if (!err) {
          resolve({ code: 0, ...out, missing: false });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: unknown };
        if (e.code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: e.message, missing: true });
          return;
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, ...out, missing: false });
          return;
        }
        // Killed by the timeout, a signal, or the output cap.
        const why = out.stderr ? `${out.stderr.trimEnd()}\n${e.message}` : e.message;
        resolve({ code: -1, stdout: out.stdout, stderr: why, missing: false });
      },
    );
  });
