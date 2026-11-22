# Phase 5: Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kage tells the developer when a session needs them, lets them reach anything from the keyboard, and proves it is fast:
- it pings the phone through ntfy when a session needs you, and optionally when a turn is done;
- it shows a browser notification and a count in the tab title when the page can;
- ⌘K / Ctrl+K opens a command palette that jumps to a session or runs an action;
- every budget in spec §7 is an automated check that runs in CI and in the Docker test image.

**Architecture:**
- **Server, notifications.** Two new modules under `packages/server/src/notify/`.
  - `NtfyClient` (`ntfy.ts`) makes Kage's first outbound call: one JSON POST to the ntfy server, with a timeout, retries with backoff, no redirects and redacted logs. It uses Node's `fetch`.
  - `Notifier` (`notifier.ts`) subscribes to the `SessionSource` events, as the `EventHub` does. It turns status changes into episodes: a short hold, one ping per needs-you episode, a quiet period per session, and a global cap. `LiveSource` itself doesn't change for this.
  - `kage ping` sends one test ping, so the setup can be checked from a shell.
- **Board.**
  - `notify.ts` adds Web Notifications (only in a secure context), the needs-you count in `document.title`, and the deep link `#s=<id>` that a ping's link opens.
  - The palette is a fuzzy ranker (`palette/fuzzy.ts`), a command list built from the store (`palette/commands.ts`) and an ARIA combobox (`components/Palette.tsx`).
  - To make room in the first load: the demo data leaves the board's bundle, and the diff view becomes a lazy chunk through esbuild code splitting (R78).
- **Budgets.**
  - `build.test.ts` grows to cover the static import closure, every chunk and the fonts.
  - A new Playwright project `perf` (`e2e/perf.spec.ts`, live mode, Linux) measures time to a usable board, hook to screen, idle CPU and memory, DOM bounds and the SSE rate under 30 busy sessions. It writes `test-results/budgets.json`.

**Tech Stack:** as phase 4 (Node ≥ 24.2, TypeScript strict, Hono, Preact + signals, vitest, Playwright 1.64.1, real tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and in the Docker test image). No new runtime dependencies. The only package change is the font swap in Task 3 (build-time assets), if its measurement says so.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md):
- §2 (goals: notify), §5.5 (live updates, the timer rules), §5.9 (notifications), §5.10 (security), §5.11 (config, `ntfyTopic`), §5.12 (API);
- §6.1 (the top bar's `⌘K`), §6.3 (colours), §6.4 (keyboard: `⌘K`/`Ctrl K`), §6.5, §6.6 (copy), §10 (focus styling);
- §7 (budgets, every line), §8 (budget tests), §9 (phase 5 check), §11.

Backlog items that land here: B28, B33, B36 and B37 from [`docs/backlog.md`](../backlog.md), plus R78 from the phase 4 ledger. Facts: [`host-integration.md`](../specs/host-integration.md) (Task 5 adds §6, ntfy).

## Global Constraints

- **Everything in the phase 1–4 Global Constraints still applies:**
  - Node ≥ 24.2, strict mode plus `erasableSyntaxOnly`, no native modules;
  - `execFile`/`spawn` with argument arrays, never a shell;
  - copy from the design target, colours through tokens;
  - invented test data;
  - tests never touch the user's tmux server, config, state, git config or `~/.claude`;
  - `describe.runIf(hasTmux)` for tmux tests;
  - hooks stay silent;
  - the rulings R4–R82, K1–K10 and PF4 of the phase 2–4 ledgers.
- **Start point:** branch `phase-5` from `phase-4`, once the phase 4 final fix wave has landed (Task 0 lists what it hands over).
- **Dependencies:** no new runtime dependency. `fetch`, `AbortSignal.timeout` and `node:http` cover ntfy and the fake ntfy server. There is no axe-core: accessibility is checked with Playwright's `getByRole` and `toMatchAriaSnapshot`. The one exception is Task 3's font package swap (`@fontsource-variable/geist` and `@fontsource-variable/geist-mono` in place of `@fontsource/geist` and `@fontsource/geist-mono`, exact versions at least two weeks old), and only if its measurement passes.
- **Outbound network (Kage's first, ruling N0):**
  - Only `NtfyClient` calls out, and only when `ntfyTopic` is set. Never in demo mode.
  - **Tests never reach a real ntfy server.** Unit tests inject `fetch`. Integration tests and e2e use a fake ntfy server on `127.0.0.1` (`e2e/fake-ntfy.ts`).
  - A vitest setup file in `packages/server` replaces `globalThis.fetch` with one that throws for any host other than `127.0.0.1`, `::1` or `localhost`.
  - Real `ntfy.sh` is used only in the Phase 5 check: a random 32-character topic and invented task text.
- **Secrets (N1):**
  - `ntfyTopic` and `ntfyToken` never appear in a log line, an error message, a config error, the SSE snapshot, an API answer or the page.
  - The topic travels in the JSON body, never in the URL, so a proxy log or a fetch error can't carry it.
  - The token travels only in `Authorization: Bearer`.
  - A test greps every captured log line and error for both values.
- **Privacy (N2):** a ping carries only:
  - the title `<project> needs you` or `<project> is done`;
  - the message: the task text, stripped of control and bidi characters (`stripAnsi`), cut to 100 characters with `…`;
  - the priority: 4 for needs you, 3 for done;
  - `click`: `http://<MagicDNS name>:<port>/#s=<id>`.

  Never the question, a command, a branch, a path, output or file names. Browser notifications carry the same title and body.
- **Idle cost:**
  - With no ping pending, the notifier holds no timer. With `ntfyTopic` empty, it isn't built.
  - The palette and `notify.ts` add no timers.
  - The phase 4 rules stand.
  - A test asserts `vi.getTimerCount()` for each.
- **Colours:**
  - The palette uses existing tokens only. The active option has the selected row's look (`#1a1d22`, the lime 2 px inset edge). Matched characters are `--fg-strong`, the status word is amber for needs you and lime for running (§6.3 allows both), and the rest is `--fg-2`/`--fg-3`.
  - The panel has the toast's surface (`#20242a`, border `#2f343c`, radius 9 px, the toast's shadow). There is no scrim and no blur: a scrim is a filled block (§6.3).
  - Focus rings stay `color-mix(in srgb, var(--lime) 45%, transparent)` (§10).
- **Budget (ruling B1):**
  - The first load stays ≤ 30 KB gzipped (spec §7). Phase 4 left it at 25,421 B against a 25.5 KB cap.
  - Phase 5 first takes back about 2.4 KB:
    - the demo seeds, which esbuild can't drop today: 1,296 B, measured;
    - the diff view, made lazy: about 1,090 B before the loader.
  - The build test's cap then rises to **26.5 KB**, within the spec's 30 KB: phase 6 adds no board code, and 3.5 KB stays in reserve.
  - If the palette alone is over 2 KB gzipped, it moves into a lazy chunk the same way as the diff. It is prefetched on the first ⌘K hint hover or keydown, never at load.
  - Each UI task reports the build test's `first load gzipped` line.
- **Real Claude runs:** at most 4 short prompts, all in the Phase 5 check. Every other test uses `e2e/fake-claude.mjs`.

## Review Focus

1. **A secret or private text leaks through a ping or a log.**
   - A task text with an ANSI escape, a bidi override or 2,000 characters must reach ntfy stripped and cut to 100.
   - A question holding `export TOKEN=…` must never be sent.
   - A fetch error, a 401 from ntfy and a config error must never print the topic or the token.

   Tests: Task 5 (`publishBody`, `redact`, the log grep), Task 6 (`pingFor` never reads `question`), Task 1 (config errors).
2. **A flapping or restarted session pings too often, or never.**
   - Answer, then the next prompt 5 s later, gives one ping within the quiet period.
   - A prompt answered at the board within the 3 s hold gives none.
   - Kage restarting with a session already waiting gives none.
   - Twenty sessions waiting at once give at most 10 pings, then one log line.
   - A ping still retrying after the session left needs-you is dropped.

   Tests: Task 6.
3. **An unreachable or hostile ntfy server hurts Kage.**
   - A server that never answers is cut off after 5 s on each try.
   - A 3xx is not followed, so the token never reaches another host.
   - A 429 with `Retry-After: 99999` waits at most 60 s.
   - 4xx other than 429 isn't retried.
   - `stop()` aborts what is in flight, and the process exits without waiting for it.

   Tests: Task 5.
4. **The palette steals keys it shouldn't.**
   - Ctrl+K inside the open terminal goes to Claude (it's kill-line in a shell).
   - Esc in the palette closes only the palette, not the diff view under it.
   - Typing `j` in the palette types `j`.
   - With the palette closed, the browser's own Ctrl+K isn't eaten on the login screen.

   Tests: Task 8.
5. **A budget check passes without measuring what §7 says.**
   - The first load must include every chunk the app statically imports.
   - Hook to screen must start at the hook's arrival on the socket and end at the DOM change, not at an SSE frame.
   - Idle CPU must be measured with no tab connected and 10 sessions alive.

   Tests: Tasks 1 and 2 (perf spec, build test), with the definitions in Task 1's rules.

## File structure

```
packages/server/src/
  config.ts               Task 4: ntfyServer, ntfyToken, ntfyOnDone; topic, URL and token rules
  notify/ntfy.ts          Task 5: NtfyClient, publishBody, redact, NTFY
  notify/notifier.ts      Task 6: Notifier, pingFor, boardLink
  serve.ts                Task 6: wiring, the startup line
  main.ts                 Task 6: `kage ping`
  listen.ts               Task 6: ListenAddress gains dnsName
  live-source.ts          Task 4: now-only hook changes go through #emitThrottled
  preview/files.ts        Tasks 4, 9: untracked line-count cache (B37); paths stripped (B36)
  test/setup-fetch.ts     Task 5: the loopback-only fetch guard (vitest setupFiles)
packages/shared/package.json            Task 2: "sideEffects": false
packages/web/
  build.ts, build.test.ts               Tasks 2, 3: code splitting, modulepreload, closure-based first load, fonts
  index.html                            Task 2: %PRELOAD% for static chunks
  src/diff-loader.ts                    Task 2: lazy DiffView
  src/components/DiffView.tsx           Task 2: becomes the chunk's entry (default export)
  src/notify.ts                         Task 7: Web Notifications, title count, deep link
  src/palette/fuzzy.ts, commands.ts     Task 8
  src/components/Palette.tsx            Task 8
  src/components/TopBar.tsx             Task 8: the ⌘K hint becomes a button
  src/keys.ts, store.ts, main.tsx, sse.ts   Tasks 1, 7, 8
  src/styles/board.css                  Tasks 3, 8, 9
  src/copy.test.ts                      Task 9
packages/server/src/assets.ts           Task 2: chunk- and diff- names immutable
e2e/
  budgets.ts                            Task 1: recordBudget, budgets.json
  perf.spec.ts                          Task 1: the perf project
  fake-ntfy.ts                          Task 5 (used by Tasks 6, 10)
  fake-claude.mjs                       Task 1: `flood` scenario
  palette.spec.ts, notify.spec.ts       Task 10
  fonts.ts                              Task 3: the variable faces, if adopted
playwright.config.ts                    Tasks 1, 10: projects perf and live
docs/specs/host-integration.md          Task 5: §6 ntfy
docs/…, README.md                       Task 11
site/index.html                         Task 12
```

---

### Task 0: Phase 4 residuals (filled in by the controller)

The controller fills this task from the phase 4 final review and the Phase 4 check findings (P4F1, P4F2 and the final wave items the phase 4 ledger lists: B34/R63, B35, B39, B40, B41, the happy-dom noise). Until then it is a placeholder. No task below depends on it except through the shared files it touches.

---

### Task 1: The budget harness (measure first)

Every §7 line becomes a check now, before anything changes, so later tasks can't regress. A budget that fails at the start is marked `test.fixme('<owning task>')`, and the owning task removes the mark.

**Files:**
- Create: `e2e/budgets.ts`, `e2e/perf.spec.ts`
- Modify:
  - `e2e/fake-claude.mjs` (scenario `flood`: after `UserPromptSubmit`, it appends 2,000 `say` records to its transcript in batches of 50 every 100 ms, then fires `Stop`);
  - `e2e/harness.ts` (`postHook(event, body)`: one POST to the hook socket, as `kage hook` does; `serveRss()` and `serveCpuMs()` read `/proc/<pid>/status` `VmRSS` and `/proc/<pid>/stat` utime+stime);
  - `playwright.config.ts` (project `perf`: live, `testMatch: 'perf.spec.ts'`, port `KAGE_E2E_PERF_PORT` or 4395);
  - `packages/web/src/sse.ts` (the first snapshot marks `kage:board` once it has painted).
- Test: the spec itself; `packages/web/src/sse.test.ts` (the mark).

**Interfaces:**
- Produces:

```ts
// e2e/budgets.ts
export interface Budget { name: string; value: number; limit: number; unit: 'B' | 'ms' | '%' | 'MB' | '/s' | 'nodes' }
/** Appends to test-results/budgets.json and asserts value <= limit. */
export function recordBudget(b: Budget): void;
// sse.ts: after the first snapshot is applied, requestAnimationFrame → performance.mark('kage:board')
```

Rules (these definitions go into spec §7 in Task 11):
- **Time to a usable board:** `performance.getEntriesByName('kage:board')[0].startTime`, which is measured from navigation start.
  - A fresh browser context each run, against live mode with 10 sessions.
  - Chromium's network is set by CDP `Network.emulateNetworkConditions` to a tailnet LAN: 10 ms latency, 50 Mbit/s down, 20 Mbit/s up.
  - The median of 5 runs must be ≤ 300 ms.
- **Hook to screen:** `t0` is the test's `Date.now()` just before `postHook` writes. That is the moment the hook reaches Kage, the same socket write `kage hook` makes. `t1` is recorded in the page by a `MutationObserver` on the row's status, as `performance.timeOrigin + performance.now()`.
  - 20 samples, alternating `PermissionRequest` (to needs you) and `PostToolUse` (to running).
  - The p95 must be ≤ 150 ms.
  - The `kage hook` command's own wall time (spawn to exit, median of 10) is recorded with the limit 300 ms and `test.info().annotations`. It is reported but not asserted: phase 6's single executable owns it.
- **Idle server:** 10 fake-claude sessions, done, at their idle box. Every page and SSE stream is closed. After 10 s settle, measure for 30 s. CPU = Δ(utime+stime) / 30 s must be ≤ 1%, and `VmRSS` at the end must be ≤ 80 MB. Linux only (`/proc`); skipped elsewhere with a reason.
- **Rendering:** the viewed session runs `flood`.
  - Sampled every 100 ms, `.k-out .ln` never exceeds 500 nodes.
  - The element of a line that stays on screen is the same element after 200 more lines: mark it with `data-probe`, and it must still carry it.
  - The diff view of a 3,000-line change shows at most 1,000 line elements.
- **SSE under load (ruling B3, a plan budget that Task 11 adds to §7):**
  - 30 windows run `exec sleep 3600`. The driver posts `PreToolUse`/`PostToolUse` pairs with each window's `pane` at 10 per second per session for 10 s.
  - A Node SSE reader on `/api/events` counts frames.
  - Limits: `session.updated` ≤ 4 per session per second (≤ 120/s total), and ≤ 200 KB/s.
  - In an open page during the burst, no long task is over 100 ms (`PerformanceObserver` `longtask`).
  - If hooks from a `sleep` pane don't link (check this in Step 1), use 30 `fake-claude.mjs busy` windows instead: a new scenario that loops tool hooks.
- **Sizes**, read from `packages/web/dist` (the perf spec runs after the build): first load, every lazy chunk, the term loader and the fonts, with the same limits as `build.test.ts` (Tasks 2 and 3). The terminal chunk isn't requested at load: no `term-` request before `T`.

- [ ] **Step 1: Write `perf.spec.ts`** with the six measurements above, each through `recordBudget`. Check whether `sleep` panes link through posted hooks, and note which form the SSE test uses.
- [ ] **Step 2: Run** `corepack pnpm test:linux` (the perf project runs with the others). Expected: the harness runs, and `budgets.json` lists every budget. Mark each failing budget `test.fixme` with its owning task: fonts → Task 3; RSS, CPU or SSE → Task 4; the first load can't fail yet. Record the baseline table in the commit message.
- [ ] **Step 3: Unit-test the mark** in `sse.test.ts`: one `kage:board` mark after the first snapshot, none after a reconnect snapshot.
- [ ] **Step 4: Run** the unit tests and the chromium e2e on Windows (perf skips itself there). Expected: PASS.
- [ ] **Step 5: Commit.** `test(e2e): the budget harness — board time, hook to screen, idle server, DOM bounds, SSE under load, sizes`

---

### Task 2: First-load headroom: demo out of the bundle, the diff view lazy (R78)

**Files:**
- Modify:
  - `packages/shared/package.json` (`"sideEffects": false`);
  - `packages/web/build.ts` (`splitting: true`, `chunkNames: 'chunk-[hash]'`; the diff entry; `HASHED` = `/^(app|term|diff|chunk)-[A-Za-z0-9]+\.(js|css)$/`; the output check by kind instead of `names.length !== 4`; `%PRELOAD%` gets one `<link rel="modulepreload">` per chunk that `app` imports statically, from the metafile);
  - `packages/web/index.html`;
  - `packages/web/src/components/DiffView.tsx`, `SessionPanel.tsx`;
  - `packages/server/src/assets.ts` (the same `HASHED` names are immutable).
- Create: `packages/web/src/diff-loader.ts`
- Test: `packages/web/build.test.ts`, `packages/web/src/components/diff.test.tsx`, `packages/server/src/app.test.ts`

**Interfaces:**
- Produces:

```ts
// diff-loader.ts (main bundle)
export const diffImport: { load: () => Promise<typeof import('./components/DiffView.tsx')> };  // import('./components/DiffView.tsx'), swappable in tests
/** Renders "Loading the diff…" until the chunk is in, then DiffView; a failure shows the R78 line. */
export function LazyDiff(props: { session: Session }): JSX.Element;
// build.ts
export interface BuildResult { metafile: esbuild.Metafile; /** app's JS plus its static import closure, and app's CSS. */ firstLoad: string[] }
```

Rules:
- A load failure shows `Couldn't load the diff.` with a **Try again** button (R78 copy, §6.6). Try again calls `diffImport.load()` again, and a failure is not cached. The output's footer stays "Back to session  Esc".
- The terminal's own entry stays separate, as phase 4 built it. If splitting makes `term` import a shared chunk, that chunk must not contain preact (the existing test).

- [ ] **Step 1: Write the failing tests.**
  - `build.test.ts`:
    - the first load is index.html + every file in `firstLoad`, gzipped, and is ≤ 26.5 KB (B1);
    - `app-*.js` doesn't contain `Write notes`, the docs seed's text from `demo.ts`;
    - a `diff-*.js` exists and isn't in `firstLoad`;
    - every `chunk-*` file in `firstLoad` has a `modulepreload` link;
    - `term-*` and `diff-*` are never named by a `<script>` or `<link>`;
    - the old "exactly 4 hashed files" test becomes "only `HASHED` names, one app JS, one app CSS, one term JS, one term CSS, one diff JS".
  - `diff.test.tsx`:
    - View diff shows `Loading the diff…`, then the page;
    - a rejected `diffImport.load` shows `Couldn't load the diff.` and Try again;
    - Try again loads it.
  - `app.test.ts`: `/chunk-abc123.js` and `/diff-abc123.js` are served `immutable`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Check that `demoSessions` still loads on the server: `demo-source.test.ts` stays green.
- [ ] **Step 4: Run** the unit tests, the build and the e2e visual and board specs. Expected: PASS, visuals unchanged. Report the first load (expected about 23.2 KB) and the diff chunk size.
- [ ] **Step 5: Commit.** `perf(web): demo data out of the board bundle; the diff view as a lazy chunk (R78)`

---

### Task 3: Fonts within 60 KB (spec §7)

The six static files total 72,968 B against §7's "at most 60 KB (two woff2 subsets)".

**Files:**
- Modify: `packages/web/build.ts` (`FONTS`), `packages/web/src/styles/board.css` (`@font-face`), `packages/web/index.html` (preloads), `packages/web/package.json`, `e2e/fonts.ts`
- Test: `packages/web/build.test.ts`, `e2e/visual.spec.ts` (unchanged; it decides)

- [ ] **Step 1: Measure.** Install `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (pick exact versions at least two weeks old) and record the sizes of their latin `wght` woff2 files.
  - If the two together are ≤ 60 KB, continue.
  - If not, stop and report: the controller rules between (a) amending §7 to the six static files' 72 KB, or (b) dropping a weight, which changes the design target.
- [ ] **Step 2: Write the failing test.** `build.test.ts`: `dist/fonts` holds exactly two woff2 files, together ≤ 60 × 1024 B. Both are preloaded, and every `url(/fonts/…)` in the CSS names one of them.
- [ ] **Step 3: Implement.**
  - Two `@font-face` rules with `font-weight: 100 900`.
  - `e2e/fonts.ts` serves the same two files for every weight the target asks for, so the target and the app still render with identical fonts (§8).
  - Remove the old packages.
- [ ] **Step 4: Run** the build test and the visual spec (all four states ≤ 0.5%), then remove Task 1's fonts `fixme` and run the perf project. Expected: PASS. If the visual spec fails, report the diff images; don't loosen the threshold.
- [ ] **Step 5: Commit.** `perf(web): Geist and Geist Mono as two variable woff2 files (fonts within 60 KB)`

---

### Task 4: Server budgets: SSE coalescing, idle cost, the untracked cache (B37)

**Files:**
- Modify:
  - `packages/server/src/live-source.ts` (hooks whose only effect is a new `now` line call `#emitThrottled`; status, question and count changes still call `#emitNow`);
  - `packages/server/src/preview/files.ts` (B37: untracked line counts cached by `path`, `size` and `mtimeMs` per worktree, at most 2,000 entries, cleared when the session is removed);
  - whatever Task 1's idle measurement names (see Step 3).
- Test: `live-source.test.ts`, `preview/files.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - LiveSource, with a fake clock: 10 `PreToolUse`/`PostToolUse` hooks in 1 s on a running session emit at most 4 `session.updated` frames, and the last carries the last `now`. A `PermissionRequest` in the middle of them emits at once, with no wait.
  - `files.ts`: a second `listChanges` with unchanged untracked files reads none of them (a counting fake `readFile`). A changed `mtimeMs` re-reads that file only.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Then run the perf project. If idle RSS is over 80 MB or CPU over 1%, find the cause with `--heap-prof` or `--cpu-prof` on the idle server, and fix it in this task. Candidates in order:
  - `ws` and `terminal/*` imported only on the first upgrade (`await import()` in `TerminalServer.handleUpgrade`);
  - `preview/diff.ts` imported on the first diff request;
  - timers that run with no tab.

  Each fix gets a unit test (`vi.getTimerCount()`, or a module-not-loaded check through an injected importer). If the budget still fails after these, stop and report the numbers; the controller rules.
- [ ] **Step 4: Run** the unit tests on Windows and WSL, and `corepack pnpm test:linux`. Remove Task 1's `fixme` marks for SSE, CPU and RSS. Expected: PASS.
- [ ] **Step 5: Commit.** `perf(server): coalesce now-line updates to 4 a second; cache untracked counts (B37); idle within budget`

---

### Task 5: The ntfy client

**Files:**
- Create: `packages/server/src/notify/ntfy.ts`, `packages/server/test/setup-fetch.ts`, `e2e/fake-ntfy.ts`
- Modify: `packages/server/vitest.config.ts` (`setupFiles`), `docs/specs/host-integration.md` (new §6, "ntfy")
- Test: `packages/server/src/notify/ntfy.test.ts` (injected fetch), `packages/server/src/notify/ntfy.int.test.ts` (the fake server)

**Interfaces:**
- Produces:

```ts
// notify/ntfy.ts
export interface NtfyConfig { server: string; topic: string; token: string }   // server without a trailing slash
export interface Ping { title: string; message: string; priority: 3 | 4; click: string | null }
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export const NTFY = { timeoutMs: 5000, backoffMs: [2000, 8000, 30000], maxRetryAfterMs: 60_000, messageChars: 100 } as const;
/** {"topic","title","message","priority","click"?} — the topic is only ever here. */
export function publishBody(cfg: NtfyConfig, p: Ping): string;
/** 'timeout' | 'HTTP <status>' | the error's cause code (ECONNREFUSED…) | 'network error'. Never a message or URL. */
export function redact(err: unknown): string;
export class NtfyClient {
  constructor(d: { config: NtfyConfig; fetch?: FetchFn; log: (line: string) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void> });
  /** true when ntfy answered 2xx. Never throws. `stillWanted` is checked before every retry. */
  send(p: Ping, stillWanted?: () => boolean): Promise<boolean>;
  /** Aborts every request and wait in flight. */
  close(): void;
}
// e2e/fake-ntfy.ts
export function startFakeNtfy(o?: { status?: number[]; hang?: boolean; redirect?: string }): Promise<{ url: string; received: { headers: Record<string, string>; body: unknown }[]; close(): Promise<void> }>;
```

Rules:
- `POST <server>/` (ntfy's JSON publish) with:
  - `Content-Type: application/json`;
  - `Authorization: Bearer <token>`, only when there is a token;
  - `redirect: 'error'` and `signal: AbortSignal.any([timeout, close])`.
- Retries happen only on a network error, a timeout, a 5xx or a 429, after `backoffMs[i]`. A 429's `Retry-After` (seconds) replaces that wait, capped at `maxRetryAfterMs`. That makes at most 4 attempts. Any other 4xx is final.
- Logs:
  - one line per failed ping, after its last attempt: `ntfy: couldn't send a ping (<redact>).`;
  - one line for a refusal: `ntfy: the server refused the ping (HTTP 401). Check ntfyToken.` for 401 and 403, otherwise `(HTTP <n>).`;
  - nothing on success.
- `host-integration.md` §6 records, from ntfy's own documentation (no calls): the JSON publish fields, the message size limit, the public server's rate limits, and that a topic on ntfy.sh can be read by anyone who knows it.

- [ ] **Step 1: Write the failing tests.**
  - `publishBody`: exact JSON for both priorities; `click` absent when null; the topic is not in the URL that `send` fetches.
  - `send` against a recording fake fetch:
    - 200 → true, one call, and the headers are exact, with no `Authorization` without a token;
    - 503, 503, 200 → true after waits of 2,000 and 8,000 ms (fake sleep);
    - 429 with `Retry-After: 99999` → a wait of 60,000;
    - 400 → false, no retry, one log line;
    - a hang → aborted at 5,000 ms each try (fake timers), then false after 4 tries;
    - `stillWanted` false before the second try → false and no second call;
    - `close()` during a wait → false at once, with no timers left (`vi.getTimerCount() === 0`).
  - **The secrets grep:** with topic `Tq7…` (32 characters) and token `tk_secret…`, drive every failure path (network error whose message contains the full URL and the topic, 401, timeout, a thrown TypeError). No log line and no `redact` result contains either value.
  - The fetch guard: an unguarded `fetch('https://ntfy.sh/')` in a test throws `Tests may not call <host>`.
  - Integration, with the fake server:
    - a real POST arrives with the JSON body;
    - a 302 to another port is not followed (false; the second server sees nothing);
    - `hang` times out.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Write §6 of `host-integration.md`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): ntfy client — JSON publish, timeouts, backoff, no redirects, redacted logs; fake ntfy for tests`

---

### Task 6: The notifier, `kage ping` and the config

**Files:**
- Create: `packages/server/src/notify/notifier.ts`
- Modify:
  - `packages/server/src/config.ts`;
  - `packages/server/src/listen.ts` (`ListenAddress.dnsName: string | null`, the `tailscale status` name when it was found);
  - `packages/server/src/serve.ts`;
  - `packages/server/src/main.ts` (`kage ping`, USAGE)
- Test: `notify/notifier.test.ts` (fake source, fake clock, fake send), `config.test.ts`, `main.test.ts`, `listen.test.ts`. The `serve.ts` wiring is covered by Task 10's e2e

**Interfaces:**
- Consumes: `NtfyClient`, `Ping` (Task 5); `SessionSource` (`list`, `subscribe`).
- Produces:

```ts
// config.ts — KageConfig gains (defaults in brackets)
ntfyServer: string;   // ['https://ntfy.sh']
ntfyToken: string;    // ['']
ntfyOnDone: boolean;  // [false]
// notify/notifier.ts
export interface NotifierOptions { onDone: boolean; holdMs: number; quietMs: number; doneAfterMs: number; maxPerWindow: number; windowMs: number }
export const NOTIFY_DEFAULTS: NotifierOptions = { onDone: false, holdMs: 3000, quietMs: 120_000, doneAfterMs: 60_000, maxPerWindow: 10, windowMs: 600_000 };
export function pingFor(kind: 'needs-you' | 'done', s: Pick<Session, 'id' | 'project' | 'task'>, link: string | null): Ping;
export function boardLink(host: string, port: number, id: string): string;   // http://host:port/#s=<encodeURIComponent(id)>
export class Notifier {
  constructor(d: { source: Pick<SessionSource, 'list' | 'subscribe'>; send: (p: Ping, stillWanted: () => boolean) => Promise<boolean>;
    link: (id: string) => string | null; options: NotifierOptions; clock?: () => number; log: (line: string) => void });
  start(): void;   // seeds statuses from list(): nothing already waiting is pinged
  stop(): void;    // clears holds; with nothing pending it owns no timer
}
```

Rules (N3, the episode logic):
- **Needs you.** On a `session.updated` that moves a session into needs-you from any other status (or its first sighting after `start`), a hold of `holdMs` starts. When the hold ends, it pings if all of these hold:
  - the session is still needs-you, in the same episode (no status change in between);
  - no ping went to this session within `quietMs`;
  - the global window allows it.
- **`stillWanted`** for its retries is "still needs-you, same episode".
- **Done** (only with `ntfyOnDone`). A move from running or needs-you into **done** (never into ended: a stop is the user's own act) pings after the same hold, if the session was active (running or needs you) for at least `doneAfterMs` since its last done, ended or first sighting. The quiet period and the window apply.
- **Global window.** At most `maxPerWindow` pings in any `windowMs`. A skipped ping is counted, and one line per window is logged: `ntfy: too many pings; skipped N.`
- `session.removed` forgets the session.
- **Config rules** (N4). Errors never repeat a value.
  - `ntfyTopic`: `""`, or `^[A-Za-z0-9_-]{1,64}$`. With no token and the server's host `ntfy.sh`, it must be at least 16 characters: `ntfyTopic must be at least 16 letters, digits, - or _ on ntfy.sh: anyone who guesses it can read your pings`.
  - `ntfyServer`:
    - an `https:` URL, or `http:` only for a loopback host, a Tailscale address (100.64.0.0/10, `fd7a:115c:a1e0::/48`) or a `.ts.net` name;
    - no user info, query or fragment;
    - a trailing `/` is dropped.
  - `ntfyToken`: `""` or `^[A-Za-z0-9_-]{1,128}$`.
  - `ntfyOnDone`: a boolean.
- **Wiring.** Live mode only, and only when `ntfyTopic` is set. `link(id)` = `boardLink(listen.dnsName ?? displayHost(cfg, listen.address, hostname()), cfg.port, id)`. `stop()` and `client.close()` join the cleanups. At startup, one line: `Pings go to ntfy at <server host>.` (never the topic). The token is never sent to the browser, and nothing about ntfy enters the snapshot. Task 10's e2e needs a short done threshold, so serve reads one test-only variable, `KAGE_NOTIFY_DONE_AFTER_MS` (a whole number of ms), in place of `doneAfterMs`. It isn't documented in USAGE, as with `KAGE_DEMO_NOW`.
- **`kage ping`** loads the config and sends `pingFor`-shaped test content: title `Kage test ping`, message `ntfy is set up for <name>.`, priority 3, no link.
  - On success it prints `Sent a test ping to <server host>.` and exits 0.
  - With no topic it prints `No ntfyTopic in ~/.config/kage/config.json.` and exits 1.
  - On failure it prints `Couldn't send the ping (<redact>).` and exits 1.

- [ ] **Step 1: Write the failing tests.**
  - Notifier, with a fake clock:
    - running → needs-you → 3 s → one ping with exactly `{title: 'demo needs you', message: <task>, priority: 4, click: 'http://box.tail1.ts.net:8080/#s=s1'}`;
    - needs-you → running at 2 s → no ping;
    - answer and a new prompt 5 s later → still one ping; the same at 121 s → two;
    - a session needs-you at `start()` → no ping;
    - 20 sessions waiting at once → 10 pings and one `skipped 10` line;
    - `stillWanted` turns false once the session leaves needs-you;
    - done after 61 s running with `onDone` → one ping `demo is done`, priority 3; after 30 s running → none; without `onDone` → none; → ended → none;
    - a task text with `\x1b[31m`, U+202E and 300 characters → stripped and 100 characters ending in `…`;
    - `pingFor` on a session with a `question` holding `export TOKEN=abc` → the ping contains no `TOKEN`;
    - no timers once idle, and after `stop()`.
  - Config:
    - each rule above, accepted and refused;
    - an error message never contains the bad value (test with a recognisable value);
    - defaults.
  - `listen.ts`: `dnsName` is set from `tailscaleDnsName`, else null.
  - `main.ts`: `kage ping` against the fake ntfy (config in a temp `XDG_CONFIG_HOME`) prints the success line; with no topic, exit 1 and the exact line; neither prints the topic.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): ntfy pings when a session needs you (and optionally when done); kage ping`

---

### Task 7: Board: browser notifications, the title count, the deep link

**Files:**
- Create: `packages/web/src/notify.ts`
- Modify: `packages/web/src/main.tsx` (install), `packages/web/src/store.ts`
- Test: `packages/web/src/notify.test.ts`

**Interfaces:**
- Produces:

```ts
// notify.ts
export type NotifyState = 'unsupported' | 'insecure' | 'default' | 'granted' | 'denied';
export const notifyState: Signal<NotifyState>;
/** Asks for permission; call only from a user action (the palette, Task 8). */
export function enableNotifications(): Promise<void>;
/** The title count, browser notifications on moves into needs-you, and #s=<id> on load. Returns the stopper. */
export function installNotify(win?: Window): () => void;
```

Rules (W1):
- **Support.** `'insecure'` when `!isSecureContext`, since browsers expose `Notification` only to https and localhost: an `http://my-pc:8080` board over the tailnet can't use it. `'unsupported'` without `Notification`.
- **When it notifies.** Only on a `session.updated` that moves a session into needs-you. Never for a snapshot, and only while the page is hidden or unfocused. It uses `new Notification('<project> needs you', {body: <task, as N2>, tag: 'kage-<id>'})`. Clicking it calls `window.focus()`, `select(id)` and `close()`. A notification closes when its session leaves needs-you.
- **Title.** `document.title` is `(<n>) kage` while n > 0 sessions need you, else `kage`. This works in every context.
- **Deep link.** At load, `#s=<id>` sets `selectWhenSeen`, and `history.replaceState` drops the hash. A `hashchange` does the same.

- [ ] **Step 1: Write the failing tests** (happy-dom, with a fake `Notification` class and a toggled `isSecureContext`):
  - insecure → `notifyState` is `insecure`, and nothing is constructed;
  - granted, hidden, running → needs-you → one notification with the exact title, body and tag;
  - visible and focused → none;
  - a snapshot with a waiting session → none;
  - leaving needs-you closes it;
  - clicking it selects the session;
  - the title goes `(2) kage` → `kage`;
  - `#s=s1` at load selects `s1` once it is seen, and the hash is gone;
  - no timers.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests, the build and the visual spec. Expected: PASS. Report the first load.
- [ ] **Step 5: Commit.** `feat(web): browser notifications where the page allows them, the needs-you count in the title, #s= links`

---

### Task 8: Board: the command palette

**Files:**
- Create: `packages/web/src/palette/fuzzy.ts`, `packages/web/src/palette/commands.ts`, `packages/web/src/components/Palette.tsx`
- Modify:
  - `packages/web/src/keys.ts` (⌘K/Ctrl+K before every other check);
  - `packages/web/src/store.ts` (`paletteOpen`);
  - `packages/web/src/components/TopBar.tsx` (the `⌘K` span becomes `<button class="k-k">`: same text, same pixels, `aria-label="Command palette"`, `title` `Ctrl+K` off Mac);
  - `packages/web/src/main.tsx`, `styles/board.css`
- Test: `palette/fuzzy.test.ts`, `palette/commands.test.ts`, `components/palette.test.tsx`, `keys.test.ts`

**Interfaces:**
- Consumes: `select`, `newTaskOpen`, `mainView`, `openTerminal`, `archiveOpen`, `focusList` (store); `pin`, `archive`, `resume`, `stop` (api); `enableNotifications`, `notifyState` (Task 7); `canStop`, `groupOf`.
- Produces:

```ts
// palette/fuzzy.ts
export interface Match { score: number; hits: number[] }   // hits: matched indices, for highlighting
/** Case-insensitive subsequence match; null when not all query characters appear in order. */
export function fuzzy(query: string, text: string): Match | null;
export function rank<T>(query: string, items: readonly T[], text: (t: T) => string, limit?: number): { item: T; match: Match }[];   // limit 50
// palette/commands.ts
export type CommandGroup = 'sessions' | 'this session' | 'general';
export interface Command { id: string; group: CommandGroup; title: string; key?: string; session?: Session; run: () => void }
export function commands(): Command[];   // built from the signals at open
// store.ts
export const paletteOpen: Signal<boolean>;
```

Scoring (`fuzzy`): +1 per hit; +5 for a hit at index 0 or after a space, `/`, `-`, `_` or `.`; +3 for a hit right after the previous hit; −0.01 × the text length. Ties keep the input order. With an empty query, `rank` returns the items in order.

Rules (P1):
- **Items.**
  - `sessions`: every session in board order (needs you, running, done, pinned first). Its text is `project / task branch`, shown as `project /` (`--fg-3`), the task, and the status word on the right.
  - `this session`, for the selected one, only where the board allows it: `View diff`, `Open the terminal` (`T`), `Pin`/`Unpin` (`S`), `Archive` (`E`), `Resume` (`U`), `Stop` (`X`), `Delete…` (opens the confirmation, never deletes).
  - `general`: `New task` (`N`); `Show archived` when the count is above 0; `Turn on browser notifications` when `notifyState` is `default`. When it is `insecure`, a disabled item, `Browser notifications need HTTPS; use ntfy instead`.
- **Keys.**
  - ⌘K / Ctrl+K (no Alt or Shift) toggles the palette from anywhere, typing included, except while the terminal view is open (P2: the key goes to Claude) and on the login screen (the browser keeps it).
  - Inside the palette:
    - ↑/↓ move, wrapping;
    - Enter runs the active item and closes the palette;
    - Esc closes it, and stops propagation so the diff view under it stays open;
    - Tab stays in the input;
    - every other key types.
  - Board shortcuts are off while it is open.
- **Focus.**
  - On open, the input is focused, holding the previous `document.activeElement`.
  - On close without a command, focus goes back there.
  - A session jump focuses its list row (`focusList`).
  - New task focuses the form's field.
- **ARIA.**
  - The panel is `role="dialog"`, `aria-modal="true"`, `aria-label="Command palette"`.
  - The input is `role="combobox"`, `aria-expanded="true"`, `aria-controls="k-pal-list"`, `aria-autocomplete="list"`, `aria-activedescendant="k-pal-o<n>"`.
  - The list is `role="listbox"`. Each group is `role="group"` with `aria-labelledby` its lowercase label. Options are `role="option"` with `aria-selected`; a disabled item has `aria-disabled="true"`.
  - A polite live region says `<n> results` or `No matches.`.
  - Hover (`pointermove`) sets the active option, and a click runs it.
- **Copy:**
  - the placeholder `Jump to a session or run a command…`;
  - the empty line `No matches.`;
  - the footer `↑↓ to move · Enter to open · Esc to close`;
  - more than 50 → `Keep typing to see more.`
- **Look.**
  - Top 12vh, centred, 560 px wide, at most 60vh tall, the list scrolling.
  - The surface and colours follow the Global Constraints. The input row is 44 px, Geist 14 px, with a `--line` divider under it.
  - Option rows are as `.k-it`, and group labels as `.k-g`. Key hints are `kbd`, `--fg-3`, 11 px.

- [ ] **Step 1: Write the failing tests.**
  - `fuzzy`:
    - `fuzzy('dn', 'docs / Write notes')` matches with hits at `[0, 13]`;
    - `fuzzy('xz', 'docs')` is null;
    - word starts outrank scattered hits (`wn` ranks `Write notes` above `wonderland`);
    - `rank` keeps the input order on ties and caps at 50;
    - 1,000 items of 60 characters rank in under 10 ms (median of 20 runs).
  - `commands`:
    - a done Kage session offers Unpin/Pin, Archive and Delete…, but not Stop;
    - an external one offers no Pin, Archive, Resume, Stop or Delete;
    - an ended one offers Resume, but no terminal;
    - `Show archived` only with a count;
    - the notifications item follows `notifyState`.
  - `palette.test.tsx`:
    - Ctrl+K opens it with the input focused and the exact ARIA attributes;
    - typing `wn` makes the first option `docs / Write notes`;
    - ↓ moves `aria-activedescendant`, and Enter selects that session, closes the palette and focuses its row;
    - Esc closes and restores focus to the element focused before;
    - Esc with the diff view open closes only the palette;
    - `j` typed in the input doesn't move the board's selection;
    - Ctrl+K with `mainView === 'terminal'` does nothing and isn't prevented;
    - Ctrl+K on the login screen isn't prevented;
    - a click on the top bar's `⌘K` opens it;
    - `New task` opens the form with its field focused;
    - `Delete…` opens the confirmation and calls no API;
    - the live region reads `No matches.` for `zzzz`.
  - `keys.test.ts`: ⌘K (metaKey) and Ctrl+K both toggle; Ctrl+Shift+K doesn't.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Measure the palette's gzipped share (build once with and without it). If it is over 2 KB, make it lazy as B1 says.
- [ ] **Step 4: Run** the unit tests, the build and the visual spec (the top bar is unchanged in all four states). Expected: PASS. Report the first load and the palette's share.
- [ ] **Step 5: Commit.** `feat(web): the command palette (⌘K / Ctrl+K) — sessions and actions, fuzzy, combobox and listbox`

---

### Task 9: UX polish: copy consistency, empty states, focus, B28, B36

**Files:**
- Create: `packages/web/src/copy.test.ts`
- Modify:
  - `packages/server/src/preview/files.ts` (B36: `stripAnsi` on `FileChange.path` where the list is built);
  - `packages/web/src/components/PreviewPane.tsx` (B28: clamp to `LIMITS.files`; the empty files line);
  - `NewTask.tsx`, `DiffView.tsx`, `Toast.tsx`, `board.css` (focus and roles below)
- Test: `copy.test.ts`, `preview/files.test.ts`, `board.test.tsx`, `newtask.test.tsx`, `diff.test.tsx`

Rules:
- **Copy check** (`copy.test.ts`, node environment):
  - It reads spec §6.6 and the new §6.7 (Task 11 adds §6.7; until then the test reads a fixture list in the test, which Task 11 replaces with the spec read).
  - It takes every double-quoted sentence. `<…>` and `N` become `.+` and `\d+`.
  - It asserts that each one occurs in `packages/*/src/**/*.{ts,tsx}` outside tests.
  - It also asserts that every `{ error: '…' }` and `ActionError(…, '…')` literal on the server ends in `.`, has no `!` and no `Error:` prefix, and that no web string starts with `Error`.
- **Empty states:**
  - the files section with `filesTotal === 0` shows `No files changed yet.` (`.k-none`), and View diff is hidden;
  - an external session's right column shows `Kage didn't start this window, so there's no branch to compare.` in place of the files section.
- **Focus:**
  - Esc on the New task form returns focus to `＋ New task`;
  - Esc on the diff view returns it to `View diff →`;
  - the toast is `role="status"`;
  - after a palette jump, the row is focused (Task 8).
- **B36:** a path with `\x1b[2J` or U+202E reaches the list stripped.

- [ ] **Step 1: Write the failing tests** for each rule above.
- [ ] **Step 2: Run them.** Expected: FAIL; the copy test may list drift between §6.6 and the code.
- [ ] **Step 3: Implement.** Fix each drift in the code when the spec's sentence is the right one, else note it for Task 11's §6.6 correction.
- [ ] **Step 4: Run** the unit tests, the build and the visual spec. Expected: PASS; visuals unchanged (the demo sessions all have files).
- [ ] **Step 5: Commit.** `fix(web,server): copy check against the spec, empty states, focus returns, stripped file paths (B36), clamped list (B28)`

---

### Task 10: e2e: palette, notifications, deep link, double-X Stop (B33)

**Files:**
- Create: `e2e/palette.spec.ts` (chromium, demo), `e2e/notify.spec.ts` (live)
- Modify: `e2e/live.spec.ts` (B33), `playwright.config.ts` (`notify.spec.ts` in the `live` project), `e2e/harness.ts` (config `ntfyTopic`/`ntfyServer` from the fake)

- [ ] **Step 1: Write `palette.spec.ts`** (demo):
  - Ctrl+K opens it, and `toMatchAriaSnapshot` matches the combobox, listbox, groups and options;
  - `wn` + Enter selects `docs / Write notes`, and its row is focused;
  - Esc restores focus;
  - with the diff view open, Esc closes only the palette;
  - after `T` (demo answers 4501, so stub the terminal view open by routing `term-*.js` to a stub module), Ctrl+K opens nothing;
  - a click on `⌘K` opens it.
- [ ] **Step 2: Write `notify.spec.ts`** (live, the fake ntfy, `holdMs` left at its default):
  - `edit-and-test` reaches needs you → within 6 s the fake receives exactly one body `{topic, title: 'demo needs you', message: <task>, priority: 4, click: 'http://…/#s=<id>'}`;
  - the body has no `question`, branch or path;
  - answering and the next prompt give no second ping;
  - `serveOut` never contains the topic;
  - opening the `click` URL in the page selects that session;
  - with `ntfyOnDone` and a `flood` task longer than `doneAfterMs` (the harness sets `KAGE_NOTIFY_DONE_AFTER_MS=1000`, a test-only env read in serve), `demo is done` arrives;
  - on `http://127.0.0.1` (a secure context), with `context.grantPermissions(['notifications'])` and the page hidden through CDP `Emulation.setFocusEmulationEnabled` off: a waiting session creates a `Notification` (spied through `page.addInitScript`).
- [ ] **Step 3: Add B33 to `live.spec.ts`:** one X does nothing, and a second within 2 s stops; a card answered after its question changed gets 409 and the error line.
- [ ] **Step 4: Run** `corepack pnpm test:linux` three times in a row, then the chromium e2e on Windows. Expected: PASS each time.
- [ ] **Step 5: Commit.** `test(e2e): palette, ntfy pings against a fake server, browser notification, #s= links, double-X stop (B33)`

---

### Task 11: Docs

**Files:**
- Modify `docs/specs/2026-11-21-kage-design.md`, with amendments marked "(amended 2026-11-22, phase 5)":
  - §5.1: the variable fonts (if Task 3 adopted them); code splitting, the `diff-` and `chunk-` files, modulepreload.
  - §5.5: now-line updates are coalesced to 4 a second per session; status changes go at once.
  - §5.9, as built:
    - ntfy JSON publish, opt-in;
    - the payload (N2);
    - hold, quiet period, done rule and global window (N3);
    - retries and timeouts;
    - secrets never logged (N1);
    - browser notifications only in a secure context (W1), the title count and `#s=` links;
    - `kage ping`.
  - §5.10: Kage's one outbound call; redirects refused; `http:` only to loopback or the tailnet.
  - §5.11: `ntfyServer`, `ntfyToken`, `ntfyOnDone` and their rules (N4).
  - §6.1: the `⌘K` hint is a button.
  - §6.4: the palette's keys, groups and focus rules (P1, P2).
  - New §6.7, "Copy added in phase 5": every new sentence from Tasks 2, 5–9.
  - §7:
    - the definitions of each measurement (Task 1's rules);
    - the SSE and long-task budget (B3);
    - the cap of 26.5 KB (B1) and the measured first load;
    - the fonts' measured size;
    - the hook command's wall time, recorded for phase 6.
  - §8: the `perf` project and `budgets.json`.
- `docs/specs/host-integration.md`: a "Read first" pointer to §6.
- `docs/backlog.md`: mark B28, B33, B36 and B37 done. Add what was deferred, at least:
  - suppressing pings while a board tab is visible;
  - aggregating many pings into one;
  - a sign-out action (needs to know whether a token is set);
  - a phone layout for the page a ping opens.
- `docs/plans/README.md`: phase 5 built.
- `README.md`:
  - "Notifications": the ntfy config, `kage ping`, what a ping contains, why the topic is a secret, browser notifications need https or localhost;
  - the palette;
  - the new config keys in the example.
- `packages/web/src/copy.test.ts`: read §6.7 from the spec instead of the fixture.

- [ ] **Step 1: Update the docs** as listed, in the house style (short sentences, exact commands).
- [ ] **Step 2: Run** `corepack pnpm lint` and `copy.test.ts`. Expected: clean, PASS.
- [ ] **Step 3: Commit.** `docs: polish — notifications, the command palette, the budgets as built`

---

### Task 12: The landing page

**Files:** `site/index.html`, `site/style.css` if needed. No new images unless the controller supplies a recaptured board shot.

- [ ] **Step 1: Update `site/`:**
  - the status chip `In development · phases 1–5 built`;
  - two feature cards in the existing style: "Pings on your phone" (ntfy; only the project, the task and a link; the topic is a secret) and "Everything on ⌘K";
  - one line under the security section: "One outbound call, only if you set it: the ntfy ping";
  - the roadmap's Polish entry marked built, with the budget numbers measured in Task 1's final run (first load, board time, hook to screen, idle CPU and RSS).
- [ ] **Step 2: Check** that the page renders at 1320 px and 390 px wide (Playwright screenshot of `site/index.html`, browser page only), with no horizontal scroll and no external requests but the existing ones.
- [ ] **Step 3: Commit.** `site: phase 5 — pings, the palette, the measured budgets`. Publishing (`scripts/publish-site.sh`) is the controller's step after the owner's go on main.

---

**Phase 5 check (spec §9: "Kage pings the phone, and every budget in §7 passes"):** in WSL, run `kage serve` (127.0.0.1, or the Tailscale IP when it is up) with `projectsRoot` holding a scratch repo and real `claude` 2.1.330. Use at most 4 prompts. The config holds a fresh random 32-character `ntfyTopic` on `https://ntfy.sh`, with `ntfyOnDone: true`.
1. `kage ping` prints `Sent a test ping to ntfy.sh.`. The controller reads it back with `curl -s "https://ntfy.sh/<topic>/json?poll=1"`: one message, title `Kage test ping`.
2. Start a task that needs a permission. Within about 5 s of the board turning amber, the poll shows one message with only `title`, `message`, `priority` 4 and `click`. Opening `click` in the browser selects the session. Answer it: no second ping. When the turn has run ≥ 60 s and finishes, `… is done` arrives (if the task is shorter, record that and skip it).
3. Grep Kage's stderr for the topic: nothing.
4. On `http://127.0.0.1:<port>` in Chrome, turn on browser notifications from the palette, switch to another tab, and trigger a prompt: a notification shows, and clicking it opens the session. On the tailnet address, the palette shows the HTTPS line instead.
5. Ctrl+K: jump to a session by typing three letters, start a New task from it, and Esc out of it over the diff view.
6. `corepack pnpm test:linux`: every project green, and `test-results/budgets.json` shows every §7 budget within its limit. Paste the table into the ledger.

**Owner step (optional):** subscribe the ntfy phone app to a topic of your own and run `kage ping`: the phone shows "Kage test ping". This is the literal "pings the phone"; the poll in step 1 proves the same delivery path.
