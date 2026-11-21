# Phase 2: Live Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kage shows real Claude Code sessions running in the tmux session `kage`, with live status (running, needs you, done, ended) from Claude's hooks and live output from Claude's transcript, replacing the demo data when `kage serve` runs without `--demo`.

**Architecture:** A `LiveSource` implements the existing `SessionSource` interface. It combines four inputs: a `TmuxClient` (one-shot `tmux` commands) and `TmuxWatcher` (one control-mode client for window and activity events), a `HookServer` that receives events from the `kage hook` CLI over a Unix socket, `TranscriptTail` readers that turn Claude's JSONL transcript into display lines, and a `StateStore` for what tmux and git don't know. The SSE hub gains per-tab stream ids so output lines go only to the tab viewing that session.

**Tech Stack:** as phase 1 (Node ≥ 24.2, TypeScript strict, Hono, Preact + signals, vitest, Playwright). Real tmux 3.4 in WSL Ubuntu 24.04 and in a Docker test image; no new runtime dependencies.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md) — §5.2 (sessions), §5.3 (status), §5.4 (output), §5.5 (live updates, amended for stream ids), §5.8a (restarts), §5.10 (security), §5.11 (config). Backlog items B1–B8 and B12 in [`docs/backlog.md`](../backlog.md) land here.

## Global Constraints

- Everything from the phase 1 plan's Global Constraints still applies (Node ≥ 24.2, strict + `erasableSyntaxOnly`, no native modules, `execFile` with argument arrays, copy from the design target, colours via tokens, 30 KB first-load budget, invented test data).
- **Tests never touch the user's real tmux server, config or state.** tmux tests use a private socket (`tmux -L kage-test-<random>`), set through `KAGE_TMUX_SOCKET`; every test that writes state or config uses a temp `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`.
- **Hooks must never disturb Claude.** `kage hook` prints nothing on stdout or stderr (Claude adds some hooks' stdout to its context), and exits 0 within 2 s whether or not the Kage server is reachable.
- **Real transcripts never enter the repo.** Fixtures are hand-written to match the shapes recorded in Task 1; they contain invented text only.
- Unit tests keep passing on Windows; tests that need tmux use `describe.runIf(hasTmux)` and run in WSL, in the Docker test image (Task 11) and in CI.
- Status rules (spec §5.3, owner rulings 2026-11-21): only permission prompts and `AskUserQuestion` make a session **needs you**; Claude's idle notification never does; `Stop` means **done**; a session whose `claude` process is gone is **ended**.
- Ownership: a window is Kage's only if its tmux option `@kage_id` matches a record (§5.2). External windows are shown and marked external.
- Live mode refuses to start while `token` is set in the config (backlog B8), with the message `"token" is set, but token login isn't built yet. Remove it from the config to run live sessions.`

## Review Focus

1. **The Kage server is down when hooks fire:** `kage hook` still exits 0 within 2 s and prints nothing; when the server comes back, status is rebuilt from the transcript tail and tmux. Covered in Task 6 and Task 9.
2. **Odd transcript content:** a half-written last line, a 5 MB tool result, invalid UTF-8, unknown record types and unknown content-block types must never crash the reader; long outputs are truncated. Covered in Task 7.
3. **tmux disappears:** no tmux server, no `kage` session, or the server killed while Kage runs: Kage creates the session, the watcher restarts with backoff (1 s doubling to 30 s), and the board shows the sessions as ended rather than crashing. Covered in Task 5 and Task 9.
4. **Busy sessions:** 30 windows and fast output must not flood the browser: activity-driven updates are throttled to at most 4 per second per session, and the server stays near idle when nothing changes. Covered in Task 5 and Task 9.
5. **Hostile text in output:** HTML, ANSI escape sequences and control characters from transcripts or pane captures render as plain text; ANSI sequences are stripped from pane captures. Covered in Task 7 and Task 8.

## File structure

```
docs/specs/claude-code-integration.md      Task 1: recorded facts about hooks, settings and transcripts
packages/shared/src/types.ts               v2 protocol: streamId, projectsRoot, session.lines, now
packages/server/src/
  tmux/client.ts        TmuxClient: execFile wrapper (session, windows, capture, options)
  tmux/watcher.ts       TmuxWatcher: control-mode events (window add/close, activity)
  tmux/format.ts        list-windows format string and parser
  hooks/cli.ts          `kage hook <event>`: stdin → Unix socket, silent, ≤ 2 s
  hooks/settings.ts     writes Claude settings with Kage's hooks; `kage hooks-path`
  hooks/server.ts       HookServer: POST /hook on the Unix socket
  hooks/status.ts       nextStatus(): pure status reducer
  transcript/tail.ts    TranscriptTail: follow a JSONL file from an offset
  transcript/lines.ts   toDisplayLines(), questionFrom(), nowLine()
  pane/prompt.ts        parsePermissionPrompt(), paneLines() (ANSI-stripped fallback)
  state/store.ts        StateStore: ~/.local/state/kage/state.json, atomic writes
  live-source.ts        LiveSource implements SessionSource
  events.ts             (modified) stream ids, view routing, backpressure
  app.ts, main.ts       (modified) /api/view v2, live mode, CLI commands
packages/server/test/fixtures/             transcripts, hook payloads, pane captures (invented)
packages/web/src/                          (modified) store, sse, Output, SessionPanel, TopBar
e2e/fake-claude.mjs                        stand-in for claude: hooks + transcript + prompt
e2e/live.spec.ts                           live board against real tmux (runIf tmux)
Dockerfile.test, scripts/test-linux.sh     Linux test image and runner
```

---

### Task 1: Spike — record how Claude Code behaves (throwaway code, tracked notes)

Runs in WSL Ubuntu 24.04 (`wsl -d Ubuntu-24.04`), with Node 24 and Claude Code at `~/.local/node/bin` and the owner signed in to Claude Code there. Use a scratch git repo at `/tmp/kage-spike` and a private tmux socket `tmux -L kage-spike`. Keep prompts tiny (each run uses the owner's Claude plan).

**Files:**
- Create: `docs/specs/claude-code-integration.md`, `packages/server/test/fixtures/hooks/*.json`, `packages/server/test/fixtures/transcripts/*.jsonl`, `packages/server/test/fixtures/panes/*.txt`
- Throwaway (not committed): a logging hook script in `/tmp/kage-spike`

**Interfaces:**
- Produces: the facts below, in `claude-code-integration.md` (a table per question, with the Claude Code version), and invented fixtures that mirror every observed shape.

- [ ] **Step 1: Hooks.** Start `claude --settings /tmp/kage-spike/settings.json` in a tmux window, with a hook command for every event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`) that appends `{event, env: {TMUX_PANE}, stdin}` to a log. Record:
  - whether `--settings <file>` is accepted and merges with the user's own settings;
  - each event's stdin fields, especially `session_id`, `transcript_path`, `cwd` and the `Notification` fields that distinguish a permission prompt from the idle notice (`notification_type`, or the message text);
  - whether `TMUX_PANE` is in the hook's environment;
  - the order of events for one prompt that edits a file and runs a command.
- [ ] **Step 2: Permission prompt in the pane.** Trigger a permission prompt (a Bash command in default mode). Save `tmux capture-pane -p -J` output as a fixture (replace any real paths with invented ones). Record which keystroke answers option 1 and option 2 (`send-keys 1` vs. arrow + Enter).
- [ ] **Step 3: AskUserQuestion.** Prompt Claude to ask a multiple-choice question. Record the transcript record shape of the `AskUserQuestion` tool call (where the question text and options are) and how a numbered answer is sent.
- [ ] **Step 4: Transcript shapes.** From the session's JSONL, record the shapes Kage needs, and only those: assistant text blocks, `tool_use` blocks (name and the input fields for Read, Edit, Write, Bash, Grep/Glob, AskUserQuestion), user `tool_result` blocks (text and error), and how a session start and end look. List every other record type seen, as "ignore".
- [ ] **Step 5: Idle and exit.** Record whether the idle `Notification` arrives and after how long; what the pane shows and which process is in the pane (`#{pane_current_command}`) after `/exit`.
- [ ] **Step 6: Write the notes and fixtures.** Write `docs/specs/claude-code-integration.md`, and hand-write invented fixtures in the observed shapes: `transcripts/edit-and-test.jsonl` (a say line, Read, Edit with a one-line change, Bash running tests with a PASS summary), `transcripts/ask-question.jsonl` (ends with an AskUserQuestion with two options), `transcripts/noise.jsonl` (the ignored record types, a truncated last line), `hooks/<event>.json` for each event including `notification-permission.json` and `notification-idle.json`, and `panes/permission-bash.txt`.
- [ ] **Step 7: Commit.** `docs: record Claude Code hook, settings and transcript behaviour; test fixtures`

If a fact contradicts the spec (for example `--settings` doesn't exist, or `TMUX_PANE` is missing), stop and report it before later tasks start; the controller rules on the change.

---

### Task 2: Protocol v2 (shared types, demo source, web store)

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/server/src/demo-source.ts`, `packages/server/src/source.ts`, `packages/web/src/store.ts`, `packages/web/src/sse.ts`
- Test: `packages/shared/src/types.test.ts` (new), `packages/server/src/demo-source.test.ts`, `packages/web/src/store.test.ts`

**Interfaces:**
- Produces:

```ts
// shared/types.ts (changed)
export interface Session { /* as before */ now?: string }   // "now doing" line, e.g. "Running npm test"
export type ServerEvent =
  | { type: 'snapshot'; host: string; streamId: string; projectsRoot: string; sessions: Session[] }  // sessions[].lines is []
  | { type: 'session.updated'; session: Session }            // session.lines is []
  | { type: 'session.lines'; id: string; lines: DisplayLine[]; reset: boolean }
  | { type: 'session.removed'; id: string };
// server/source.ts (changed)
export type SourceEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; id: string }
  | { type: 'session.lines'; id: string; lines: DisplayLine[] };  // appended lines
export interface SessionSource {
  list(): Session[]; get(id: string): Session | undefined;
  lines(id: string): DisplayLine[];                         // last ≤ 200
  remove(id: string): Promise<void>;
  subscribe(fn: (e: SourceEvent) => void): () => void;
}
// web/store.ts (added)
export const linesById: Signal<Map<string, DisplayLine[]>>;  // capped at 500 per id
export const streamId: Signal<string | null>;
export const projectsRoot: Signal<string>;
```

- [ ] **Step 1: Write the failing tests.** Shared: a type-level test that `snapshot` requires `streamId` and `projectsRoot`. DemoSource: `list()` returns sessions with `lines: []`; `lines('shop')` returns the six demo lines for `shop` from `demoSessions`; `reset()` still restores. Web store: `applyEvent(snapshot)` stores `streamId` and `projectsRoot`; `session.lines` with `reset: true` replaces the lines for that id, `reset: false` appends; more than 500 lines keep the newest 500; `session.removed` drops the id's lines.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Demo lines move out of the snapshot into `DemoSource.lines(id)`. The web `Output` reads `linesById.get(selectedId) ?? []` (rendering changes come in Task 4).
- [ ] **Step 4: Run the tests.** Expected: PASS, with unit, lint and typecheck green. (The visual e2e will pass again after Task 3 delivers lines.)
- [ ] **Step 5: Commit.** `feat(shared,server,web): protocol v2 — lines travel separately from sessions`

---

### Task 3: Hub v2 — stream ids, view routing, backpressure; `/api/view` v2

**Files:**
- Modify: `packages/server/src/events.ts`, `packages/server/src/app.ts`, `packages/web/src/api.ts`, `packages/web/src/main.tsx`
- Test: `packages/server/src/events.test.ts`, `packages/server/src/app.test.ts`, `packages/web/src/view.test.ts` (new)

**Interfaces:**
- Consumes: `SessionSource`, `SourceEvent` (Task 2).
- Produces:

```ts
export class EventHub {
  constructor(source: SessionSource, host: string, projectsRoot: string, opts?: { heartbeatMs?: number; maxQueue?: number });  // maxQueue default 256 frames
  stream(): ReadableStream<Uint8Array>;    // snapshot carries a new random streamId (crypto.randomUUID())
  view(streamId: string, id: string | null): boolean;   // false for an unknown streamId; sends session.lines reset:true with source.lines(id)
  get clientCount(): number; close(): void;
}
// POST /api/view {streamId, id}: 204, or 404 {"error":"Unknown stream"}; 400 for a malformed body
// web: sendView() posts {streamId, id: selectedId} after each snapshot and on every selection change
```

- [ ] **Step 1: Write the failing tests.** Two streams; `view(a, 'shop')` sends `session.lines` (reset, six lines) only to `a`; a source `session.lines` event for `shop` reaches only streams viewing `shop`; `view(a, null)` stops it; `session.updated` still reaches all streams; a stream whose `desiredSize` falls below `-maxQueue` is closed and removed (simulate a reader that never reads); unknown streamId → `false` / HTTP 404; a malformed body → 400. Web: after a snapshot the client posts the view for the selected session; selecting another session posts again; a reconnect posts again with the new streamId.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Per-stream state `{id, controller, viewing: string | null, timer}`. Backpressure check on every enqueue.
- [ ] **Step 4: Run the tests and the e2e visual spec.** Expected: PASS; `corepack pnpm build && corepack pnpm test:e2e` back to 7/7 (demo lines now arrive via `session.lines`).
- [ ] **Step 5: Commit.** `feat(server,web): per-tab streams, view routing and backpressure`

---

### Task 4: Board v2 — append-only output, ended state, real paths

**Files:**
- Modify: `packages/web/src/components/Output.tsx`, `SessionPanel.tsx`, `SessionList.tsx`, `TopBar.tsx`, `packages/web/src/styles/board.css` (only for the ended chip and the external marker)
- Test: `packages/web/src/components/board.test.tsx`

**Interfaces:**
- Consumes: `linesById`, `projectsRoot` (Task 2); `Session.now`, `Session.external`, status `ended`.

- [ ] **Step 1: Write the failing tests.**
  - Output renders lines with stable keys: appending one line adds exactly one DOM node and leaves the existing nodes in place (same element identity); 600 lines render at most 500 nodes (the newest).
  - An `ended` session shows the chip `ended` (grey, like done), `finished <age> ago`, and the footer: `Resume` with key `U` on the left (inert, per ruling R2), `Archive` (E) and `Delete…` on the right; no follow-up field.
  - An external session shows `external` after the task in the list row's subline (`--fg-3`) and its footer has Terminal only (no Stop, Archive or Delete).
  - The meta line shortens the worktree with `projectsRoot` (e.g. root `/home/dev/projects`, worktree `/home/dev/projects/api/.worktrees/x` → `api/.worktrees/x`).
  - A running session with `now` set shows it as the think line when its lines don't already end with a think line.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keys from a per-session running counter assigned when lines arrive. Keep every design-target state pixel-identical.
- [ ] **Step 4: Run unit tests, then build + e2e.** Expected: PASS; visual diffs stay under 0.5% in all four states.
- [ ] **Step 5: Commit.** `feat(web): append-only output, ended and external sessions, real worktree paths`

---

### Task 5: tmux client and watcher

**Files:**
- Create: `packages/server/src/tmux/{client,watcher,format}.ts`
- Modify: `packages/server/src/config.ts` (env `KAGE_TMUX_SOCKET` → `tmuxSocket: string | null`, default null)
- Test: `packages/server/src/tmux/format.test.ts`, `watcher.test.ts` (recorded control-mode lines), `client.int.test.ts` (`describe.runIf(hasTmux)`, private socket)

**Interfaces:**
- Produces:

```ts
export interface TmuxWindow { windowId: string; kageId: string | null; paneId: string; panePid: number;
  command: string; cwd: string; name: string; activity: number }   // activity: epoch seconds
export class TmuxClient {
  constructor(opts: { session: string; socket: string | null; exec?: ExecFn });
  ensureSession(): Promise<void>;                   // new-session -d -s <session> if missing
  listWindows(): Promise<TmuxWindow[]>;             // [] when the server or session is missing
  capturePane(paneId: string, lines: number): Promise<string>;   // capture-pane -p -J -S -<lines>
  setKageId(windowId: string, kageId: string): Promise<void>;    // set-option -w -t <id> @kage_id <uuid>
}
export type WatchEvent = { type: 'windows-changed' } | { type: 'activity'; paneId: string } | { type: 'down' };
export class TmuxWatcher {
  constructor(opts: { session: string; socket: string | null; spawn?: SpawnFn; throttleMs?: number });  // throttle 250 ms per pane
  start(): void; stop(): void; on(fn: (e: WatchEvent) => void): () => void;
}
export const hasTmux: boolean;   // true when `tmux -V` runs
```

- [ ] **Step 1: Write the failing tests.**
  - `format.test.ts`: the list-windows format uses tab separators and parses `@12\t<uuid or empty>\t%3\t4242\tclaude\t/home/dev/x\tfix-login\t1795271520` into a `TmuxWindow`; a missing `@kage_id` parses as null; malformed lines are skipped.
  - `watcher.test.ts` with a fake spawned process: `%window-add @3`, `%window-close @3` and `%unlinked-window-close @3` emit `windows-changed`; 50 `%output %1 …` lines in 100 ms emit at most one `activity` for `%1` per 250 ms; process exit emits `down` and restarts after 1 s, then 2 s, … capped at 30 s, resetting after a successful start; `stop()` kills the child and clears timers.
  - `client.int.test.ts` (real tmux, private socket): `listWindows()` is `[]` with no server; `ensureSession()` creates the session; a second window with `setKageId` reads back its `kageId`; `capturePane` returns text printed in the pane.
- [ ] **Step 2: Run them.** Windows: unit tests FAIL (missing modules), integration skipped. WSL: run `corepack pnpm test --project server` there too.
- [ ] **Step 3: Implement.** All commands through `execFile('tmux', ['-L', socket, …])` when a socket is set. The watcher runs `tmux -C attach -t <session>` (with `-L` when set) via `spawn` and parses lines; it never writes keystrokes in this phase.
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS (integration in WSL).
- [ ] **Step 5: Commit.** `feat(server): tmux client and control-mode watcher`

---

### Task 6: Hooks — CLI, settings file, socket server, status reducer

**Files:**
- Create: `packages/server/src/hooks/{cli,settings,server,status}.ts`
- Test: `cli.test.ts`, `settings.test.ts`, `server.test.ts`, `status.test.ts` (fixtures from Task 1)

**Interfaces:**
- Produces:

```ts
export type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop' | 'SessionEnd';
export interface HookEvent { event: HookEventName; pane: string | null; sessionId: string; transcriptPath: string | null;
  cwd: string | null; notification: 'permission' | 'idle' | 'other' | null; message: string | null; toolName: string | null; at: number }
export function socketPath(env: NodeJS.ProcessEnv): string;   // KAGE_SOCKET, else $XDG_RUNTIME_DIR/kage.sock, else ~/.local/state/kage/kage.sock; on Windows \\.\pipe\kage-<user>
export function runHookCli(event: string, io: { stdin: Readable; env: NodeJS.ProcessEnv; post?: PostFn }): Promise<0>;  // always resolves 0, ≤ 2 s
export function writeHooksSettings(dir: string, command: string[]): Promise<string>;     // returns the settings file path
export class HookServer { constructor(path: string); listen(): Promise<void>; close(): Promise<void>; on(fn: (e: HookEvent) => void): () => void }
export function nextStatus(prev: SessionStatus | undefined, e: HookEvent): SessionStatus | undefined;
```

- [ ] **Step 1: Write the failing tests.**
  - CLI: with a fake `post` that hangs, `runHookCli` resolves 0 within 2.1 s; it writes nothing to stdout/stderr (capture both); it sends the stdin JSON plus `pane` from `TMUX_PANE` and the event name; malformed stdin still resolves 0.
  - Settings: the file registers all seven events, each running exactly `command` + `['hook', <Event>]` as an argument list (no shell string); it contains no other settings.
  - Server (temp socket path): POST `/hook` with a fixture → `on` receives a parsed `HookEvent`; the Unix socket file has mode `0600` (skip the mode check on Windows); bodies over 1 MB → 413; other paths → 404.
  - Status (one test per row of spec §5.3, using the Task 1 fixtures): SessionStart/UserPromptSubmit/Pre/PostToolUse → running; Notification permission → needs-you; Notification idle → unchanged; Stop → done; SessionEnd → ended; PreToolUse with toolName `AskUserQuestion` → needs-you.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Map `notification_type` (or, if Task 1 found none, the message text pattern it recorded) to `permission | idle | other`. The server parses with a size limit and validates field types.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): hook CLI, Claude settings, hook socket server and status rules`

---

### Task 7: Transcript reader

**Files:**
- Create: `packages/server/src/transcript/{tail,lines}.ts`
- Test: `tail.test.ts`, `lines.test.ts` (fixtures from Task 1)

**Interfaces:**
- Produces:

```ts
export function toDisplayLines(record: unknown): DisplayLine[];   // [] for anything it doesn't know
export function questionFrom(record: unknown): Question | null;    // AskUserQuestion → {text, options}
export function nowLine(record: unknown): string | null;           // e.g. "Running npm test", "Editing src/auth.ts"
export class TranscriptTail {
  constructor(path: string, opts?: { maxLines?: number; fromEnd?: number });   // maxLines 200; fromEnd: bytes to read at start (default 256 KiB)
  start(): Promise<void>; stop(): void;
  lines(): DisplayLine[]; question(): Question | null; now(): string | null;
  on(fn: (added: DisplayLine[]) => void): () => void;
}
```

- [ ] **Step 1: Write the failing tests.**
  - `edit-and-test.jsonl` → `say`, `tool` (`Read` + detail `src/auth/session.ts`), `tool` (`Update` + path) followed by `del`/`add` lines from the edit, `tool` (`Bash` + command), `out` lines `PASS …` (at most 3 lines from a tool result, each at most 200 characters).
  - `ask-question.jsonl` → `questionFrom` returns the question and both options.
  - `noise.jsonl` → no throw; unknown record and block types produce nothing; the truncated last line is held until the rest is appended.
  - A 5 MB tool result produces at most 3 `out` lines; invalid UTF-8 doesn't throw; a line containing `<img src=x onerror=alert(1)>` comes through as plain text (rendering is already text-only).
  - `TranscriptTail` on a temp file: appending records emits only the new lines; `maxLines` keeps the newest 200; a file that doesn't exist yet is picked up when created; `stop()` closes the watcher.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Follow with `fs.watch` plus reading from the last offset; split on `\n`, keep the partial tail; parse each line with `JSON.parse` in try/catch. Display rules exactly as the design target's line kinds (spec §5.4).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): transcript reader for display lines, questions and the now line`

---

### Task 8: Pane prompt parser and fallback lines

**Files:**
- Create: `packages/server/src/pane/prompt.ts`
- Test: `prompt.test.ts` (fixtures from Task 1)

**Interfaces:**
- Produces:

```ts
export function stripAnsi(s: string): string;
export function parsePermissionPrompt(pane: string): Question | null;   // numbered choices → {text, options}
export function paneLines(pane: string, max: number): DisplayLine[];    // fallback: kind 'out', ANSI and control chars removed, trailing blank lines dropped
```

- [ ] **Step 1: Write the failing tests.** `panes/permission-bash.txt` → a question whose text is the prompt line and whose options are the numbered choices in order (text without the number); a pane with no numbered choices → null; ANSI colour codes, cursor moves and control characters are removed; `paneLines` keeps the last `max` non-empty lines.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** against the recorded pane format.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): permission prompt parser and pane fallback lines`

---

### Task 9: State store and LiveSource

**Files:**
- Create: `packages/server/src/state/store.ts`, `packages/server/src/live-source.ts`
- Test: `store.test.ts`, `live-source.test.ts` (fakes for tmux, watcher, hook server and transcript tails)

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces:

```ts
export interface SessionRecord { kageId: string; windowId: string | null; project: string; task: string; branch: string;
  worktree: string; createdAt: number; pinned: boolean; archived: boolean; sessionId: string | null; transcriptPath: string | null }
export class StateStore { constructor(path: string); load(): Promise<SessionRecord[]>; save(records: SessionRecord[]): Promise<void> }  // atomic: write temp + rename
export class LiveSource implements SessionSource {
  constructor(deps: { tmux: TmuxClient; watcher: TmuxWatcher; hooks: HookServer; store: StateStore;
    tail: (path: string) => TranscriptTail; projectsRoot: string; now?: () => number });
  start(): Promise<void>; stop(): Promise<void>;
  // SessionSource: list, get, lines, subscribe; remove() rejects with NotImplementedError until phase 4
}
```

- [ ] **Step 1: Write the failing tests.**
  - Store: a missing file loads `[]`; save then load round-trips; a crash between temp write and rename leaves the old file intact (simulate by writing only the temp file); a corrupt file loads `[]` and is renamed `state.json.corrupt-<time>`.
  - LiveSource with fakes:
    - a tmux window without `@kage_id` appears as an external session (project from the cwd's folder name, task from the window name, status `running` while there was pane activity in the last 5 s, otherwise `done`), with `external: true`;
    - a window whose `@kage_id` matches a record appears with the record's project, task, branch and worktree;
    - a record whose window is gone appears as `ended`;
    - hook events for a pane set status by `nextStatus`; `SessionStart` links the pane to `sessionId` and starts a `TranscriptTail` on `transcriptPath`;
    - transcript lines arrive as `session.lines` events, and `lines(id)` returns the tail's lines;
    - a permission Notification captures the pane and sets `question` from `parsePermissionPrompt`; a transcript question sets `question` too; leaving needs-you clears it;
    - a session without a transcript gets `paneLines` from a capture on activity (throttled);
    - `windows-changed` re-lists windows and emits `session.updated` / `session.removed` only for real changes; `activity` events produce at most 4 `session.updated` per second per session;
    - `down` from the watcher marks Kage sessions `ended` and drops external ones; recovery re-lists;
    - on `start()` with the hook server not having seen a session, status is rebuilt from the transcript tail (last record) and pane activity (**review focus 1**).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Session id = `kageId` for Kage windows, `ext-<windowId>` for external ones (stable while the window lives).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): state store and live session source`

---

### Task 10: Live mode in `kage serve`, CLI commands, host names

**Files:**
- Modify: `packages/server/src/main.ts`, `packages/server/src/listen.ts`, `packages/server/src/app.ts` (DELETE → 501 when the source rejects with NotImplementedError)
- Test: `main.test.ts` (new; the command dispatch and startup checks as functions), `listen.test.ts`, `app.test.ts`

**Interfaces:**
- Produces: commands `kage serve [--demo] [--unsafe-listen-all] [--port N]` (live unless `--demo`), `kage hook <Event>`, `kage hooks-path` (writes the settings to `$XDG_STATE_HOME/kage/claude-settings.json` and prints its path), and `tailscaleDnsName(exec?) : Promise<string | null>` in listen.ts.

- [ ] **Step 1: Write the failing tests.**
  - Live mode with `token` set exits 1 with the exact message from Global Constraints; `--demo` with a token keeps the phase 1 warning and runs.
  - `kage hooks-path` prints a path whose file's hook commands are `[process.execPath, <absolute path of main.ts or the built entry>, 'hook', <Event>]`.
  - `kage hook Stop` with an unreachable socket exits 0 and prints nothing.
  - B1: `tailscaleDnsName` parses `tailscale status --json` → `Self.DNSName` without the trailing dot (e.g. `box.tail1234.ts.net`), null on any error; resolveListenAddress adds it to `hostNames` for a Tailscale bind.
  - B12: `cfg.name` joins `hostNames` only when it's a single DNS label or ends in `.ts.net` or `.local`; `name: "example.com"` is not accepted as a Host.
  - `DELETE /api/sessions/:id` on the live source → 501 `{"error":"Deleting sessions arrives in a later version"}`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Live wiring: `ensureSession()`, start the hook server on `socketPath(env)`, the watcher, the store at `$XDG_STATE_HOME/kage/state.json`, `LiveSource.start()`, then the HTTP server. Shutdown stops all of them.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): live mode, hook commands, MagicDNS and safer host names`

---

### Task 11: Linux test image, fake Claude and the live e2e

**Files:**
- Create: `Dockerfile.test`, `scripts/test-linux.sh`, `e2e/fake-claude.mjs`, `e2e/live.spec.ts`
- Modify: `playwright.config.ts` (a `live` project), `.github/workflows/ci.yml` (install tmux; run the live project), `package.json` (`test:linux`)

**Interfaces:**
- Consumes: `kage serve`, `kage hooks-path`, `kage hook` (Task 10).

- [ ] **Step 1: Write the image and runner.** `Dockerfile.test` from `mcr.microsoft.com/playwright:v1.64.1-noble` (matches `@playwright/test` 1.64.1) plus `tmux` and corepack. `scripts/test-linux.sh` copies the tracked files (`git ls-files -z | tar --null -T - -c`) into a fresh container, runs `pnpm install --frozen-lockfile`, lint, typecheck, unit (including tmux integration), build and all e2e projects, and exits with the tests' status. `pnpm test:linux` runs it.
- [ ] **Step 2: Write `fake-claude.mjs`.** Given a scenario name, it behaves like Claude in a tmux pane: runs `kage hook SessionStart` (with a fixture body whose `transcript_path` points to a temp file and whose cwd is the pane's), appends the scenario's transcript records with short delays, fires PreToolUse/PostToolUse, then for `needs-permission` prints the recorded permission prompt and fires `Notification` (permission) and waits for a digit on stdin; on `1` it continues and fires `Stop`. All hooks go through the real `kage hook` CLI.
- [ ] **Step 3: Write `live.spec.ts`** (project `live`, skipped when tmux is missing). Before all: temp HOME/XDG dirs, a private tmux socket via `KAGE_TMUX_SOCKET`, `kage serve` live on 127.0.0.1:4393 with `KAGE_NAME=my-pc`. Tests:
  - a window started with `node e2e/fake-claude.mjs edit-and-test` appears as running with the transcript's lines in order, then becomes done with the Stop;
  - `needs-permission` shows `Waiting for you` with the prompt's options as buttons, the row reads `waiting for your reply`, and after `tmux send-keys 1` (by the test, not the UI) the session runs and then is done;
  - a plain `sh` window appears as external;
  - killing a window removes the external session; killing the tmux server marks Kage sessions ended and the board stays up.
- [ ] **Step 4: Run.** `corepack pnpm test:linux`. Expected: everything passes in the container. Then run the Windows suite: unit + phase 1 e2e still pass.
- [ ] **Step 5: Commit.** `test(e2e): live sessions against real tmux with a fake Claude; Linux test image and CI`

---

### Task 12: Docs

**Files:**
- Modify: `README.md` ("Try it with real sessions": run `kage serve` in WSL or Linux, start Claude with `claude --settings "$(kage hooks-path)"` in the tmux session `kage`), `docs/backlog.md` (mark B1–B6, B8, B12 done; keep B7's Resume for phase 4), `docs/plans/README.md` (phase 2 built), `CONTRIBUTING.md` (`pnpm test:linux`)

- [ ] **Step 1: Update the docs** as listed, in the house style (short sentences, exact commands).
- [ ] **Step 2: Run** `corepack pnpm lint`. Expected: clean.
- [ ] **Step 3: Commit.** `docs: live sessions, Linux tests, backlog and roadmap`

---

**Phase 2 check (spec §9):** in WSL, `kage serve` (bound to 127.0.0.1) and a real `claude --settings "$(kage hooks-path)"` in the tmux session `kage`: the board in a Windows browser at `http://127.0.0.1:8080` shows the session with live status and output, turns amber on a permission prompt, and done when Claude finishes.
