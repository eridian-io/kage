import { existsSync, watch } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { ProjectsResponse } from '@kage/shared';
import { createApp } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { ConfigError, type KageConfig, loadConfig, startupWarnings } from './config.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';
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
import type { SessionSource } from './source.ts';
import { StateStore, stateDir } from './state/store.ts';
import { parseTmuxVersion, TmuxClient, tmuxVersionOutput } from './tmux/client.ts';
import { TmuxWatcher } from './tmux/watcher.ts';
import { TranscriptTail } from './transcript/tail.ts';

const DIST = join(import.meta.dirname, '../../web/dist');

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

/**
 * Starts live mode in order: the tmux session, the hook server, the hooks settings file, the
 * state store, the watcher and the source. Each started part pushes its cleanup.
 */
async function startLive(
  cfg: KageConfig,
  io: Io,
  cli: CliParts,
  cleanups: Cleanup[],
): Promise<LiveSource> {
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

  try {
    await cli.writeSettings(io.env);
  } catch (err) {
    throw new StartError(`Couldn't write the Claude settings file: ${oneLine(err)}`);
  }
  checkSignal(io);

  const store = new StateStore(join(stateDir(io.env), 'state.json'));
  const watcher = new TmuxWatcher({ ...target, beforeLaunch: ensureSession });
  const source = new LiveSource({
    tmux,
    watcher,
    hooks,
    store,
    tail: (path) => new TranscriptTail(path),
    projectsRoot: cfg.projectsRoot,
  });
  // stop() also stops the watcher, and is safe on a source that failed part-way through start.
  cleanups.push(() => source.stop());
  try {
    await source.start();
  } catch (err) {
    throw new StartError(`Couldn't load the sessions: ${oneLine(err)}`);
  }
  checkSignal(io);
  return source;
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
  if (demo) {
    const d = new DemoSource();
    source = d;
    demoReset = () => d.reset();
  } else {
    const live = await startLive(cfg, io, cli, cleanups);
    source = live;
    const cache = new ProjectsCache(async () => ({
      projects: await listProjects(cfg.projectsRoot),
      last: live.lastProject(),
    }));
    projects = () => cache.get();
  }

  const hub = new EventHub(source, cfg.name, cfg.projectsRoot);
  cleanups.push(() => hub.close());
  const app = createApp({
    source,
    hub,
    assets,
    allowed: { hostNames: listen.hostNames, port: cfg.port },
    token: cfg.token,
    ...(demoReset ? { demoReset } : {}),
    ...(projects ? { projects } : {}),
  });

  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: listen.address, port: cfg.port }, () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
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
  // The HTTP server stops first: no new requests or streams while the rest shuts down.
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    hub.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
  });
  checkSignal(io);
  io.out(`Kage is running at http://${displayHost(cfg, listen.address, hostname())}:${cfg.port}`);

  return { stop: () => unwind(cleanups) };
}
