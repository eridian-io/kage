#!/usr/bin/env node
import { existsSync, watch } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { type Asset, loadAssets } from './assets.ts';
import { ConfigError, loadConfig, startupWarnings } from './config.ts';
import { DemoSource } from './demo-source.ts';
import { EventHub } from './events.ts';
import { defaultTailscaleIp, displayHost, ListenError, resolveListenAddress } from './listen.ts';

const USAGE = 'Usage: kage serve [--demo] [--unsafe-listen-all] [--port N]';
const DIST = join(import.meta.dirname, '../../web/dist');

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** Under `node --watch`, reload the assets when the web build rewrites dist/. */
function reloadOnChange(assets: Map<string, Asset>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(DIST, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const fresh = await loadAssets(DIST);
        if (!fresh.has('/')) return;
        assets.clear();
        for (const [k, v] of fresh) assets.set(k, v);
      } catch {
        // mid-write; the next change event reloads
      }
    }, 150);
  });
  watcher.on('error', (err) => {
    console.error(`kage: stopped watching dist/ (${err.message}); restart to pick up web changes`);
    watcher.close();
  });
}

async function serveCommand(args: string[]): Promise<void> {
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
    fail(`${(err as Error).message}\n${USAGE}`);
  }

  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try {
    cfg = await loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(`Config error: ${err.message}`);
    throw err;
  }
  if (values.port !== undefined) {
    const n = Number(values.port);
    if (!/^\d+$/.test(values.port) || n < 1 || n > 65535) {
      fail(`--port must be an integer in 1–65535, got "${values.port}".`);
    }
    cfg = { ...cfg, port: n };
  }

  if (!values.demo) fail('Live sessions arrive in phase 2. Run with --demo for now.', 2);
  for (const warning of startupWarnings(cfg)) console.warn(warning);

  let listen: Awaited<ReturnType<typeof resolveListenAddress>>;
  try {
    listen = await resolveListenAddress(cfg, {
      unsafeListenAll: values['unsafe-listen-all'] === true,
      tailscaleIp: defaultTailscaleIp,
      hostname,
    });
  } catch (err) {
    if (err instanceof ListenError) fail(err.message);
    throw err;
  }

  if (!existsSync(join(DIST, 'index.html'))) {
    fail('The board is not built yet. Run "corepack pnpm build" first.');
  }
  const assets = await loadAssets(DIST);
  if (process.execArgv.some((a) => a.startsWith('--watch'))) reloadOnChange(assets);

  const source = new DemoSource();
  const hub = new EventHub(source, cfg.name, cfg.projectsRoot);
  const app = createApp({
    source,
    hub,
    assets,
    allowed: { hostNames: listen.hostNames, port: cfg.port },
    demoReset: () => source.reset(),
  });

  const server = serve({ fetch: app.fetch, hostname: listen.address, port: cfg.port }, () => {
    console.log(
      `Kage is running at http://${displayHost(cfg, listen.address, hostname())}:${cfg.port}`,
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') fail(`Port ${cfg.port} is already in use.`);
    if (err.code === 'EADDRNOTAVAIL')
      fail(`Can't listen on ${listen.address}: no such address here.`);
    fail(`Couldn't start the server: ${err.message}`);
  });

  const shutdown = () => {
    hub.close();
    server.close(() => process.exit(0));
    if ('closeAllConnections' in server) server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'serve') {
  await serveCommand(rest);
} else if (command === undefined || command === 'help' || command === '--help') {
  console.log(USAGE);
} else {
  fail(`Unknown command "${command}".\n${USAGE}`);
}
