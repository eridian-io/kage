import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_NOW, resetDemo, SERVER_ENV } from './env.ts';

const ROOT = join(import.meta.dirname, '..');

test.beforeEach(async ({ page }) => {
  await resetDemo();
  await page.clock.setFixedTime(DEMO_NOW);
});

test('j and k move the selection', async ({ page }) => {
  await page.goto('/');
  const on = page.locator('.k-it.on');
  await expect(on).toHaveText(/dark mode/);
  await page.keyboard.press('j');
  await expect(on).toHaveText(/fix login bug/);
  await expect(page.locator('.k-head h3')).toContainText('fix login bug');
  await page.keyboard.press('j');
  await expect(on).toHaveText(/node 24/);
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await expect(on).toHaveText(/dark mode/);
  // k at the top stays on the first session.
  await page.keyboard.press('k');
  await expect(on).toHaveText(/dark mode/);
});

test('delete removes the session and shows the toast', async ({ page }) => {
  await page.goto('/');
  await page.locator('.k-it', { hasText: 'update README' }).click();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await expect(page.getByText('Delete this session?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete session' }).click();
  await expect(page.locator('.k-it', { hasText: 'update README' })).toHaveCount(0);
  await expect(page.locator('.k-it')).toHaveCount(5);
  await expect(page.locator('.k-toast')).toHaveText(
    'Deleted docs · update README · worktree and branch removed',
  );
  await expect(page.locator('.k-host')).toContainText('my-pc · 5 sessions');
});

test.describe('reconnecting', () => {
  const port = 4392;
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;

  /** Starts a demo server on its own port and resolves once it prints its address. */
  function start(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const c = spawn(
        process.execPath,
        ['packages/server/src/main.ts', 'serve', '--demo', '--port', String(port)],
        { cwd: ROOT, env: { ...process.env, ...SERVER_ENV }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      const onData = (d: Buffer) => {
        out += d.toString();
        if (out.includes('Kage is running at')) resolve(c);
      };
      c.stdout?.on('data', onData);
      c.stderr?.on('data', onData);
      c.once('error', reject);
      c.once('exit', (code) =>
        reject(new Error(`Server exited (${code}) before starting:\n${out}`)),
      );
      child = c;
    });
  }

  /** Kills the server and waits until it has exited. */
  async function stop(): Promise<void> {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
    c.kill();
    await exited;
  }

  test.afterAll(async () => {
    await stop();
  });

  test('the board reconnects after the server restarts', async ({ page }) => {
    try {
      await start();
      await page.goto(base);
      await expect(page.locator('.k-it')).toHaveCount(6);
      const bar = page.getByRole('status').filter({ hasText: 'Reconnecting' });
      await expect(bar).toHaveCount(0);

      await stop();
      await expect(bar).toHaveText('Reconnecting to my-pc…');

      await start();
      await expect(bar).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator('.k-it')).toHaveCount(6);
      await expect(page.locator('.k-host')).toContainText('my-pc · 6 sessions');
    } finally {
      await stop();
    }
  });
});
