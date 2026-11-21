# Phase 3: Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the board, the developer starts a Claude Code task in a new git worktree and branch, answers its prompts (permission prompts, questions and startup screens), replies or sends a follow-up, stops it, and sees its preview ports and changed files. An optional access token guards all of it.

**Architecture:** Three new server parts sit next to `LiveSource`, which gains a few narrow entry points (`adopt`, `claim`, `abandon`, `target`, `markAnswered`, `markReplied`, `markStopped`, `setPreview`):
- `TaskLauncher` validates a new task, creates the worktree and branch with git, writes the record, and opens a tagged tmux window that runs `claude` directly.
- `SessionControls` turns answer, reply and stop into checked keystrokes. It reads the pane before every key, so no keystroke can approve a prompt the user didn't choose.
- `PreviewTracker` finds listening ports in the pane's process tree and the worktree's changed files, only for sessions a tab is viewing.

An `authGuard` enforces the config `token` with an HMAC cookie. The web board wires the inert controls from phases 1 and 2 and adds the New task form.

**Tech Stack:** as phase 2 (Node ≥ 24.2, TypeScript strict, Hono, Preact + signals, vitest, Playwright, real tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and in the Docker test image). No new runtime dependencies.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md): §5.2 (sessions, new task, permission mode), §5.3 (status), §5.4 (answering), §5.5 (events), §5.7 (ports and files), §5.8 (Stop), §5.10 (security, token), §5.11 (config), §5.12 (API), §6.1, §6.4, §6.5 (UI), §7 (budgets). Backlog items B13, B14, B15 and B17 in [`docs/backlog.md`](../backlog.md) land here. Facts: [`docs/specs/claude-code-integration.md`](../specs/claude-code-integration.md).

## Global Constraints

- Everything in the phase 1 and phase 2 Global Constraints still applies:
  - Node ≥ 24.2, strict mode plus `erasableSyntaxOnly`, no native modules;
  - `execFile` with argument arrays;
  - copy from the design target, colours through tokens;
  - invented test data;
  - tests never touch the user's tmux server, config, state or `~/.claude`;
  - `describe.runIf(hasTmux)` for tmux tests;
  - hooks stay silent.
- **Start point:** branch `phase-3` from `phase-2` once the phase 2 final fix wave has landed. That wave hides Kage's placeholder window and fixes startup-screen detection for new windows, and Task 7 depends on the second fix.
- **Git in tests:** git tests use temp repos (`git init -b main`) with a local `user.name`/`user.email` and the env `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and a temp `HOME`. They never run against a real checkout.
- **Launching Claude (rulings R4 and R19):**
  - Kage runs exactly `<claude> --settings <claude-settings.json> --permission-mode default|acceptEdits -- <task>`. Drop the `--` if Task 1 finds that Claude rejects it; tasks starting with `-` are refused anyway.
  - It never passes `--dangerously-skip-permissions` or any other permission mode.
  - tmux starts the argument vector directly (`new-window … -- argv…`, with no shell and no wrapper), so the pane's command is Claude, and the window closes when Claude exits.
  - The record is saved before the window opens, and the window gets `@kage_id`.
- **Keys:** `TmuxClient.sendKeys` accepts only `1`–`9`, `Enter`, `Escape`, `Up` and `Down`, and `sendText` always uses `-l --`. Every key that answers a prompt follows a fresh `capture-pane` that shows the expected prompt. Kage never sends `Enter` at a permission prompt or a question. A typed reply to one starts with `Escape`.
- **Guards:** every mutating route goes through `hostGuard`, `csrfGuard` (`X-Kage: 1` plus an exact `Origin`) and, with a token set, `authGuard`.
- **Request bodies:**
  - Bodies are validated strictly: exact key sets (an unknown key is a 400), exact types and the limits in `LIMITS`.
  - Error bodies are always `{"error": "<one sentence>"}`.
  - Status codes: 400 for an invalid body, 401 when not signed in, 403 for ownership, 404 for an unknown session or project, 409 for the wrong state or a changed screen, 422 when git or tmux fails, 501 in demo mode, 503 when Claude Code is missing.
- **Timeouts:** tmux calls 5 s (phase 2); git calls 10 s, except `git worktree add` at 60 s. git runs with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`.
- **Ownership:** Stop needs the window's live `@kage_id` to match a record, re-read just before `kill-window`. A failed launch rolls back only the worktree, branch and record that the same request created.
- **Colours:**
  - Lime only for New task, Start, preview links and the existing alive marks.
  - Amber only for needs you.
  - Muted red only for Stop and Delete.
  - Error lines use `--fg` or `--fg-2`, never red or amber.
  - The "kage" wordmark stays off-white.
- **Budget:** the first load stays ≤ 30 KB gzipped (spec §7). It is about 17.0 KB on `phase-2` (index.html 369 B, CSS 2,702 B, JS 13,952 B). Phase 3 must end at ≤ 22 KB, to leave room for phases 4–5. Each UI task prints the build test's `first load gzipped` line in its report. `GET /api/projects` is fetched only when the form opens.
- **Real Claude runs:** at most 6 short prompts in Task 1, and the Phase 3 check at the end. Every other test uses `e2e/fake-claude.mjs`.

## Review Focus

1. **Injection and traversal.** Hostile input must never reach a shell, become a git or Claude option, or escape the worktree folder. The hostile inputs are task, reply, project, base and config values, for example:
   - `--dangerously-skip-permissions` and `-p x`;
   - `../../etc`, `a/../../b` and `$(rm -rf ~)`;
   - `;`, a newline, ESC, NUL and RTL overrides in a reply;
   - a 13 KB task;
   - a branch prefix of `-x` and a `worktreeDir` of `../out`.

   Covered in Tasks 2, 5, 6 and 7, with a test for each example.
2. **No accidental approval.** No sequence of board actions sends a key that approves something the user didn't pick:
   - the screen is read again before every key;
   - Enter is never sent at a permission prompt;
   - a reply at a prompt starts with Escape;
   - Enter after typed text only once the text shows in Claude's input box (the ghost-suggestion hazard).

   Covered in Task 7.
3. **Ownership.** Stop re-reads `@kage_id`, external windows are never stopped, and a rollback touches only what its own request created. Covered in Tasks 6 and 7.
4. **Token login.** The token is compared in constant time. Every `/api/*` route except `auth` and `login` is guarded, including the SSE stream. The cookie is `HttpOnly` and `SameSite=Strict`, failed logins are rate-limited, and the token never appears in a log, a URL or a response. Covered in Task 2.
5. **Idle cost.** Ports are scanned only while a viewed session is running or needs you. File refreshes are debounced and never run concurrently for one session. No tab means no timers beyond phase 2's. Covered in Task 8.
6. **Races.** Covered in Tasks 6 and 7:
   - hooks from a new window before its tag is visible (`claim`);
   - double clicks (a per-session action lock);
   - a prompt that changes between render and click (verify before the key);
   - the transcript's interrupt record after Kage's own Escape (suppressed for 5 s).

## File structure

```
docs/specs/claude-code-integration.md   Task 1: §7 "Starting and answering" (new facts)
docs/specs/host-integration.md          Task 1: recorded git, tmux and port-scan behaviour (new)
packages/shared/src/types.ts            Task 3: protocol v3 (startup flag, filesTotal, ports/files events, API bodies, LIMITS)
packages/server/src/
  auth.ts                 Task 2: authGuard, auth cookie, LoginLimiter
  config.ts               Task 2: token, worktreeDir and branchPrefix validation
  tmux/client.ts          Task 4: newWindow, sendKeys, sendText, windowKageId, killWindow; list-panes (B14)
  tmux/format.ts          Task 4: LIST_PANES_FORMAT, parsePanes, pickPanes
  git/exec.ts             Task 5: GitExec with Kage's git environment and timeouts
  git/projects.ts         Task 5: listProjects, findProject
  control/validate.ts     Tasks 6–7: parseNewTask, parseAnswer, parseReply
  control/slug.ts         Task 6: slugify, uniqueSlug
  control/launcher.ts     Task 6: TaskLauncher, claudeArgv, resolveClaude, LaunchError
  control/keys.ts         Task 7: answerPlan, cursorIndex, inputLine, inputShows
  control/actions.ts      Task 7: SessionControls, ActionError
  pane/prompt.ts          Task 7: parseStartupScreen returns the screen kind
  preview/ports.ts        Task 8: parseSs, parseLsof, parsePs, portsFor, processLabel
  preview/files.ts        Task 8: changedFiles, parseNumstat
  preview/tracker.ts      Task 8: PreviewTracker
  live-source.ts          Tasks 4, 6, 7, 8: the entry points above
  state/store.ts          Task 6: SessionRecord gains base and permissionMode
  app.ts, serve.ts, main.ts  Tasks 2, 5, 6, 7, 8: routes and wiring; B15
packages/server/test/fixtures/          panes/trust.txt, idle-typed.txt, idle-pasted.txt; ports/ss.txt, lsof.txt, ps.txt
packages/web/src/
  api.ts, sse.ts, store.ts, keys.ts     Tasks 2, 3, 9, 10
  components/Login.tsx                  Task 2
  components/NewTask.tsx                Task 9
  components/Ask.tsx, FollowUp.tsx      Task 10 (split out of SessionPanel)
  components/SessionPanel.tsx, SessionList.tsx, PreviewPane.tsx, main.tsx   Tasks 9–10
  styles/board.css                      Tasks 2, 9, 10
e2e/fake-claude.mjs, e2e/live.spec.ts, e2e/login.spec.ts, Dockerfile.test   Task 11
```

---

### Task 0: Phase 2 residuals (from the phase 2 fix-wave re-review)

**Files:** `packages/server/src/hooks/{event,status}.ts`, `live-source.ts`, `serve.ts`, `tmux/client.ts`, `hooks/settings.ts`, `text/{ansi,bounds}.ts`, `transcript/lines.ts`, and their tests.

- [ ] **Step 1: Write the failing tests.**
  - `SessionStart` with `source: "compact"` leaves the status unchanged: a running session stays running, and its `now` line stays. `HookEvent` gains `source: string | null`.
  - The first window of the `kage` session gets `KAGE_SOCKET`: `new-session -e KAGE_SOCKET=<path>`.
  - When a window's pane returns to a shell, `hookSeen` and `idleSeen` reset, so a second `claude` started there gets its startup screens checked.
  - A failure to tag `@kage_placeholder` is logged once and doesn't fail `ensureSession`.
  - `writeHooksSettings` chmods an existing state directory that is looser than 0700, if we own it.
  - `plain`/`plainLine` strip Unicode bidi and format characters (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+2028, U+2029). They cut after `stripAnsi`, so no escape fragment survives.
  - A pane capture that is a strict suffix of the previous one (shrunk) emits a reset.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS on Windows and in the WSL fresh clone.
- [ ] **Step 5: Commit.** `fix(server): phase 2 residuals (compact SessionStart, placeholder socket env, startup re-checks, bidi stripping)`

---

### Task 1: Spike: record how git, tmux and Claude behave for control (throwaway code, tracked notes)

Runs in WSL Ubuntu 24.04 with Claude Code 2.1.330 at `~/.local/node/bin`, signed in. Use the private tmux socket `tmux -L kage-spike3`, scratch repos under `/tmp/kage-spike3`, and the hooks settings from `kage hooks-path`, run with a temp `XDG_STATE_HOME`. Use at most 6 Claude prompts.

**Files:**
- Create: `docs/specs/host-integration.md`
- Modify: `docs/specs/claude-code-integration.md` (a new §7, "Starting and answering")
- Create these invented fixtures:
  - `packages/server/test/fixtures/panes/trust.txt`;
  - `panes/idle-typed.txt` (the idle box with typed text);
  - `panes/idle-pasted.txt` (the box after a long `send-keys -l`, if Claude shows a paste placeholder);
  - `ports/ss.txt`, `ports/ps.txt`;
  - `ports/lsof.txt` (written from the `lsof -F` documentation and marked unobserved: no Mac is available).

**Interfaces:**
- Produces a table of answers for each question below, plus the fixtures.

- [ ] **Step 1: git.** In a repo whose `.worktrees/` doesn't exist yet, run `git -C <repo> worktree add -b kage/x <repo>/.worktrees/x main`. Record:
  - whether git creates the parent folders;
  - the error text when the branch exists and when the path exists;
  - whether `--` before the path is accepted;
  - the output of `git rev-parse --git-path info/exclude` for a normal repo and for a repo whose `.git` is a file;
  - that `git status` in the main checkout lists `.worktrees/` until `/.worktrees/` is in `info/exclude`;
  - `git diff --numstat -z <merge-base>` and `git ls-files --others --exclude-standard -z` output shapes, including a rename and a binary file.
- [ ] **Step 2: tmux.** Record:
  - whether `new-window -d -P -F '#{window_id} #{pane_id}' -t =kage: -n x -c <dir> -e K=V -- /bin/sleep 60` runs `sleep` directly, so that `#{pane_current_command}` is `sleep`;
  - whether a `; set-option -w @kage_id <uuid>` in the same `tmux` invocation, after `new-window -d`, tags the **new** window;
  - whether a 12,000-byte argument passes through `new-window`;
  - whether `send-keys -l -- <2000 bytes>` arrives intact;
  - `list-panes -s -t =kage -F` with `#{@kage_id}` (does the window option resolve per pane?) and `#{pane_dead}`.
- [ ] **Step 3: Claude starting in a new worktree.** Run `claude --settings <f> --permission-mode default -- "say hi in one word"` in a fresh worktree of a repo whose root is already trusted. Record:
  - whether `--` is accepted;
  - whether the folder-trust screen appears for the worktree folder (this answers the open question in integration §6);
  - on the trust screen: whether `Down` moves `❯` to "Yes, I trust this folder", whether `Down` on the last option wraps, and whether `Enter` then accepts.

  Save the screen as `panes/trust.txt` (invented paths).
- [ ] **Step 4: Replies.** Record what each of these does:
  - at a Bash permission prompt, `Escape` followed by `send-keys -l -- "use the other script"` and `Enter`. Does the text become the next prompt? How long until the idle box returns?
  - the same at an AskUserQuestion prompt;
  - at an idle box showing a ghost suggestion, typing text: does the ghost disappear, and is the typed text visible after `❯ `? Save `idle-typed.txt`.
  - `send-keys -l` of 1,500 characters: does Claude show a paste placeholder (for example `[Pasted text #1 +N lines]`) instead of the text? Save `idle-pasted.txt` if so, and record the length where it starts.
- [ ] **Step 5: Ports.** Start `python3 -m http.server 8765 --bind 127.0.0.1` and `node -e "require('http').createServer().listen(8766)"` inside a tmux pane. Record:
  - `ss -ltnpH` output (IPv4, IPv6 and wildcard forms, and the `users:((…))` field);
  - `ps -A -o pid=,ppid=,args=` for the pane's process tree.

  Write `ports/ss.txt` and `ports/ps.txt` from the shapes, with invented pids and paths.
- [ ] **Step 6: Write the notes.**
  - `host-integration.md`: one table each for git, tmux and ports, with versions.
  - `claude-code-integration.md` §7: new-worktree trust, `--`, trust-screen keys, Escape-then-reply, paste placeholder.
- [ ] **Step 7: Commit.** `docs: record git, tmux and Claude behaviour for starting and answering tasks; fixtures`

If a fact breaks a plan assumption, stop and report before Task 4 starts; the controller rules. The fallbacks are already planned:
- no `--` support: omit it;
- the `;` sequence doesn't tag the new window: tag in a second call, and `claim` covers the gap;
- a trust screen per worktree: answer it from the board;
- a paste placeholder: `inputShows` accepts it.

---

### Task 2: Token login (B13) and serve startup hardening (B15)

**Why first:** this phase gives the board the power to start agents and to approve their commands. Today anything on the tailnet that passes the Host and Origin checks can do that, and that includes a shared node or a compromised device. The token is opt-in (`""` keeps today's behaviour), costs nothing on the first load (the form is about 0.5 KB), and must exist before any mutating route ships, so that a config with a token never suggests protection that isn't there.

**Files:**
- Create: `packages/server/src/auth.ts`, `packages/web/src/components/Login.tsx`
- Modify:
  - `packages/server/src/config.ts` (token validation; remove the token warning from `startupWarnings`);
  - `packages/server/src/serve.ts` (remove `TOKEN_REFUSAL` and its check; B15);
  - `packages/server/src/main.ts` (B15 signals);
  - `packages/server/src/app.ts` (auth routes, the guard);
  - `packages/web/src/api.ts`, `sse.ts`, `store.ts`, `main.tsx`, `styles/board.css`
- Test: `auth.test.ts` (new), `app.test.ts`, `config.test.ts`, `main.test.ts`, `packages/web/src/login.test.tsx` (new), `sse.test.ts`

**Interfaces:**
- Produces:

```ts
// server/auth.ts
export const AUTH_COOKIE = 'kage_auth';
export function authCookieValue(token: string): string;          // base64url(HMAC-SHA256(key=token, 'kage-auth-v1'))
export function setCookieHeader(token: string): string;          // kage_auth=<v>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000
export const CLEAR_COOKIE: string;                               // kage_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0
export function isAuthorised(token: string, cookieHeader: string | undefined): boolean;  // true when token === ''; timingSafeEqual on the decoded values
export function authGuard(token: string): MiddlewareHandler;     // /api/* except GET /api/auth and POST /api/login → 401 {"error":"Sign in to Kage"}
export class LoginLimiter { constructor(opts?: { max?: number; windowMs?: number; now?: () => number }); allow(): boolean; fail(): void }  // 5 failures per 60 s, globally
// routes
// GET  /api/auth    → 204 when authorised (or no token), 401 {"error":"Sign in to Kage"}
// POST /api/login   {token: string} exactly → 204 + Set-Cookie | 400 | 401 {"error":"That token isn't right."} | 429 {"error":"Too many tries. Wait a minute and try again."}
// POST /api/logout  → 204 + CLEAR_COOKIE
// config: token is "" or at least 16 characters, else ConfigError "token must be at least 16 characters"
// AppDeps gains: token: string
// serveCommand(args, io, cli) reads io.signal?: AbortSignal (B15)
// web/store.ts
export const authRequired: Signal<boolean>;
// web/api.ts
export function login(token: string): Promise<'ok' | 'wrong' | 'limited' | 'error'>;
```

- [ ] **Step 1: Write the failing tests.**
  - `auth.test.ts`:
    - `isAuthorised('', undefined)` is true;
    - the right cookie passes;
    - a cookie for a different token, a cookie that differs in its last character, an empty cookie and a missing cookie fail;
    - other cookies in the header are ignored;
    - `authCookieValue` never contains the token;
    - the limiter allows 5 failures in 60 s, refuses the 6th, and allows again after the window (fake clock).
  - `app.test.ts`, with a token set:
    - `GET /api/events`, `POST /api/view` and `DELETE /api/sessions/x` without the cookie → 401;
    - with the cookie they behave as before;
    - `GET /` and `/app-*.js` are served without the cookie;
    - `POST /api/login` still needs `X-Kage` and `Origin` (403 without them);
    - a wrong token → 401, and the 6th wrong try in a minute → 429, even with the right token;
    - the right token → 204 with exactly `setCookieHeader(token)`;
    - extra keys → 400;
    - logout clears the cookie;
    - no response body or header contains the token.

    With no token set, everything passes as in phase 2.
  - `config.test.ts`: a token of 15 characters → ConfigError; 16 → ok; `startupWarnings` no longer mentions the token.
  - `main.test.ts`:
    - live mode with a token **starts** (the refusal is gone);
    - B15: an AbortSignal aborted while startup waits on `ensureSession` unwinds what started, prints `Stopped before Kage was ready.` and returns 130;
    - a failing `loadAssets` prints one line, `Couldn't start Kage: <message>`, with no stack trace.
  - `login.test.tsx`:
    - with `authRequired` true, the board renders the top bar (logo and wordmark only) and the form:
      - the text `This Kage needs its access token.`;
      - a password input with placeholder `Access token` and `autocomplete="current-password"`;
      - the button `Sign in`;
    - a wrong token shows `That token isn't right.`;
    - 429 shows `Too many tries. Wait a minute and try again.`;
    - success sets `authRequired` false and reconnects the stream.
  - `sse.test.ts`: on a stream error the client calls `GET /api/auth`; a 401 sets `authRequired` and stops retrying; a 204 retries as before.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The guard reads the `Cookie` header itself, with no cookie library.
  - The limiter counts only failures.
  - `main.ts` installs SIGINT and SIGTERM handlers **before** calling `serveCommand`: the first signal aborts startup, and a second calls `process.exit(130)`.
  - `serveCommand` checks `io.signal` between startup steps and wraps `loadAssets` and `createApp` in the one-line error.
  - Login form CSS: centred in the middle column; `.k-login` input and button reuse the `.k-follow` and `.k-act` styles; Sign in text in lime (it is the one action on screen).
- [ ] **Step 4: Run the tests, then build and the e2e visual spec.** Expected: PASS. The visual diffs are unchanged, and the first-load size is printed.
- [ ] **Step 5: Commit.** `feat(server,web): token login with an HMAC cookie; clean startup interrupts (B13, B15)`

---

### Task 3: Protocol v3

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/demo.ts`, `packages/server/src/source.ts`, `packages/server/src/events.ts`, `packages/server/src/live/session-view.ts`, `packages/web/src/store.ts`, `packages/web/src/sse.ts`
- Test: `packages/shared/src/types.test.ts`, `packages/server/src/events.test.ts`, `packages/web/src/store.test.ts`

**Interfaces:**
- Produces:

```ts
// shared/types.ts (added or changed)
export interface Question { text: string; options: string[]; /** A Claude startup screen (R9): answered by buttons only, no typed reply. */ startup?: boolean }
export interface Session { /* as before */ filesTotal: number }   // files holds at most LIMITS.files entries
export type ServerEvent = /* phase 2 types */
  | { type: 'session.ports'; id: string; ports: Port[] }
  | { type: 'session.files'; id: string; files: FileChange[]; filesTotal: number };
export interface Project { name: string; defaultBranch: string; branches: string[] }
export interface ProjectsResponse { projects: Project[]; last: string | null }
export interface NewTaskBody { project: string; base: string; task: string; acceptEdits: boolean }
export interface NewTaskResponse { id: string }
export interface AnswerBody { option: number }
export interface ReplyBody { text: string }
export interface ApiError { error: string }
export const LIMITS = { taskChars: 4000, replyChars: 4000, textBytes: 12_000, files: 100, projects: 200, branches: 200 } as const;
// server/source.ts: SourceEvent gains the same two variants
```

- [ ] **Step 1: Write the failing tests.**
  - Every demo session has `filesTotal === files.length`.
  - The hub forwards `session.ports` and `session.files` to every stream, whatever each one views.
  - `sameSession` ignores `ports`, `files` and `filesTotal`, which have their own events, and compares `question.startup`.
  - The web store: `session.ports` replaces that session's `ports`; `session.files` replaces `files` and `filesTotal`; both are ignored for an unknown id; `sse.ts` listens for both types.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `toSession` fills `filesTotal: 0` until Task 8 brings real data.
- [ ] **Step 4: Run the tests and the e2e visual spec.** Expected: PASS; visuals unchanged.
- [ ] **Step 5: Commit.** `feat(shared,server,web): protocol v3 — port and file events, startup questions, API bodies`

---

### Task 4: tmux control primitives and split panes (B14)

**Files:**
- Modify: `packages/server/src/tmux/client.ts`, `packages/server/src/tmux/format.ts`, `packages/server/src/live-source.ts` (pass the hook panes it knows to `listWindows`; use `dead` in `#claudeGone`)
- Test: `tmux/format.test.ts`, `tmux/client.test.ts` (fake exec), `tmux/client.int.test.ts` (runIf tmux), `live-source.test.ts`

**Interfaces:**
- Produces:

```ts
// tmux/format.ts
export interface TmuxWindow { /* phase 2 fields */ dead: boolean }   // the chosen pane's #{pane_dead}
export const LIST_PANES_FORMAT: string;   // window_id, @kage_id, pane_id, pane_pid, pane_current_command, pane_current_path, window_name, window_activity, pane_active, pane_dead (tabs)
export function parsePanes(out: string): Array<TmuxWindow & { active: boolean }>;
/** One pane per window: a pane that has sent a hook, else one running `claude`, else the active pane. */
export function pickPanes(panes: Array<TmuxWindow & { active: boolean }>, hookPanes: ReadonlySet<string>): TmuxWindow[];
// tmux/client.ts
export type Key = '1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'Enter'|'Escape'|'Up'|'Down';
export class TmuxClient {
  listWindows(hookPanes?: ReadonlySet<string>): Promise<TmuxWindow[]>;   // now list-panes -s -t =<session>
  newWindow(o: { name: string; cwd: string; env: Record<string, string>; argv: string[]; kageId: string }): Promise<{ windowId: string; paneId: string }>;
  sendKeys(paneId: string, keys: Key[]): Promise<void>;   // send-keys -t <pane> <keys…>; throws TypeError on any other key or a bad pane id
  sendText(paneId: string, text: string): Promise<void>;  // send-keys -t <pane> -l -- <chunk>, chunks ≤ 2000 UTF-8 bytes, split on code points
  windowKageId(windowId: string): Promise<string | null>; // show-options -w -v -t <id> @kage_id; null when unset
  killWindow(windowId: string): Promise<void>;
}
```

`newWindow` runs `new-window -d -P -F '#{window_id}\t#{pane_id}' -t =<session>: -n <name> -c <cwd> [-e K=V]… -- <argv…>`. It tags the window in the same invocation (`; set-option -w @kage_id <id>`) when Task 1 confirmed that this targets the new window; otherwise it calls `setKageId` straight after. It validates the result with `/^@\d+$/` and `/^%\d+$/`. Env names must match `/^[A-Z_][A-Z0-9_]*$/`.

- [ ] **Step 1: Write the failing tests.**
  - format:
    - a window with two panes where the second has sent a hook picks the second;
    - with no hooks, a pane running `claude` wins over the active pane;
    - otherwise the active pane is picked;
    - `pane_dead` `1` gives `dead: true`;
    - malformed lines are skipped.
  - client (fake exec, asserting exact argument arrays):
    - `newWindow` with argv `['/x/claude', '--settings', '/s', '--permission-mode', 'default', '--', '$(rm -rf ~); echo']` passes the last element as one argument after `--`;
    - an env key `A=B` or `lower` throws;
    - `sendKeys('%1', ['C-c' as Key])` throws, and so does `sendKeys('1; kill-server', ['1'])`;
    - `sendText` of 4,500 bytes of mixed ASCII and emoji makes three `-l --` calls whose decoded text joins back to the input;
    - `windowKageId` returns null for empty output.
  - `client.int.test.ts` (real tmux, private socket):
    - `newWindow` with argv `['sleep', '30']` shows `pane_current_command` `sleep`, `@kage_id` set, and the env var reaches the process (a second window with argv `['sh', '-c', 'printenv K > <tmp file>']` writes it);
    - `sendText` then `capture-pane` shows the text in a `cat` window;
    - `killWindow` removes it.
  - LiveSource: a hook from a pane that isn't the window's first pane maps to that window (B14).
- [ ] **Step 2: Run them.** Windows: unit tests FAIL; the integration tests are skipped. In WSL: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): tmux window launch, checked keys and text, ownership reads; pick the right pane in split windows (B14)`

---

### Task 5: Git helper and projects (`GET /api/projects`)

**Files:**
- Create: `packages/server/src/git/exec.ts`, `packages/server/src/git/projects.ts`
- Modify:
  - `packages/server/src/config.ts` (validate `worktreeDir` and `branchPrefix`; env `KAGE_CLAUDE_BIN` → `claudeBin: string | null`);
  - `packages/server/src/app.ts` (the route);
  - `packages/server/src/live-source.ts` (`lastProject()`);
  - `packages/server/src/serve.ts` (wiring)
- Test: `git/projects.test.ts` (temp repos; runs on Windows too, since git is there), `config.test.ts`, `app.test.ts`

**Interfaces:**
- Produces:

```ts
// git/exec.ts
export type GitExec = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
export const gitExec: GitExec;   // execFile('git', args, {cwd, timeout (10 s), maxBuffer 16 MiB, env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'}})
export function firstLine(err: unknown): string;   // first line of git's stderr or the message
// git/projects.ts
export const PROJECT_NAME: RegExp;   // /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/
export function listProjects(root: string, exec?: GitExec): Promise<Project[]>;
export function findProject(root: string, name: string, exec?: GitExec): Promise<(Project & { path: string }) | null>;
// live-source.ts
lastProject(): string | null;   // the project of the newest record (by createdAt)
// app.ts: AppDeps gains projects?: () => Promise<ProjectsResponse>
// GET /api/projects → 200 ProjectsResponse | 501 {"error":"Demo mode can't start tasks."}
// config: worktreeDir relative, segments /^[A-Za-z0-9._-]+$/, none "." or "..";
//         branchPrefix "" or segments /^[A-Za-z0-9._-]+$/ separated by "/", optionally ending in "/", no segment starting with "-" or "." or ending in ".lock", no ".."
```

Rules:
- **Projects** are the folders directly inside `root` whose name matches `PROJECT_NAME` and that contain `.git` (a folder or a file). Repos with no local branch are skipped. Results are sorted by name and capped at `LIMITS.projects`. Up to 8 repos are read at once.
- **Branches** come from `git for-each-ref --format=%(refname:short) refs/heads`, capped at `LIMITS.branches`.
- **`defaultBranch`** is the first match in this order:
  1. `origin/HEAD`'s branch, if it exists locally;
  2. the checked-out branch;
  3. `main`;
  4. `master`;
  5. the first branch.

- [ ] **Step 1: Write the failing tests.**
  - Projects:
    - a root holding repos `api` (branches `main`, `feat/x`), `web` (checked out on `develop`), a plain folder `notes`, a file, a folder named `bad name` and an empty repo lists `api` (default `main`) and `web` (default `develop`) only;
    - a repo whose `.git` is a file (a worktree checkout) is listed;
    - `findProject(root, '../etc')`, `'.'`, `'..'` and `'api/../web'` → null;
    - a project folder that is a symlink inside the root is listed by its link name.
  - Config:
    - `worktreeDir` values `../out`, `/abs`, `a/../b` and `.` → ConfigError; `.worktrees` and `tmp/wt` → ok;
    - `branchPrefix` values `-x/`, `a..b/`, `x.lock/` and `a b/` → ConfigError; `kage/`, `""` and `team/kage/` → ok.
  - App: `GET /api/projects` with a stub returns its JSON; with no `projects` dep → 501; behind the token guard when a token is set.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): git helper, project and branch listing, safe worktree and branch settings`

---

### Task 6: TaskLauncher and `POST /api/sessions`

**Files:**
- Create: `packages/server/src/control/{validate,slug,launcher}.ts`
- Modify:
  - `packages/server/src/state/store.ts` (`base`, `permissionMode`; old records load with `null` and `'default'`);
  - `packages/server/src/live-source.ts` (`adopt`, `claim`, `abandon`; reconcile consults claims);
  - `packages/server/src/app.ts`, `packages/server/src/serve.ts`, `packages/server/src/main.ts` (`KAGE_CLAUDE_BIN` in USAGE)
- Test: `control/validate.test.ts`, `control/slug.test.ts`, `control/launcher.test.ts` (temp repos, fake tmux), `control/launcher.int.test.ts` (runIf tmux: real git and tmux, argv `sleep`), `store.test.ts`, `live-source.test.ts`, `app.test.ts`

**Interfaces:**
- Consumes: `GitExec`, `findProject` (Task 5); `TmuxClient.newWindow` (Task 4).
- Produces:

```ts
// control/validate.ts
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export function parseNewTask(body: unknown): Parsed<NewTaskBody>;
export function hasControlChars(s: string, allowNewlines: boolean): boolean;   // C0, DEL, C1, U+2028/9, bidi overrides U+202A–E and U+2066–9
// control/slug.ts
export function slugify(task: string): string;   // NFKD, strip marks, lowercase, [^a-z0-9]+ → "-", trim "-", ≤ 40 (cut at a "-" when one is in the last 10), "" → "task"
export function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string>;   // base, base-2 … base-99, trimmed to stay ≤ 40; throws after 99
// control/launcher.ts
export class LaunchError extends Error { constructor(readonly status: 400 | 404 | 422 | 503, message: string) }
export function claudeArgv(bin: string, settingsPath: string, acceptEdits: boolean, task: string): string[];
export function resolveClaude(env: NodeJS.ProcessEnv): Promise<string | null>;   // KAGE_CLAUDE_BIN, else the first executable `claude` on PATH
export interface LauncherDeps {
  projectsRoot: string; worktreeDir: string; branchPrefix: string;
  git: GitExec; tmux: Pick<TmuxClient, 'newWindow'>;
  source: Pick<LiveSource, 'adopt' | 'claim' | 'abandon'>;
  claudeBin: string | null; settingsPath: string; hookSocket: string; windowPath: string;   // PATH inside the window
  newId?: () => string; now?: () => number;
}
export class TaskLauncher { constructor(d: LauncherDeps); start(body: NewTaskBody): Promise<NewTaskResponse> }
// state/store.ts
export interface SessionRecord { /* phase 2 */ base: string | null; permissionMode: 'default' | 'acceptEdits' }
// live-source.ts
adopt(record: SessionRecord): Promise<void>;     // adds it, saves at once (awaited), emits it as running with now "Starting Claude…"
claim(kageId: string, windowId: string): void;   // the window is this record's even before @kage_id is visible; drops an ext-<windowId> session if one appeared; re-lists
abandon(kageId: string): Promise<void>;          // launch failed: removes the record and session (session.removed), saves
// POST /api/sessions → 201 NewTaskResponse | 400 | 404 | 422 | 501 | 503
```

Validation messages (400):
- `Expected {"project", "base", "task", "acceptEdits"}`
- `Unexpected field "<k>"`
- `Describe the task in 1–4000 characters.`
- `The task is too long (over 12,000 bytes).`
- `The task can't contain control characters.`
- `The task can't start with "-".`
- `"acceptEdits" must be true or false.`

404 messages:
- `No project named "<p>" in <projectsRoot>.`
- `No branch named "<b>" in <p>.`

The base must be one of the project's listed branches.

`start` runs these steps, serialised per project:
1. Return 503 when `claudeBin` is null: `Claude Code isn't on Kage's PATH. Install it, or set KAGE_CLAUDE_BIN.`
2. Validate (above).
3. Find the slug with `uniqueSlug`. A slug counts as taken when the branch `<prefix><slug>` exists (`show-ref --verify --quiet refs/heads/…`), when the path `<repo>/<worktreeDir>/<slug>` exists, or when a record uses the branch.
4. Assert that the resolved worktree path is inside `<repo>/<worktreeDir>/`.
5. Make sure `/<worktreeDir>/` is a line of `git rev-parse --git-path info/exclude`; append it if missing.
6. Run `git worktree add -b <branch> <path> <base>`. On failure: 422 `git couldn't create the worktree: <first line>`.
7. `adopt` the record (`base`, `permissionMode`, `windowId: null`).
8. `newWindow({name: slug, cwd: path, env: {KAGE_SOCKET: hookSocket, PATH: windowPath}, argv: claudeArgv(…), kageId})`.
9. `claim(kageId, windowId)`.
10. Return `{id: kageId}`.

If a step after step 6 fails: `git worktree remove --force <path>`, then `git branch -D <branch>`, then `abandon`, then 422 `tmux couldn't open a window: <first line>`.

- [ ] **Step 1: Write the failing tests.**
  - `slugify`:
    - `Fix the login bug!` → `fix-the-login-bug`;
    - `Ünïcödé café` → `unicode-cafe`;
    - `日本語` → `task`;
    - a 120-character task → ≤ 40 characters, with no trailing `-`;
    - `--dangerously-skip-permissions` → `dangerously-skip-permissions`.
  - `uniqueSlug`: with `x` and `x-2` taken → `x-3`; the suffix keeps the length ≤ 40.
  - `parseNewTask`: each 400 message above, with one input each, including a 4,001-character task, 3,000 four-byte emoji (over 12,000 bytes), `"a\u001b[2Jb"`, `"‮evil"`, `"-p hi"` and `acceptEdits: "true"`; newlines and tabs inside the task are allowed.
  - `claudeArgv('/c', '/s', true, 'x')` equals `['/c', '--settings', '/s', '--permission-mode', 'acceptEdits', '--', 'x']`; `false` → `'default'`.
  - Launcher (temp repo with `main`, fake tmux, fake source):
    - the worktree exists at `<repo>/.worktrees/<slug>` on branch `kage/<slug>`;
    - `info/exclude` gains `/.worktrees/` once, not again on a second task;
    - the record is adopted before `newWindow` runs (call order);
    - `newWindow` gets `cwd` = the worktree and the exact argv;
    - two concurrent starts with the same task get `…` and `…-2`;
    - an unknown base → 404;
    - `newWindow` throwing removes the worktree and branch, calls `abandon`, and returns 422;
    - a pre-existing branch `kage/<slug>` that Kage didn't create is never deleted (it makes the slug taken instead);
    - `claudeBin` null → 503, with no git call made.
  - Store: a phase 2 state file (no `base` or `permissionMode`) loads with `null` and `'default'`.
  - LiveSource:
    - `adopt` emits a running session with `now` `Starting Claude…`, and the store has saved it;
    - `claim` before the re-list: a window `@7` with no `@kage_id` yet attaches to the record, not as `ext-@7`;
    - `claim` after an `ext-@7` session appeared: `session.removed` for `ext-@7`, then the record's session attaches;
    - `abandon` emits `session.removed`.
  - Integration (WSL): a real `start` with `claudeBin` = a temp script `#!/bin/sh\nexec sleep 30`: the window runs `sleep`, `@kage_id` equals the returned id, and the worktree and branch exist.
  - App: 201 with `{id}`; LaunchError statuses are passed through; demo → 501 `{"error":"Demo mode can't start tasks."}`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `serve.ts` resolves `claudeBin` once at startup and logs nothing when it is missing (the route says it). The window's `PATH` is Kage's `PATH`.
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): start tasks in new worktrees and branches, launched directly and tagged before hooks arrive`

---

### Task 7: Session controls: answer, reply, stop

**Files:**
- Create: `packages/server/src/control/keys.ts`, `packages/server/src/control/actions.ts`
- Modify:
  - `packages/server/src/control/validate.ts` (`parseAnswer`, `parseReply`);
  - `packages/server/src/pane/prompt.ts` (the startup screen kind);
  - `packages/server/src/live-source.ts` (prompt kind per session; `target`, `markAnswered`, `markReplied`, `markStopped`; set `question.startup`);
  - `packages/server/src/app.ts`, `packages/server/src/serve.ts`
- Test: `control/keys.test.ts` (pane fixtures), `control/actions.test.ts` (fake tmux scripted with captures), `pane/prompt.test.ts`, `live-source.test.ts`, `app.test.ts`

**Interfaces:**
- Consumes: `TmuxClient.capturePane`, `sendKeys`, `sendText`, `windowKageId`, `killWindow` (Task 4).
- Produces:

```ts
// pane/prompt.ts
export type StartupKind = 'login' | 'trust' | 'renderer' | 'security' | 'theme';
export interface StartupScreen extends Question { screen: StartupKind }
export function parseStartupScreen(pane: string): StartupScreen | null;
// control/keys.ts
export type PromptKind = 'permission' | 'ask' | StartupKind;
export type KeyPlan =
  | { kind: 'digit'; digit: number }        // send the digit (no Enter)
  | { kind: 'enter' }                       // a one-option screen (security notes, theme "Continue")
  | { kind: 'cursor'; index: number }       // move ❯ to option index (0-based) with Up/Down, verify, then Enter
  | { kind: 'refuse'; reason: string };
export function answerPlan(kind: PromptKind, options: string[], option: number): KeyPlan;
export function cursorIndex(pane: string, options: string[]): number | null;   // which option line carries ❯
export function inputLine(pane: string): string | null;    // the idle box's text after "❯ " ("" when empty); null when no idle box is live
export function inputShows(pane: string, text: string): boolean;   // the box holds the first ≤ 20 characters of text (whitespace collapsed), or the paste placeholder Task 1 recorded
// control/validate.ts
export function parseAnswer(body: unknown): Parsed<AnswerBody>;   // exactly {option}, an integer 1–9
export function parseReply(body: unknown): Parsed<ReplyBody>;     // exactly {text}; trimmed 1–4000 chars, ≤ 12,000 bytes, no control characters (newlines included)
// control/actions.ts
export class ActionError extends Error { constructor(readonly status: 403 | 404 | 409 | 422, message: string) }
export interface ControlTarget { id: string; kageId: string | null; windowId: string | null; paneId: string | null;   // null once the window is gone
  status: SessionStatus; question: Question | null; promptKind: PromptKind | null; external: boolean }
export class SessionControls {
  constructor(d: { tmux: Pick<TmuxClient, 'capturePane' | 'sendKeys' | 'sendText' | 'windowKageId' | 'killWindow'>;
    source: Pick<LiveSource, 'target' | 'markAnswered' | 'markReplied' | 'markStopped'>;
    sleep?: (ms: number) => Promise<void> });
  answer(id: string, option: number): Promise<void>;
  reply(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
}
// live-source.ts
target(id: string): ControlTarget | null;   // null only for an unknown id
markAnswered(id: string): void;   // needs-you → running, question cleared; one check capture 500 ms later: a prompt or startup screen → needs-you with it; the denial line → done
markReplied(id: string): void;    // → running; a transcript interrupt within 5 s doesn't set done (it is Kage's own Escape)
markStopped(id: string): void;    // → ended now; the window-close event confirms
// routes: POST /api/sessions/:id/answer {option} · /reply {text} · /stop → 204 | 400 | 403 | 404 | 409 | 422 | 501
```

`answerPlan` rules:

| Prompt kind | Plan |
|---|---|
| `permission`, `ask`, `renderer` | `digit` |
| `security`, or `theme` with the single option `Continue` | `enter` |
| `trust`, `theme` with numbered options | `cursor` |
| `login` | `refuse`, with `Sign in to Claude Code in the terminal: tmux attach -t <session>.` |

An option outside `1…options.length` refuses with `There's no option <n>.`. The trust and theme screens use the cursor because their options are unnumbered, or numbered but not observed to take digits; the cursor plan reads the screen before and after moving, and only then presses Enter. If Task 1 shows that `Down` wraps, the delta is still computed from the observed `❯` line, never assumed.

Before every key, `SessionControls` captures the pane and checks it:
- **answer:**
  1. The session must be needs-you with a question; otherwise 409 `This session isn't waiting for an answer.`
  2. The capture must show the same prompt: the same option labels, from `parsePermissionPrompt`, or `parseStartupScreen` for startup kinds. Otherwise 409 `The prompt on screen changed. Look again.`
  3. Send the plan's keys. For `cursor`: send `Up`/`Down` × |delta| in one call, capture, and require `cursorIndex === index`, or 409 with the same message and no Enter. Then send Enter.
  4. `markAnswered`.
- **reply:**
  1. 409 for a startup screen (`Answer this screen with its buttons.`), for running (`Claude is still working. Wait for it to finish, or stop it.`) and for ended or windowless sessions (`This session has ended.`). Answer gives 409 `This session has ended.` for those too.
  2. At needs-you: send `Escape`, then poll the capture every 100 ms, at most 10 times, until `inputLine` isn't null and `showsPrompt` is false. Otherwise 409 `Claude didn't return to its input box.`
  3. At done: `inputLine` must not be null, or 409 `Claude isn't at its input box.`
  4. `sendText`, capture, and require `inputShows`. Otherwise 409 `Couldn't type into Claude's input box. Check the terminal.`, with no Enter.
  5. Send `Enter`, then `markReplied`.
- **stop:**
  1. 403 `Kage only stops sessions it started.` for external sessions.
  2. 409 `This session has already ended.` for an ended one, or one without a window.
  3. `windowKageId(windowId)` must equal the record's `kageId`, or 403 `That window isn't Kage's any more.`
  4. `killWindow`, then `markStopped`.

All three:
- 404 `No session with id <id>` for an unknown session.
- One action at a time per session, else 409 `Kage is still sending the last action to this session.`
- A tmux failure → 422 `tmux couldn't send the keys: <first line>`.

- [ ] **Step 1: Write the failing tests.**
  - `keys.test.ts`:
    - `answerPlan` for each row of the table, and option 0, 5 of 4, and 10;
    - `cursorIndex(trust.txt, ['No, exit', 'Yes, I trust this folder'])` → 0;
    - the same screen with `❯` moved → 1;
    - `inputLine` on `idle-typed.txt` → the typed text, on a permission prompt → null, on an empty box → `""`;
    - `inputShows` handles collapsed whitespace and the paste placeholder.
  - `prompt.test.ts`: each startup screen returns its `screen` kind; the phase 2 tests still pass.
  - `actions.test.ts` (fake tmux returning scripted captures):
    - answering 1 on a permission prompt sends exactly `['1']` after one capture;
    - answering when the capture shows different options → 409, with no keys sent;
    - trust option 2: the keys are `['Down']`, then a capture, then `['Enter']`;
    - trust where the second capture still shows `❯` on "No, exit" → 409, with no Enter;
    - login → 409, with no keys;
    - reply at a permission prompt: `['Escape']`, the captures until the idle box shows, `sendText`, a capture, `['Enter']`, in that order;
    - reply at done when `inputShows` is false → 409 and **no Enter**;
    - reply at done never sends Enter before `sendText` (the ghost-suggestion guard);
    - reply while running → 409;
    - stop on an external session → 403, with no tmux call;
    - stop when `windowKageId` returns another UUID → 403, with no kill;
    - two concurrent `answer` calls → the second is 409;
    - a `sendKeys` rejection → 422, and the lock is released.
  - `parseReply`: newline, ESC, NUL, `‮` and 4,001 characters → 400; the text is trimmed.
  - LiveSource:
    - `markAnswered` turns needs-you to running and clears the question; a check capture showing a new prompt → needs-you with it (a multi-question AskUserQuestion); a capture showing the denial line → done;
    - after `markReplied`, a transcript interrupt within 5 s keeps running, and one after 5 s sets done;
    - `markStopped` → ended;
    - `target` returns `promptKind` `ask` after an AskUserQuestion PreToolUse, `permission` after a PermissionRequest capture, and `trust` for the trust screen;
    - `question.startup` is true for startup screens.
  - App: each route validates (400), maps ActionError statuses, needs the CSRF headers, and returns 501 in demo mode (`Demo mode can't run tasks.`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The 500 ms check reuses `#processCapture`, with the gen bumped by `markAnswered`, so a stale capture can't undo it.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): answer, reply and stop with screen checks before every key`

---

### Task 8: Preview data: ports and changed files

**Files:**
- Create: `packages/server/src/preview/{ports,files,tracker}.ts`
- Modify:
  - `packages/server/src/live-source.ts` (ports, files and filesTotal per session; `setPreview`; tracker notifications on view changes, edit hooks and Stop);
  - `packages/server/src/serve.ts` (the real scanners on Linux and macOS; none elsewhere)
- Test: `preview/ports.test.ts` (fixtures), `preview/files.test.ts` (temp repos), `preview/tracker.test.ts` (fake clock), `live-source.test.ts`

**Interfaces:**
- Produces:

```ts
// preview/ports.ts
export interface Listener { port: number; address: string; pid: number }
export interface Proc { pid: number; ppid: number; args: string }
export function parseSs(out: string): Listener[];     // ss -ltnpH: "127.0.0.1:5173", "[::1]:5173", "*:3000", "0.0.0.0:8080"; users:(("node",pid=4242,fd=23))
export function parseLsof(out: string): Listener[];   // lsof -iTCP -sTCP:LISTEN -nP -F pn
export function parsePs(out: string): Proc[];         // ps -A -o pid=,ppid=,args=
export function processLabel(args: string): string;   // "node /p/node_modules/.bin/vite --port 5173" → "vite"; interpreters node, bun, deno, python, python3, ruby: the first non-option argument's basename without extension; else the program's basename; at most 20 chars
export function portsFor(panePid: number, listeners: Listener[], procs: Proc[]): Port[];   // the pane pid and its descendants; one entry per port, sorted; localOnly when every address is 127.0.0.0/8 or ::1
export function scanCommands(platform: NodeJS.Platform): { listeners: [string, string[]]; procs: [string, string[]] } | null;   // null off Linux and macOS
// preview/files.ts
export function parseNumstat(out: string): FileChange[];   // -z, renames → the new path; binary "-" → 0
export function changedFiles(worktree: string, base: string | null, exec?: GitExec): Promise<{ files: FileChange[]; total: number }>;
// preview/tracker.ts
export interface PreviewTarget { id: string; worktree: string; base: string | null; panePid: number | null; active: boolean }   // active: running or needs-you
export class PreviewTracker {
  constructor(d: { target: (id: string) => PreviewTarget | null;
    publish: (id: string, patch: { ports?: Port[]; files?: FileChange[]; filesTotal?: number }) => void;
    scan: (() => Promise<{ listeners: Listener[]; procs: Proc[] }>) | null;
    files: (worktree: string, base: string | null) => Promise<{ files: FileChange[]; total: number }>;
    portEveryMs?: number /* 5000 */; filesDebounceMs?: number /* 500 */ });
  setViewed(ids: ReadonlySet<string>): void;   // newly viewed ids: ports and files now
  touch(id: string, reason: 'edit' | 'stop'): void;   // edit: files (debounced); stop: files and ports
  forget(id: string): void;
  stop(): void;
}
// live-source.ts
setPreview(id: string, patch: { ports?: Port[]; files?: FileChange[]; filesTotal?: number }): void;   // emits session.ports / session.files only on a real change
```

Rules:
- **Changed files:**
  1. `mb` = `git merge-base <base> HEAD`, or `HEAD` when the base is null or missing.
  2. Tracked changes come from `git diff --numstat -z <mb>`: commits on the branch plus uncommitted work.
  3. Untracked files come from `git ls-files --others --exclude-standard -z`, each with `added` = its line count. A file is counted only when its resolved path is inside the worktree, it isn't a symlink, it is ≤ 1 MiB, and there is no NUL in its first 8 KiB; otherwise 0. At most 100 untracked files are read.
  4. The list is sorted by path, `files` is capped at `LIMITS.files`, and `total` is the full count.
- **Port timer:**
  - It runs every 5 s only while some viewed session is `active`.
  - One scan serves every viewed session.
  - A scan never overlaps another.
- **File refreshes:** one git run at a time per session; a touch during a run queues one more run.
- **Edit hooks:** a `PostToolUse` whose `toolName` is `Edit`, `Write`, `MultiEdit` or `NotebookEdit`.
- **External sessions:** they use their pane's cwd as the worktree, with a null base.

- [ ] **Step 1: Write the failing tests.**
  - ports:
    - `ss.txt` parses every listener, IPv6 included;
    - `lsof.txt` too;
    - a vite under `sh → node` under the pane pid is found, while a listener of an unrelated pid isn't;
    - `127.0.0.1` only → `localOnly: true`;
    - `0.0.0.0`, `*` or a Tailscale IP → false;
    - the same port on `127.0.0.1` and `::1` → one entry, local-only;
    - `processLabel` for vite, `python3 -m http.server` → `http.server`, `/usr/bin/caddy run` → `caddy`, and an `args` of 300 characters.
  - files (temp repo; branch off `main`, one commit, then working-tree changes):
    - a committed edit, an uncommitted edit, a rename, a binary file and an untracked 3-line file → the expected counts;
    - a symlink pointing outside the worktree → counted 0 and never read;
    - 150 changes → `files.length` 100, `total` 150;
    - a missing base → diffs against HEAD.
  - tracker (fake clock):
    - no viewed sessions → no timers (assert with `vi.getTimerCount()`);
    - viewing an active session scans once now and every 5 s; viewing a done one scans once and arms no timer;
    - five `touch(id, 'edit')` in 100 ms → one files run 500 ms after the last;
    - a touch during a run → exactly one more run;
    - `publish` is called only when the value changed;
    - `stop()` clears everything.
  - LiveSource:
    - a PostToolUse Edit hook calls `touch(id, 'edit')`, and Stop calls `touch(id, 'stop')`;
    - `setPreview` emits `session.files` with `filesTotal`, but nothing when the value is unchanged;
    - `toSession` carries the latest ports and files.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): preview ports from the pane's process tree and changed files against the merge base`

---

### Task 9: Board: the New task form

**Files:**
- Create: `packages/web/src/components/NewTask.tsx`
- Modify:
  - `packages/web/src/components/SessionList.tsx` (the button opens the form; the form replaces the button while open);
  - `packages/web/src/main.tsx` (the empty state);
  - `packages/web/src/store.ts` (`newTaskOpen`, `selectWhenSeen`);
  - `packages/web/src/api.ts` (`apiGet`);
  - `packages/web/src/keys.ts` (`N`, Esc);
  - `packages/web/src/styles/board.css` (`.k-nt-*`)
- Test: `packages/web/src/components/newtask.test.tsx` (new), `keys.test.ts`, `store.test.ts`

**Interfaces:**
- Consumes: `GET /api/projects`, `POST /api/sessions` (Tasks 5 and 6); `LIMITS` (Task 3).
- Produces:

```ts
export const newTaskOpen: Signal<boolean>;
/** After a start: select this id as soon as a session.updated brings it (keepSelection must not drop it first). */
export const selectWhenSeen: Signal<string | null>;
export function apiGet(path: string): Promise<Response>;
```

Form (left column top, 250 px; the copy is exact):

| Part | Copy and behaviour |
|---|---|
| Task | `<textarea rows=3 maxlength=4000>` with placeholder `What should Claude do?`, focused on open. Enter starts; Shift+Enter adds a new line. |
| Project | label `Project` (`--fg-3`, 12 px), a native `<select>`. Defaults to `last`, else the first project. Changing it sets the branch to that project's `defaultBranch`. |
| Branch | label `Branch off`, a `<select>` of the project's branches |
| Checkbox | `Accept edits automatically`, unchecked on every open; hint under it (`--fg-3`, 12 px): `Claude still asks before it runs commands.` |
| Buttons | `Start` with kbd `↵`, lime text and the `.k-act` outline; `Cancel` with kbd `Esc`, `.k-act` |
| While loading | the selects are disabled and show `Loading…` |
| No projects | `No git repositories in <projectsRoot>.` (`--fg-2`) with Start disabled |
| While starting | Start reads `Starting…` and everything is disabled |
| Error | one line under the buttons, `--fg`: `Couldn't start: <server error>` |
| Empty state (middle column) | `No sessions yet`, then `Start a task: Kage makes a git worktree and branch for it and runs Claude there.` (`--fg-2`) and a lime `＋ New task` button that opens the form |

`N` opens the form (ignored while typing), and `Esc` closes it. Start is disabled while the stream is down (spec §6.5) or the task is blank. A 201 closes the form and sets `selectWhenSeen`. Demo mode shows the 501 message as the error line.

- [ ] **Step 1: Write the failing tests.**
  - Clicking `＋ New task` or pressing `N` opens the form, with the textarea focused; `N` typed inside the textarea doesn't reopen or close anything.
  - The projects fetch happens on open and not before; the selects default to `last` and its `defaultBranch`; changing the project resets the branch.
  - Enter posts exactly `{project, base, task, acceptEdits}`, with the task trimmed; Shift+Enter doesn't post; a blank task doesn't post.
  - A 201 closes the form, and the board selects the new id once its `session.updated` arrives, even though `keepSelection` ran in between.
  - A 422 shows `Couldn't start: <error>` and keeps the text; Esc closes and the next open is clean.
  - The empty state shows the copy above, and its button opens the form.
  - The checkbox is unchecked on every open.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use native controls styled with tokens: `--line-strong` outlines, `--bg` fields, Geist 13.5 px, and lime focus at low opacity (spec §10). The closed state stays pixel-identical to the target.
- [ ] **Step 4: Run the unit tests, then build and the e2e visual spec.** Expected: PASS; visual diffs under 0.5% in all four states. Report the first-load size.
- [ ] **Step 5: Commit.** `feat(web): New task form with project and branch pickers and the accept-edits option`

---

### Task 10: Board: answer, reply, follow-up, Stop, preview links

**Files:**
- Create: `packages/web/src/components/Ask.tsx`, `packages/web/src/components/FollowUp.tsx`
- Modify:
  - `packages/web/src/components/SessionPanel.tsx` (use them; wire Stop);
  - `packages/web/src/components/PreviewPane.tsx`;
  - `packages/web/src/store.ts` (`replyOpen`, `busy`, `actionError`);
  - `packages/web/src/keys.ts` (`1`–`9`, `R`, `X`);
  - `packages/web/src/styles/board.css`
- Test: `packages/web/src/components/board.test.tsx`, `keys.test.ts`

**Interfaces:**
- Consumes: the answer, reply and stop routes (Task 7); `session.ports` and `session.files` (Tasks 3 and 8).
- Produces:

```ts
export const replyOpen: Signal<boolean>;                       // the reply field under a question is open
export const busy: Signal<ReadonlySet<string>>;                // session ids with an action in flight
export const actionError: Signal<{ id: string; text: string } | null>;   // cleared on select and on the next action
export function act(id: string, path: 'answer' | 'reply' | 'stop', body?: unknown): Promise<boolean>;
```

Behaviour (the copy is exact; the design target where it shows the element):
- **Answer buttons** post `{option: i + 1}`. Keys `1`–`9` do the same for the selected needs-you session when that option exists. Everything is disabled while busy or disconnected.
- **`or press R to reply`:**
  - It is shown only for non-startup questions. Clicking it or pressing `R` opens a field under the options, with the `.k-follow` look, placeholder `Reply instead of choosing…` and kbd `Esc`.
  - Enter posts `{text}`, and Esc closes the field.
  - For a startup screen the hint is hidden. The login screen shows, in `--fg-3`: `Open the session's terminal (tmux attach) and sign in there.`
- **Follow-up (done, not ended):**
  - The target's `.k-follow` becomes a real `<input>`, with placeholder `Follow up in this session…` and the kbd `R` placed as in the target.
  - `R` focuses it, and Enter posts `{text}` and clears it on success. It must look exactly like the target's div at rest.
- **Stop** (footer, `X`) posts stop. It is disabled while busy, and it is never shown for external sessions (phase 2).
- **Errors:** one line above the footer, in `--fg-2`: `Couldn't send: <server error>`.
- **Ports:**
  - A card that isn't local-only is `<a class="k-port" href="http://<location.hostname>:<port>/" target="_blank" rel="noopener noreferrer">`, with `:<port> <process>` and the lime `Open ↗`.
  - A local-only card is a `<div class="k-port local">` with `Only on this machine` (`--fg-3`) in place of `Open ↗`, and under it a mono `--fg-3` line, `ssh -L <port>:localhost:<port> <location.hostname>`, with the title `Run this on your laptop, then open http://localhost:<port>`.
- **Files:** the header is `Files changed · <filesTotal>`. When `filesTotal > files.length`, a last row reads `and <n> more` (`--fg-3`). View diff stays inert until phase 4.

- [ ] **Step 1: Write the failing tests.**
  - Clicking `2` on the needs-you card posts `{option: 2}` to `/api/sessions/<id>/answer` with `X-Kage: 1`; key `2` does the same; key `5` with two options does nothing; keys while typing in a field do nothing.
  - The buttons are disabled while that session is busy.
  - `R` on needs-you opens the reply field focused; Enter posts `{text}`; Esc closes; a startup question has no hint and `R` does nothing; the login question shows the terminal line.
  - The done session's follow-up input: `R` focuses it; Enter posts and clears on 204; on 409 the text stays and the error line shows `Couldn't send: <error>`.
  - Stop posts; `X` does the same for a running session; external sessions have no Stop and `X` does nothing.
  - Port cards: a link card has the exact href, target and rel; a local-only card has no `<a>` and shows the ssh line; demo data still renders as in the target.
  - `filesTotal` 150 with 100 files shows `Files changed · 150` and `and 50 more`.
  - `actionError` clears on selecting another session.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `INERT` from every wired control. Terminal, Archive, Resume, Pin and View diff stay inert until phase 4.
- [ ] **Step 4: Run the unit tests, then build and the e2e visual spec.** Expected: PASS; visual diffs under 0.5% (the follow-up input and the link cards must match the target pixel for pixel). Report the first-load size: ≤ 22 KB.
- [ ] **Step 5: Commit.** `feat(web): answer, reply, follow-up and Stop from the board; preview links and local-only ports`

---

### Task 11: Live e2e: start, answer, reply, stop with the fake Claude; login e2e

**Files:**
- Modify: `e2e/fake-claude.mjs`, `e2e/live.spec.ts`, `Dockerfile.test` (add `git`), `playwright.config.ts` (login spec in the `chromium` project)
- Create: `e2e/login.spec.ts`
- Git: mark `e2e/fake-claude.mjs` executable (`git update-index --chmod=+x`)

**Interfaces:**
- Consumes: everything above. Kage launches the fake through `KAGE_CLAUDE_BIN`.

**Fake Claude changes:**
- **Arguments:**
  - It accepts Claude's form, `--settings <f> --permission-mode <m> [--] <task>`, and still the phase 2 form `<scenario>`.
  - The scenario is the task's first word when it is `edit-and-test`, `needs-permission` or `trust-first`, else `edit-and-test`.
  - It writes its argv as JSON to `$FAKE_CLAUDE_DIR/argv-<sessionId>.json`.
- **Idle box:**
  - Printable keys go into the box, which is redrawn as `❯ <text>`. Enter on a non-empty box runs a follow-up turn:
    1. a user record;
    2. `UserPromptSubmit`;
    3. the say line `You said: <text>`;
    4. `Stop`.
  - Enter on an empty box does nothing.
  - It exits on `/exit` then Enter, Ctrl+C or Ctrl+D, after firing SessionEnd. The phase 2 test that sent `q` now sends `/exit` and Enter.
- **Escape at the prompt:** it writes the R11 denial and returns to the idle box (no hook), so a reply can follow.
- **`trust-first`:**
  - Before SessionStart, it draws the folder-trust screen exactly like `panes/trust.txt`, with `❯` on `No, exit`.
  - `Down` and `Up` (`\x1b[B`/`\x1bOB`, `\x1b[A`/`\x1bOA`) move `❯`. `Enter` on `Yes, I trust this folder` continues as edit-and-test; on `No, exit` it exits with no hook.

- [ ] **Step 1: Extend the fake** as above.
- [ ] **Step 2: Extend `live.spec.ts`.**
  - `beforeAll`:
    - `projects/demo` and `projects/shop` become git repos (`git init -b main`, an invented README, one commit, local user config);
    - `config/kage/config.json` = `{"projectsRoot": "<root>/projects"}`;
    - `KAGE_CLAUDE_BIN` = the fake;
    - git env as in Global Constraints.
  - New tests, in order:
    1. **Start from the board:**
       - open New task, type `edit-and-test Make greet() lowercase`, project `demo`, branch `main`, press Enter;
       - the session is selected, with branch `kage/edit-and-test-make-greet-lowercase`;
       - `<root>/projects/demo/.worktrees/edit-and-test-make-greet-lowercase` exists, and `info/exclude` contains `/.worktrees/`;
       - the argv file contains `--permission-mode`, `default` and a `--settings` path ending `claude-settings.json`;
       - the window's `@kage_id` equals the session id;
       - the lines arrive, and the chip reaches `done`.
    2. **Answer from the board:**
       - start `needs-permission Clear the build cache` with **Accept edits automatically** checked;
       - the argv shows `acceptEdits`;
       - `Waiting for you` with four buttons; press key `1`;
       - chips `needs you → running → done`; the last line is `The build cache is cleared.`
    3. **Follow-up:** on that done session, type `Say hello` in the follow-up field and press Enter. The lines gain `> Say hello` and `You said: Say hello`, and the chips go `running → done`.
    4. **Reply at a prompt:** start `needs-permission Clear the cache again`; at the prompt press `R`, type `Use the cache script instead` and press Enter. The board reaches done, then shows `> Use the cache script instead` and `You said: …`, and never shows `running` before the reply was sent.
    5. **No from the board (B17):** start `needs-permission One more`, then click `4 No`. The board reaches done, with no question; the pane shows the denial line.
    6. **Startup screen:** start `trust-first Check the folder`. The card shows `Trust this folder?` with `No, exit` and `Yes, I trust this folder`, and the row reads `waiting for your reply`. Click `Yes, I trust this folder`; the chip goes running, then done.
    7. **Stop:**
       - select test 1's session and click Stop;
       - the chip becomes `ended`, and the window is gone;
       - the worktree folder still exists, and `git branch --list kage/edit-and-test-make-greet-lowercase` is non-empty;
       - `POST /api/sessions/ext-…/stop` for a plain external `sh` window, with valid CSRF headers, returns 403 and the window lives.
- [ ] **Step 3: Write `login.spec.ts`.** It starts its own `kage serve --demo --port 4394` with a temp `XDG_CONFIG_HOME` whose config has `"token": "e2e-token-0123456789"`, and checks:
  - `/` shows the login form;
  - a wrong token shows `That token isn't right.`;
  - the right token shows the board with `my-pc`;
  - a reload stays signed in;
  - `fetch('/api/events')` from a fresh context returns 401.
- [ ] **Step 4: Run.** `corepack pnpm test:linux`: everything passes in the container, three runs in a row. Then on Windows: the unit tests and the chromium e2e (visual, board, login) pass.
- [ ] **Step 5: Commit.** `test(e2e): start, answer, reply, No, startup screen and stop from the board; token login`

---

### Task 12: Docs

**Files:**
- Modify:
  - `docs/specs/2026-11-21-kage-design.md`: amendments marked "(amended 2026-11-21, phase 3)":
    - §5.1: the record gains `base` and `permissionMode`.
    - §5.2: the exact argv; direct launch with `-e KAGE_SOCKET` and `PATH`; the window closes when Claude exits; tagging plus `claim`; slugs; the `info/exclude` entry `/<worktreeDir>/`; rollback; serialisation per project.
    - §5.4: answer plans (digit, Enter, verified cursor); the screen check before every key; a reply at a prompt is Escape then the text; Enter only after the typed text shows; the post-answer check; the interrupt suppression.
    - §5.5: `session.ports` and `session.files`, broadcast; caps.
    - §5.7: the `ps` process tree, process labels, files against the merge base plus untracked, `GIT_OPTIONAL_LOCKS=0`.
    - §5.10: the token is ≥ 16 characters, with the HMAC cookie, `/api/auth`, `/api/login`, `/api/logout` and the limiter.
    - §5.11: `worktreeDir` and `branchPrefix` validation; `KAGE_CLAUDE_BIN`.
    - §5.12: the new routes and the status codes.
    - §6.5: the New task form, login and local-only port copy.
  - `docs/backlog.md`: mark B13, B14, B15 and B17 done; add anything found and deferred.
  - `docs/plans/README.md`: phase 3 built.
  - `README.md`: "Start a task from the board" and the token in the config example.
  - `main.ts` USAGE: already updated in Task 6.

- [ ] **Step 1: Update the docs** as listed, in the house style (short sentences, exact commands).
- [ ] **Step 2: Run** `corepack pnpm lint`. Expected: clean.
- [ ] **Step 3: Commit.** `docs: control — new tasks, answering, replies, stop, preview data, token login`

---

**Phase 3 check (spec §9):** in WSL, run `kage serve` (bound to 127.0.0.1, or the Tailscale IP when it is up) with `projectsRoot` holding a scratch git repo, and real `claude` 2.1.330. From the Windows browser:
1. Start a task in a new worktree (`Create hello.txt with one line, then run cat hello.txt`), and see it running in its own branch and worktree.
2. Answer its edit and Bash prompts from the board, and see it done.
3. Send a follow-up from the board and see it run.
4. Stop it from the board: the window is gone, and the worktree and branch remain.
5. See its changed files on the right, and a preview card for a port it opened, if the task opens one.

Then set a 16-character token, restart, and confirm that the board asks for it.
