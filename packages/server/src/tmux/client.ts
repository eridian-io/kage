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

export interface TmuxTarget {
  socket: string | null;
  /** ; only matters when the call starts the server. */
  configFile?: string;
}

export function tmuxArgs(t: TmuxTarget, args: string[]): string[] {
  return [
    ...(t.configFile ? ['-f', t.configFile] : []),
    ...(t.socket ? ['-L', t.socket] : []),
    ...args,
  ];
}

const MISSING_RE = /no server running|error connecting to|can't find session/i;
const stderrOf = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? '');

export class TmuxClient {
  readonly #session: string;
  readonly #target: TmuxTarget;
  readonly #exec: ExecFn;

  constructor(opts: {
    session: string;
    socket: string | null;
    configFile?: string;
    exec?: ExecFn;
  }) {
    this.#session = opts.session;
    this.#target = { socket: opts.socket, configFile: opts.configFile };
    this.#exec = opts.exec ?? defaultExec;
  }

  #run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.#exec('tmux', tmuxArgs(this.#target, args));
  }

  /** Creates the detached session when it is missing. */
  async ensureSession(): Promise<void> {
    try {
      await this.#run(['has-session', '-t', `=${this.#session}`]);
    } catch {
      try {
        await this.#run(['new-session', '-d', '-s', this.#session]);
      } catch (e) {
        // A concurrent caller created it between our has-session and new-session.
        if (!/duplicate session/i.test(stderrOf(e))) throw e;
      }
    }
  }

  /** The session's windows; [] only when tmux says the server or session is missing, else throws. */
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
    } catch (e) {
      if (MISSING_RE.test(stderrOf(e))) return [];
      throw e;
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
