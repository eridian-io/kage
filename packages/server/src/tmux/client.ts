import { execFile, execFileSync } from 'node:child_process';
import { LIST_WINDOWS_FORMAT, parseWindows, type TmuxWindow } from './format.ts';

export type { TmuxWindow } from './format.ts';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Every tmux call ends within 5 s: a wedged server must not hang Kage. */
export const EXEC_OPTIONS = { maxBuffer: 16 * 1024 * 1024, timeout: 5000 } as const;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, EXEC_OPTIONS, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

/**
 * Reads `tmux -V` output ("tmux 3.4", "tmux 3.3a", "tmux next-3.6"). `tooOld` is true only for a
 * numbered version below 3.2; builds without one ("master", "openbsd-7.5") get the benefit of the doubt.
 */
export function parseTmuxVersion(output: string): { version: string; tooOld: boolean } {
  const version = output.trim().replace(/^tmux\s+/, '');
  const m = /^(?:next-)?(\d+)\.(\d+)/.exec(version);
  const tooOld = m !== null && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 2));
  return { version, tooOld };
}

function detectTmux(): string | null {
  try {
    return execFileSync('tmux', ['-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: EXEC_OPTIONS.timeout,
    });
  } catch {
    return null;
  }
}

/** `tmux -V` output, or null when tmux doesn't run (Windows, or not installed). */
export const tmuxVersionOutput: string | null = detectTmux();

/** True when `tmux -V` runs (false on Windows or without tmux). */
export const hasTmux: boolean = tmuxVersionOutput !== null;

export interface TmuxTarget {
  socket: string | null;
  /** A tmux config file (`-f`); it only matters when the call starts the server. */
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

  /**
   * Creates the detached session when it is missing. Its first window only holds the session
   * open, so it is tagged `@kage_placeholder` (R22) and the board hides it while it sits at a
   * shell.
   */
  async ensureSession(): Promise<void> {
    try {
      await this.#run(['has-session', '-t', `=${this.#session}`]);
    } catch {
      let windowId: string;
      try {
        const { stdout } = await this.#run([
          'new-session',
          '-d',
          '-s',
          this.#session,
          '-P',
          '-F',
          '#{window_id}',
        ]);
        windowId = stdout.trim();
      } catch (e) {
        // A concurrent caller created it between our has-session and new-session.
        if (!/duplicate session/i.test(stderrOf(e))) throw e;
        return;
      }
      if (/^@\d+$/.test(windowId)) {
        await this.#run(['set-option', '-w', '-t', windowId, '@kage_placeholder', '1']);
      }
    }
  }

  /** R22: the placeholder window now runs something else; it shows like any other window. */
  async clearPlaceholder(windowId: string): Promise<void> {
    await this.#run(['set-option', '-w', '-u', '-t', windowId, '@kage_placeholder']);
  }

  /** Sets a variable in the session's environment, which windows created later inherit. */
  async setEnvironment(name: string, value: string): Promise<void> {
    await this.#run(['set-environment', '-t', `=${this.#session}`, name, value]);
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
