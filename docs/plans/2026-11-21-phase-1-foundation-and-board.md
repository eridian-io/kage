# Phase 1: Foundation and Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Kage server that serves the board UI in demo mode, pixel-matched to the approved design, with the security defaults, live updates over SSE, and the delete flow working end to end.

**Architecture:** A pnpm workspace with three packages. `@kage/shared` holds the types and the demo sessions. `@kage/server` is a Hono app on Node 24 that gets sessions from a `SessionSource` (only `DemoSource` in this phase) and pushes them to browsers over SSE. `@kage/web` is a Preact + signals board, built with esbuild and served from memory by the server. A Playwright test renders the design target and the app side by side and compares them pixel by pixel.

**Tech Stack:** Node 24, TypeScript (strict, `erasableSyntaxOnly`), pnpm 10 through corepack, Hono and `@hono/node-server`, Preact and `@preact/signals`, esbuild, vitest (with happy-dom for the web package), Playwright (Chromium), `pixelmatch` and `pngjs`, Biome. Fonts come from `@fontsource/geist` and `@fontsource/geist-mono`.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md). The visual target is [`docs/design/kage-board.html`](../design/kage-board.html). Read both before you start. Where the spec and the target page disagree on looks, the page wins.

## Global Constraints

- Node 24 LTS (`.nvmrc` says `24`). `"engines": { "node": ">=24" }` in every package.json.
- TypeScript `strict: true` and `erasableSyntaxOnly: true` (no enums, namespaces or parameter properties), so the server source also runs directly with `node` in development.
- No native (compiled) npm modules anywhere. A single-executable build comes in phase 6.
- Every tmux and git call uses `execFile` with an argument array, never a shell string. Only `tailscale ip -4` is called in this phase.
- The UI copy is exactly as in the design target. Lowercase group labels: "needs you", "running", "done".
- Colours only through the tokens in spec §6.2. Lime only for alive or actionable things, amber only for "needs you", muted red only for Stop and Delete (spec §6.3). The "kage" wordmark is never lime.
- First-load budget: HTML, CSS and JS at most 30 KB gzipped, excluding fonts and the logo (spec §7).
- Test fixtures and demo data use invented data only.
- Commit messages: `feat(scope): …`, `fix(scope): …`, `test(scope): …`, `chore: …`, `docs: …`.

## Review Focus

1. **Untrusted text in output:** a transcript line or task containing `<img src=x onerror=alert(1)>` must show as literal text, never as HTML. Covered by a test in Task 6.
2. **Long names and paths:** a 120-character task and a 200-character worktree path must truncate with an ellipsis (title tooltip for the full value), never widen a column or wrap the header. Covered in Task 6.
3. **Host header variants:** `my-pc:8080`, `my-pc`, `100.64.0.7:8080` and a bracketed IPv6 Tailscale address must all be accepted when they match the config; `evil.example` must get 403. Covered in Task 3.
4. **Server restart during use:** when the SSE stream drops, the board shows "Reconnecting to my-pc…" within 2 s, keeps the last state readable, disables actions, and re-syncs from the next `snapshot`. Covered in Task 7.
5. **Deleting the selected session, or the last session in a group:** the selection moves to the first remaining session, the group header disappears when it's empty, and with no sessions left the "No sessions yet" state shows. Covered in Task 6.

## File structure

```
package.json                     root: workspace scripts, dev tooling
pnpm-workspace.yaml              packages/*
tsconfig.base.json               shared compiler options
biome.json                       lint and format
vitest.config.ts                 root: test.projects = packages/*
playwright.config.ts             e2e: starts `kage serve --demo`, Chromium, 1320x900
packages/shared/
  src/types.ts                   Session, DisplayLine, Question, Port, FileChange, ServerEvent
  src/demo.ts                    demoSessions(now): the design target's sample data
  src/order.ts                   sortSessions(), groupOf()
  src/format.ts                  formatAge(), shortWorktree()
packages/server/
  src/main.ts                    CLI entry: `kage serve [--demo] [--unsafe-listen-all]`
  src/config.ts                  loadConfig(): defaults, ~ expansion, validation
  src/listen.ts                  resolveListenAddress()
  src/security.ts                hostGuard(), csrfGuard()
  src/source.ts                  SessionSource interface
  src/demo-source.ts             DemoSource
  src/events.ts                  EventHub (SSE fan-out, heartbeat)
  src/app.ts                     createApp(): routes
  src/assets.ts                  loadAssets(): built UI files in memory, gzip + brotli
packages/web/
  build.ts                       esbuild build → dist/ (hashed names, index.html)
  index.html                     template
  src/main.tsx                   mounts <Board/>
  src/store.ts                   signals: sessions, selectedId, connection, ui state
  src/sse.ts                     connect(): EventSource with reconnect
  src/api.ts                     post()/del() with the X-Kage header
  src/keys.ts                    keyboard shortcuts (J/K, Esc in this phase)
  src/components/TopBar.tsx
  src/components/SessionList.tsx
  src/components/SessionPanel.tsx    header, output, question, follow-up, confirm, footer
  src/components/Output.tsx
  src/components/PreviewPane.tsx
  src/components/Toast.tsx
  src/styles/tokens.css          the §6.2 tokens
  src/styles/board.css           ported from the design target
  public/kage-logo-96.png        copy of assets/kage-logo-96.png
e2e/
  visual.spec.ts                 app vs design target, four states
  board.spec.ts                  select, keyboard, delete flow, reconnect
.github/workflows/ci.yml
```

---

### Task 1: Workspace, shared types and demo data

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/shared/src/demo.ts`, `packages/shared/src/order.ts`, `packages/shared/src/format.ts`
- Test: `packages/shared/src/demo.test.ts`, `packages/shared/src/order.test.ts`, `packages/shared/src/format.test.ts`

**Interfaces:**
- Produces (in `@kage/shared`):

```ts
export type SessionStatus = 'needs-you' | 'running' | 'done' | 'ended';
export type LineKind = 'say' | 'tool' | 'add' | 'del' | 'out' | 'think';
export interface DisplayLine { kind: LineKind; text: string; detail?: string }   // detail: tool argument
export interface Question { text: string; options: string[] }
export interface Port { port: number; process: string; localOnly: boolean }
export interface FileChange { path: string; added: number; removed: number }
export interface Session {
  id: string; status: SessionStatus; project: string; task: string;
  branch: string; worktree: string;            // worktree: absolute or ~-prefixed path
  startedAt: number; statusSince: number;      // epoch ms
  pinned: boolean; archived: boolean; external: boolean; unpushed: number;
  question?: Question; lines: DisplayLine[]; ports: Port[]; files: FileChange[];
}
export type ServerEvent =
  | { type: 'snapshot'; host: string; sessions: Session[] }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; id: string };
export function demoSessions(now: number): Session[];
export function sortSessions(list: Session[]): Session[];
export function groupOf(s: Session): 'needs you' | 'running' | 'done';
export function formatAge(ms: number): string;
export function shortWorktree(path: string, projectsRoot?: string): string;
```

- [ ] **Step 1: Scaffold the workspace.** Root `package.json` (`"private": true`, `"packageManager": "pnpm@10.x"` with the exact version corepack installs), scripts: `dev`, `build`, `lint` (`biome check .`), `format`, `typecheck` (`tsc -b`), `test` (`vitest run`), `test:e2e` (`playwright test`). `tsconfig.base.json`: `strict`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`, `target` `es2024`, `jsx` `react-jsx` with `jsxImportSource` `preact`, `noUncheckedIndexedAccess`. Biome: recommended rules, 2-space indent, single quotes. Run `corepack pnpm install`. Expected: an install with no errors.

- [ ] **Step 2: Write the failing tests.**

```ts
// demo.test.ts — the demo data is the design target's data
const now = Date.UTC(2026, 10, 21, 14, 32);
const s = demoSessions(now);
expect(s.map(x => x.id)).toEqual(['web', 'shop', 'infra', 'rate', 'footer', 'docs']);
expect(s.find(x => x.id === 'web')).toMatchObject({ status: 'needs-you', project: 'web', task: 'dark mode',
  branch: 'feat/dark-mode', worktree: '~/projects/web/.worktrees/dark-mode',
  question: { text: 'Which approach should I use?', options: ['CSS variables', 'Tailwind'] } });
expect(formatAge(now - s.find(x => x.id === 'web')!.statusSince)).toBe('4m');
expect(formatAge(now - s.find(x => x.id === 'web')!.startedAt)).toBe('18m');
expect(s.find(x => x.id === 'rate')).toMatchObject({ status: 'done', pinned: true });
expect(s.find(x => x.id === 'docs')).toMatchObject({ unpushed: 1 });
expect(s.find(x => x.id === 'shop')!.lines.at(-1)).toEqual({ kind: 'think', text: 'Writing a regression test for the refresh case… (38s)' });
// order.test.ts — groups needs-you, running, done; pinned first within done; then oldest statusSince first
expect(sortSessions(s).map(x => x.id)).toEqual(['web', 'shop', 'infra', 'rate', 'footer', 'docs']);
expect(sortSessions(s.filter(x => !x.archived)).length).toBe(6);
expect(groupOf({ ...s[0], status: 'ended' })).toBe('done');
// format.test.ts
expect(formatAge(59_000)).toBe('now'); expect(formatAge(4 * 60_000)).toBe('4m');
expect(formatAge(3 * 3_600_000)).toBe('3h'); expect(formatAge(2 * 86_400_000)).toBe('2d');
expect(shortWorktree('~/projects/web/.worktrees/dark-mode')).toBe('web/.worktrees/dark-mode');
expect(shortWorktree('/srv/code/api/.worktrees/x', '/srv/code')).toBe('api/.worktrees/x');
```

- [ ] **Step 3: Run them.** `corepack pnpm test --project shared`. Expected: FAIL (modules not found).

- [ ] **Step 4: Implement** `types.ts`, `demo.ts`, `order.ts` and `format.ts`. Port every sample field from the `S` array in `docs/design/kage-board.html`: `st` maps `wait→needs-you`, `run→running`, `done→done`; `lines[].k/t/d` map to `kind/text/detail`; `ports` become `{port, process, localOnly: false}`; `files` become `{path, added, removed}` with numbers. Times: `statusSince = now − tm`, `startedAt = now − age`, using the target's `tm`/`age` values. `archived` is false everywhere, `external` false, `unpushed` 1 only for `docs`.

- [ ] **Step 5: Run the tests.** Expected: PASS. Also `corepack pnpm lint` and `corepack pnpm typecheck` pass.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(shared): workspace, session types and demo data"`

---

### Task 2: Config loader

**Files:**
- Create: `packages/server/package.json` (bin `kage` → `src/main.ts` for now), `packages/server/tsconfig.json`, `packages/server/src/config.ts`
- Test: `packages/server/src/config.test.ts`

**Interfaces:**
- Produces:

```ts
export interface KageConfig {
  name: string;                                // display name in the host pill; default: short os.hostname()
  projectsRoot: string; host: string | null; port: number; tmuxSession: string;
  worktreeDir: string; branchPrefix: string;
  autoArchive: { onMerge: boolean; afterDays: number };
  ntfyTopic: string; token: string;
}
export const DEFAULT_CONFIG: KageConfig;   // values from spec §5.11, host null (auto-detect)
export function loadConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): Promise<KageConfig>;
export class ConfigError extends Error {}  // message names the bad key and the expected value
```

- [ ] **Step 1: Write the failing tests:** a missing file gives `DEFAULT_CONFIG` (`port` 8080, `tmuxSession` `"kage"`, `worktreeDir` `".worktrees"`, `branchPrefix` `"kage/"`, `autoArchive` `{onMerge: true, afterDays: 14}`); `~` in `projectsRoot` expands to the home directory; unknown keys are ignored; `port: 70000` throws `ConfigError` with a message containing `port` and `1–65535`; `projectsRoot: 5` throws a `ConfigError` naming `projectsRoot`; the path defaults to `$XDG_CONFIG_HOME/kage/config.json`, else `~/.config/kage/config.json`; malformed JSON throws a `ConfigError` that includes the file path; `name` defaults to the part of `os.hostname()` before the first dot; the env vars `KAGE_NAME`, `KAGE_HOST` and `KAGE_PORT` override the file (used by the e2e tests and by systemd drop-ins).
- [ ] **Step 2: Run them.** `corepack pnpm test --project server`. Expected: FAIL.
- [ ] **Step 3: Implement `loadConfig`.** Hand-written validation; no schema library.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): config loader with defaults and validation`

---

### Task 3: Listen address and security guards

**Files:**
- Create: `packages/server/src/listen.ts`, `packages/server/src/security.ts`
- Test: `packages/server/src/listen.test.ts`, `packages/server/src/security.test.ts`

**Interfaces:**
- Consumes: `KageConfig` (Task 2).
- Produces:

```ts
export interface ListenAddress { address: string; hostNames: string[] }  // hostNames: accepted Host values without port
export function resolveListenAddress(cfg: KageConfig, opts: {
  unsafeListenAll: boolean;
  tailscaleIp: () => Promise<string | null>;   // default runs execFile('tailscale', ['ip', '-4'])
  hostname: () => string;
}): Promise<ListenAddress>;
export class ListenError extends Error {}
export function hostGuard(allowed: { hostNames: string[]; port: number }): MiddlewareHandler;  // Hono
export function csrfGuard(allowed: { hostNames: string[]; port: number }): MiddlewareHandler;
```

- [ ] **Step 1: Write the failing tests.**
  - `resolveListenAddress`: with `cfg.host` set to `"100.64.0.7"`, it returns that address and the host names include it plus `hostname()`; with no host, it uses `tailscaleIp()`; when `tailscaleIp()` returns null, it throws `ListenError` with the message `Tailscale isn't running. Start it with "tailscale up", or set "host" in ~/.config/kage/config.json.`; `cfg.host: "0.0.0.0"` throws unless `unsafeListenAll` is true.
  - `hostGuard` (via `new Hono().use(hostGuard(...))` and `app.request`): with names `['my-pc', '100.64.0.7', 'fd7a:115c::1']` and port 8080, `Host: my-pc:8080`, `my-pc`, `100.64.0.7:8080` and `[fd7a:115c::1]:8080` all get 200; `evil.example`, `my-pc:9999` and a missing Host get 403 with body `Unknown host`.
  - `csrfGuard`: a POST without `X-Kage: 1` gets 403; a POST with `X-Kage: 1` and `Origin: http://my-pc:8080` gets 200; a POST with the header but `Origin: http://evil.example` gets 403; GET requests pass without the header.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Parse `Host` with the `URL` constructor (`new URL('http://' + host)`), and compare `hostname` (brackets stripped) and `port` (empty means 80).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): bind to Tailscale only, host and CSRF guards`

---

### Task 4: Session source, demo source and the SSE hub

**Files:**
- Create: `packages/server/src/source.ts`, `packages/server/src/demo-source.ts`, `packages/server/src/events.ts`
- Test: `packages/server/src/demo-source.test.ts`, `packages/server/src/events.test.ts`

**Interfaces:**
- Consumes: `Session`, `ServerEvent`, `demoSessions` (Task 1).
- Produces:

```ts
export interface SessionSource {
  list(): Session[];                         // excludes archived
  get(id: string): Session | undefined;
  remove(id: string): Promise<void>;         // throws NotFoundError for an unknown id
  subscribe(fn: (e: ServerEvent) => void): () => void;   // never emits 'snapshot'
}
export class NotFoundError extends Error {}
export class DemoSource implements SessionSource { constructor(now?: number) }  // now defaults to Number(process.env.KAGE_DEMO_NOW) || Date.now()
export class EventHub {
  constructor(source: SessionSource, host: string, opts?: { heartbeatMs?: number });  // default 30_000
  stream(): ReadableStream<Uint8Array>;      // one per client: a 'snapshot' first, then source events, then ': hb' comments
  get clientCount(): number;
  close(): void;
}
```

- [ ] **Step 1: Write the failing tests.** `DemoSource.list()` returns six sessions; `remove('docs')` emits `{type: 'session.removed', id: 'docs'}` and `list()` then has five; `remove('nope')` rejects with `NotFoundError`. `EventHub.stream()`: the first chunk decodes to `event: snapshot\ndata: {...}\n\n`, with a `host` and six sessions; after `source.remove('docs')` the next chunk is `event: session.removed`; with `heartbeatMs: 20` a `: hb` comment arrives (fake timers); cancelling the reader drops `clientCount` back to 0.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** SSE framing is `event: <type>\ndata: <JSON>\n\n`. The hub subscribes to the source once and fans out to all open streams.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): session source, demo source and SSE hub`

---

### Task 5: Board styles and tokens

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vitest.config.ts` (environment `happy-dom`), `packages/web/src/styles/tokens.css`, `packages/web/src/styles/board.css`, `packages/web/public/kage-logo-96.png` (copied from `assets/kage-logo-96.png`)
- Test: `packages/web/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: CSS custom properties `--bg --line --line-strong --fg --fg-strong --fg-2 --fg-3 --lime --amber --red --add --del --sans --mono` on `:root`, and the board's class names (the `.v1-*` rules from the target, renamed `v1-` → `k-`, for example `.k-top`, `.k-side`, `.k-it`, `.k-main`, `.k-act`, `.k-foot`, `.k-aside`).

- [ ] **Step 1: Write the failing test.** Read `tokens.css` as text and assert each token from spec §6.2 with its exact value (`--bg: #0f1114`, `--line: #1b1e23`, `--line-strong: #2a2f37`, `--fg: #c9ced6`, `--fg-strong: #eef0f3`, `--fg-2: #8a919c`, `--fg-3: #5f6672`, `--lime: #cdf35a`, `--amber: #d9a650`, `--red: #e08a8a`, `--add: #9cc59f`, `--del: #c98d8d`). Read `board.css` and assert that no hex colour appears outside `tokens.css`, except the overlay and hover shades listed in an `ALLOWED_LITERALS` array at the top of the test (copy each one you need from the target, so every literal is a deliberate choice).
- [ ] **Step 2: Run it.** `corepack pnpm test --project web`. Expected: FAIL.
- [ ] **Step 3: Write `tokens.css` and `board.css`.** Port every `.v1*`, `.klogo`, `.dot`, `.cursor` and `.ln-*` rule from `docs/design/kage-board.html` that the Quiet board uses, with values unchanged except that colours become tokens. `@font-face` rules point at `/fonts/geist-latin-{400,500,600,700}-normal.woff2` and `/fonts/geist-mono-latin-{400,500}-normal.woff2` (copied by the build in Task 7), with `font-display: swap`. Add `body { margin: 0; background: var(--bg) }` and `.k-app { height: 100vh }`. Add a focus style: `:focus-visible { outline: 2px solid color-mix(in srgb, var(--lime) 45%, transparent); outline-offset: 2px }`.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(web): design tokens and board styles from the design target`

---

### Task 6: Board components

**Files:**
- Create: `packages/web/src/store.ts`, `packages/web/src/api.ts`, `packages/web/src/keys.ts`, `packages/web/src/main.tsx`, `packages/web/src/components/{TopBar,SessionList,SessionPanel,Output,PreviewPane,Toast}.tsx`
- Test: `packages/web/src/components/board.test.tsx`, `packages/web/src/keys.test.ts`

**Interfaces:**
- Consumes: shared types and helpers (Task 1); CSS classes (Task 5).
- Produces:

```ts
// store.ts
export const host: Signal<string>;
export const sessions: Signal<Session[]>;
export const selectedId: Signal<string | null>;
export const connection: Signal<'connecting' | 'live' | 'reconnecting'>;
export const confirmingDelete: Signal<boolean>;
export const toast: Signal<string | null>;
export const sorted: ReadonlySignal<Session[]>;   // sortSessions(sessions)
export const selected: ReadonlySignal<Session | null>;
export function applyEvent(e: ServerEvent): void;  // snapshot replaces all; updated upserts; removed deletes and, if it was selected, selects sorted[0]
export function selectNext(delta: 1 | -1): void;
// api.ts
export function apiDelete(path: string): Promise<Response>;   // sends X-Kage: 1
export function apiPost(path: string, body: unknown): Promise<Response>;
// keys.ts
export function installKeys(target?: Document): () => void;   // J/K select, Esc cancels the confirm; ignored in inputs and textareas
export function Board(): JSX.Element;   // exported from main.tsx (mounting happens only when not under test)
```

- [ ] **Step 1: Write the failing tests** (`@testing-library/preact` on happy-dom, store seeded with `applyEvent({type: 'snapshot', host: 'my-pc', sessions: demoSessions(NOW)})`, `Date.now` faked to `NOW`):
  - The top bar shows `my-pc · 6 sessions`, `1 needs you` and `2 running`.
  - The list shows the group labels `needs you`, `running` and `done` in that order. The `web` row contains `web /`, `dark mode`, `4m` and `waiting for your reply`, and has class `on`. The `rate` row starts with `★`.
  - The panel header shows `web /`, `dark mode` and a chip `needs you`, plus the meta `branch feat/dark-mode`, `worktree web/.worktrees/dark-mode` (with `title` = the full path) and `started 18m ago`.
  - The question shows `Waiting for you`, `Which approach should I use?`, buttons `1 CSS variables` and `2 Tailwind`, and `or press R to reply`.
  - The footer shows `Terminal` with key `T` and `Stop` with key `X`, and no Archive.
  - Clicking `shop` shows a chip `running`, the think line text in an element with class `ln-think`, a `.cursor` element, and the footer `Stop`.
  - Clicking `docs` shows a chip `done`, `finished 1h ago`, the follow-up field `Follow up in this session…`, and the footer `Archive` and `Delete…`. Clicking `Delete…` hides the follow-up and shows `Delete this session?` and `1 commit isn’t pushed and will be lost.`. Clicking `Cancel` hides it again.
  - Confirming calls `apiDelete('/api/sessions/docs')`. After `applyEvent({type: 'session.removed', id: 'docs'})`, the toast reads `Deleted docs · update README · worktree and branch removed` and `web` is selected.
  - **Review focus 1:** a session whose `task` and a `say` line contain `<img src=x onerror=alert(1)>` renders that text literally (`container.querySelector('img[src="x"]')` is null).
  - **Review focus 2:** a 120-character task and a 200-character worktree render with `text-overflow: ellipsis` classes and a `title` holding the full text.
  - **Review focus 5:** removing the only `needs-you` session removes the `needs you` group label; removing all sessions shows `No sessions yet`.
  - `keys.test.ts`: `j` moves the selection from `web` to `shop`, `k` moves it back, `j` inside an `<input>` does nothing, and `Escape` sets `confirmingDelete` to false.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the components.** Mirror the target's DOM structure (`k-top`, `k-b` > `k-side` / `k-main` / `k-aside`) so the ported CSS lays out identically. Render all text through JSX (never `dangerouslySetInnerHTML`). Output renders `say` lines in the sans style and every other kind as mono, with prefixes exactly as in the target (`+ `, `− `, two spaces for `out`, nothing for `tool`/`say`/`think`); `tool` lines render as `text + ' ' + detail`. In this phase the answer buttons, Stop, Archive, Terminal and the follow-up field are visible but inert (`aria-disabled="true"` and the title `Available in a later version`); only Delete is wired. Ages re-render once a minute through a `now` signal.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(web): board components matching the design target`

---

### Task 7: SSE client, build, asset serving and `kage serve`

**Files:**
- Create: `packages/web/src/sse.ts`, `packages/web/build.ts`, `packages/web/index.html`, `packages/server/src/assets.ts`, `packages/server/src/app.ts`, `packages/server/src/main.ts`
- Modify: `packages/web/src/main.tsx` (call `connect()`), root `package.json` (`dev`, `build` scripts)
- Test: `packages/server/src/app.test.ts`, `packages/web/src/sse.test.ts`, `packages/web/build.test.ts`

**Interfaces:**
- Consumes: `EventHub`, `DemoSource`, `SessionSource` (Task 4); guards (Task 3); `loadConfig` (Task 2); `applyEvent`, `connection` (Task 6).
- Produces:

```ts
// assets.ts
export interface Asset { body: Uint8Array; gzip: Uint8Array; br: Uint8Array; type: string; etag: string; immutable: boolean }
export function loadAssets(distDir: string): Promise<Map<string, Asset>>;   // '/' maps to index.html
// app.ts
export function createApp(deps: { source: SessionSource; hub: EventHub; assets: Map<string, Asset>;
  allowed: { hostNames: string[]; port: number } }): Hono;
// sse.ts
export function connect(url?: string, opts?: { retryMs?: number }): () => void;   // default retry 1000 ms
// build.ts (CLI): `node packages/web/build.ts` → packages/web/dist/{index.html, app-[hash].js, app-[hash].css, fonts/*, kage-logo-96.png}
// main.ts (CLI): `kage serve [--demo] [--unsafe-listen-all] [--port N]`
```

- [ ] **Step 1: Write the failing tests.**
  - `app.test.ts`: `GET /` returns HTML with `content-encoding: br` when `Accept-Encoding: br` is sent, and with gzip otherwise; a hashed asset gets `cache-control: public, max-age=31536000, immutable`, and `index.html` gets `no-cache` and an `etag` (a matching `If-None-Match` gives 304); `GET /api/events` returns `content-type: text/event-stream` and first a `snapshot`; `DELETE /api/sessions/docs` with `X-Kage: 1` and a valid Origin gives 204, and an unknown id gives 404 `{"error":"No session with id nope"}`; `POST /api/view` with `{"id":"web"}` gives 204; every route returns 403 for `Host: evil.example`.
  - `sse.test.ts` (a fake `EventSource`): an `error` event sets `connection` to `reconnecting` immediately and reconnects after `retryMs`; the next `snapshot` sets it to `live` and replaces the sessions (**review focus 4**).
  - `build.test.ts`: after running the build, `dist/index.html` references exactly one hashed JS and one hashed CSS file, and the gzipped sizes of `index.html` + JS + CSS add up to at most 30 × 1024 bytes.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The esbuild options are `bundle`, `minify`, `format: 'esm'`, `target: 'es2022'`, `jsx: 'automatic'`, `jsxImportSource: 'preact'`, `entryNames: 'app-[hash]'`. Copy the Fonts woff2 files listed in Task 5 from `@fontsource/geist` and `@fontsource/geist-mono`, and the logo, into `dist/`. `index.html` preloads the two 400-weight fonts and the logo. `loadAssets` precompresses everything at startup with `zlib` (brotli quality 11, gzip level 9). `main.ts` loads the config, creates the `EventHub` with `cfg.name` as its `host`, resolves the listen address (printing `ListenError` messages in plain text and exiting with code 1), builds `DemoSource` when `--demo` is given (otherwise it prints `Live sessions arrive in phase 2. Run with --demo for now.` and exits with code 2), and prints `Kage is running at http://<host>:<port>`. The `connection` signal drives a bar under the top bar reading `Reconnecting to my-pc…`, and disables Delete while it's not `live`. `dev` runs the web build in watch mode and `node --watch packages/server/src/main.ts serve --demo`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then run `corepack pnpm build && node packages/server/src/main.ts serve --demo --port 4390`. Expected: it prints `Kage is running at http://<your-tailscale-host>:4390`, and the board opens in a browser on the tailnet.
- [ ] **Step 5: Commit.** `feat: serve the board in demo mode with live SSE updates`

---

### Task 8: Pixel match against the design target, and end-to-end flows

**Files:**
- Create: `playwright.config.ts`, `e2e/visual.spec.ts`, `e2e/board.spec.ts`, `e2e/fonts.ts` (route helper)
- Test: those specs

**Interfaces:**
- Consumes: `kage serve --demo` (Task 7); `docs/design/kage-board.html#full`.

- [ ] **Step 1: Write the specs.**
  - `playwright.config.ts`: Chromium only, `workers: 1`, viewport 1320×900, `deviceScaleFactor: 1`. `webServer` runs `node packages/server/src/main.ts serve --demo --port 4391` with the env `KAGE_DEMO_NOW=1795271520000` (that's `Date.UTC(2026, 10, 21, 14, 32)`), `KAGE_HOST=127.0.0.1` and `KAGE_NAME=my-pc`, so the host pill reads `my-pc` as in the target. Use `page.clock.setFixedTime(1795271520000)` in every test.
  - `e2e/fonts.ts`: `routeGoogleFonts(page)` answers `https://fonts.googleapis.com/css2*` with `@font-face` rules pointing at the app's `/fonts/*.woff2` files (served from `http://127.0.0.1:4391`), and aborts `fonts.gstatic.com`.
  - `visual.spec.ts`: for each state (`needs-you`: initial; `running`: click `shop`; `done`: click `docs`; `delete-confirm`: click `docs`, then `Delete…`), screenshot the target (`file://…/docs/design/kage-board.html#full`, after `routeGoogleFonts` and `document.fonts.ready`) and the app at the same state, pause the cursor animation in both (`.cursor { animation: none }`), compare them with `pixelmatch` (`threshold: 0.1`), and assert that differing pixels are under 0.5% of 1320×900. On failure, write `test-results/<state>-diff.png`.
  - `board.spec.ts`: `j`/`k` move the selection; the delete flow removes `docs` and shows the toast; stopping the server and starting it again shows `Reconnecting to my-pc…`, then the bar disappears and the board shows six sessions again.
- [ ] **Step 2: Run them.** `corepack pnpm build && corepack pnpm test:e2e`. Expected on the first run: the visual spec fails wherever the app doesn't yet match.
- [ ] **Step 3: Fix the CSS and markup until all four states pass.** Change the app, never the target. If something in the target is genuinely wrong, stop and ask the owner.
- [ ] **Step 4: Run them again.** Expected: all e2e specs PASS.
- [ ] **Step 5: Commit.** `test(e2e): pixel match against the design target, board flows`

---

### Task 9: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` ("Quick start" becomes the development quick start, `pnpm dev`, until phase 6 adds the installer), `CONTRIBUTING.md` (if commands differ)

- [ ] **Step 1: Write the workflow.** Trigger on `push` to `main`, `pull_request` and `workflow_dispatch`. Use `ubuntu-latest` with `actions/setup-node` (Node 24, pnpm cache) and `corepack enable`, then run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm exec playwright install --with-deps chromium` and `pnpm test:e2e`. Upload `test-results/` as an artifact on failure. Pin every action to a full commit SHA, with the version in a comment. Set `permissions: contents: read`.
- [ ] **Step 2: Validate it.** Run `corepack pnpm dlx @action-validator/cli .github/workflows/ci.yml` (or `actionlint` if it's installed). Expected: no errors.
- [ ] **Step 3: Run the full local check.** `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm test:e2e`. Expected: all PASS.
- [ ] **Step 4: Commit.** `chore(ci): lint, typecheck, unit, build and e2e on every pull request`

---

**Phase 1 check (spec §9):** all visual tests pass against the design target, and `kage serve --demo` opens the board from a laptop over Tailscale.
