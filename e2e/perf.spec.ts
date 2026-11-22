import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, request } from 'node:http';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { measureSizes, SIZE_LIMITS } from '../packages/web/sizes.ts';
import { median, percentile, readBudgets, recordBudget } from './budgets.ts';
import { PERF_BASE, PERF_PORT } from './env.ts';
import { chip, hasTmux, LiveHarness, ROOT, row, STATUS_MS, startTask } from './harness.ts';

/**
 * The budgets of spec §7, each through recordBudget (test-results/budgets.json). A budget that
 * fails today carries `allowFail: '<owning task>'` (ruling PF5, F5); the owning task removes it.
 * The definitions are Task 1's rules in the phase 5 plan (Task 11 copies them into §7):
 * - sizes, read from packages/web/dist with the limits build.test.ts uses (packages/web/sizes.ts);
 * - time to a usable board: the `kage:board` mark, fresh context, tailnet LAN emulation, median
 *   of 5 against live mode with 10 sessions;
 * - hook to screen: the test's clock before the hook's socket write to a MutationObserver's
 *   clock at the row's change, p95 of 40 (F8); `kage hook`'s own wall time is an annotation;
 * - idle server: 10 done sessions, no page or stream, 10 s settle, 30 s measured (Linux /proc);
 * - rendering: the DOM cap and line identity under a 2,000-line flood, and a 3,000-line diff;
 * - SSE under load: 30 windows writing transcript records and posting tool hooks, frames and
 *   bytes counted over the 10 s burst.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIST = join(ROOT, 'packages/web/dist');

/** One transcript line in Claude's record format (as e2e/fake-claude.mjs writes them). */
const transcriptRecord = (sessionId: string, cwd: string, record: Record<string, unknown>) =>
  `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    ...record,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.330',
  })}\n`;

test('sizes: first load, the terminal chunk and loader, the fonts (packages/web/dist)', async () => {
  test.skip(!existsSync(join(DIST, 'index.html')), 'Needs the web build (corepack pnpm build)');
  const s = await measureSizes(DIST);
  recordBudget({
    name: 'First load (gzipped)',
    value: s.firstLoad,
    limit: SIZE_LIMITS.firstLoad,
    unit: 'B',
  });
  recordBudget({
    name: 'Terminal chunk (gzipped)',
    value: s.termChunk,
    limit: SIZE_LIMITS.termChunk,
    unit: 'B',
  });
  recordBudget({
    name: 'Terminal loader (gzipped)',
    value: s.termLoader,
    limit: SIZE_LIMITS.termLoader,
    unit: 'B',
  });
  recordBudget(
    { name: 'Fonts (woff2)', value: s.fonts, limit: SIZE_LIMITS.fonts, unit: 'B' },
    { allowFail: 'Task 3' },
  );
});

test.afterAll(() => {
  const rows = readBudgets();
  if (rows.length === 0) return;
  // The Docker run keeps only the log: the whole table, once.
  console.log(
    [
      'budgets.json:',
      ...rows.map(
        (r) =>
          `  ${r.pass ? 'pass' : 'FAIL'}  ${r.name}: ${r.value} ${r.unit} (limit ${r.limit})${r.allowFail ? ` [allowFail ${r.allowFail}]` : ''}`,
      ),
    ].join('\n'),
  );
});

// ------------------------------------------------------------------ live

/** The fields of a session the perf spec reads from the event stream. */
interface Seen {
  id: string;
  task: string;
  status: string;
}

/**
 * A Node reader on /api/events: the latest session fields by id, and from reset() on, the
 * session.updated frames per id and the bytes received.
 */
function sseReader(base: string) {
  const sessions = new Map<string, Seen>();
  const updated = new Map<string, number>();
  let bytes = 0;
  let buf = '';
  let res: IncomingMessage | null = null;
  const req = request(`${base}/api/events`, (r) => {
    res = r;
    r.setEncoding('utf8');
    r.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      buf += chunk;
      for (let at = buf.indexOf('\n\n'); at >= 0; at = buf.indexOf('\n\n')) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const type = /^event: ?(.*)$/m.exec(frame)?.[1];
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.replace(/^data: ?/, ''))
          .join('\n');
        if (!type || !data) continue;
        const e = JSON.parse(data) as { sessions?: Seen[]; session?: Seen };
        if (type === 'snapshot') for (const s of e.sessions ?? []) sessions.set(s.id, s);
        if (type === 'session.updated' && e.session) {
          sessions.set(e.session.id, e.session);
          updated.set(e.session.id, (updated.get(e.session.id) ?? 0) + 1);
        }
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    sessions,
    updated,
    bytes: () => bytes,
    reset: () => {
      updated.clear();
      bytes = 0;
    },
    close: () => {
      (res as IncomingMessage | null)?.destroy();
      req.destroy();
    },
  };
}

/** The sessions of one snapshot, read on a stream that closes right after it. */
async function snapshot(): Promise<Seen[]> {
  const r = sseReader(PERF_BASE);
  try {
    await expect.poll(() => r.sessions.size > 0 || null, { timeout: 5000 }).toBe(true);
    return [...r.sessions.values()];
  } catch {
    return [];
  } finally {
    r.close();
  }
}

/** The row's status as the board shows it: its group heading, and the needs-you line. */
const rowStatus = (page: Page, id: string) =>
  page.evaluate(
    (i) => (window as unknown as { statusInPage: (id: string) => string | null }).statusInPage(i),
    id,
  );

/** Installs statusInPage and kageArm/kageHit in the page (hook to screen). */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const status = (id: string): string | null => {
      const el = document.querySelector(`.k-it[data-id="${id}"]`);
      if (!el) return null;
      let p = el.previousElementSibling;
      while (p && !p.classList.contains('k-g')) p = p.previousElementSibling;
      const g = p?.textContent ?? '';
      return el.querySelector('.w') ? `${g}+w` : g;
    };
    w.statusInPage = status;
    let want: { id: string; status: string } | null = null;
    w.kageArm = (id: string, s: string) => {
      want = { id, status: s };
      w.kageHit = null;
    };
    new MutationObserver(() => {
      if (want && status(want.id) === want.status) {
        w.kageHit = performance.timeOrigin + performance.now();
        want = null;
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
}

test.describe('live budgets', () => {
  test.skip(!hasTmux(), 'Live sessions need tmux (Linux or macOS)');

  const h = new LiveHarness(PERF_PORT);
  const { dirOf, tmux, newWindow, postHook } = h;
  const IDLE = Array.from({ length: 10 }, (_, i) => `idle-${i + 1}`);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await h.setUp();
    // Short steps: ten fakes reach their idle box quickly. Kage reads the same hooks either way.
    h.env.FAKE_CLAUDE_STEP_MS = '200';
    await h.startTmux('placeholder');
    await tmux('set-option', '-w', '-t', 'kage:placeholder', '@kage_placeholder', '1');
    await h.startServe();
    // One after another, so ten Node starts and their hook processes don't pile up at once.
    for (const [i, name] of IDLE.entries()) {
      await h.startFake(name, dirOf(i % 2 ? 'projects/shop' : 'projects/demo'), 'edit-and-test');
      await sleep(400);
    }
    await expect
      .poll(
        async () =>
          (await snapshot()).filter((s) => IDLE.includes(s.task) && s.status === 'done').length,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(10);
  });

  test.afterAll(async () => {
    await h.tearDown();
  });

  test.afterEach(async ({ page: _page }, info) => {
    await h.attachOnFailure(info);
  });

  test('idle server: CPU and RSS with 10 done sessions and no page or stream open', async () => {
    test.skip(!existsSync('/proc/self/stat'), 'Reads /proc/<pid>: Linux only');
    test.setTimeout(90_000);
    await sleep(10_000);
    const cpu0 = h.serveCpuMs();
    const t0 = performance.now();
    await sleep(30_000);
    const cpu = ((h.serveCpuMs() - cpu0) / (performance.now() - t0)) * 100;
    recordBudget({ name: 'Idle server CPU (30 s)', value: cpu, limit: 1, unit: '%' });
    recordBudget(
      { name: 'Idle server RSS', value: h.serveRss(), limit: 80, unit: 'MB' },
      { allowFail: 'Task 4' },
    );
  });

  test('time to a usable board: median of 5 fresh loads on a tailnet LAN', async ({ browser }) => {
    test.setTimeout(60_000);
    const times: number[] = [];
    let termBytes = 0;
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext({
        baseURL: PERF_BASE,
        viewport: { width: 1320, height: 900 },
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      // A tailnet LAN: 10 ms latency, 50 Mbit/s down, 20 Mbit/s up (bytes per second).
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 10,
        downloadThroughput: 50_000_000 / 8,
        uploadThroughput: 20_000_000 / 8,
      });
      page.on('response', async (r) => {
        if (/\/term-/.test(new URL(r.url()).pathname))
          termBytes += (await r.body().catch(() => Buffer.alloc(1))).length;
      });
      await page.goto('/');
      const at = await page.waitForFunction(
        () => performance.getEntriesByName('kage:board')[0]?.startTime,
      );
      times.push((await at.jsonValue()) as number);
      await expect(page.locator('.k-it')).toHaveCount(10);
      await ctx.close();
    }
    console.log(`board times: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
    recordBudget({
      name: 'Time to a usable board (median of 5)',
      value: median(times),
      limit: 300,
      unit: 'ms',
    });
    // The terminal is loaded only on demand (§7): nothing of it at load.
    recordBudget({ name: 'Terminal chunk fetched at load', value: termBytes, limit: 0, unit: 'B' });
  });

  test('hook to screen: p95 of 40 status changes; kage hook wall time noted', async ({ page }) => {
    test.setTimeout(90_000);
    const cwd = dirOf('projects/demo');
    const pane = await newWindow('hook-probe', cwd, 'exec sleep 3600');
    const sid = randomUUID();
    const body = (event: string, extra: Record<string, unknown> = {}) => ({
      session_id: sid,
      cwd,
      hook_event_name: event,
      ...extra,
    });
    const tool = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
    await page.goto('/');
    await installProbe(page);
    await postHook('PostToolUse', body('PostToolUse', tool), pane);
    await expect(row(page, 'hook-probe')).toHaveCount(1, { timeout: STATUS_MS });
    const id = (await row(page, 'hook-probe').getAttribute('data-id')) as string;
    await expect.poll(() => rowStatus(page, id), { timeout: STATUS_MS }).toBe('running');

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      // Alternating: PermissionRequest to needs you, PostToolUse back to running (R7).
      const [event, want] =
        i % 2 === 0 ? ['PermissionRequest', 'needs you+w'] : ['PostToolUse', 'running'];
      await page.evaluate(
        ([i2, s]) =>
          (window as unknown as { kageArm: (a: string, b: string) => void }).kageArm(
            i2 as string,
            s as string,
          ),
        [id, want],
      );
      const t0 = Date.now();
      await postHook(event as string, body(event as string, tool), pane);
      const hit = await page.waitForFunction(
        () => (window as unknown as { kageHit: number | null }).kageHit,
        null,
        {
          timeout: STATUS_MS,
        },
      );
      samples.push(((await hit.jsonValue()) as number) - t0);
      await sleep(50);
    }
    console.log(`hook to screen: ${samples.map((t) => t.toFixed(0)).join(', ')} ms`);
    recordBudget({
      name: 'Hook to screen (p95 of 40)',
      value: percentile(samples, 95),
      limit: 150,
      unit: 'ms',
    });

    // `kage hook`'s own wall time, spawn to exit: reported, not asserted (phase 6's single
    // executable owns it; ruling PF5, F5).
    const walls: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await new Promise<void>((resolve, reject) => {
        const c = spawn(
          process.execPath,
          ['--no-warnings', 'packages/server/src/main.ts', 'hook', 'PostToolUse'],
          {
            cwd: ROOT,
            env: { ...h.env, TMUX_PANE: pane },
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        );
        c.once('error', reject);
        c.once('exit', () => resolve());
        c.stdin.end(JSON.stringify(body('PostToolUse', tool)));
      });
      walls.push(performance.now() - t);
    }
    const wall = median(walls);
    const note = `kage hook wall time: median of 10 = ${wall.toFixed(0)} ms (limit 300 ms; reported, not asserted)`;
    console.log(note);
    test.info().annotations.push({ type: 'budget (not asserted)', description: note });
  });

  /** The idle fakes have served their budgets; their Node processes go before the heavy tests. */
  const freeIdle = async () => {
    for (const name of IDLE) await tmux('kill-window', '-t', `kage:${name}`).catch(() => {});
  };

  test('rendering: at most 500 line nodes and stable line elements under a 2,000-line flood', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await freeIdle();
    const pane = await h.startFake('flood-view', dirOf('projects/demo'), 'flood');
    await page.goto('/');
    await row(page, 'flood-view').click();
    await expect(chip(page)).toHaveText('running', { timeout: STATUS_MS });
    await page.evaluate(() => {
      const w = window as unknown as {
        kageMax: number;
        kageSampler: ReturnType<typeof setInterval>;
      };
      w.kageMax = 0;
      // Every 100 ms; the think ("now") line counts too (ruling PF5, F13).
      w.kageSampler = setInterval(() => {
        w.kageMax = Math.max(w.kageMax, document.querySelectorAll('.k-tr .ln').length);
      }, 100);
    });
    await tmux('send-keys', '-t', pane, 'Enter');

    const lastN = () =>
      page.evaluate(() => {
        const say = [...document.querySelectorAll('.k-tr .ln-say')].at(-1)?.textContent ?? '';
        return Number(/^Flood line (\d+)$/.exec(say)?.[1] ?? 0);
      });
    // Mark a line that stays on screen; after 200 more it must be the same element.
    await expect.poll(lastN, { timeout: STATUS_MS }).toBeGreaterThanOrEqual(300);
    const probe = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.k-tr .ln-say')].at(-1) as HTMLElement;
      el.dataset.probe = '1';
      return el.textContent ?? '';
    });
    const n = Number(/(\d+)$/.exec(probe)?.[1]);
    await expect.poll(lastN, { timeout: STATUS_MS }).toBeGreaterThanOrEqual(n + 200);
    await expect(page.locator('.k-tr .ln', { hasText: new RegExp(`^${probe}$`) })).toHaveCount(1);
    const kept = await page.locator('.k-tr .ln[data-probe]').allTextContents();

    await expect(chip(page)).toHaveText('done', { timeout: 30_000 });
    const max = await page.evaluate(() => {
      const w = window as unknown as {
        kageMax: number;
        kageSampler: ReturnType<typeof setInterval>;
      };
      clearInterval(w.kageSampler);
      return Math.max(w.kageMax, document.querySelectorAll('.k-tr .ln').length);
    });
    recordBudget({
      name: 'Output line nodes under a flood (max)',
      value: max,
      limit: 500,
      unit: 'nodes',
    });
    recordBudget({
      name: 'Output lines re-created after 200 more (probe)',
      value: kept.length === 1 && kept[0] === probe ? 0 : 1,
      limit: 0,
      unit: 'nodes',
    });
  });

  test('rendering: a 3,000-line change shows at most 1,000 diff line elements', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await freeIdle();
    await page.goto('/');
    const id = await startTask(page, 'commit-only Big diff', 'demo');
    await expect(chip(page)).toHaveText('done', { timeout: STATUS_MS });
    const state = JSON.parse(readFileSync(dirOf('state', 'kage', 'state.json'), 'utf8')) as {
      records: { kageId: string; worktree: string }[];
    };
    const worktree = state.records.find((r) => r.kageId === id)?.worktree as string;
    const big = Array.from({ length: 3000 }, (_, i) => `Invented line ${i + 1}`).join('\n');
    writeFileSync(join(worktree, 'big.txt'), `${big}\n`);
    await h.git(worktree, 'add', 'big.txt');
    await h.git(
      worktree,
      '-c',
      'user.name=Fake',
      '-c',
      'user.email=fake@example.invalid',
      'commit',
      '-q',
      '-m',
      'Add big.txt',
    );
    await page.getByRole('button', { name: 'View diff →' }).click();
    await expect(page.locator('.k-diff-h .p', { hasText: 'big.txt' })).toHaveCount(1, {
      timeout: STATUS_MS,
    });
    const count = await page.locator('.k-dv .k-dl').count();
    // It measured a real page of the change, not an empty one.
    expect(count).toBeGreaterThan(500);
    recordBudget({
      name: 'Diff line elements (3,000-line change)',
      value: count,
      limit: 1000,
      unit: 'nodes',
    });
  });

  test('SSE under load: 30 sessions posting tool hooks for 10 s', async ({ page }) => {
    test.setTimeout(120_000);
    await freeIdle();
    const cwd = dirOf('projects/demo');
    const names = Array.from({ length: 30 }, (_, i) => `busy-${i + 1}`);
    const panes: string[] = [];
    for (const name of names) panes.push(await newWindow(name, cwd, 'exec sleep 3600'));
    const sids = names.map(() => randomUUID());
    const transcripts = names.map((_, i) => dirOf('claude', `perf-${i}.jsonl`));
    for (const t of transcripts) writeFileSync(t, '');
    /**
     * As Claude does it: the transcript record first (tool_use before PreToolUse, tool_result
     * before PostToolUse), then the hook. The records move each session's now line, so the burst
     * drives the activity path that the 4-a-second rule bounds; hooks alone change no visible
     * field, and Kage sends nothing for them.
     */
    const hook = (i: number, event: string, n: number) => {
      const sid = sids[i] as string;
      const id = `toolu_perf_${i}_${n}`;
      const command = `npm run step-${n}`;
      appendFileSync(
        transcripts[i] as string,
        event === 'PreToolUse'
          ? transcriptRecord(sid, cwd, {
              type: 'assistant',
              message: {
                model: 'claude-opus-5-5',
                id: `msg_${id}`,
                type: 'message',
                role: 'assistant',
                content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
                stop_reason: 'tool_use',
                stop_sequence: null,
                usage: { input_tokens: 2, output_tokens: 40 },
              },
            })
          : transcriptRecord(sid, cwd, {
              type: 'user',
              message: {
                role: 'user',
                content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }],
              },
              toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
            }),
      );
      return postHook(
        event,
        {
          session_id: sid,
          transcript_path: transcripts[i],
          cwd,
          hook_event_name: event,
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: id,
        },
        panes[i] as string,
      );
    };
    const reader = sseReader(PERF_BASE);
    try {
      // Step 1's check: hooks posted from a `sleep` pane link to its window (each turns running).
      await Promise.all(names.map((_, i) => hook(i, 'PreToolUse', 0)));
      const running = () =>
        [...reader.sessions.values()].filter(
          (s) => names.includes(s.task) && s.status === 'running',
        ).length;
      await expect.poll(running, { timeout: STATUS_MS }).toBe(30);

      await page.goto('/');
      await expect(page.locator('.k-it')).not.toHaveCount(0);
      await page.evaluate(() => {
        const w = window as unknown as { kageLong: number };
        w.kageLong = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.kageLong = Math.max(w.kageLong, e.duration);
        }).observe({ type: 'longtask' });
      });

      // 10 pairs per second per session: each 100 ms tick posts PreToolUse then PostToolUse.
      reader.reset();
      const start = performance.now();
      const posts: Promise<void>[] = [];
      for (let k = 1; k <= 100; k++) {
        const wait = start + (k - 1) * 100 - performance.now();
        if (wait > 0) await sleep(wait);
        for (let i = 0; i < names.length; i++) {
          posts.push(hook(i, 'PreToolUse', k).then(() => hook(i, 'PostToolUse', k)));
        }
      }
      await Promise.all(posts);
      // The burst's last throttled frame may land up to 250 ms after its hook.
      const end = start + 10_000 + 500;
      if (end > performance.now()) await sleep(end - performance.now());
      const secs = 10;
      const perSession = names.map((_, i) => {
        const s = [...reader.sessions.values()].find((x) => x.task === names[i]);
        return s ? (reader.updated.get(s.id) ?? 0) : 0;
      });
      const total = [...reader.updated.values()].reduce((a, b) => a + b, 0);
      const bytes = reader.bytes();
      const long = await page.evaluate(() => (window as unknown as { kageLong: number }).kageLong);
      console.log(
        `SSE: per-session frames ${perSession.join(',')}; total ${total}; ${bytes} B; longest task ${long} ms`,
      );
      // F8: counted over the whole window, ≤ 41 per session (4 a second plus the boundary frame).
      recordBudget(
        {
          name: 'SSE session.updated per session (10 s window)',
          value: Math.max(...perSession) / secs,
          limit: 4.1,
          unit: '/s',
        },
        { allowFail: 'Task 4' },
      );
      recordBudget(
        {
          name: 'SSE session.updated, all sessions',
          value: total / secs,
          limit: 123,
          unit: '/s',
        },
        { allowFail: 'Task 4' },
      );
      recordBudget({
        name: 'SSE bytes per second',
        value: bytes / secs,
        limit: 200 * 1024,
        unit: 'B',
      });
      recordBudget({
        name: 'Longest task in an open page during the burst',
        value: long,
        limit: 100,
        unit: 'ms',
      });
    } finally {
      reader.close();
    }
  });
});
