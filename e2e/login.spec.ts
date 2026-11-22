import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SERVER_ENV } from './env.ts';
import { closeCode, rawUpgrade } from './harness.ts';

/**
 * Token login (B13, spec §5.10) end to end: a demo `kage serve` of its own whose config sets an
 * access token. HOME and XDG_* are temp dirs, so nothing reads or writes the user's config.
 */

const ROOT = join(import.meta.dirname, '..');
const PORT = 4394;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2e-token-0123456789';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let root = '';
let serve: ChildProcess | null = null;
let serveOut = '';

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kage-login-'));
  for (const d of ['home', 'config/kage', 'state', 'run']) {
    mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root, 'config/kage/config.json'), JSON.stringify({ token: TOKEN }), {
    mode: 0o600,
  });
  const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
  const env = {
    ...rest,
    ...SERVER_ENV,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
  };
  await new Promise<void>((resolve, reject) => {
    const c = spawn(
      process.execPath,
      ['packages/server/src/main.ts', 'serve', '--demo', '--port', String(PORT)],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    serve = c;
    const onData = (d: Buffer) => {
      serveOut += d.toString();
      if (serveOut.includes('Kage is running at')) resolve();
    };
    c.stdout?.on('data', onData);
    c.stderr?.on('data', onData);
    c.once('error', reject);
    c.once('exit', (code) => reject(new Error(`kage serve exited (${code}):\n${serveOut}`)));
  });
});

test.afterAll(async () => {
  const c = serve;
  serve = null;
  if (c && c.exitCode === null && c.signalCode === null) {
    const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
    c.kill('SIGTERM');
    const timer = setTimeout(() => c.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(timer);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test('the board asks for the token, refuses a wrong one, and stays signed in', async ({ page }) => {
  await page.goto(`${BASE}/`);
  const field = page.getByLabel('Access token');
  await expect(field).toBeVisible();
  await expect(page.locator('.k-it')).toHaveCount(0);

  await field.fill('not-the-token-at-all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText("That token isn't right.");

  await field.fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.k-host')).toContainText('my-pc');
  await expect(page.locator('.k-it').first()).toBeVisible();
  await expect(field).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.k-host')).toContainText('my-pc');
  await expect(page.locator('.k-it').first()).toBeVisible();
  await expect(page.getByLabel('Access token')).toHaveCount(0);
});

test('a fresh browser context gets 401 from the event stream', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/`);
    await expect(page.getByLabel('Access token')).toBeVisible();
    const status = await page.evaluate(async () => (await fetch('/api/events')).status);
    expect(status).toBe(401);
  } finally {
    await context.close();
  }
});

test('a terminal upgrade needs the token cookie: 401 without it, 101 (then demo mode’s close) with it', async () => {
  const path = '/api/sessions/k-demo-term/terminal';
  const good = { Origin: BASE, 'Sec-WebSocket-Protocol': 'kage.term.v1' };
  expect((await rawUpgrade(PORT, path, good)).status).toBe(401);

  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'X-Kage': '1', Origin: BASE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(res.status).toBe(204);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(cookie).toMatch(/^kage_auth=./);

  const signedIn = await rawUpgrade(PORT, path, { ...good, Cookie: cookie });
  expect(signedIn.status).toBe(101);
  // Demo mode has no terminal: it closes right after the upgrade with 4501.
  expect(closeCode(signedIn.frame)).toBe(4501);
});
