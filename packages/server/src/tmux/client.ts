import { execFile, execFileSync } from 'node:child_process';
import { LIST_WINDOWS_FORMAT, parseWindows, type TmuxWindow } from './format.ts';

export type { TmuxWindow } from './format.ts';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

function detectTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when `tmux -V` runs (false on Windows or without tmux). */
export const hasTmux: boolean = detectTmux();

export function tmuxArgs(socket: string | null, args: string[]): string[] {
  return socket ? ['-L', socket, ...args] : args;
}

export class TmuxClient {
  readonly #session: string;
  readonly #socket: string | null;
  readonly #exec: ExecFn;

  constructor(opts: { session: string; socket: string | null; exec?: ExecFn }) {
    this.#session = opts.session;
    this.#socket = opts.socket;
    this.#exec = opts.exec ?? defaultExec;
  }

  #run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.#exec('tmux', tmuxArgs(this.#socket, args));
  }

  /** Creates the detached session when it is missing. */
  async ensureSession(): Promise<void> {
    try {
      await this.#run(['has-session', '-t', `=${this.#session}`]);
    } catch {
      await this.#run(['new-session', '-d', '-s', this.#session]);
    }
  }

  /** The session's windows; [] when the server or the session is missing. */
  async listWindows(): Promise<TmuxWindow[]> {
    try {
      const { stdout } = await this.#run([
        'list-windows',
        '-t',
        `=${this.#session}`,
        '-F',
        LIST_WINDOWS_FORMAT,
      ]);
      return parseWindows(stdout);
    } catch {
      return [];
    }
  }

  async capturePane(paneId: string, lines: number): Promise<string> {
    const { stdout } = await this.#run([
      'capture-pane',
      '-p',
      '-J',
      '-t',
      paneId,
      '-S',
      `-${lines}`,
    ]);
    return stdout;
  }

  async setKageId(windowId: string, kageId: string): Promise<void> {
    await this.#run(['set-option', '-w', '-t', windowId, '@kage_id', kageId]);
  }
}
