import { expect, test } from '@playwright/test';
import { LIVE_BASE } from './env.ts';
import { hasTmux, LiveHarness, STATUS_MS } from './harness.ts';

/**
 * The board's browser notification end to end (W1, spec §5.9), on live `kage serve` with no
 * ntfy topic: a session moving into needs-you while the board has no focus shows one, with the
 * ping's title and body, from a lazy chunk the app's own CSP lets in.
 *
 * The full Chromium in its new headless mode, for this file only: the headless shell reports the
 * notification permission as denied whatever is granted, and keeps the page focused.
 */

test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');
test.describe.configure({ mode: 'serial', timeout: 90_000 });
// The app's CSP as shipped (the config bypasses it for the visual specs).
test.use({ channel: 'chromium', bypassCSP: false });

const BROWSER_TASK = 'needs-permission Rotate the keys';
const h = new LiveHarness();

test.beforeAll(async () => {
  await h.setUp();
  await h.startTmux('notify-browser');
  await h.startServe();
});

test.afterAll(async () => {
  await h.tearDown();
});

test.afterEach(async ({ page: _page }, info) => {
  await h.attachOnFailure(info);
});

test('a waiting session shows a notification while the board has no focus', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications'], { origin: LIVE_BASE });
  await page.addInitScript(() => {
    const w = window as unknown as {
      kageNotes: { title: string; body: string }[];
      cspViolations: string[];
      Notification: typeof Notification;
    };
    w.kageNotes = [];
    w.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    const Real = w.Notification;
    class Spy extends Real {
      constructor(title: string, o?: NotificationOptions) {
        w.kageNotes.push({ title, body: o?.body ?? '' });
        super(title, o);
      }
    }
    Object.defineProperty(Spy, 'permission', { get: () => Real.permission });
    w.Notification = Spy;
  });
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  await page.goto('/');
  await expect(page.locator('.k-host')).toContainText('my-pc');
  // 127.0.0.1 is a secure context: the board reads the granted permission.
  expect(await page.evaluate(() => [isSecureContext, Notification.permission])).toEqual([
    true,
    'granted',
  ]);
  const loaded = requested.length;

  // No focus: Playwright's focus emulation off, and another tab in front.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await context.newPage();
  await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);

  // Started by the API, so nothing on the board takes focus back.
  const res = await fetch(`${LIVE_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'X-Kage': '1', Origin: LIVE_BASE, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'demo',
      base: 'main',
      task: BROWSER_TASK,
      acceptEdits: false,
    }),
  });
  expect(res.status, await res.text()).toBe(201);

  const notes = () =>
    page.evaluate(() => (window as unknown as { kageNotes: unknown[] }).kageNotes);
  await expect
    .poll(notes, { timeout: STATUS_MS })
    .toEqual([{ title: 'demo needs you', body: BROWSER_TASK }]);
  // The text came from a chunk loaded only now, and the CSP let it in.
  expect(requested.slice(loaded).some((p) => /^\/chunk-\w+\.js$/.test(p))).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
  ).toEqual([]);
  await other.close();
});
