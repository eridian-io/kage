import { execFile, execFileSync } from 'node:child_process';
import { LIST_PANES_FORMAT, parsePanes, pickPanes, type TmuxWindow } from './format.ts';

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

/**
 * Every tmux call Kage makes. `-u` first: without a UTF-8 locale (a service has no LANG unless
 * the system sets one, and launchd sets none), tmux 3.4 and 3.5 write each tab of a `-F` format
 * as `_`, and Kage would parse no window at all (found by pnpm test:install).
 */
export function tmuxArgs(t: TmuxTarget, args: string[]): string[] {
  return [
    '-u',
    ...(t.configFile ? ['-f', t.configFile] : []),
    ...(t.socket ? ['-L', t.socket] : []),
    ...args,
  ];
}

const MISSING_RE = /no server running|error connecting to|can't find session/i;
/** has-session's words when no tmux server runs at all (not just no such session). */
const NO_SERVER_RE = /no server running|error connecting to/i;
const stderrOf = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? '');
/** The first line of a failure: its stderr, else its message. */
const why = (e: unknown): string =>
  (stderrOf(e).trim() || String((e as Error).message ?? e)).split(/\r?\n/)[0] ?? '';

/** The only keys Kage sends (K8: no C-u, no C-c; Escape at most once per call). */
export type Key =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'Enter'
  | 'Escape'
  | 'Up'
  | 'Down';
const KEYS: ReadonlySet<string> = new Set<Key>([
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'Enter',
  'Escape',
  'Up',
  'Down',
]);

/**
 * The largest `send-keys -l` argument. Ruling K10: a reply (at most 4,000 characters and 12,000
 * bytes) goes in one call; a 12,000-byte argument fits tmux's message limit (host §2). Longer text
 * is split on code points.
 */
export const SEND_TEXT_MAX_BYTES = 12_000;

/** K4: how long after `new-window` Kage looks whether the window is still there. */
const LAUNCH_CHECK_MS = 250;

const WINDOW_ID = /^@\d+$/;
const PANE_ID = /^%\d+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** C0 controls and DEL: only sendKeys produces Enter or Escape. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
/** tmux's answer for a window or session that no longer exists. */
const GONE_RE = /no such window|can't find window|can't find session|no server running/i;

/** A literal value for an option tmux expands as a format: `#` becomes `##`. */
const escapeFormat = (value: string): string => value.replaceAll('#', '##');

function checkWindowId(id: string): void {
  if (!WINDOW_ID.test(id)) throw new TypeError(`not a tmux window id: ${JSON.stringify(id)}`);
}
function checkPaneId(id: string): void {
  if (!PANE_ID.test(id)) throw new TypeError(`not a tmux pane id: ${JSON.stringify(id)}`);
}

/** Splits text into pieces of at most `max` UTF-8 bytes without cutting a code point. */
function utf8Chunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let size = 0;
  for (const cp of text) {
    const n = Buffer.byteLength(cp, 'utf8');
    if (size + n > max && chunk !== '') {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += cp;
    size += n;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

export class TmuxClient {
  readonly #session: string;
  readonly #target: TmuxTarget;
  readonly #exec: ExecFn;
  readonly #env: Record<string, string>;
  readonly #warn: (message: string) => void;
  readonly #launchCheckMs: number;
  readonly #serverScope: (() => string[]) | undefined;
  #warnedPlaceholder = false;
  /** The scope fallback's warning, once per process (R123). */
  #warnedScope = false;

  constructor(opts: {
    session: string;
    socket: string | null;
    configFile?: string;
    exec?: ExecFn;
    /** Environment for the session's first window (`new-session -e`), e.g. KAGE_SOCKET. */
    env?: Record<string, string>;
    /** Where a non-fatal problem is reported (serve passes stderr). */
    warn?: (message: string) => void;
    /** K4: the wait before newWindow checks the window is still there (tests pass 0). */
    launchCheckMs?: number;
    /**
     * R122: the command that starts a new tmux server in a scope of its own (its argv before
     * `tmux …`), asked each time a server is started; serve sets it under the systemd service.
     */
    serverScope?: () => string[];
  }) {
    this.#session = opts.session;
    this.#target = { socket: opts.socket, configFile: opts.configFile };
    this.#exec = opts.exec ?? defaultExec;
    this.#env = opts.env ?? {};
    this.#warn = opts.warn ?? (() => {});
    this.#launchCheckMs = opts.launchCheckMs ?? LAUNCH_CHECK_MS;
    this.#serverScope = opts.serverScope;
  }

  #run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.#exec('tmux', tmuxArgs(this.#target, args));
  }

  /**
   * Creates the detached session when it is missing. Its first window only holds the session
   * open, so it is tagged `@kage_placeholder` (R22) and the board hides it while it sits at a
   * shell. It gets the client's `env` (KAGE_SOCKET), which `set-environment` would only give
   * windows created later. The tag is best-effort: a failure is reported once and the session
   * stands (the placeholder then shows on the board as a shell window).
   *
   * R122: when no tmux server runs and `serverScope` is set (under the systemd service), the
   * server is started through that command (systemd-run --user --scope …), so it lives in a
   * scope of its own and a stop or restart of kage.service doesn't take it, or Claude, along.
   * If that fails, the server starts the plain way, with a warning.
   */
  async ensureSession(): Promise<void> {
    let noServer = false;
    try {
      await this.#run(['has-session', '-t', `=${this.#session}`]);
      return;
    } catch (e) {
      noServer = NO_SERVER_RE.test(stderrOf(e));
    }
    let windowId: string;
    const env = Object.entries(this.#env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const create = ['new-session', '-d', '-s', this.#session, ...env, '-P', '-F', '#{window_id}'];
    try {
      windowId = (await this.#newSession(create, noServer)).stdout.trim();
    } catch (e) {
      // A concurrent caller created it between our has-session and new-session.
      if (!/duplicate session/i.test(stderrOf(e))) throw e;
      return;
    }
    if (/^@\d+$/.test(windowId)) {
      try {
        await this.#run(['set-option', '-w', '-t', windowId, '@kage_placeholder', '1']);
      } catch (e) {
        if (!this.#warnedPlaceholder) {
          this.#warnedPlaceholder = true;
          this.#warn(`kage: couldn't tag tmux window ${windowId} as @kage_placeholder: ${why(e)}`);
        }
      }
    }
  }

  /** new-session, through serverScope when it starts the server (R122). */
  async #newSession(
    args: string[],
    noServer: boolean,
  ): Promise<{ stdout: string; stderr: string }> {
    const scope = noServer ? this.#serverScope?.() : undefined;
    if (!scope || scope.length === 0) return this.#run(args);
    const [cmd, ...pre] = scope as [string, ...string[]];
    try {
      return await this.#exec(cmd, [...pre, 'tmux', ...tmuxArgs(this.#target, args)]);
    } catch (e) {
      if (/duplicate session/i.test(stderrOf(e))) throw e;
      if (!this.#warnedScope) {
        this.#warnedScope = true;
        this.#warn(
          `kage: couldn't start tmux in a scope of its own (${why(e)}), so a restart of the service will close its windows.`,
        );
      }
      return this.#run(args);
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

  /**
   * The session's windows, one pane each (B14: a pane in `hookPanes`, else one running claude,
   * else the active pane); [] only when tmux says the server or session is missing, else throws.
   */
  async listWindows(hookPanes: ReadonlySet<string> = new Set()): Promise<TmuxWindow[]> {
    try {
      const { stdout } = await this.#run([
        'list-panes',
        '-s',
        '-t',
        `=${this.#session}`,
        '-F',
        LIST_PANES_FORMAT,
      ]);
      return pickPanes(parsePanes(stdout), hookPanes);
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

  /**
   * Opens a detached window running `argv` directly. tmux skips the shell only when it gets two
   * or more arguments (a lone argv[0] runs as `$SHELL -c argv[0]`), so argv must have at least
   * two elements. `name` and `cwd` are format-escaped (`#` as `##`); `-e` values, argv and the
   * tag are not expanded by tmux. It tags the window with `@kage_id` in a
   * second call (K1: a `;`-chained set-option tags the session's current window), then checks
   * that the window is still there with a live pane (K4: `new-window` exits 0 when argv[0] is
   * missing and the window closes at once). On any failure after the window opened, it is killed
   * (best effort) and the error is thrown.
   */
  async newWindow(o: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    argv: string[];
    kageId: string;
  }): Promise<{ windowId: string; paneId: string }> {
    // With a single argument tmux runs it through `$SHELL -c`: always pass argv[0] and arguments.
    if (o.argv.length < 2)
      throw new TypeError('newWindow needs a command and at least one argument');
    const env: string[] = [];
    for (const [k, v] of Object.entries(o.env)) {
      if (!ENV_NAME.test(k))
        throw new TypeError(`not an environment variable name: ${JSON.stringify(k)}`);
      env.push('-e', `${k}=${v}`);
    }
    const { stdout } = await this.#run([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}\t#{pane_id}',
      '-t',
      `=${this.#session}:`,
      // tmux expands -n and -c as formats (`#(...)` would run a shell job): `##` is a literal #.
      '-n',
      escapeFormat(o.name),
      '-c',
      escapeFormat(o.cwd),
      ...env,
      '--',
      ...o.argv,
    ]);
    const out = stdout.replace(/\r?\n$/, '');
    const [windowId = '', paneId = '', ...rest] = out.split('\t');
    if (!WINDOW_ID.test(windowId) || !PANE_ID.test(paneId) || rest.length > 0) {
      throw new Error(`tmux new-window printed something unexpected: ${JSON.stringify(out)}`);
    }
    const closed = () => new Error(`the window closed at once: ${o.argv[0]} didn't start`);
    try {
      try {
        await this.setKageId(windowId, o.kageId);
      } catch (e) {
        // A missing argv[0] can close the window before the tag lands (`no such window`).
        throw (await this.#paneAlive(windowId, paneId)) ? e : closed();
      }
      if (this.#launchCheckMs > 0) await new Promise((r) => setTimeout(r, this.#launchCheckMs));
      if (!(await this.#paneAlive(windowId, paneId))) throw closed();
    } catch (e) {
      await this.#run(['kill-window', '-t', windowId]).catch(() => {});
      throw e;
    }
    return { windowId, paneId };
  }

  /** K4: true while the window exists and its pane's process runs. */
  async #paneAlive(windowId: string, paneId: string): Promise<boolean> {
    let stdout: string;
    try {
      ({ stdout } = await this.#run([
        'list-panes',
        '-t',
        windowId,
        '-F',
        '#{pane_id}\t#{pane_dead}\t#{pane_current_command}',
      ]));
    } catch {
      return false; // can't find window: it already closed
    }
    return stdout
      .split('\n')
      .map((l) => l.replace(/\r$/, '').split('\t'))
      .some(([id, dead]) => id === paneId && dead === '0');
  }

  /** Sends allowed keys only (K8); throws TypeError on any other key or a bad pane id. */
  async sendKeys(paneId: string, keys: Key[]): Promise<void> {
    checkPaneId(paneId);
    for (const k of keys)
      if (!KEYS.has(k)) throw new TypeError(`key not allowed: ${JSON.stringify(k)}`);
    // K8: two Escapes on an empty input box open Claude's rewind menu.
    if (keys.filter((k) => k === 'Escape').length > 1)
      throw new TypeError('Escape is sent at most once');
    if (keys.length === 0) return;
    await this.#run(['send-keys', '-t', paneId, ...keys]);
  }

  /**
   * Types text literally (`-l --`: no key names, and text starting `-` is not an option). One
   * call up to SEND_TEXT_MAX_BYTES (K10); longer text in several, split on code points.
   */
  async sendText(paneId: string, text: string): Promise<void> {
    checkPaneId(paneId);
    if (CONTROL.test(text))
      throw new TypeError('text holds a control character; use sendKeys for keys');
    for (const chunk of utf8Chunks(text, SEND_TEXT_MAX_BYTES)) {
      await this.#run(['send-keys', '-t', paneId, '-l', '--', chunk]);
    }
  }

  /** The window's `@kage_id`, or null when unset (K5: `-q` makes an unset option print nothing). */
  async windowKageId(windowId: string): Promise<string | null> {
    checkWindowId(windowId);
    const { stdout } = await this.#run([
      'show-options',
      '-w',
      '-q',
      '-v',
      '-t',
      windowId,
      '@kage_id',
    ]);
    const id = stdout.replace(/\r?\n$/, '');
    return id === '' ? null : id;
  }

  /**
   * Kills the window only when its `@kage_id` is exactly `kageId`, re-read just before. False
   * when it holds another id or none, or when the window is gone. With killUntaggedWindow, this
   * is the only way control code kills a window; there is no unchecked kill.
   */
  async killOwnedWindow(windowId: string, kageId: string): Promise<boolean> {
    checkWindowId(windowId);
    if (kageId === '') throw new TypeError('killOwnedWindow needs a kage id');
    return this.#killIfHeld(windowId, kageId);
  }

  /**
   * A launch's rollback: kills the window only when its `@kage_id` is unset, re-read just before
   * (a `new-window` that timed out after tmux opened the window, before the tag). False when it
   * holds an id or is gone.
   */
  async killUntaggedWindow(windowId: string): Promise<boolean> {
    checkWindowId(windowId);
    return this.#killIfHeld(windowId, null);
  }

  async #killIfHeld(windowId: string, kageId: string | null): Promise<boolean> {
    let held: string | null;
    try {
      held = await this.windowKageId(windowId);
    } catch (e) {
      if (GONE_RE.test(stderrOf(e))) return false;
      throw e;
    }
    if (held !== kageId) return false;
    try {
      await this.#run(['kill-window', '-t', windowId]);
    } catch (e) {
      // The window closed between the re-read and the kill.
      if (GONE_RE.test(stderrOf(e))) return false;
      throw e;
    }
    return true;
  }
}
