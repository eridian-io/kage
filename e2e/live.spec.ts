import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import { LIVE_PORT } from './env.ts';

/**
 * The live board end to end: `kage serve` in live mode against a private tmux server, with
 * e2e/fake-claude.mjs standing in for Claude (real `kage hook` calls, a real transcript file and
 * a drawn permission prompt). Nothing touches the user's tmux, config or state: HOME and XDG_*
 * are temp dirs and tmux runs on its own socket (KAGE_TMUX_SOCKET).
 */

const ROOT = join(import.meta.dirname, '..');
const FAKE = join(ROOT, 'e2e/fake-claude.mjs');
const run = promisify(execFile);
/** Status changes can take a few hook and re-list rounds; never wait on fixed sleeps. */
const STATUS_MS = 15_000;
const SEEDED_ID = 'k-e2e-seeded';

function hasTmux(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');
test.describe.configure({ mode: 'serial', timeout: 60_000 });

let root = '';
let socket = '';
let env: NodeJS.ProcessEnv = {};
let serve: ChildProcess | null = null;
let serveOut = '';

const dirOf = (...parts: string[]) => join(root, ...parts);

function tmux(...args: string[]): Promise<{ stdout: string }> {
  return run('tmux', ['-L', socket, ...args], { env });
}

/** Opens a window in the `kage` session running `command`; returns its pane id. */
async function newWindow(name: string, cwd: string, command: string): Promise<string> {
  const { stdout } = await tmux(
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
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Starts the fake in a new window the way a person starts claude: typed into an interactive
 * shell. The shell's job control gives it its own process group, so tmux reports it (node) as
 * the pane's command. Under `sh -c 'node …; exec sh'` tmux would report the sh, the process
 * group's leader, and Kage would read claude as gone (R17). When the fake exits, the pane is
 * back at its shell.
 */
async function startFake(name: string, cwd: string, scenario: string): Promise<string> {
  const pane = await newWindow(name, cwd, 'sh');
  await tmux('send-keys', '-t', pane, '-l', `${q(process.execPath)} ${q(FAKE)} ${scenario}`);
  await tmux('send-keys', '-t', pane, 'Enter');
  return pane;
}

function startServe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      ['packages/server/src/main.ts', 'serve', '--port', String(LIVE_PORT)],
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
}

async function stopServe(): Promise<void> {
  const c = serve;
  serve = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
  c.kill('SIGTERM');
  const timer = setTimeout(() => c.kill('SIGKILL'), 8000);
  await exited;
  clearTimeout(timer);
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kage-live-'));
  socket = `kage-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  for (const d of [
    'home',
    'config',
    'state/kage',
    'run',
    'claude',
    'projects/demo',
    'projects/shop',
  ]) {
    mkdirSync(dirOf(d), { recursive: true, mode: 0o700 });
  }
  const { TMUX: _t, TMUX_PANE: _p, ...rest } = process.env;
  env = {
    ...rest,
    HOME: dirOf('home'),
    XDG_CONFIG_HOME: dirOf('config'),
    XDG_STATE_HOME: dirOf('state'),
    XDG_RUNTIME_DIR: dirOf('run'),
    KAGE_SOCKET: dirOf('run', 'kage.sock'),
    KAGE_TMUX_SOCKET: socket,
    KAGE_HOST: '127.0.0.1',
    KAGE_NAME: 'my-pc',
    SHELL: '/bin/sh',
    FAKE_CLAUDE_DIR: dirOf('claude'),
  };
  // A session Kage created before this run (phase 3 will create them): its record, and its
  // window carrying @kage_id. Kage reconciles both at start (spec §5.8a).
  writeFileSync(
    dirOf('state', 'kage', 'state.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          kageId: SEEDED_ID,
          windowId: null,
          project: 'demo',
          task: 'seeded task',
          branch: 'kage/seeded-task',
          worktree: dirOf('projects/demo'),
          createdAt: Date.now() - 60_000,
          pinned: false,
          archived: false,
          sessionId: null,
          transcriptPath: null,
        },
      ],
    }),
  );
  await run(
    'tmux',
    ['-f', '/dev/null', '-L', socket, 'new-session', '-d', '-s', 'kage', '-n', 'seeded'],
    { env, cwd: dirOf('projects/demo') },
  );
  await tmux('set-option', '-w', '-t', 'kage:seeded', '@kage_id', SEEDED_ID);
  await startServe();
});

test.afterAll(async () => {
  // Kage first: its watcher would start the tmux server again.
  await stopServe().catch(() => {});
  await tmux('kill-server').catch(() => {});
  if (root) rmSync(root, { recursive: true, force: true });
});

/** On failure: every pane's text and Kage's output, attached to the report. */
test.afterEach(async ({ page: _page }, info) => {
  if (info.status === info.expectedStatus) return;
  let text = '';
  try {
    const format = '#{window_id} #{pane_id} #{window_name} #{pane_current_command}';
    const { stdout } = await tmux('list-windows', '-a', '-F', format);
    text += stdout;
    for (const line of stdout.trim().split('\n')) {
      const paneId = line.split(' ')[1];
      if (!paneId) continue;
      const pane = await tmux('capture-pane', '-p', '-t', paneId);
      text += `\n--- ${line}\n${pane.stdout}`;
    }
  } catch (err) {
    text += `tmux: ${(err as Error).message}\n`;
  }
  await info.attach('panes.txt', { body: text, contentType: 'text/plain' });
  await info.attach('kage-serve.txt', { body: serveOut, contentType: 'text/plain' });
  // The list reporter shows attachments by name only; the container run needs the text.
  console.log(`${text}
--- kage serve
${serveOut}`);
});

const row = (page: Page, task: string) => page.locator('.k-it', { hasText: task });
const chip = (page: Page) => page.locator('.k-head .k-chip');

/** Records every `task: chip` the panel shows from now on, so short states can't be missed. */
async function recordChips(page: Page): Promise<() => Promise<string[]>> {
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

test('a fake Claude session runs with its transcript lines, then is done', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.k-host')).toContainText('my-pc');
  const pane = await startFake('greet-lowercase', dirOf('projects/demo'), 'edit-and-test');

  await row(page, 'greet-lowercase').click({ timeout: STATUS_MS });
  const chips = await recordChips(page);
  await expect(row(page, 'greet-lowercase')).toContainText('external');
  await expect(page.locator('.k-head h3')).toContainText('demo /');

  await expect(page.locator('.k-main .ln')).toHaveText(
    [
      '> Make greet() say hello in lowercase, then run the tests',
      "I'll update greet() and run the tests.",
      'Update src/greet.js',
      "−   return 'Hello, ' + name;",
      "+   return 'hello, ' + name;",
      'Bash npm test',
      '  PASS test/greet.test.js',
      '  Tests: 2 passed, 2 total',
      'greet() now says hello in lowercase, and both tests pass.',
    ],
    { timeout: STATUS_MS },
  );
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  const seen = await chips();
  expect(seen).toContain('greet-lowercase: running');
  expect(seen.indexOf('greet-lowercase: running')).toBeLessThan(
    seen.lastIndexOf('greet-lowercase: done'),
  );

  // Quitting the fake fires SessionEnd and the pane goes back to its shell.
  await tmux('send-keys', '-t', pane, 'q');
  await expect(chip(page)).toHaveText('ended', { timeout: STATUS_MS });
  await expect(page.locator('.k-main .ln').last()).toHaveText(
    'greet() now says hello in lowercase, and both tests pass.',
  );
});

test('a permission prompt waits for you, and runs on after 1 is sent to the pane', async ({
  page,
}) => {
  await page.goto('/');
  const pane = await startFake('clear-cache', dirOf('projects/shop'), 'needs-permission');

  await expect(row(page, 'clear-cache')).toContainText('waiting for your reply', {
    timeout: STATUS_MS,
  });
  await expect(row(page, 'clear-cache')).toContainText('external');
  await row(page, 'clear-cache').click();
  await expect(chip(page)).toHaveText('needs you');
  await expect(page.locator('.k-ask .k-q')).toHaveText(
    'Waiting for youDo you want to proceed? — npm run clean',
    { timeout: STATUS_MS },
  );
  await expect(page.locator('.k-ask .k-opts button')).toHaveText([
    '1Yes',
    '2Yes, and don’t ask again for: npm run clean *',
    '3Yes, and switch to auto mode',
    '4No',
  ]);

  const chips = await recordChips(page);
  // The test answers in the pane, not through the board (answering from Kage is phase 3).
  await tmux('send-keys', '-t', pane, '1');
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask')).toHaveCount(0);
  await expect(row(page, 'clear-cache')).not.toContainText('waiting for your reply');
  // Approved: it runs until the command's PostToolUse and the Stop; never done in between.
  expect(await chips()).toEqual([
    'clear-cache: needs you',
    'clear-cache: running',
    'clear-cache: done',
  ]);
  await expect(page.locator('.k-main .ln').last()).toHaveText('The build cache is cleared.');
});

test('a plain shell window is an external session; killing it removes the session', async ({
  page,
}) => {
  await page.goto('/');
  await newWindow('plain-shell', dirOf('projects/shop'), 'sh');
  await expect(row(page, 'plain-shell')).toContainText('external', { timeout: STATUS_MS });
  await expect(row(page, 'plain-shell')).not.toContainText('waiting for your reply');

  await tmux('kill-window', '-t', 'kage:plain-shell');
  await expect(row(page, 'plain-shell')).toHaveCount(0, { timeout: STATUS_MS });
});

test('killing the tmux server ends Kage sessions, drops external ones, and the board stays up', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'seeded task').click({ timeout: STATUS_MS });
  await expect(row(page, 'seeded task')).not.toContainText('external');
  await expect(chip(page)).not.toHaveText('ended');
  await expect(row(page, 'greet-lowercase')).toHaveCount(1);

  await tmux('kill-server');
  await expect(chip(page)).toHaveText('ended', { timeout: STATUS_MS });
  await expect(row(page, 'greet-lowercase')).toHaveCount(0, { timeout: STATUS_MS });
  await expect(row(page, 'clear-cache')).toHaveCount(0);
  await expect(page.locator('.k-host')).toContainText('my-pc');
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting' })).toHaveCount(0);
  expect(serve?.exitCode ?? null).toBeNull();
});
