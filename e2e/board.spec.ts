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

test('keys typed right after R go into the reply field, never to the board', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
  await page.keyboard.press('r');
  // A digit reaching the board would answer the question.
  await page.keyboard.type('1 Use CSS variables');
  await expect(page.locator('.k-ask .k-follow input')).toHaveValue('1 Use CSS variables');
  // Demo mode refuses the send; the text stays and the server's sentence shows.
  await page.keyboard.press('Enter');
  await expect(page.locator('.k-err')).toHaveText("Couldn't send. Demo mode can't run tasks.");
  await expect(page.locator('.k-ask .k-follow input')).toHaveValue('1 Use CSS variables');
  await page.keyboard.press('Escape');
  await expect(page.locator('.k-ask .k-follow')).toHaveCount(0);
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
      // Review focus 4: the bar shows within 2 s of the stream dropping.
      await expect(bar).toHaveText('Reconnecting to my-pc…', { timeout: 2000 });

      await start();
      await expect(bar).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator('.k-it')).toHaveCount(6);
      await expect(page.locator('.k-host')).toContainText('my-pc · 6 sessions');
    } finally {
      await stop();
    }
  });
});

test.describe('the terminal (Task 13)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { cspViolations: string[] };
      w.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
  });
  const violations = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

  test('T loads the chunk only then; demo mode answers with its sentence', async ({ page }) => {
    const requested: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
    expect(requested.filter((p) => p.startsWith('/term-'))).toEqual([]);
    await page.keyboard.press('t');
    await expect(page.locator('.k-err')).toHaveText('Demo mode has no terminal.');
    await expect(page.locator('[data-act="term"]')).toHaveText('TerminalT');
    expect(requested.filter((p) => /^\/term-\w+\.js$/.test(p))).toHaveLength(1);
    expect(requested.filter((p) => /^\/term-\w+\.css$/.test(p))).toHaveLength(1);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('xterm renders the pane under the strict CSP, types, and leaves with Shift+Esc', async ({
    page,
  }) => {
    const frames: string[] = [];
    let url = '';
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/terminal/, (ws) => {
      url = ws.url();
      ws.onMessage((m) => frames.push(String(m)));
      ws.send(JSON.stringify({ t: 'reset', cols: 80, rows: 24, mode: 'rw' }));
      ws.send(
        Buffer.from(
          'plain row\r\n\x1b[38;2;215;119;87mTRUECOLOR\x1b[0m \x1b[48;2;40;80;40mTRUEBG\x1b[0m',
        ),
      );
    });
    await page.goto('/');
    await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
    await page.keyboard.press('t');
    const rows = page.locator('.k-term .xterm-rows');
    await expect(rows).toContainText('TRUECOLOR');
    expect(url).toMatch(/\/api\/sessions\/web\/terminal\?cols=\d+&rows=\d+$/);
    await expect(page.locator('.k-foot .l')).toContainText('Back to session⇧Esc');
    await expect(page.locator('.k-foot .l .k-hint')).toHaveText(
      'Shift+Esc (or Ctrl+Shift+X) to leave',
    );
    // The text can show a frame before xterm's style for it lands: poll, never read once.
    const style = (text: string, prop: 'color' | 'backgroundColor') => () =>
      rows
        .locator('span', { hasText: text })
        .first()
        .evaluate((e, p) => getComputedStyle(e)[p], prop);
    await expect.poll(style('TRUECOLOR', 'color')).toBe('rgb(215, 119, 87)');
    await expect.poll(style('TRUEBG', 'backgroundColor')).toBe('rgb(40, 80, 40)');
    // Keys go to the pane, Esc included; board keys don't act (F9).
    await page.keyboard.type('j1');
    await page.keyboard.press('Escape');
    const keys = () => frames.filter((f) => f.startsWith('{"t":"in"'));
    await expect.poll(() => keys().length).toBe(3);
    expect(keys().map((f) => JSON.parse(f).d)).toEqual(['j', '1', '\x1b']);
    await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
    await page.keyboard.press('Shift+Escape');
    await expect(page.locator('.k-term')).toHaveCount(0);
    await expect(page.locator('[data-act="term"]')).toBeFocused();
    expect(await violations(page)).toEqual([]);
  });

  test('a view-only pane shows the line and sends nothing', async ({ page }) => {
    const frames: string[] = [];
    await page.routeWebSocket(/\/terminal/, (ws) => {
      ws.onMessage((m) => frames.push(String(m)));
      ws.send(JSON.stringify({ t: 'reset', cols: 60, rows: 10, mode: 'ro' }));
      ws.send(Buffer.from('external window'));
    });
    await page.goto('/');
    await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
    await page.keyboard.press('t');
    await expect(page.locator('.k-term .xterm-rows')).toContainText('external window');
    await expect(page.locator('.k-term-ro')).toHaveText(
      "View only: Kage didn't start this window, so it doesn't type into it.",
    );
    await page.keyboard.type('abc');
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(300);
    expect(frames).toEqual([]);
    await page.keyboard.press('Control+Shift+X');
    await expect(page.locator('.k-term')).toHaveCount(0);
  });
});
