import { existsSync, watch } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { ArchivedSession, ProjectsResponse } from '@kage/shared';
import { createApp } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { ConfigError, type KageConfig, loadConfig, startupWarnings } from './config.ts';
import { ActionLock, attachCommand, SessionControls } from './control/actions.ts';
import { resolveClaude, TaskLauncher } from './control/launcher.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';
import { FinishActions } from './finish/actions.ts';
import { AutoArchiver, gitCommonDir } from './finish/auto-archive.ts';
import { branchCounts, branchState } from './git/branch.ts';
import { gitExec } from './git/exec.ts';
import { listProjects, ProjectsCache } from './git/projects.ts';
import { socketPath } from './hooks/cli.ts';
import { HookServer } from './hooks/server.ts';
import {
  defaultTailscaleIp,
  displayHost,
  ListenError,
  resolveListenAddress,
  tailscaleDnsName,
} from './listen.ts';
import { LiveSource } from './live-source.ts';
import type { Io, Running } from './main.ts';
import { boardLink, NOTIFY_DEFAULTS, Notifier } from './notify/notifier.ts';
import { NtfyClient } from './notify/ntfy.ts';
import { DiffService } from './preview/diff.ts';
import { changedFiles, UntrackedCache } from './preview/files.ts';
import { makeScanner } from './preview/ports.ts';
import { PreviewTracker } from './preview/tracker.ts';
import type { SessionSource } from './source.ts';
import { StateStore, stateDir } from './state/store.ts';
import { TerminalBridge } from './terminal/bridge.ts';
import { ControlClient } from './terminal/control.ts';
import { TerminalServer } from './terminal/server.ts';
import { parseTmuxVersion, TmuxClient, tmuxVersionOutput } from './tmux/client.ts';
import { TmuxWatcher } from './tmux/watcher.ts';
import { TranscriptTail } from './transcript/tail.ts';

const DIST = join(import.meta.dirname, '../../web/dist');

/** R53: live mode without a token, said once at startup. */
export const NO_TOKEN = 'No token set: anyone on your tailnet can start and approve tasks.';
/** B15: a SIGINT or SIGTERM arrived before the server was up; what had started is stopped. */
export const STOPPED = 'Stopped before Kage was ready.';
/** The exit code after a startup interrupted by a signal (128 + SIGINT). */
export const STOPPED_CODE = 130;

/** Why live mode can't start here, or null. Checked before anything is started. */
export function liveModeError(
  platform: NodeJS.Platform,
  tmuxVersion: string | null,
): string | null {
  if (platform === 'win32') {
    return 'Live sessions need Linux or macOS (tmux). On Windows, run Kage inside WSL, or use "kage serve --demo".';
  }
  if (tmuxVersion === null) {
    return `tmux isn't installed. Install tmux 3.2 or newer, or run "kage serve --demo".`;
  }
  const { version, tooOld } = parseTmuxVersion(tmuxVersion);
  if (tooOld)
    return `tmux ${version} is too old. Install tmux 3.2 or newer, or run "kage serve --demo".`;
  return null;
}

/** One line for stderr: the first line of an error's tmux stderr or message. */
function oneLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = String((e.stderr && String(e.stderr).trim()) || e.message || err);
  return text.split(/\r?\n/)[0] ?? text;
}

/** Under `node --watch`, reload the assets when the web build rewrites dist/. */
function reloadOnChange(dist: string, assets: Map<string, Asset>, io: Io): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dist, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const fresh = await loadAssets(dist);
        if (!fresh.has('/')) return;
        assets.clear();
        for (const [k, v] of fresh) assets.set(k, v);
      } catch {
        // mid-write; the next change event reloads
      }
    }, 150);
  });
  watcher.on('error', (err) => {
    io.err(`kage: stopped watching dist/ (${err.message}); restart to pick up web changes`);
    watcher.close();
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

type Cleanup = () => void | Promise<void>;

/** Runs cleanups newest first; one failing doesn't stop the rest. */
async function unwind(cleanups: Cleanup[]): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // keep going: everything else must still stop
    }
  }
}

class StartError extends Error {}
/** Thrown between startup steps once `io.signal` has aborted. */
class Stopped extends Error {}

function checkSignal(io: Io): void {
  if (io.signal?.aborted) throw new Stopped();
}

/** What live mode started, for the task launcher. */
interface LiveParts {
  source: LiveSource;
  /** The tmux client, for SessionControls (captures, keys, the owned-window kill). */
  tmux: TmuxClient;
  /** Opens a window in the kage session, re-creating the session first if it went away. */
  newWindow: TmuxClient['newWindow'];
  settingsPath: string;
  hookSocket: string;
  /** One action at a time per session, across the controls, the finish actions and resume (F5, R68). */
  lock: ActionLock;
  /** Pin, archive and restore; auto-archive archives through it too. */
  finish: FinishActions;
  /** Browser terminals over one tmux control client (Task 11), mounted by the WebSocket. */
  bridge: TerminalBridge;
}

/**
 * Starts live mode in order: the tmux session, the hook server, the hooks settings file, the
 * state store, the watcher and the source. Each started part pushes its cleanup.
 */
async function startLive(
  cfg: KageConfig,
  io: Io,
  cli: CliParts,
  cleanups: Cleanup[],
): Promise<LiveParts> {
  const target = {
    session: cfg.tmuxSession,
    socket: cfg.tmuxSocket,
    configFile: io.tmuxConfigFile,
  };
  const hookSocket = socketPath(io.env);
  // Windows inherit the session's environment, so `kage hook` in them posts to this socket even
  // when their shell's XDG_RUNTIME_DIR or HOME differ from serve's. The first window gets it at
  // new-session (-e); set-environment covers a session that already exists.
  const tmux = new TmuxClient({
    ...target,
    env: { KAGE_SOCKET: hookSocket },
    warn: (message) => io.err(message),
    ...(io.tmuxExec ? { exec: io.tmuxExec } : {}),
  });
  const ensureSession = async () => {
    await tmux.ensureSession();
    await tmux.setEnvironment('KAGE_SOCKET', hookSocket).catch(() => {});
  };
  try {
    await ensureSession();
  } catch (err) {
    throw new StartError(`Couldn't start the tmux session "${cfg.tmuxSession}": ${oneLine(err)}`);
  }
  checkSignal(io);

  const hooks = new HookServer(hookSocket);
  try {
    await hooks.listen();
  } catch (err) {
    throw new StartError(`Couldn't open the hook socket: ${oneLine(err)}`);
  }
  cleanups.push(() => hooks.close());
  checkSignal(io);

  let settingsPath: string;
  try {
    settingsPath = await cli.writeSettings(io.env);
  } catch (err) {
    throw new StartError(`Couldn't write the Claude settings file: ${oneLine(err)}`);
  }
  checkSignal(io);

  const store = new StateStore(join(stateDir(io.env), 'state.json'));
  const watcher = new TmuxWatcher({ ...target, beforeLaunch: ensureSession });
  // F11/R70: a session with a terminal open on its window is never archived automatically.
  // The bridge is built after the source (its idle callback touches the source), so late-bound.
  let bridge: TerminalBridge | null = null;
  const isTerminalOpen = (id: string): boolean => {
    const w = source.terminalTarget(id)?.windowId ?? null;
    return w !== null && bridge?.isWindowOpen(w) === true;
  };
  // B37: untracked files' line counts, re-read only when their size or mtime changed.
  const untracked = new UntrackedCache();
  const source = new LiveSource({
    tmux,
    watcher,
    hooks,
    store,
    tail: (path) => new TranscriptTail(path),
    projectsRoot: cfg.projectsRoot,
    // Ports from ss and ps on Linux, lsof and ps on macOS; no port scan elsewhere (spec §5.7).
    preview: (host) =>
      new PreviewTracker({
        target: (id) => host.previewTarget(id),
        publish: (id, patch, always) => host.setPreview(id, patch, always),
        scan: makeScanner(io.platform ?? process.platform),
        files: (worktree, base) => changedFiles(worktree, base, gitExec, { cache: untracked }),
        forgetFiles: (worktree) => untracked.forget(worktree),
        // A record's unpushed and uncommitted counts, refreshed with its files (spec §5.8).
        branch: (worktree, o) => branchCounts(worktree, o.branch, gitExec),
      }),
    // Auto-archive on merge and after afterDays (spec §5.8), through the same archive action.
    autoArchive: (host) =>
      new AutoArchiver({
        config: cfg.autoArchive,
        candidates: () => host.autoCandidates(),
        state: (c) => branchState(c.worktree, c, gitExec),
        archive: (id) => finish.archive(id, true, { auto: true }),
        gitDir: (repo) => gitCommonDir(repo, gitExec),
        log: (line) => io.err(line),
      }),
    isTerminalOpen,
    // A failed resume (R63) is reported on the card and here.
    log: (line) => io.err(line),
  });
  // A control-mode client on the same tmux server and session, only while a terminal is open.
  const termBridge = new TerminalBridge({
    client: (o) => new ControlClient({ target, session: cfg.tmuxSession, ...o }),
    log: (line) => io.err(line),
    // The last terminal on a window closed: auto-archive may look at its session again (F11).
    onWindowIdle: (windowId) => source.windowIdle(windowId),
  });
  bridge = termBridge;
  cleanups.push(() => termBridge.stop());
  // Built before source.start(), which starts the auto-archiver that archives through it.
  const lock = new ActionLock();
  const finish = new FinishActions({
    tmux,
    source,
    lock,
    git: gitExec,
    projectsRoot: cfg.projectsRoot,
    worktreeDir: cfg.worktreeDir,
    branchPrefix: cfg.branchPrefix,
    // Delete recounts what the confirmation showed; a mismatch reaches the board (B10).
    counts: (worktree, branch) => branchCounts(worktree, branch, gitExec),
    publish: (id, counts) => source.setPreview(id, counts),
    isTerminalOpen,
  });
  // stop() also stops the watcher, and is safe on a source that failed part-way through start.
  cleanups.push(() => source.stop());
  try {
    await source.start();
  } catch (err) {
    throw new StartError(`Couldn't load the sessions: ${oneLine(err)}`);
  }
  checkSignal(io);
  const newWindow: TmuxClient['newWindow'] = async (o) => {
    await ensureSession();
    return tmux.newWindow(o);
  };
  return { source, tmux, newWindow, settingsPath, hookSocket, lock, finish, bridge: termBridge };
}

/**
 * Phone pings (spec §5.9): live mode with an `ntfyTopic` only. The notifier reads the live
 * source's events; the link uses the MagicDNS name when Tailscale gave one. One startup line
 * names the server's host, never the topic or the server's path; nothing about ntfy reaches
 * the browser or the snapshot. `KAGE_NOTIFY_DONE_AFTER_MS` (whole ms) is a test-only override
 * of the done threshold for the e2e, not documented in USAGE.
 */
function startNotifier(
  cfg: KageConfig,
  listen: { address: string; dnsName: string | null },
  source: LiveSource,
  io: Io,
  cleanups: Cleanup[],
): void {
  const client = new NtfyClient({
    config: { server: cfg.ntfyServer, topic: cfg.ntfyTopic, token: cfg.ntfyToken },
    log: (line) => io.err(line),
  });
  const doneAfter = io.env.KAGE_NOTIFY_DONE_AFTER_MS ?? '';
  const host = listen.dnsName ?? displayHost(cfg, listen.address, hostname());
  const notifier = new Notifier({
    source,
    send: (p, stillWanted) => client.send(p, stillWanted),
    link: (id) => boardLink(host, cfg.port, id),
    hostName: cfg.name,
    options: {
      ...NOTIFY_DEFAULTS,
      onDone: cfg.ntfyOnDone,
      ...(/^\d{1,9}$/.test(doneAfter) ? { doneAfterMs: Number(doneAfter) } : {}),
    },
    log: (line) => io.err(line),
  });
  notifier.start();
  cleanups.push(() => {
    notifier.stop();
    client.close();
  });
  io.out(`Pings go to ntfy at ${new URL(cfg.ntfyServer).host}.`);
}

/** What serve needs from main.ts, passed in: serve.ts must not import main.ts at runtime. */
export interface CliParts {
  usage: string;
  /** Writes the hooks settings file (the same file as `kage hooks-path`). */
  writeSettings: (env: NodeJS.ProcessEnv) => Promise<string>;
}

/**
 * `kage serve`: a number is the exit code; a Running is a server that is up. `io.signal` is
 * checked between startup steps (B15): once it aborts, what started is stopped and the exit code
 * is 130. Errors after the config checks print one line, never a stack trace.
 */
export async function serveCommand(
  args: string[],
  io: Io,
  cli: CliParts,
): Promise<number | Running> {
  let values: { demo?: boolean; 'unsafe-listen-all'?: boolean; port?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        demo: { type: 'boolean' },
        'unsafe-listen-all': { type: 'boolean' },
        port: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\n${cli.usage}`);
    return 1;
  }

  let cfg: KageConfig;
  try {
    cfg = await loadConfig({ env: io.env });
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(`Config error: ${err.message}`);
      return 1;
    }
    throw err;
  }
  if (values.port !== undefined) {
    const n = Number(values.port);
    if (!/^\d+$/.test(values.port) || n < 1 || n > 65535) {
      io.err(`--port must be an integer in 1–65535, got "${values.port}".`);
      return 1;
    }
    cfg = { ...cfg, port: n };
  }

  const cleanups: Cleanup[] = [];
  try {
    return await startServer(cfg, values, io, cli, cleanups);
  } catch (err) {
    await unwind(cleanups);
    if (err instanceof Stopped) {
      io.err(STOPPED);
      return STOPPED_CODE;
    }
    io.err(err instanceof StartError ? err.message : `Couldn't start Kage: ${oneLine(err)}`);
    return 1;
  }
}

/** serveCommand after the flags and the config: each started part pushes its cleanup. */
async function startServer(
  cfg: KageConfig,
  values: { demo?: boolean; 'unsafe-listen-all'?: boolean },
  io: Io,
  cli: CliParts,
  cleanups: Cleanup[],
): Promise<number | Running> {
  checkSignal(io);
  const demo = values.demo === true;
  if (demo) {
    for (const warning of startupWarnings(cfg)) io.err(warning);
  } else {
    const tmuxVersion = io.tmuxVersion === undefined ? tmuxVersionOutput : io.tmuxVersion;
    const refusal = liveModeError(io.platform ?? process.platform, tmuxVersion);
    if (refusal) {
      io.err(refusal);
      return 1;
    }
  }

  let listen: Awaited<ReturnType<typeof resolveListenAddress>>;
  try {
    listen = await resolveListenAddress(cfg, {
      unsafeListenAll: values['unsafe-listen-all'] === true,
      tailscaleIp: defaultTailscaleIp,
      tailscaleDnsName: () => tailscaleDnsName(),
      hostname,
    });
  } catch (err) {
    if (err instanceof ListenError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
  checkSignal(io);

  const dist = io.dist ?? DIST;
  if (!existsSync(join(dist, 'index.html'))) {
    io.err('The board is not built yet. Run "corepack pnpm build" first.');
    return 1;
  }
  const assets = await (io.loadAssets ?? loadAssets)(dist);
  checkSignal(io);

  if (process.execArgv.some((a) => a.startsWith('--watch'))) {
    cleanups.push(reloadOnChange(dist, assets, io));
  }

  let source: SessionSource;
  let demoReset: (() => void) | undefined;
  let projects: (() => Promise<ProjectsResponse>) | undefined;
  let launcher: TaskLauncher | undefined;
  let invalidateProjects: (() => void) | undefined;
  let controls: SessionControls | undefined;
  let finish: FinishActions | undefined;
  let archivedList: (() => ArchivedSession[]) | undefined;
  let differ: DiffService | undefined;
  let liveParts: LiveParts | undefined;
  if (demo) {
    const d = new DemoSource();
    source = d;
    demoReset = () => d.reset();
  } else {
    const live = await startLive(cfg, io, cli, cleanups);
    liveParts = live;
    source = live.source;
    const cache = new ProjectsCache(async () => ({
      projects: await listProjects(cfg.projectsRoot),
      last: live.source.lastProject(),
    }));
    projects = () => cache.get();
    invalidateProjects = () => cache.invalidate();
    // Resolved once; when it is missing, POST /api/sessions says so (503), nothing is logged.
    const claudeBin = await resolveClaude(io.env);
    checkSignal(io);
    launcher = new TaskLauncher({
      projectsRoot: cfg.projectsRoot,
      worktreeDir: cfg.worktreeDir,
      branchPrefix: cfg.branchPrefix,
      git: gitExec,
      tmux: {
        newWindow: live.newWindow,
        listWindows: (p) => live.tmux.listWindows(p),
        killUntaggedWindow: (w) => live.tmux.killUntaggedWindow(w),
        killOwnedWindow: (w, k) => live.tmux.killOwnedWindow(w, k),
      },
      source: live.source,
      // Resume shares the one action lock with the controls and finish actions (F5, R68).
      lock: live.lock,
      claudeBin,
      settingsPath: live.settingsPath,
      hookSocket: live.hookSocket,
      // The window's PATH is Kage's, so claude and `kage hook` resolve as they do for Kage.
      windowPath: io.env.PATH ?? null,
    });
    controls = new SessionControls({
      tmux: live.tmux,
      source: live.source,
      attach: attachCommand(cfg.tmuxSession, cfg.tmuxSocket),
      lock: live.lock,
    });
    finish = live.finish;
    const liveSource = live.source;
    archivedList = () => liveSource.archivedList();
    // The diff reads the same folder and base as the file list (spec §5.7, amended).
    differ = new DiffService({ target: (id) => liveSource.previewTarget(id) });
  }

  const hub = new EventHub(source, cfg.name, cfg.projectsRoot);
  cleanups.push(() => hub.close());
  const allowed = { hostNames: listen.hostNames, port: cfg.port };
  const app = createApp({
    source,
    hub,
    assets,
    allowed,
    token: cfg.token,
    ...(demoReset ? { demoReset } : {}),
    ...(projects ? { projects } : {}),
    ...(launcher ? { launcher, resumer: launcher } : {}),
    ...(invalidateProjects ? { invalidateProjects } : {}),
    ...(controls ? { controls } : {}),
    ...(finish ? { finish } : {}),
    ...(archivedList ? { archivedList } : {}),
    ...(differ ? { differ } : {}),
  });
  // The terminal WebSocket (B9), in both modes: demo answers 4501 after its guards.
  const terminals = new TerminalServer({
    allowed,
    token: cfg.token,
    source: liveParts?.source ?? null,
    bridge: liveParts?.bridge ?? null,
    tmux: liveParts?.tmux ?? null,
  });
  // Closed before the HTTP server (and again here if the server never started).
  cleanups.push(() => terminals.close());

  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: listen.address, port: cfg.port }, () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
      // Every upgrade goes to the terminal server, which refuses all but its own path.
      (s as HttpServer).on('upgrade', (req, socket, head) =>
        terminals.handleUpgrade(req, socket, head),
      );
    });
  } catch (e) {
    await unwind(cleanups);
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') io.err(`Port ${cfg.port} is already in use.`);
    else if (err.code === 'EADDRNOTAVAIL')
      io.err(`Can't listen on ${listen.address}: no such address here.`);
    else io.err(`Couldn't start the server: ${oneLine(err)}`);
    return 1;
  }
  // The HTTP server stops first: no new requests or streams while the rest shuts down. The
  // terminals close before it (1001), since an upgraded socket would hold server.close() open.
  cleanups.push(async () => {
    terminals.close();
    liveParts?.bridge.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    hub.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
  });
  checkSignal(io);
  // R53: without a token, anyone who can reach the address can start and approve tasks.
  if (!demo && cfg.token === '') io.err(NO_TOKEN);
  io.out(`Kage is running at http://${displayHost(cfg, listen.address, hostname())}:${cfg.port}`);
  if (liveParts && cfg.ntfyTopic !== '') startNotifier(cfg, listen, liveParts.source, io, cleanups);

  return { stop: () => unwind(cleanups) };
}
