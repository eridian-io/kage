import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { LIVE_BASE, LIVE_PORT } from './env.ts';
import {
  blur,
  chip,
  closeCode,
  hasTmux,
  LiveHarness,
  lines,
  lineTexts,
  ownChips,
  rawUpgrade,
  recordChips,
  row,
  STATUS_MS,
  startTask,
} from './harness.ts';

/**
 * Phase 4 live: pin, the diff, delete with the warning, archive and restore, resume (and R63's
 * failed resume), auto-archive on merge, and the terminal on Kage's and external windows with its
 * upgrade guards. Real tmux, git and `kage serve`; the fake Claude (e2e/fake-claude.mjs) does the
 * commits. Each test starts the sessions it needs, so none depends on another's leftovers.
 */

test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');
test.describe.configure({ mode: 'serial', timeout: 90_000 });

/** A resumed session leaves "Starting Claude…" through the 10 s first-prompt fallback (F6). */
const RESUME_MS = 25_000;
const NBSP = / /g;

const h = new LiveHarness();
const { dirOf, tmux, git, kageWindow, newWindow } = h;

test.beforeAll(async () => {
  await h.setUp({ autoArchive: { onMerge: true, afterDays: 14 } });
  // The session's first window is Kage's placeholder (R22): tagged, so the board leaves it out.
  await h.startTmux('placeholder');
  await tmux('set-option', '-w', '-t', 'kage:placeholder', '@kage_placeholder', '1');
  await h.startServe();
});

test.afterAll(async () => {
  await h.tearDown();
});

test.afterEach(async ({ page: _page }, info) => {
  await h.attachOnFailure(info);
});

// ------------------------------------------------------------------ helpers

interface Rec {
  kageId: string;
  branch: string;
  worktree: string;
  pinned: boolean;
  archived: boolean;
  sessionId: string | null;
  unpinnedAt: number | null;
}

/** Kage's state.json records (null while the file is being replaced). */
function records(): Rec[] | null {
  try {
    return (
      JSON.parse(readFileSync(dirOf('state', 'kage', 'state.json'), 'utf8')) as { records: Rec[] }
    ).records;
  } catch {
    return null;
  }
}

const recordOf = (id: string): Rec | null => records()?.find((r) => r.kageId === id) ?? null;

function mustRecord(id: string): Rec {
  const r = recordOf(id);
  if (!r) throw new Error(`No record for ${id}`);
  return r;
}

/** Starts `task` from the board and waits for its turn to end; returns the session id. */
async function doneTask(
  page: Page,
  task: string,
  project: 'demo' | 'shop' = 'demo',
): Promise<string> {
  const id = await startTask(page, task, project);
  await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
  return id;
}

/** The ids of the done group's rows, in board order. */
const doneIds = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    let inDone = false;
    for (const el of document.querySelectorAll('.k-side > .k-g, .k-side > .k-it')) {
      if (el.classList.contains('k-g')) inDone = el.textContent === 'done';
      else if (inDone) out.push(el.getAttribute('data-id') ?? '');
    }
    return out;
  });

/** Both rows are in done, `id` below `other`. */
async function after(page: Page, id: string, other: string): Promise<boolean> {
  const ids = await doneIds(page);
  return ids.includes(other) && ids.indexOf(id) > ids.indexOf(other);
}

/** The number "archived N" shows; 0 while it is hidden. */
async function archivedCount(page: Page): Promise<number> {
  const b = page.locator('.k-arch > .k-g');
  if ((await b.count()) === 0) return 0;
  return Number(/archived (\d+)/.exec((await b.textContent()) ?? '')?.[1] ?? Number.NaN);
}

const branchExists = async (repo: string, branch: string) =>
  (await git(repo, 'branch', '--list', branch)).trim() !== '';

const capture = async (pane: string) =>
  (await tmux('capture-pane', '-p', '-t', pane)).stdout.replace(NBSP, ' ');

const windowSize = async (windowId: string) =>
  (await tmux('show-options', '-wqv', '-t', windowId, 'window-size')).stdout.trim();

/** Ends a Kage session's fake the way a person quits Claude: /exit, then Enter. */
async function quit(page: Page, id: string): Promise<void> {
  const win = await kageWindow(id);
  expect(win).not.toBeNull();
  await tmux('send-keys', '-t', win?.paneId as string, '-l', '/exit');
  await tmux('send-keys', '-t', win?.paneId as string, 'Enter');
  await expect(chip(page)).toHaveText('ended', { timeout: STATUS_MS });
}

/**
 * U on the selected session. Claude's SessionEnd ends the session a moment before its window
 * closes and Kage's next listing lets the window go; a U in between is refused ("This session
 * already has a window.", 409; B86). Transitions Task 0 found that order behind R63's failures
 * under load and on ubuntu-latest: then U is pressed again. A U that is taken shows no refusal.
 */
async function resume(page: Page): Promise<void> {
  const refused = page.locator('.k-err', { hasText: 'already has a window' });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('u');
    try {
      await expect(refused).toBeVisible({ timeout: 1000 });
    } catch {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('U was refused 20 times: Kage still lists the window');
}

/** The fake's session id for `task`, once its argv file is there. */
async function claudeSession(task: string): Promise<string> {
  await expect.poll(() => h.fakeSessionFor(task), { timeout: STATUS_MS }).not.toBeNull();
  return h.fakeSessionFor(task) as string;
}

/** The colour CSS gives `var(--name)`, as getComputedStyle reports colours. */
const tokenColour = (page: Page, name: string) =>
  page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.color = `var(${n})`;
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);

// ------------------------------------------------------------------ tests

test('S pins a done session to the top of done and records it; S again unpins (R69)', async ({
  page,
}) => {
  await page.goto('/');
  const first = await doneTask(page, 'edit-and-test Finish first');
  const task = 'edit-and-test Pin me';
  const id = await doneTask(page, task);
  // Unpinned, the session that finished first comes first.
  await expect.poll(() => after(page, id, first)).toBe(true);

  await blur(page);
  await page.keyboard.press('s');
  await expect(row(page, task).locator('.k-name')).toHaveText(/^★ /);
  await expect.poll(async () => (await doneIds(page))[0]).toBe(id);
  await expect(page.locator('.k-pin')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => recordOf(id)?.pinned).toBe(true);

  await page.keyboard.press('s');
  await expect(row(page, task).locator('.k-name')).not.toHaveText(/^★/);
  await expect(page.locator('.k-pin')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => recordOf(id)?.pinned).toBe(false);
  // R69: unpinning restarts the age clock.
  expect(typeof recordOf(id)?.unpinnedAt).toBe('number');
  await expect.poll(() => after(page, id, first)).toBe(true);
});

test('the diff view lists the changed files in the right column order, in the diff colours', async ({
  page,
}) => {
  await page.goto('/');
  await doneTask(page, 'commit-and-edit Write notes');
  const paths = ['README.md', 'notes.md', 'scratch.txt'];
  await expect(page.locator('.k-file .p')).toHaveText(paths, { timeout: STATUS_MS });

  await page.getByRole('button', { name: 'View diff →' }).click();
  await expect(page.locator('.k-diff-h .p')).toHaveText(paths, { timeout: STATUS_MS });
  const files = page.locator('.k-diff-file');
  const add = await tokenColour(page, '--add');
  const del = await tokenColour(page, '--del');
  // README.md: one line changed, a − and a + line.
  await expect(files.nth(0).locator('.k-dl.del')).toHaveCount(1);
  await expect(files.nth(0).locator('.k-dl.del')).toHaveText('−A sample project for the live e2e.');
  await expect(files.nth(0).locator('.k-dl.add')).toHaveCount(1);
  await expect(files.nth(0).locator('.k-dl.add')).toHaveText('+A sample project with notes.');
  expect(
    await files
      .nth(0)
      .locator('.k-dl.del')
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe(del);
  // notes.md (committed) and scratch.txt (untracked): only + lines, in the add colour.
  for (const n of [1, 2]) {
    await expect(files.nth(n).locator('.k-dl.del')).toHaveCount(0);
    expect(await files.nth(n).locator('.k-dl.add').count()).toBeGreaterThan(0);
    await expect(files.nth(n).locator('.k-dl.add .g').first()).toHaveText('+');
    expect(
      await files
        .nth(n)
        .locator('.k-dl.add')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe(add);
  }
  await expect(files.nth(2).locator('.k-dl.add')).toHaveText(['+A scratch line.']);

  await page.keyboard.press('Escape');
  await expect(page.locator('.k-dv')).toHaveCount(0);
  await expect(lines(page).last()).toHaveText(
    'The notes are committed; README.md and scratch.txt are not.',
  );
});

test('Delete warns about unpushed, uncommitted and ignored work, refuses changed counts, then removes it all', async ({
  page,
}) => {
  const repo = dirOf('projects/shop');
  // A branch of the user's: delete never touches it.
  await git(repo, 'branch', 'feature/keep');
  // .env is ignored in every worktree of the repo (info/exclude is shared).
  mkdirSync(join(repo, '.git/info'), { recursive: true });
  appendFileSync(join(repo, '.git/info/exclude'), '\n.env\n');

  await page.goto('/');
  const task = 'commit-and-edit Delete me';
  const id = await doneTask(page, task, 'shop');
  const { worktree, branch } = mustRecord(id);
  expect(existsSync(worktree)).toBe(true);
  writeFileSync(join(worktree, '.env'), 'TOKEN=invented-for-the-e2e\n');
  // Viewing the session again counts again: the reload brings the ignored file in.
  await page.reload();
  await row(page, task).click({ timeout: STATUS_MS });

  await page.getByRole('button', { name: 'Delete…' }).click();
  const warn = page.locator('.k-confirm .warn');
  await expect(warn).toHaveText(
    '1 commit isn’t pushed and will be lost. 2 files have uncommitted changes and will be lost. 1 ignored file (like .env) will be deleted too.',
    { timeout: STATUS_MS },
  );

  // A file appears after the confirmation was drawn. Viewing the session again recounts, so the
  // board shows the new counts before anything is sent.
  writeFileSync(join(worktree, 'extra.txt'), 'One more invented line.\n');
  await page.reload();
  await row(page, task).click({ timeout: STATUS_MS });
  await page.getByRole('button', { name: 'Delete…' }).click();
  await expect(warn).toContainText('3 files have uncommitted changes and will be lost.', {
    timeout: STATUS_MS,
  });

  // The counts the first confirmation showed are refused (B10), and nothing is removed.
  const stale = await page.request.delete(`${LIVE_BASE}/api/sessions/${encodeURIComponent(id)}`, {
    headers: { 'X-Kage': '1', Origin: LIVE_BASE, 'Content-Type': 'application/json' },
    data: { unpushed: 1, uncommitted: 2, ignored: 1 },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toEqual({
    error: 'The branch changed since you looked. Look again before deleting.',
  });
  expect(existsSync(worktree)).toBe(true);
  expect(await kageWindow(id)).not.toBeNull();

  // The board's confirmation, with the fresh counts, deletes. A click right after the counts
  // changed is held for 400 ms (FRESH_MS), so wait for it to be enabled.
  const confirm = page.getByRole('button', { name: 'Delete session' });
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true', { timeout: STATUS_MS });
  await confirm.click();
  await expect(page.locator('.k-toast')).toHaveText(
    new RegExp(`^Deleted .*${task}.* · worktree and branch removed$`),
    {
      timeout: STATUS_MS,
    },
  );
  await expect(row(page, task)).toHaveCount(0);
  await expect.poll(() => existsSync(worktree)).toBe(false);
  expect(await branchExists(repo, branch)).toBe(false);
  await expect.poll(() => kageWindow(id)).toBeNull();
  await expect.poll(() => records()?.some((r) => r.kageId === id)).toBe(false);
  expect(await branchExists(repo, 'feature/keep')).toBe(true);
});

test('E archives a done session, keeping its worktree and branch; Restore brings it back ended', async ({
  page,
}) => {
  await page.goto('/');
  const task = 'edit-and-test Archive me';
  const id = await doneTask(page, task);
  const { worktree, branch } = mustRecord(id);
  expect(await kageWindow(id)).not.toBeNull();
  const before = await archivedCount(page);

  await blur(page);
  await page.keyboard.press('e');
  await expect(page.locator('.k-toast')).toHaveText(
    new RegExp(`^Archived .*${task}.* · worktree and branch kept$`),
    {
      timeout: STATUS_MS,
    },
  );
  await expect(row(page, task)).toHaveCount(0);
  await expect(page.locator('.k-arch > .k-g')).toHaveText(`archived ${before + 1}`);
  await expect.poll(() => kageWindow(id)).toBeNull();
  expect(existsSync(worktree)).toBe(true);
  expect(await branchExists(dirOf('projects/demo'), branch)).toBe(true);
  await expect.poll(() => recordOf(id)?.archived).toBe(true);

  await page.locator('.k-arch > .k-g').click();
  await page.getByRole('button', { name: `Restore demo / ${task}` }).click();
  await expect(page.locator('.k-it.on')).toHaveAttribute('data-id', id, { timeout: STATUS_MS });
  await expect(chip(page)).toHaveText('ended');
  await expect(page.locator('.k-foot').getByRole('button', { name: /Resume/ })).toBeVisible();
  await expect.poll(() => recordOf(id)?.archived).toBe(false);
});

test('U resumes an ended session with --resume and its session id, in a window tagged with its id', async ({
  page,
}) => {
  await page.goto('/');
  const task = 'edit-and-test Resume me';
  const id = await doneTask(page, task);
  const sid = await claudeSession(task);
  await quit(page, id);
  await expect.poll(() => kageWindow(id)).toBeNull();
  await expect(page.locator('.k-foot').getByRole('button', { name: /Resume/ })).toBeVisible();

  const chips = await recordChips(page);
  await blur(page);
  await resume(page);
  await expect(chip(page)).toHaveText('done', { timeout: RESUME_MS });
  const own = ownChips(await chips(), task);
  expect(own).toContain(`${task}: running`);
  expect(own.indexOf(`${task}: running`)).toBeLessThan(own.lastIndexOf(`${task}: done`));

  const argv = JSON.parse(readFileSync(dirOf('claude', `argv-${sid}.json`), 'utf8')) as string[];
  expect(argv.slice(-2)).toEqual(['--resume', sid]);
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default');
  expect(await kageWindow(id)).not.toBeNull();
  expect(mustRecord(id).sessionId).toBe(sid);
});

test("a resume Claude can't find (R63) ends the session again, says so, and keeps its session id", async ({
  page,
}) => {
  await page.goto('/');
  const task = 'edit-and-test Lost conversation';
  const id = await doneTask(page, task);
  const sid = await claudeSession(task);
  await quit(page, id);
  // Claude would find no conversation with this id any more.
  rmSync(dirOf('claude', `${sid}.jsonl`));

  const chips = await recordChips(page);
  await blur(page);
  await resume(page);
  // The resume ran: the line comes from the failed resume's SessionEnd.
  await expect(lines(page).last()).toHaveText(
    "Claude couldn't find this conversation, so the session wasn't resumed.",
    { timeout: STATUS_MS },
  );
  await expect(chip(page)).toHaveText('ended');
  // Running (Starting Claude…) may come and go between two renders; it never ends anywhere else.
  const own = ownChips(await chips(), task);
  expect(own[0]).toBe(`${task}: ended`);
  expect(own.at(-1)).toBe(`${task}: ended`);
  expect(own.every((c) => c === `${task}: ended` || c === `${task}: running`)).toBe(true);
  await expect.poll(() => kageWindow(id)).toBeNull();
  expect(mustRecord(id).sessionId).toBe(sid);
  await expect(page.locator('.k-foot').getByRole('button', { name: /Resume/ })).toBeVisible();
});

test('a merged branch is archived on its own within 15 s; a pinned one stays', async ({ page }) => {
  await page.goto('/');
  const keep = 'commit-only Keep this';
  const keepId = await doneTask(page, keep);
  await blur(page);
  await page.keyboard.press('s');
  await expect.poll(() => recordOf(keepId)?.pinned).toBe(true);
  const task = 'commit-only Add changelog';
  const id = await doneTask(page, task);
  expect(mustRecord(id).branch).toBe('kage/commit-only-add-changelog');
  const before = await archivedCount(page);

  const repo = dirOf('projects/demo');
  await git(repo, 'merge', '--no-ff', '-q', '-m', 'merge', 'kage/commit-only-add-changelog');
  await git(repo, 'merge', '--no-ff', '-q', '-m', 'merge', mustRecord(keepId).branch);
  await expect(row(page, task)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.k-arch > .k-g')).toHaveText(`archived ${before + 1}`);
  await expect.poll(() => recordOf(id)?.archived).toBe(true);
  await expect.poll(() => kageWindow(id)).toBeNull();
  // The pinned one was looked at in the same pass, and stays.
  await expect(row(page, keep)).toHaveCount(1);
  expect(recordOf(keepId)?.archived).toBe(false);
});

test("T opens a live terminal on Kage's window: typing reaches Claude, the size follows, Shift+Esc restores it", async ({
  page,
}) => {
  const termScripts: string[] = [];
  page.on('request', (r) => {
    if (/\/term-[^/]+\.js$/.test(new URL(r.url()).pathname)) termScripts.push(r.url());
  });
  // xterm's size as the page and the server last agreed it: the URL, size frames, resets.
  let cols = 0;
  page.on('websocket', (ws) => {
    const q = new URL(ws.url()).searchParams.get('cols');
    if (q) cols = Number(q);
    const take = (payload: string | Buffer) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload) as { t: string; cols?: number };
      if ((m.t === 'size' || m.t === 'reset') && typeof m.cols === 'number') cols = m.cols;
    };
    ws.on('framesent', (f) => take(f.payload));
    ws.on('framereceived', (f) => take(f.payload));
  });
  await page.goto('/');
  const task = 'edit-and-test Open a terminal';
  const id = await doneTask(page, task);
  const win = await kageWindow(id);
  if (!win) throw new Error('no window');
  expect(termScripts).toEqual([]);
  expect(await windowSize(win.windowId)).toBe('');

  await blur(page);
  await page.keyboard.press('t');
  await expect(page.locator('.xterm')).toBeVisible({ timeout: STATUS_MS });
  await expect(page.locator('.k-foot .k-act', { hasText: 'Back to session' })).toHaveText(
    'Back to session⇧Esc',
  );
  await expect(
    page.locator('.k-foot .k-act', { hasText: 'Back to session' }).locator('kbd'),
  ).toHaveText('⇧Esc');
  await expect(page.locator('.k-foot .k-hint')).toHaveText('Shift+Esc (or Ctrl+Shift+X) to leave');
  // The snapshot shows Claude's idle box.
  await expect(page.locator('.xterm-rows')).toContainText('❯', { timeout: STATUS_MS });
  expect(termScripts).toHaveLength(1);
  // F13: while a terminal has the window sized, window-size is `manual` (host-integration §4.4).
  await expect.poll(() => windowSize(win.windowId)).toBe('manual');

  await page.keyboard.type('hello');
  await expect.poll(() => capture(win.paneId), { timeout: STATUS_MS }).toContain('❯ hello');
  await expect(page.locator('.xterm-rows')).toContainText('hello');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('You said: hello', {
    timeout: STATUS_MS,
  });

  const was = cols;
  expect(was).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(() => cols, { timeout: 2000 }).not.toBe(was);
  // One comparison per poll: xterm may settle on a second size while it is checked.
  const width = async () =>
    Number(
      (await tmux('display-message', '-p', '-t', win.windowId, '#{window_width}')).stdout.trim(),
    );
  await expect.poll(async () => (await width()) - cols, { timeout: 2000 }).toBe(0);
  expect(await windowSize(win.windowId)).toBe('manual');

  await page.keyboard.press('Shift+Escape');
  await expect(page.locator('.xterm')).toHaveCount(0);
  await expect
    .poll(async () => (await lineTexts(page)).slice(-2), { timeout: STATUS_MS })
    .toEqual(['> hello', 'You said: hello']);
  // The restore unsets the option: back to the empty string (host-integration §4.4, F13).
  await expect.poll(() => windowSize(win.windowId), { timeout: STATUS_MS }).toBe('');
  expect(termScripts).toHaveLength(1);
});

test('T on an external window is view only: nothing typed reaches its pane, and it is never resized', async ({
  page,
}) => {
  // The board's own socket (the first one); the test opens a second one by hand below.
  const sentIn: string[] = [];
  let board: unknown = null;
  page.on('websocket', (ws) => {
    board ??= ws;
    ws.on('framesent', (f) => {
      if (ws === board && typeof f.payload === 'string' && f.payload.includes('"t":"in"')) {
        sentIn.push(f.payload);
      }
    });
  });
  await page.goto('/');
  const pane = await newWindow('ext-term', dirOf('projects/shop'), 'sh');
  await expect(row(page, 'ext-term')).toContainText('external', { timeout: STATUS_MS });
  const extId = (await row(page, 'ext-term').getAttribute('data-id')) as string;
  const windowId = (await tmux('display-message', '-p', '-t', pane, '#{window_id}')).stdout.trim();
  await row(page, 'ext-term').click();

  await blur(page);
  await page.keyboard.press('t');
  await expect(page.locator('.xterm')).toBeVisible({ timeout: STATUS_MS });
  await expect(page.locator('.k-term-ro')).toHaveText(
    "View only: Kage didn't start this window, so it doesn't type into it.",
    { timeout: STATUS_MS },
  );
  // The shell's prompt (`#` as root in the container).
  await expect(page.locator('.xterm-rows')).toContainText(/[$#]/, { timeout: STATUS_MS });
  await page.keyboard.type('echo hi');
  await page.keyboard.press('Enter');

  // The server drops input and sizes too (R54): the same frames sent by hand on a second socket.
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://${location.host}/api/sessions/${encodeURIComponent(id)}/terminal`,
          'kage.term.v1',
        );
        (window as unknown as { rawTerm: WebSocket }).rawTerm = ws;
        ws.onerror = () => reject(new Error('socket error'));
        ws.onmessage = (e) => {
          if (typeof e.data !== 'string' || (JSON.parse(e.data) as { t: string }).t !== 'reset')
            return;
          ws.send(JSON.stringify({ t: 'in', d: 'echo raw\r' }));
          ws.send(JSON.stringify({ t: 'size', cols: 50, rows: 12 }));
          resolve();
        };
      }),
    extId,
  );
  // A marker typed through tmux itself runs after anything that reached the pane before it.
  await tmux('send-keys', '-t', pane, '-l', 'echo mark-$((40+2))');
  await tmux('send-keys', '-t', pane, 'Enter');
  await expect.poll(() => capture(pane), { timeout: STATUS_MS }).toMatch(/^mark-42$/m);
  const text = await capture(pane);
  expect(text).not.toContain('echo hi');
  expect(text).not.toContain('echo raw');
  expect(sentIn).toEqual([]);
  expect(await windowSize(windowId)).toBe('');

  await page.evaluate(() => (window as unknown as { rawTerm: WebSocket }).rawTerm.close());
  await page.keyboard.press('Control+Shift+X');
  await expect(page.locator('.xterm')).toHaveCount(0);
});

test('the terminal upgrade refuses a foreign or missing Origin and a missing subprotocol', async ({
  page,
}) => {
  await page.goto('/');
  await newWindow('ext-guard', dirOf('projects/shop'), 'sh');
  await expect(row(page, 'ext-guard')).toHaveCount(1, { timeout: STATUS_MS });
  const id = (await row(page, 'ext-guard').getAttribute('data-id')) as string;
  const path = `/api/sessions/${encodeURIComponent(id)}/terminal`;
  const proto = { 'Sec-WebSocket-Protocol': 'kage.term.v1' };

  expect(
    (await rawUpgrade(LIVE_PORT, path, { Origin: 'http://evil.example', ...proto })).status,
  ).toBe(403);
  expect((await rawUpgrade(LIVE_PORT, path, proto)).status).toBe(403);
  expect((await rawUpgrade(LIVE_PORT, path, { Origin: LIVE_BASE })).status).toBe(400);
  const good = await rawUpgrade(LIVE_PORT, path, { Origin: LIVE_BASE, ...proto });
  expect(good.status).toBe(101);
  // The first frame is the reset: this external window is view only.
  expect(good.frame?.opcode).toBe(1);
  expect(JSON.parse(good.frame?.data.toString('utf8') ?? '{}')).toMatchObject({
    t: 'reset',
    mode: 'ro',
  });
  expect(closeCode(good.frame)).toBeNull();
});
