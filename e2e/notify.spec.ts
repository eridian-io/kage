import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { LIVE_BASE } from './env.ts';
import { type FakeNtfy, startFakeNtfy } from './fake-ntfy.ts';
import {
  blur,
  chip,
  hasTmux,
  LiveHarness,
  lineTexts,
  row,
  STATUS_MS,
  startTask,
} from './harness.ts';

/**
 * Notifications end to end (spec §5.9): `kage serve` in live mode pings the fake ntfy on
 * 127.0.0.1, never a real ntfy server (R85; the harness refuses any other ntfyServer). The hold is
 * the shipped 3 s; the done threshold is 1 s (KAGE_NOTIFY_DONE_AFTER_MS, test only). Then the
 * board's `#s=` links. The browser notification is notify-browser.spec.ts.
 *
 * The full Chromium (its new headless mode): the headless shell reports notification permission
 * as denied whatever is granted, and keeps the page focused.
 */

test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');
test.describe.configure({ mode: 'serial', timeout: 90_000 });

/** Random, as a real topic is; it must never show in Kage's output (N1). */
const TOPIC = `kage-e2e-${randomBytes(12).toString('hex')}`;
const WAIT_TASK = 'needs-permission Clear the build cache';
const BARRIER_TASK = 'needs-permission Tidy the logs';
const FLOOD_TASK = 'flood Write a long answer';

const h = new LiveHarness();
let ntfy: FakeNtfy;
/** The waiting session's id (the first test), for the link test. */
let waitId = '';

const bodies = () => ntfy.received.map((r) => r.body as Record<string, unknown>);
const link = (id: string) => `${LIVE_BASE}/#s=${encodeURIComponent(id)}`;

test.beforeAll(async () => {
  ntfy = await startFakeNtfy();
  await h.setUp({ ntfyTopic: TOPIC, ntfyServer: ntfy.url });
  h.env.KAGE_NOTIFY_DONE_AFTER_MS = '1000';
  await h.startTmux('notify');
  await h.startServe();
});

test.afterAll(async () => {
  await h.tearDown();
  await ntfy?.close();
});

test.afterEach(async ({ page: _page }, info) => {
  await h.attachOnFailure(info);
});

/** The permission prompt of the needs-permission fake, its buttons live (R51). */
async function expectPrompt(page: Page): Promise<void> {
  await expect(chip(page)).toHaveText('needs you', { timeout: STATUS_MS });
  await expect(page.locator('.k-ask .k-opts button:not(.k-or)').first()).toBeEnabled();
}

test('a session that needs you sends one ping: title, task, priority and link only', async ({
  page,
}) => {
  await page.goto('/');
  waitId = await startTask(page, WAIT_TASK, 'demo');
  await expectPrompt(page);
  // The hold is 3 s: the ping lands well inside 6 s of the board showing needs you.
  await expect.poll(() => ntfy.received.length, { timeout: 6000 }).toBe(1);
  const [got] = ntfy.received;
  expect(got?.body).toEqual({
    topic: TOPIC,
    title: 'demo needs you',
    message: WAIT_TASK,
    priority: 4,
    click: link(waitId),
  });
  // N1: the topic travels in the body, never the URL; no token is set, so no Authorization.
  expect(got?.path).toBe('/');
  expect(got?.headers.authorization).toBeUndefined();
  // N2: never the question, its command, the branch or a path.
  const text = JSON.stringify(got?.body);
  for (const secret of ['proceed', 'npm run clean', 'kage/', h.root, '.worktrees']) {
    expect(text).not.toContain(secret);
  }
  expect(h.serveOut).not.toContain(TOPIC);
});

test('answering, and the next prompt, send no second ping', async ({ page }) => {
  await page.goto('/');
  await row(page, WAIT_TASK).click({ timeout: STATUS_MS });
  await expectPrompt(page);
  await blur(page);
  await page.keyboard.press('1');
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });

  const field = page.getByLabel('Follow up in this session…');
  await field.fill('Say hello');
  await field.press('Enter');
  await expect
    .poll(async () => (await lineTexts(page)).slice(-1), { timeout: STATUS_MS })
    .toEqual(['You said: Say hello']);
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });

  // A barrier, not a sleep: another session's ping comes 3 s after its prompt, later than any
  // hold the first session's moves could have started.
  await startTask(page, BARRIER_TASK, 'shop');
  await expectPrompt(page);
  await expect.poll(() => ntfy.received.length, { timeout: 6000 }).toBe(2);
  expect(bodies().map((b) => b.title)).toEqual(['demo needs you', 'shop needs you']);
  expect(bodies()[1]?.message).toBe(BARRIER_TASK);
  expect(h.serveOut).not.toContain(TOPIC);
});

test("opening a ping's link selects its session", async ({ page }) => {
  await page.goto('/');
  // Another session is selected first.
  await row(page, BARRIER_TASK).click({ timeout: STATUS_MS });
  await expect(page.locator('.k-it.on')).not.toHaveAttribute('data-id', waitId);
  const click = String(bodies()[0]?.click);
  await page.goto('about:blank');
  await page.goto(click);
  await expect(page.locator('.k-it.on')).toHaveAttribute('data-id', waitId, {
    timeout: STATUS_MS,
  });
  await expect(page.locator('.k-head .k-task')).toHaveText(WAIT_TASK);
  // The hash is dropped, so a reload doesn't follow it again.
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});

test('with ntfyOnDone, a long turn that finishes pings done', async ({ page }) => {
  // The config is read at start: write it again (through the harness's guard) and restart.
  await h.stopServe();
  h.writeConfig({ ntfyTopic: TOPIC, ntfyServer: ntfy.url, ntfyOnDone: true });
  await h.startServe();
  const before = ntfy.received.length;

  await page.goto('/');
  const id = await startTask(page, FLOOD_TASK, 'demo');
  await expect(chip(page)).toHaveText('running', { timeout: STATUS_MS });
  // The flood waits for Enter, then writes for about 4 s: longer than the 1 s threshold.
  await expect.poll(() => h.kageWindow(id), { timeout: STATUS_MS }).not.toBeNull();
  const win = await h.kageWindow(id);
  await h.tmux('send-keys', '-t', win?.paneId as string, 'Enter');
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });

  await expect.poll(() => ntfy.received.length, { timeout: 6000 }).toBe(before + 1);
  expect(bodies().at(-1)).toEqual({
    topic: TOPIC,
    title: 'demo is done',
    message: FLOOD_TASK,
    priority: 3,
    click: link(id),
  });
  expect(h.serveOut).not.toContain(TOPIC);
});
