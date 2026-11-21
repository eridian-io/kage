import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import { LIVE_BASE, LIVE_PORT } from './env.ts';

/**
 * The live board end to end: `kage serve` in live mode against a private tmux server, with
 * e2e/fake-claude.mjs standing in for Claude (real `kage hook` calls, a real transcript file and
 * a drawn permission prompt). Nothing touches the user's tmux, config, git config or state:
 * HOME and XDG_* are temp dirs, tmux runs on its own socket (KAGE_TMUX_SOCKET), git reads no
 * system or global config, and the projects are temp repos this spec creates. Phase 3's tests
 * start tasks from the board, so Kage launches the fake itself (KAGE_CLAUDE_BIN).
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, env })).stdout;
}

/** A temp repo on `main` with an invented README in one commit and a local identity. */
async function initRepo(path: string, name: string): Promise<void> {
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'config', 'user.name', 'Kage Test');
  await git(path, 'config', 'user.email', 'kage-test@example.invalid');
  writeFileSync(join(path, 'README.md'), `# ${name}\n\nA sample project for the live e2e.\n`);
  await git(path, 'add', 'README.md');
  await git(path, 'commit', '-q', '-m', 'Add a README');
}

/** Kage's window for session `id` (its live @kage_id), or null once it is gone. */
async function kageWindow(id: string): Promise<{ windowId: string; paneId: string } | null> {
  const { stdout } = await tmux(
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
}

/** The fake's session id for the run started with `task` (its argv file names the task last). */
function fakeSessionFor(task: string): string | null {
  for (const f of readdirSync(dirOf('claude'))) {
    const m = /^argv-(.+)\.json$/.exec(f);
    if (!m) continue;
    const argv = JSON.parse(readFileSync(dirOf('claude', f), 'utf8')) as string[];
    if (argv.at(-1) === task) return m[1] as string;
  }
  return null;
}

/** The argv Kage started the fake with for `task`, once the fake has written it. */
async function fakeArgv(task: string): Promise<string[]> {
  await expect.poll(() => fakeSessionFor(task), { timeout: STATUS_MS }).not.toBeNull();
  const sid = fakeSessionFor(task) as string;
  return JSON.parse(readFileSync(dirOf('claude', `argv-${sid}.json`), 'utf8')) as string[];
}

/** The keys the fake started with `task` has received, typed runs joined ("text:…"). */
function fakeKeys(task: string): string[] {
  const sid = fakeSessionFor(task);
  const file = sid ? dirOf('claude', `keys-${sid}.json`) : '';
  return sid && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
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
    'config/kage',
    'claude',
    'projects/demo',
    'projects/shop',
  ]) {
    mkdirSync(dirOf(d), { recursive: true, mode: 0o700 });
  }
  // tmux starts the fake directly, as it starts claude: it must be executable (git tracks +x).
  accessSync(FAKE, constants.X_OK);
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
    KAGE_CLAUDE_BIN: FAKE,
    SHELL: '/bin/sh',
    FAKE_CLAUDE_DIR: dirOf('claude'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  writeFileSync(
    dirOf('config', 'kage', 'config.json'),
    JSON.stringify({ projectsRoot: dirOf('projects') }),
  );
  for (const name of ['demo', 'shop']) await initRepo(dirOf('projects', name), name);
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

  // Quitting the fake (/exit, as in Claude) fires SessionEnd and the pane goes back to its shell.
  await tmux('send-keys', '-t', pane, '-l', '/exit');
  await tmux('send-keys', '-t', pane, 'Enter');
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
  // The option buttons; the reply hint after them is a button too.
  const options = page.locator('.k-ask .k-opts button:not(.k-or)');
  await expect(options).toHaveText([
    '1Yes',
    '2Yes, and don’t ask again for: npm run clean *',
    '3Yes, and switch to auto mode',
    '4No',
  ]);
  // The board never switches the launch permission mode (R39): shown, but disabled.
  await expect(options.nth(2)).toBeDisabled();
  await expect(options.nth(0)).toBeEnabled();

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

  // The watcher brings the session back. Its first window is Kage's placeholder (R22): tagged,
  // and kept off the board while it sits at its shell.
  await expect
    .poll(
      async () =>
        (
          await tmux('list-windows', '-t', 'kage', '-F', '#{@kage_placeholder}').catch(() => ({
            stdout: '',
          }))
        ).stdout.trim(),
      { timeout: STATUS_MS },
    )
    .toBe('1');
  // A window opened after it shows, which proves Kage has listed the windows since.
  await newWindow('after-restart', dirOf('projects/shop'), 'sh');
  await expect(row(page, 'after-restart')).toHaveCount(1, { timeout: STATUS_MS });
  await expect(page.locator('.k-it')).toHaveCount(2);
  await expect(row(page, 'seeded task')).toHaveCount(1);
});

// ------------------------------------------------------------------ phase 3: control
// Kage starts these sessions itself (the fake through KAGE_CLAUDE_BIN, in a new worktree). They
// run after the tmux server restart above, on the server Kage's watcher started again.

const DEMO_TASK = 'edit-and-test Make greet() lowercase';
const DEMO_SLUG = 'edit-and-test-make-greet-lowercase';
const ANSWER_TASK = 'needs-permission Clear the build cache';

const lines = (page: Page) => page.locator('.k-main .ln');
const lineTexts = (page: Page) => lines(page).allTextContents();
const options = (page: Page) => page.locator('.k-ask .k-opts button:not(.k-or)');

/** Fills the New task form and starts the task with Enter; returns the new session's id. */
async function startTask(
  page: Page,
  task: string,
  project: 'demo' | 'shop',
  acceptEdits = false,
): Promise<string> {
  await page.locator('.k-new').click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task').fill(task);
  await form.getByLabel('Project').selectOption(project);
  await form.getByLabel('Branch off').selectOption('main');
  if (acceptEdits) await form.getByLabel('Accept edits automatically').check();
  const started = page.waitForResponse(
    (r) => r.url() === `${LIVE_BASE}/api/sessions` && r.request().method() === 'POST',
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

/** Board keys act only while focus is outside a field. */
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Waits for the permission prompt card of the needs-permission fake. */
async function expectPrompt(page: Page): Promise<void> {
  await expect(chip(page)).toHaveText('needs you', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask .k-q')).toHaveText(
    'Waiting for youDo you want to proceed? — npm run clean',
  );
  await expect(options(page)).toHaveText([
    '1Yes',
    '2Yes, and don’t ask again for: npm run clean *',
    '3Yes, and switch to auto mode',
    '4No',
  ]);
}

test('a task started from the board gets its worktree, branch and window, and runs to done', async ({
  page,
}) => {
  await page.goto('/');
  const id = await startTask(page, DEMO_TASK, 'demo');
  await expect(page.locator('.k-meta')).toContainText(`branch kage/${DEMO_SLUG}`);

  const repo = dirOf('projects/demo');
  expect(existsSync(join(repo, '.worktrees', DEMO_SLUG))).toBe(true);
  expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.worktrees/');

  // Claude's form exactly: --settings <Kage's file> --permission-mode default -- <task>.
  const argv = await fakeArgv(DEMO_TASK);
  expect(argv).toContain('--permission-mode');
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default');
  expect(argv[argv.indexOf('--settings') + 1]).toMatch(/claude-settings\.json$/);
  expect(argv.slice(-2)).toEqual(['--', DEMO_TASK]);
  expect(await kageWindow(id)).not.toBeNull();

  await expect(lines(page)).toHaveText(
    [
      `> ${DEMO_TASK}`,
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
});

test('a prompt is answered from the board with its digit key', async ({ page }) => {
  await page.goto('/');
  await startTask(page, ANSWER_TASK, 'shop', true);
  const argv = await fakeArgv(ANSWER_TASK);
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');

  await expectPrompt(page);
  // The board never switches the launch permission mode (R39).
  await expect(options(page).nth(2)).toBeDisabled();
  const chips = await recordChips(page);
  await blur(page);
  await page.keyboard.press('1');
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  await expect(lines(page).last()).toHaveText('The build cache is cleared.');
  await expect(page.locator('.k-ask')).toHaveCount(0);
  expect(await chips()).toEqual([
    `${ANSWER_TASK}: needs you`,
    `${ANSWER_TASK}: running`,
    `${ANSWER_TASK}: done`,
  ]);
  expect(fakeKeys(ANSWER_TASK)).toEqual(['text:1']);
});

test('a follow-up on a done session runs a new turn', async ({ page }) => {
  await page.goto('/');
  await row(page, ANSWER_TASK).click({ timeout: STATUS_MS });
  await expect(chip(page)).toHaveText('done');
  const chips = await recordChips(page);

  const field = page.getByLabel('Follow up in this session…');
  await field.fill('Say hello');
  await field.press('Enter');
  await expect
    .poll(async () => (await lineTexts(page)).slice(-2), { timeout: STATUS_MS })
    .toEqual(['> Say hello', 'You said: Say hello']);
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  await expect(field).toHaveValue('');
  expect(await chips()).toEqual([
    `${ANSWER_TASK}: done`,
    `${ANSWER_TASK}: running`,
    `${ANSWER_TASK}: done`,
  ]);
});

test('a reply at a prompt sends Escape, the text and Enter, and is never read as a No', async ({
  page,
}) => {
  const task = 'needs-permission Clear the cache again';
  const reply = 'Use the cache script instead';
  await page.goto('/');
  await startTask(page, task, 'shop');
  await expectPrompt(page);
  const chips = await recordChips(page);
  await blur(page);
  await page.keyboard.press('r');
  const field = page.getByLabel('Reply instead of choosing…');
  await expect(field).toBeFocused();
  await page.keyboard.type(reply);
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await lineTexts(page)).slice(-2), { timeout: STATUS_MS })
    .toEqual([`> ${reply}`, `You said: ${reply}`]);
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask')).toHaveCount(0);
  // F20: Kage's own Escape (its interrupt record and denial line) never showed as done: the chip
  // went from needs you to running only when the reply was sent, then to done after its turn.
  expect(await chips()).toEqual([`${task}: needs you`, `${task}: running`, `${task}: done`]);
  // And the fake got exactly Escape, then the text, then Enter: no digit, no second Escape.
  expect(fakeKeys(task)).toEqual(['Escape', `text:${reply}`, 'Enter']);
});

test('No from the board (B17) denies the command: done, no question, the denial in the pane', async ({
  page,
}) => {
  const task = 'needs-permission One more';
  await page.goto('/');
  const id = await startTask(page, task, 'shop');
  await expectPrompt(page);
  await options(page).nth(3).click();
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask')).toHaveCount(0);
  await expect(row(page, task)).not.toContainText('waiting for your reply');
  const win = await kageWindow(id);
  expect(win).not.toBeNull();
  const pane = await tmux('capture-pane', '-p', '-t', win?.paneId as string);
  expect(pane.stdout).toContain('⎿  Interrupted · What should Claude do instead?');
  expect(fakeKeys(task)).toEqual(['text:4']);
});

test('the folder-trust screen is answered from the board, then the task runs', async ({ page }) => {
  const task = 'trust-first Check the folder';
  await page.goto('/');
  await startTask(page, task, 'demo');
  await expect(chip(page)).toHaveText('needs you', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask .k-q')).toHaveText('Waiting for youTrust this folder?');
  await expect(options(page)).toHaveText(['1No, exit', '2Yes, I trust this folder']);
  // Startup screens take their buttons only: no reply hint.
  await expect(page.locator('.k-ask .k-or')).toHaveCount(0);
  await expect(row(page, task)).toContainText('waiting for your reply');

  const chips = await recordChips(page);
  await options(page).nth(1).click();
  await expect(lines(page).last()).toHaveText(
    'greet() now says hello in lowercase, and both tests pass.',
    { timeout: STATUS_MS },
  );
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  const seen = await chips();
  expect(seen.slice(0, 2)).toEqual([`${task}: needs you`, `${task}: running`]);
  expect(seen.at(-1)).toBe(`${task}: done`);
  // Down, verified on screen, then Enter: never a digit or Escape on the trust screen.
  expect(fakeKeys(task)).toEqual(['Down', 'Enter']);
});

test('Stop ends a waiting session and keeps its worktree and branch; external windows are refused', async ({
  page,
}) => {
  await page.goto('/');
  // A done session shows no Stop (F2): Stop is for running and waiting sessions.
  await row(page, DEMO_TASK).click({ timeout: STATUS_MS });
  await expect(chip(page)).toHaveText('done');
  await expect(page.locator('.k-foot').getByRole('button', { name: /Stop/ })).toHaveCount(0);

  const task = 'needs-permission Leave this waiting';
  const slug = 'needs-permission-leave-this-waiting';
  const id = await startTask(page, task, 'shop');
  await expectPrompt(page);
  // R26: one X only arms Stop.
  await blur(page);
  await page.keyboard.press('x');
  await expect(page.getByRole('status').filter({ hasText: 'Press X again to stop' })).toBeVisible();
  await expect(chip(page)).toHaveText('needs you');
  expect(await kageWindow(id)).not.toBeNull();

  await page.locator('.k-foot').getByRole('button', { name: /Stop/ }).click();
  await expect(chip(page)).toHaveText('ended', { timeout: STATUS_MS });
  await expect.poll(() => kageWindow(id), { timeout: STATUS_MS }).toBeNull();
  const repo = dirOf('projects/shop');
  expect(existsSync(join(repo, '.worktrees', slug))).toBe(true);
  expect((await git(repo, 'branch', '--list', `kage/${slug}`)).trim()).not.toBe('');

  // A plain external window: Kage refuses to stop it, even with valid CSRF headers, and it lives.
  await newWindow('ext-stop', dirOf('projects/shop'), 'sh');
  await expect(row(page, 'ext-stop')).toContainText('external', { timeout: STATUS_MS });
  const extId = (await row(page, 'ext-stop').getAttribute('data-id')) as string;
  expect(extId).toMatch(/^ext-/);
  const res = await fetch(`${LIVE_BASE}/api/sessions/${encodeURIComponent(extId)}/stop`, {
    method: 'POST',
    headers: { 'X-Kage': '1', Origin: LIVE_BASE },
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Kage only stops sessions it started.' });
  const names = (await tmux('list-windows', '-a', '-F', '#{window_name}')).stdout.split('\n');
  expect(names).toContain('ext-stop');
  await expect(row(page, 'ext-stop')).toHaveCount(1);
});
