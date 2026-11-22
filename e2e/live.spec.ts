import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { LIVE_BASE } from './env.ts';
import {
  blur,
  chip,
  hasTmux,
  LiveHarness,
  lines,
  lineTexts,
  ownChips,
  recordChips,
  row,
  STATUS_MS,
  startTask,
} from './harness.ts';

/**
 * The live board end to end: `kage serve` in live mode against a private tmux server, with
 * e2e/fake-claude.mjs standing in for Claude (e2e/harness.ts has the setup). Phase 3's tests
 * start tasks from the board, so Kage launches the fake itself (KAGE_CLAUDE_BIN).
 */

const SEEDED_ID = 'k-e2e-seeded';

test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');
test.describe.configure({ mode: 'serial', timeout: 60_000 });

const h = new LiveHarness();
const { dirOf, tmux, git, kageWindow, fakeArgv, fakeKeys, newWindow, startFake } = h;

test.beforeAll(async () => {
  await h.setUp();
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
  await h.startTmux('seeded');
  await tmux('set-option', '-w', '-t', 'kage:seeded', '@kage_id', SEEDED_ID);
  await h.startServe();
});

test.afterAll(async () => {
  await h.tearDown();
});

/** On failure: every pane's text and Kage's output, attached to the report. */
test.afterEach(async ({ page: _page }, info) => {
  await h.attachOnFailure(info);
});

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
  expect(h.serve?.exitCode ?? null).toBeNull();

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

const options = (page: Page) => page.locator('.k-ask .k-opts button:not(.k-or)');

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
  // A new question holds its buttons and digits for ~800 ms (R51).
  await expect(options(page).first()).toBeEnabled();
}

test('a task started from the board gets its worktree, branch and window, and runs to done', async ({
  page,
}) => {
  await page.goto('/');
  // From the start: a launched task never shows done before its first turn (P3F1).
  const chips = await recordChips(page);
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
  expect(ownChips(await chips(), DEMO_TASK)).toEqual([
    `${DEMO_TASK}: running`,
    `${DEMO_TASK}: done`,
  ]);
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
  const fromStart = await recordChips(page);
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
  // P3F1: no done between the trust answer and the task's first turn. (The first "running",
  // before the trust screen, may come and go before the board first draws the new session.)
  const own = ownChips(await fromStart(), task);
  expect(own.slice(-3)).toEqual([`${task}: needs you`, `${task}: running`, `${task}: done`]);
  expect(own.slice(0, -3)).toEqual(own.length > 3 ? [`${task}: running`] : []);
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

test('B33: a card answered after its question changed gets 409; X then X within 2 s stops', async ({
  page,
}) => {
  const task = 'needs-permission Stop me twice';
  await page.goto('/');
  const id = await startTask(page, task, 'shop');
  await expectPrompt(page);

  // The card's question as the server no longer has it: the request is rewritten on its way, as
  // a card left on screen while the prompt changed would send it (R36).
  await page.route(`**/api/sessions/${encodeURIComponent(id)}/answer`, (route) => {
    const body = route.request().postDataJSON() as { option: number; question: string };
    return route.continue({
      postData: JSON.stringify({ ...body, question: 'Do you want to delete everything?' }),
    });
  });
  const answered = page.waitForResponse((r) => r.url().endsWith('/answer'));
  await options(page).first().click();
  expect((await answered).status()).toBe(409);
  await expect(page.locator('.k-err')).toContainText(
    'The question changed. Look again before answering.',
  );
  await expect(chip(page)).toHaveText('needs you');
  expect(fakeKeys(task)).toEqual([]);
  await page.unroute(`**/api/sessions/${encodeURIComponent(id)}/answer`);

  // R26: the first X only arms Stop and sends nothing; the second, within 2 s, stops.
  const stops: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/stop')) stops.push(r.url());
  });
  await blur(page);
  await page.keyboard.press('x');
  await expect(page.getByRole('status').filter({ hasText: 'Press X again to stop' })).toBeVisible();
  expect(stops).toEqual([]);
  await expect(chip(page)).toHaveText('needs you');
  await page.keyboard.press('x');
  await expect(chip(page)).toHaveText('ended', { timeout: STATUS_MS });
  expect(stops).toHaveLength(1);
  await expect.poll(() => kageWindow(id), { timeout: STATUS_MS }).toBeNull();
});
