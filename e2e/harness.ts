import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { serviceEnv } from '../packages/server/src/install/runtime.ts';
import { anonymousMb } from '../packages/server/src/proc-memory.ts';
import { LIVE_PORT } from './env.ts';
import { assertLocalNtfy } from './fake-ntfy.ts';

/**
 * The live specs' setup and helpers: `kage serve` in live mode against a private tmux server,
 * with e2e/fake-claude.mjs standing in for Claude (real `kage hook` calls, a real transcript file
 * and a drawn permission prompt). Nothing touches the user's tmux, config, git config or state:
 * HOME and XDG_* are temp dirs, tmux runs on its own socket (KAGE_TMUX_SOCKET), git reads no
 * system or global config, and the projects are temp repos the harness creates. Tasks started
 * from the board launch the fake through KAGE_CLAUDE_BIN.
 */

export const ROOT = join(import.meta.dirname, '..');
export const FAKE = join(ROOT, 'e2e/fake-claude.mjs');
/**
 * The shipped server (ruling R91): `pnpm build` bundles it into one file, and phase 6 runs it with
 * these flags and this environment. The perf project measures it; the other specs run the sources.
 */
export const BUNDLE = join(ROOT, 'packages/server/dist/kage.mjs');
/** The light `kage hook` the bundle's hooks run (hardening Task 13). */
export const HOOK_BUNDLE = join(ROOT, 'packages/server/dist/kage-hook.mjs');
/** The service's flags (serviceArgv): R91's pool size and a 1 MB young generation (Task 15, F19). */
export const SHIPPED_FLAGS = ['--v8-pool-size=1', '--max-semi-space-size=1'];
export const SHIPPED_ENV = { MALLOC_ARENA_MAX: '2' };
/**
 * A single executable to measure as well (Task 6): `KAGE_PERF_SEA=<gunzipped kage>`. It runs with
 * the service's environment (serviceEnv); its pool size is in its own execArgv.
 */
export const PERF_SEA: string | undefined = process.env.KAGE_PERF_SEA || undefined;
const run = promisify(execFile);
/** Status changes can take a few hook and re-list rounds; never wait on fixed sleeps. */
export const STATUS_MS = 15_000;

export function hasTmux(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let ticksPerSecond = 0;
/** USER_HZ, the unit of /proc/<pid>/stat's CPU times (100 on Linux; asked once). */
function clockTicks(): number {
  if (!ticksPerSecond) {
    try {
      ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })) || 100;
    } catch {
      ticksPerSecond = 100;
    }
  }
  return ticksPerSecond;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One live run: a temp root, a private tmux socket, the repos `demo` and `shop`, and `kage serve`.
 * The methods are arrow fields, so a spec may destructure them.
 */
export class LiveHarness {
  /** The port `kage serve` listens on (the live project's by default; the perf project has its own). */
  port: number;
  root = '';
  socket = '';
  env: NodeJS.ProcessEnv = {};
  serve: ChildProcess | null = null;
  serveOut = '';

  constructor(port = LIVE_PORT) {
    this.port = port;
  }

  dirOf = (...parts: string[]): string => join(this.root, ...parts);

  tmux = (...args: string[]): Promise<{ stdout: string }> =>
    run('tmux', ['-L', this.socket, ...args], { env: this.env });

  git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await run('git', args, { cwd, env: this.env })).stdout;

  /**
   * The temp root, its HOME and XDG_* dirs, the environment, Kage's config (projectsRoot plus
   * `config`) and the two repos. tmux and Kage start with startTmux and startServe.
   */
  setUp = async (config: Record<string, unknown> = {}): Promise<void> => {
    // Checked before anything is created; writeConfig and startServe check again.
    assertLocalNtfy(config);
    this.root = mkdtempSync(join(tmpdir(), 'kage-live-'));
    this.socket = `kage-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    for (const d of [
      'home',
      'config',
      'state/kage',
      'run',
      'config/kage',
      'claude',
      'projects/demo',
      'projects/shop',
    ]) {
      mkdirSync(this.dirOf(d), { recursive: true, mode: 0o700 });
    }
    // tmux starts the fake directly, as it starts claude: it must be executable (git tracks +x).
    accessSync(FAKE, constants.X_OK);
    const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
    this.env = {
      ...rest,
      HOME: this.dirOf('home'),
      XDG_CONFIG_HOME: this.dirOf('config'),
      XDG_STATE_HOME: this.dirOf('state'),
      XDG_RUNTIME_DIR: this.dirOf('run'),
      KAGE_SOCKET: this.dirOf('run', 'kage.sock'),
      KAGE_TMUX_SOCKET: this.socket,
      KAGE_HOST: '127.0.0.1',
      KAGE_NAME: 'my-pc',
      KAGE_CLAUDE_BIN: FAKE,
      SHELL: '/bin/sh',
      FAKE_CLAUDE_DIR: this.dirOf('claude'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    this.writeConfig(config);
    for (const name of ['demo', 'shop']) await this.initRepo(this.dirOf('projects', name), name);
  };

  configPath = (): string => this.dirOf('config', 'kage', 'config.json');

  /**
   * Kage's config: projectsRoot plus `config`, read by the next startServe. A topic only with
   * the fake ntfy on 127.0.0.1, never a real ntfy server (R85, PF5 F2).
   */
  writeConfig = (config: Record<string, unknown> = {}): void => {
    assertLocalNtfy(config);
    writeFileSync(
      this.configPath(),
      JSON.stringify({ projectsRoot: this.dirOf('projects'), ...config }),
    );
  };

  /** A temp repo on `main` with an invented README in one commit and a local identity. */
  initRepo = async (path: string, name: string): Promise<void> => {
    await this.git(path, 'init', '-q', '-b', 'main');
    await this.git(path, 'config', 'user.name', 'Kage Test');
    await this.git(path, 'config', 'user.email', 'kage-test@example.invalid');
    writeFileSync(join(path, 'README.md'), `# ${name}\n\nA sample project for the live e2e.\n`);
    await this.git(path, 'add', 'README.md');
    await this.git(path, 'commit', '-q', '-m', 'Add a README');
  };

  /** The private tmux server, with no config, and the `kage` session whose first window is `name`. */
  startTmux = async (name: string): Promise<void> => {
    await run(
      'tmux',
      ['-f', '/dev/null', '-L', this.socket, 'new-session', '-d', '-s', 'kage', '-n', name],
      { env: this.env, cwd: this.dirOf('projects/demo') },
    );
  };

  /** Kage's window for session `id` (its live @kage_id), or null once it is gone. */
  kageWindow = async (id: string): Promise<{ windowId: string; paneId: string } | null> => {
    const { stdout } = await this.tmux(
      'list-windows',
      '-a',
      '-F',
      '#{@kage_id}\t#{window_id}\t#{pane_id}',
    ).catch(() => ({ stdout: '' }));
    for (const line of stdout.trim().split('\n')) {
      const [kageId, windowId, paneId] = line.split('\t');
      if (kageId === id && windowId && paneId) return { windowId, paneId };
    }
    return null;
  };

  /** The fake's session id for the run started with `task` (its argv file names the task last). */
  fakeSessionFor = (task: string): string | null => {
    for (const f of readdirSync(this.dirOf('claude'))) {
      const m = /^argv-(.+)\.json$/.exec(f);
      if (!m) continue;
      const argv = JSON.parse(readFileSync(this.dirOf('claude', f), 'utf8')) as string[];
      if (argv.at(-1) === task) return m[1] as string;
    }
    return null;
  };

  /** The argv Kage started the fake with for `task`, once the fake has written it. */
  fakeArgv = async (task: string): Promise<string[]> => {
    await expect.poll(() => this.fakeSessionFor(task), { timeout: STATUS_MS }).not.toBeNull();
    const sid = this.fakeSessionFor(task) as string;
    return JSON.parse(readFileSync(this.dirOf('claude', `argv-${sid}.json`), 'utf8')) as string[];
  };

  /** The keys the fake started with `task` has received, typed runs joined ("text:…"). */
  fakeKeys = (task: string): string[] => {
    const sid = this.fakeSessionFor(task);
    const file = sid ? this.dirOf('claude', `keys-${sid}.json`) : '';
    return sid && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
  };

  /** Opens a window in the `kage` session running `command`; returns its pane id. */
  newWindow = async (name: string, cwd: string, command: string): Promise<string> => {
    const { stdout } = await this.tmux(
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      'kage:',
      '-n',
      name,
      '-c',
      cwd,
      command,
    );
    return stdout.trim();
  };

  /**
   * Starts the fake in a new window the way a person starts claude: typed into an interactive
   * shell. The shell's job control gives it its own process group, so tmux reports it (node) as
   * the pane's command. Under `sh -c 'node …; exec sh'` tmux would report the sh, the process
   * group's leader, and Kage would read claude as gone (R17). When the fake exits, the pane is
   * back at its shell.
   */
  startFake = async (name: string, cwd: string, scenario: string): Promise<string> => {
    const pane = await this.newWindow(name, cwd, 'sh');
    await this.tmux('send-keys', '-t', pane, '-l', `${q(process.execPath)} ${q(FAKE)} ${scenario}`);
    await this.tmux('send-keys', '-t', pane, 'Enter');
    return pane;
  };

  /**
   * Starts `kage serve`: from the sources (`dev`, as `node packages/server/src/main.ts`), the
   * bundle with the shipped flags and environment (`shipped`, ruling R91), or the single
   * executable at KAGE_PERF_SEA with the service's environment (`sea`, Task 6).
   */
  startServe = (mode: 'dev' | 'shipped' | 'sea' = 'dev'): Promise<void> =>
    new Promise((resolve, reject) => {
      if (mode === 'shipped' && !existsSync(BUNDLE)) {
        reject(new Error(`No server bundle at ${BUNDLE}: run corepack pnpm build`));
        return;
      }
      if (mode === 'sea' && !(PERF_SEA && existsSync(PERF_SEA))) {
        reject(new Error(`No single executable at KAGE_PERF_SEA (${PERF_SEA ?? 'unset'})`));
        return;
      }
      // The config as serve will read it, however a spec wrote it: no topic without the fake (R85).
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(readFileSync(this.configPath(), 'utf8')) as Record<string, unknown>;
        assertLocalNtfy(config);
      } catch (err) {
        reject(err);
        return;
      }
      // Security I3: live mode without a token starts only when told to, in every mode.
      const tokenless = typeof config.token !== 'string' || config.token === '';
      const port = [
        'serve',
        '--port',
        String(this.port),
        ...(tokenless ? ['--allow-no-token'] : []),
      ];
      const sea = PERF_SEA as string;
      const [file, args, env] =
        mode === 'sea'
          ? [
              sea,
              port,
              { ...this.env, ...serviceEnv({ kind: 'sea', exe: sea }, this.env.PATH ?? '') },
            ]
          : mode === 'shipped'
            ? [
                process.execPath,
                [...SHIPPED_FLAGS, BUNDLE, ...port],
                { ...this.env, ...SHIPPED_ENV },
              ]
            : [process.execPath, ['packages/server/src/main.ts', ...port], this.env];
      const c = spawn(file, args, {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.serve = c;
      // A restart must not resolve on the last run's "running" line.
      const from = this.serveOut.length;
      const onData = (d: Buffer) => {
        this.serveOut += d.toString();
        if (this.serveOut.slice(from).includes('Kage is running at')) resolve();
      };
      c.stdout?.on('data', onData);
      c.stderr?.on('data', onData);
      c.once('error', reject);
      c.once('exit', (code) => reject(new Error(`kage serve exited (${code}):\n${this.serveOut}`)));
    });

  stopServe = async (): Promise<void> => {
    const c = this.serve;
    this.serve = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
    c.kill('SIGTERM');
    const timer = setTimeout(() => c.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(timer);
  };

  /**
   * One POST to the hook socket, as `kage hook <event>` makes it: the event name, the pane
   * (`TMUX_PANE`) and Claude's hook JSON. Resolves once Kage has answered.
   */
  postHook = (event: string, body: Record<string, unknown>, pane: string | null): Promise<void> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify({ event, pane, payload: body });
      const req = httpRequest(
        {
          socketPath: this.env.KAGE_SOCKET,
          path: '/hook',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
          },
        },
        (res) => {
          res.on('error', reject);
          res.on('end', resolve);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end(data);
    });

  /** `kage serve`'s resident set in MB (/proc/<pid>/status VmRSS); Linux only. */
  serveRss = (): number => {
    const status = readFileSync(`/proc/${this.servePid()}/status`, 'utf8');
    const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]);
    if (!Number.isFinite(kb)) throw new Error('No VmRSS in /proc status');
    return kb / 1024;
  };

  /**
   * `kage serve`'s anonymous memory in MB: the Anonymous line of /proc/<pid>/smaps_rollup, the
   * part of its RSS Kage controls (performance P5); Linux only.
   */
  serveAnon = (): number => anonymousMb(`/proc/${this.servePid()}/smaps_rollup`);

  /** `kage serve`'s CPU time so far in ms (/proc/<pid>/stat utime + stime); Linux only. */
  serveCpuMs = (): number => {
    const stat = readFileSync(`/proc/${this.servePid()}/stat`, 'utf8');
    // The fields after the command name (which may hold spaces) start at state, field 3.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(f[11]) + Number(f[12]); // utime (field 14) and stime (field 15)
    return (ticks * 1000) / clockTicks();
  };

  servePid = (): number => {
    const pid = this.serve?.pid;
    if (!pid) throw new Error('kage serve is not running');
    return pid;
  };

  /** Kage, then the tmux server, then the temp root; each step runs even if one before failed. */
  tearDown = async (): Promise<void> => {
    // Kage first: its watcher would start the tmux server again.
    await this.stopServe().catch(() => {});
    if (this.socket) await this.tmux('kill-server').catch(() => {});
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  };

  /** On failure: every pane's text and Kage's output, attached to the report. */
  attachOnFailure = async (info: TestInfo): Promise<void> => {
    if (info.status === info.expectedStatus) return;
    let text = '';
    try {
      const format = '#{window_id} #{pane_id} #{window_name} #{pane_current_command}';
      const { stdout } = await this.tmux('list-windows', '-a', '-F', format);
      text += stdout;
      for (const line of stdout.trim().split('\n')) {
        const paneId = line.split(' ')[1];
        if (!paneId) continue;
        const pane = await this.tmux('capture-pane', '-p', '-t', paneId);
        text += `\n--- ${line}\n${pane.stdout}`;
      }
    } catch (err) {
      text += `tmux: ${(err as Error).message}\n`;
    }
    await info.attach('panes.txt', { body: text, contentType: 'text/plain' });
    await info.attach('kage-serve.txt', { body: this.serveOut, contentType: 'text/plain' });
    // The list reporter shows attachments by name only; the container run needs the text.
    console.log(`${text}
--- kage serve
${this.serveOut}`);
  };
}

// ------------------------------------------------------------------ board helpers

export const row = (page: Page, task: string) => page.locator('.k-it', { hasText: task });
export const chip = (page: Page) => page.locator('.k-head .k-chip');
export const lines = (page: Page) => page.locator('.k-main .ln');
export const lineTexts = (page: Page) => lines(page).allTextContents();

/** Board keys act only while focus is outside a field. */
export const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Records every `task: chip` the panel shows from now on, so short states can't be missed. */
export async function recordChips(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { kageChips: string[] };
    w.kageChips = [];
    const read = () => {
      const task = document.querySelector('.k-head .k-task')?.textContent ?? '';
      const c = document.querySelector('.k-head .k-chip')?.textContent ?? '';
      const v = `${task}: ${c}`;
      if (w.kageChips.at(-1) !== v) w.kageChips.push(v);
    };
    read();
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return () => page.evaluate(() => (window as unknown as { kageChips: string[] }).kageChips);
}

/** The recorded chips of one task (the head shows other sessions before it is selected). */
export const ownChips = (seen: string[], task: string) =>
  seen.filter((c) => c.startsWith(`${task}: `));

/** Fills the New task form and starts the task with Enter; returns the new session's id. */
export async function startTask(
  page: Page,
  task: string,
  project: 'demo' | 'shop',
  acceptEdits = false,
): Promise<string> {
  await page.locator('.k-side .k-new').click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task').fill(task);
  await form.getByLabel('Project').selectOption(project);
  await form.getByLabel('Branch off').selectOption('main');
  if (acceptEdits) await form.getByLabel('Accept edits automatically').check();
  const started = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sessions' && r.request().method() === 'POST',
  );
  await form.getByLabel('Task').press('Enter');
  const res = await started;
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await expect(form).toHaveCount(0);
  // The new session is selected.
  await expect(page.locator('.k-it.on')).toHaveAttribute('data-id', id, { timeout: STATUS_MS });
  await expect(page.locator('.k-head .k-task')).toHaveText(task);
  return id;
}

// ------------------------------------------------------------------ raw WebSocket upgrades

/** What a raw terminal upgrade got: the HTTP status, and after a 101 the server's first frame. */
export interface UpgradeResult {
  status: number;
  /** The first frame after a 101 (opcode 1 text, 2 binary, 8 close), when one was awaited. */
  frame?: { opcode: number; data: Buffer };
}

/** The close code of a close frame (RFC 6455 §5.5.1), or null without one. */
export const closeCode = (f: UpgradeResult['frame']): number | null =>
  f && f.opcode === 8 && f.data.length >= 2 ? f.data.readUInt16BE(0) : null;

/**
 * A WebSocket upgrade request sent by hand with `headers` (Connection, Upgrade, version and key
 * are added), so a test can leave out what a browser always sends. After a 101 it waits for the
 * server's first (unmasked) frame, then closes the socket.
 */
export function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.once('error', reject);
    req.once('response', (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.once('upgrade', (res, socket, head) => {
      let buf = Buffer.from(head);
      const done = (frame?: UpgradeResult['frame']) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, ...(frame ? { frame } : {}) });
      };
      const parse = () => {
        if (buf.length < 2) return;
        const opcode = (buf[0] as number) & 0x0f;
        let len = (buf[1] as number) & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        if (buf.length < at + len) return;
        done({ opcode, data: buf.subarray(at, at + len) });
      };
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        parse();
      });
      socket.once('close', () => done());
      socket.on('error', () => {});
      parse();
    });
    req.end();
  });
}
