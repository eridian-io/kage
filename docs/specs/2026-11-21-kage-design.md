# Kage: design

Status: approved direction, 2026-11-21 (UI: Variant 1 "Quiet").
Visual target: [`docs/design/kage-board.html`](../design/kage-board.html) (open it in a browser and click through it), with screenshots in [`docs/design/reference/`](../design/reference/).
Earlier explorations, kept for history: [`docs/design/explorations/`](../design/explorations/).

## 1. What Kage is, and why

Kage is a small web app that runs on a developer's home PC or server. It lets them start, watch, answer and stop Claude Code sessions from a laptop, over Tailscale. Today the owner does this by SSH-ing in and juggling tmux windows by hand. Kage replaces that with one calm screen that shows what every session is doing and which ones are waiting for an answer.

**Who it's for:** developers who already run Claude Code on a machine that stays on.

**What matters most, in order:**
1. **Performance.** The page loads fast, updates instantly, and costs almost nothing on the server when nobody is looking.
2. **World-class UX** that matches the approved design exactly.
3. **A thin layer.** tmux, git and Claude Code stay the source of truth. Kage never hides them: `tmux attach` must always still work.

## 2. Goals, non-goals and anti-goals

**Goals (version 1, desktop):**
- List every Kage session, grouped as needs you, running and done, with live status.
- Show the selected session's recent output, updated live.
- Answer a waiting session with one click (its options as buttons), or with a typed reply.
- Start a task in a new git worktree and branch, from a chosen project and base branch.
- Stop a session. Pin, archive and delete finished ones, with a warning before unpushed work is lost.
- Show each session's open preview ports as links, and its changed files with a diff.
- Open a full interactive terminal for a session, loaded only on demand.
- Notify the developer when a session needs them (browser notification, optional ntfy).
- Run on boot as a service. Bind only to the Tailscale interface.

**Non-goals for version 1:**
- The phone layout. The design is desktop first; mobile comes later (see the explorations).
- A light theme. It may come later; Variant 2 in the explorations shows a direction.
- Multiple users, accounts or roles. One developer per installation.
- Hosting or a cloud service. Kage runs only on the developer's own machine.
- Managing tools other than Claude Code.

**Anti-goals (would count as failure even if it works):**
- A UI that is "in your face": glows, pulses, filled colour blocks, or several accents competing.
- Polling loops that burn CPU while nobody is watching.
- Any state that only Kage knows and that disagrees with tmux or git.
- Killing or changing tmux windows, worktrees or branches that Kage did not create.
- Reachable from the public internet or the local Wi-Fi by default.

## 3. Constraints

- **Platform:** Linux (primary, with systemd) and macOS. Windows through WSL only.
- **Runtime:** Node 24 LTS, built into the released `kage` program, so users don't install Node themselves. Node 20 reached end of life in April 2026.
- **Needs on the machine:** tmux 3.2 or newer, git 2.40 or newer, Claude Code, Tailscale.
- **Licence:** AGPL-3.0. Contributions need a CLA, because commercial licences may be sold.
- **Naming:** the product is "Kage"; avoid "Claude" in the product name (Anthropic's brand guidelines).
- **Build step allowed** (owner, 2026-11-21, replacing the brief's "no build step"): TypeScript throughout, built with esbuild. Performance and quality come first. See §5.1.
- **Easy install** (owner, 2026-11-21): one command installs Kage, checks the requirements, sets it up and starts it on boot. See §5.13.

## 4. Approaches considered

| Approach | What it is | Trade-off | Decision |
|---|---|---|---|
| **A. Terminal-first** | The browser is a tmux client: every session is a tab with a full terminal (xterm.js). | Full control and little UI work. But it loads ~110 KB on every visit and streams every byte, needs-you is hard to spot, and it's clumsy on a phone. | Rejected |
| **C. Dashboard first, terminal on demand** | A light dashboard of structured state. A full terminal is lazy-loaded only when you open it. | More UI and parsing work, but fast, calm and easy to answer from. | **Chosen by the owner** |

Within C, the owner compared six board designs (Current, Quiet, Daylight, Terminal UI, Conversation, Wall) and chose **Variant 1, "Quiet"**, refined through review comments into the version saved as the design target.

## 5. Architecture

```mermaid
flowchart LR
  subgraph Laptop["💻 Laptop (browser)"]
    UI["Kage board<br>(plain JS, ~25 KB)"]
    XT["Terminal view<br>(xterm.js, lazy)"]
  end
  subgraph PC["🏠 Home PC / server"]
    subgraph K["kage server (Node 24)"]
      HTTP["HTTP: page, JSON actions,<br>SSE event stream"]
      WS["WebSocket<br>(terminal only)"]
      REG["Session registry<br>+ state file"]
      TMX["tmux bridge<br>(control mode)"]
      TR["Transcript reader"]
      GIT["git helper"]
      PORTS["Port scanner"]
      HOOK["Hook receiver"]
    end
    TM["tmux session 'kage'"]
    CC["claude (one per window)"]
    JL["Claude transcripts<br>~/.claude/projects/*.jsonl"]
    WT["git worktrees"]
  end
  UI -- "Tailscale" --> HTTP
  XT -- "Tailscale" --> WS
  HTTP --- REG
  REG --- TMX & TR & GIT & PORTS
  TMX <--> TM
  WS <--> TMX
  TM --- CC
  CC -- "hooks: kage hook ..." --> HOOK
  HOOK --> REG
  CC --> JL
  TR -. "tail" .-> JL
  GIT --- WT
```

### 5.1 Stack (builder's calls, recorded here)

- **Language:** TypeScript (`strict`) for the server, the CLI and the browser, in one pnpm workspace with shared types for the API and SSE events. `tsc --noEmit` checks types; **esbuild** builds.
- **Server:** Node 24. HTTP with [Hono](https://hono.dev) on `@hono/node-server`, which is small and fast. `ws` for the single WebSocket route. No native modules, so the server can ship as a single executable (§5.13). esbuild bundles it into one file.
- **Browser:** [Preact](https://preactjs.com) with `@preact/signals` (about 5 KB gzipped together), for fine-grained updates without re-rendering the board, and hand-written CSS using the tokens in §6.2. esbuild bundles and minifies it, and Kage serves the result with long-cache hashed file names, inlining the critical CSS. xterm.js is a separate chunk, loaded only when a terminal opens. As built (amended 2026-11-22, phase 4): `@xterm/xterm` 6.0.0 with `@xterm/addon-fit` 0.11.0 in the browser, and `ws` pinned at exactly 8.23.0 on the server (8.22.2 has a remote memory-exhaustion DoS that 8.23.0 fixes, so the two-week age rule yielded to the fix: R62). The terminal is its own esbuild entry, `term-[hash].js` and `term-[hash].css`. Only a `<meta name="kage-term">` in the page names it, and a loader of about 390 bytes in the main bundle fetches it, so it costs nothing until `T` is pressed.
- **Fonts:** Geist and Geist Mono, self-hosted as subset woff2 files, preloaded, with `font-display: swap` and a system fallback stack.
- **State:** no database. tmux and git are the truth. One small JSON file, `~/.local/state/kage/state.json` (`$XDG_STATE_HOME`), holds what they can't: task text, project, base branch, permission mode, created time, pinned, archived, and the tmux window IDs Kage created. The record gains `base` (the branch the task was cut from) and `permissionMode` (`default` or `acceptEdits`). (amended 2026-11-21, phase 3). It gains `baseCommit` (the commit the worktree was cut from, a full 40- or 64-digit hex id; null for older records), `doneAt` (epoch ms of the last move into done or ended; null while active), `archivedAt`, `restoredAt` and `unpinnedAt` (epoch ms; the last two restart auto-archive's clock, §5.8) (amended 2026-11-22, phase 4).
- **Tests:** vitest for units, real tmux for integration tests, and Playwright for end-to-end and visual tests (§8).
- **Tooling:** Biome for lint and format, pnpm.

### 5.2 Sessions

A **session** is one tmux window in the tmux session `kage` (configurable), plus Kage's record of it.

- **Created by Kage:** Kage runs `git worktree add <repo>/.worktrees/<slug> -b <branch> <base>`, then `tmux new-window -t kage -n <slug> -c <worktree>`, and starts `claude --settings <claude-settings.json> --permission-mode <mode> "<task>"` in it. The settings file is `$XDG_STATE_HOME/kage/claude-settings.json` (amended 2026-11-21, phase 2). Kage starts `claude` directly or through `exec`, never through a wrapper that stays alive: tmux reports the foreground process, and a wrapper would make the session look ended (amended 2026-11-21, phase 2).
- **Permission mode** (owner's ruling, 2026-11-21): Claude Code's default mode, so Claude asks before edits and commands, and Kage shows those prompts as amber questions with buttons. The New task form has an **"Accept edits automatically"** checkbox, which adds `--permission-mode acceptEdits` for that task. Kage always passes `--permission-mode` explicitly (`default` otherwise), because Claude Code 2.1.330 defaults to auto mode, which never prompts (amended 2026-11-21, phase 2). Commands still prompt. Kage never offers to skip permissions, and refuses a config value that would. Kage tags the window with a tmux user option, `@kage_id=<uuid>`, and the record stores that UUID with the window ID (`@12`). tmux reuses window IDs after a restart, so **ownership is the UUID**: a window counts as Kage's only if its `@kage_id` matches a record.
- **Starting a task, as built** (amended 2026-11-21, phase 3):
  - **Command.** Kage runs `claude --settings <file> --permission-mode <default|acceptEdits> -- "<task>"`. The `--` ends the options, so a task can't be read as a flag. The argv never holds another mode or `--dangerously-skip-permissions`. `claude` is `KAGE_CLAUDE_BIN` (a path, or a name looked up on `PATH`), else the first `claude` on `PATH`. With none, the start fails with 503.
  - **Direct launch.** `tmux new-window -d -P -F '#{window_id}<tab>#{pane_id}' -t <session> -n <slug> -c <worktree> -e KAGE_SOCKET=<socket> -e PATH=<Kage's PATH> -- <argv>`. `<tab>` is a tab character: tmux prints the new window's ID and its pane's ID on one line, and Kage checks both. There is no shell in between, so the window closes when Claude exits. The session then counts as ended; the worktree and branch stay.
  - **Tagging.** The window is tagged `@kage_id` in a second tmux call on its window ID, never chained with `;` in the same call: the chained form tagged the wrong window. Kage writes the record first (`adopt`), and the window then `claim`s it, so the tag and the record can't be separated.
  - **Slugs.** Lowercase ASCII from the task text, at most 40 characters, made unique against the project's branches and Kage's own records (a numeric suffix).
  - **Exclude entry.** Kage adds `/<worktreeDir>/` to the repo's `info/exclude`, found with `git rev-parse --git-path info/exclude`. A relative answer is resolved against the repo's git directory.
  - **Rollback.** If the worktree, the window or the launch check fails, Kage removes only what this request created: its window, worktree, branch and record. It never deletes a branch that existed before. After the launch it checks that the folder exists and that the window and its pane are still alive 250 ms later, else it answers 422. The 422 names the step that failed: "The worktree folder is missing.", "Kage couldn't save the session: …" or "tmux couldn't open a window: …". If `new-window` itself fails (a timeout can come after tmux opened the window), Kage lists the windows named after the slug and kills any that wasn't there before the launch and is untagged (or tagged with this launch's id), before it removes the worktree. tmux re-reads the tag just before each kill.
  - **One at a time per project.** Starts for the same project run one after another, so two identical tasks get distinct names. A project is keyed by its real folder, so a symlink or a differently-cased name shares the lock.
- **Found, not created:** windows in the `kage` session that Kage didn't create still appear, marked as *external*. Kage can show and answer them, but never stop or delete them. That's the brief's rule: "never kill windows you did not create".
- **Branch names:** `kage/<slug>` by default. The slug comes from the task text: lowercase, ASCII, at most 40 characters, made unique with a numeric suffix.
- **Worktree location:** `<repo>/.worktrees/<slug>` by default. Kage adds `.worktrees/` to the repo's `.git/info/exclude`, not to `.gitignore`, so it never changes tracked files. The location is configurable.

### 5.3 Status: how Kage knows what a session is doing

Kage starts each `claude` with a settings file whose hooks call `kage hook <event>`. That small CLI reads the hook's JSON from stdin and POSTs it to the server over a Unix socket (`$XDG_RUNTIME_DIR/kage.sock`, else `$XDG_STATE_HOME/kage/kage.sock`, else `~/.local/state/kage/kage.sock`), so hooks work even when the HTTP port is bound to Tailscale.

| Claude Code hook | Kage status | Extra data used |
|---|---|---|
| `SessionStart` | done: waiting for input (amended 2026-11-21, phase 2) | `session_id`, `transcript_path` (links the window to its transcript; every hook carries both, and any of them links) |
| `UserPromptSubmit` | running | none |
| `PreToolUse` / `PostToolUse` | running | the tool name feeds the "now doing" line; edits trigger a files refresh |
| `PostToolUseFailure` | running (the turn continues) | none |
| `PermissionRequest` | **needs you** (primary; fires within about 0.1 s) | the tool and its input |
| `Notification` (permission prompt) | **needs you** (fallback, only while a tool is pending) | the message |
| `Notification` (idle, "waiting for your input") | no change: stays done | ignored for status and never notifies |
| `Stop` | done (the turn finished; `claude` is still running and can take a follow-up) | triggers a files and ports refresh |
| `SessionEnd` | done (ended) | none |

Kage tells the two Notification kinds apart by the hook's `notification_type` field when present, and otherwise by its message text. Owner's ruling (2026-11-21): **only real questions and permission prompts turn a session amber**; a finished turn stays done.

**Done is not dead.** A done session still has `claude` waiting in its window, so the developer can give it a follow-up task (the reply box, or `R`); that sends the text and the session goes back to running. Archive also closes `claude` (kill-window) but keeps the worktree and branch.

A session whose `claude` process is gone, and whose window shows a shell prompt, counts as **ended**. In practice: the pane is dead, or its foreground command is a known shell (bash, zsh, sh, dash, fish, ksh and so on) (amended 2026-11-21, phase 2).

External windows without hooks fall back to activity: output in the last 5 seconds means running, and otherwise the status is unknown and shown as running without a cursor. The 5 s rule still applies, and a startup screen (below) overrides it (amended 2026-11-21, phase 2).

**Amendments from the phase 2 build** (2026-11-21, phase 2):

- **PermissionRequest is the needs-you trigger** (amended 2026-11-21, phase 2). It fires within about 0.1 s, while the permission `Notification` arrives about 11 s later. The `Notification` stays as a fallback, and counts only while a tool is pending (a `PreToolUse` or `PermissionRequest` with no `PostToolUse`, `PostToolUseFailure` or `Stop` since). It never turns a done or ended session amber again. `PostToolUseFailure` maps to running.
- **AskUserQuestion is recognised from `PreToolUse`** (amended 2026-11-21, phase 2): the tool name says it is a question, and `tool_input` holds the question and options.
- **Startup screens make a session needs-you** (amended 2026-11-21, phase 2). Claude's theme, security notes, folder-trust, renderer and login screens fire no hook. Kage reads them from the pane and shows the screen's text and options. The login screen has no options: Kage never answers it. The board answers them since phase 3 (§5.4), except the login screen.
- **No or Esc fires no hook** (amended 2026-11-21, phase 2). The session leaves needs-you through the transcript's rejection record (a tool result with `toolDenialKind` "user-rejected", or user text starting "[Request interrupted by user"), or through the pane: the prompt is gone and the denial line ("Interrupted · What should Claude do instead?") is near the bottom. Either way the session is done.
- **Prompt cards show every option the prompt offers**, in order, with the trailing "· …" hint trimmed (amended 2026-11-21, phase 2). Hiding one, such as "Yes, and switch to auto mode", would put the button numbers out of step with Claude's.
- **SessionStart means waiting for input** (amended 2026-11-21, phase 2). A new or resumed session waits for its first prompt, so `SessionStart` maps to done (from ended too, for a resume). A task Kage launches still reads running at once, because `UserPromptSubmit` follows within about 0.6 s. The "now doing" line goes on the wire only while the session is running.
- **Any hook links the window** (amended 2026-11-21, phase 2). Every hook carries `session_id` and `transcript_path`, so the first hook Kage sees from a pane links it to its transcript, even when the `SessionStart` was missed (Kage restarted, or a hook was lost).
- **Startup checks are bounded** (amended 2026-11-21, phase 2). Kage looks for startup screens only in a window with no hook seen yet, and stops once Claude's idle input box shows. A `claude` window is captured once more a second after Kage first sees it, because a startup screen drawn after that sits still and makes no activity.
- **The placeholder window is hidden** (amended 2026-11-21, phase 2). The window `ensureSession` creates to hold the session open is tagged `@kage_placeholder` and left off the board while it sits at a shell. Once it runs anything else the tag is cleared and it shows like any window.

**Amendments from the phase 3 build** (2026-11-21, phase 3):

- **A task Kage launches stays running until its first prompt** (amended 2026-11-21, phase 3). After the trust screen, Claude's `SessionStart` came about a second before the task's own `UserPromptSubmit`, so a launched task blinked done, and a reply sent in that blink was queued while Claude started. Now a session Kage started (`adopt`) that hasn't taken its first prompt keeps running ("Starting Claude…") through a non-compact `SessionStart`. The wait ends at the first `UserPromptSubmit`, `PreToolUse` or `SessionEnd`. If none comes within 10 s of the `SessionStart`, the wait ends, and when the pane shows Claude's idle box without "esc to interrupt" the session is done. A startup screen meanwhile shows as needs-you as before, and doesn't end the wait.
- **`SessionStart` with source `compact` keeps the status** (amended 2026-11-21, phase 3). Claude compacts its context mid-turn and fires `SessionStart` again. Kage ignores that one for status, so a running session doesn't flip to done.
- **A placeholder window gets the socket too** (amended 2026-11-21, phase 3). `kage serve` sets `KAGE_SOCKET` on the tmux session with `new-session -e` and `set-environment`, so a `claude` started by hand in a later window finds the same hook socket.
- **Bidi and format characters are stripped from all displayed text** (amended 2026-11-21, phase 3) (say, out, pane lines and plain text), so text can't read differently from what it is.

**Amendments from the phase 4 build** (amended 2026-11-22, phase 4):

- **The first-prompt fallback decides on the busy footer alone** (R57, (amended 2026-11-22, phase 4)). The 10 s fallback of the phase 3 rule captures the pane, and the session is done unless the capture shows Claude's busy footer ("esc to interrupt"). The idle box no longer has to show. If the capture fails twice in a row, the session is done too (R58): a wrong done corrects itself at the next hook, while a wrong running could stay.
- **A launch is never done before its first hook** (P4F1, amended 2026-11-22, phase 4). Before Claude's first hook, a session Kage launched or resumed is in activity mode, and its 5 s idle rule would call a quiet pane done, though Claude may be drawing the folder-trust screen just after the last capture. So until the first hook (or the idle input box shows), the idle rule captures the pane instead: a startup screen is needs-you with its question, and anything else stays running, "Starting Claude…", and is captured again a second later. Activity keeps triggering the startup-screen check as before, and the window's end still ends the wait.
- **Resume uses the same fallback** (R57, F6, (amended 2026-11-22, phase 4)). A resumed session reads running, "Starting Claude…", until its first `UserPromptSubmit`, `PreToolUse` or `SessionEnd`, or until the 10 s fallback. A resumed session takes no first prompt, so it normally reaches done through the fallback. An unknown `--resume` id exits at once and fires a `SessionEnd` with a new, random `session_id` and no `SessionStart` (integration §8): Kage treats that as a failed resume, and the record keeps its old id.
- **Known gap** (backlog B34): a resumed window that dies before Kage's first listing of it loses that `SessionEnd`.

### 5.4 Output: what the session panel shows

The design shows Claude's prose in the sans font, tool calls as muted monospace lines, diffs in green and red, and a lime "thinking" line. To render that faithfully and cheaply, Kage reads **structure**, not screen text:

- **Transcript reader:** each Claude Code session writes a JSONL transcript (its path arrives with the `SessionStart` hook). Kage tails that file with `fs.watch` plus a size poll (§5.5) and turns new records into display lines: `say` (assistant text), `tool` (tool name and a short argument), `add` / `del` (edit diffs), `out` (short tool results, such as test summaries) and `think` (the current activity). It keeps the last 200 display lines per session in memory.
- **Questions:** when the latest assistant record is an `AskUserQuestion` tool call, its options become the answer buttons. For permission prompts (a `PermissionRequest` hook, or the `Notification` fallback), Kage reads the visible options from the pane (`tmux capture-pane -p`) and turns the numbered choices into buttons. If parsing fails, the typed reply box is always available.
- **Answering:** a button sends that option's number with `tmux send-keys -t <window> <n>`. A typed reply sends `send-keys -l -- "<text>"` followed by `Enter`. As built, the details are these (amended 2026-11-21, phase 3):
  - **Plans.** Permission prompts and AskUserQuestion take the option's digit alone (a digit submits at once; no Enter). The folder-trust screen has no digits: Kage reads the `❯` from the pane, sends `Down` or `Up` presses to reach the chosen option, looks again (up to 10 times) until the `❯` is there, and only then sends `Enter`. If the `❯` never gets there, or the screen is gone, it sends nothing more and answers 409. The login screen is never answered.
  - **Screen check before every key.** Kage captures the pane and sends a key only if the same prompt is still showing. The request carries the question text the user saw (`{option, question}`). If the question has changed, the answer is 409 "The question changed. Look again before answering." A click meant for one prompt never approves another.
  - **The whole command is compared.** A permission prompt's question text holds the command up to the 500-character question bound, joined from Claude's wrapped lines, and the card wraps it. Two commands that start alike are different questions. When the command is longer than the bound, the card adds "… see the terminal for the full command".
  - **A new question waits a moment.** When the selected session's question changes (its text or options), its buttons are disabled and the digit keys do nothing for about 800 ms, so a key or click meant for the old question can't answer the new one.
  - **After an answer.** The session goes to running at once, and one pane capture 500 ms later decides what came next: another prompt or startup screen means needs-you with that question, and Claude's denial line under the tool means done (the answer was No). A status change in between cancels that check.
  - **Refused options.** "Yes, and switch to auto mode" is disabled, because it changes the launch permission policy. So is the renderer screen's "Yes, try it". "Yes, and switch to accept edits" stays enabled: accept-edits is the owner's sanctioned mode (§11), and picking it is an explicit act. A multi-select question is answered in the terminal.
  - **A reply at a prompt is `Escape`, then the text.** Escape declines the prompt ("What should Claude do instead?"), Kage waits for Claude's idle input box, and then types the text.
  - **Enter only after the text shows.** Kage types the text in one `send-keys -l --` call (up to 12,000 bytes, chunked on whole characters above that), reads the input box, and sends `Enter` only when the box shows the text (or Claude's `[Pasted text #N` placeholder, for text over 800 UTF-16 units). Otherwise it answers 409 "Your text is still in Claude's input box; send or clear it in the terminal." Kage never sends `Ctrl+U` or a double `Escape` to clear: a double `Escape` on an empty box opens Claude's rewind menu. That is Claude's documented behaviour; the phase 3 spike didn't reproduce it (claude-code-integration.md §7, "Clearing typed text"), and Kage still never sends it.
  - **A reply can't start with `!`, `#`, `/` or a digit 1–9.** `!` runs a shell command with no prompt, `#` writes memory, `/` is a slash command, and a digit could answer a prompt that appears mid-send. A reply holds no control character or line break.
  - **Interrupt suppression.** For 5 s from the reply's `Escape` (the window starts just before Kage sends it), Kage ignores the "[Request interrupted" and denial-line signals of §5.3, so the Escape that is part of a reply doesn't read as a user cancel.
  - **No pre-trusting** (owner's ruling). Kage never writes Claude's configuration to skip the trust screen. Claude trusts the folders below a trusted repo, so the screen shows only for a project that was never trusted, and the board answers it.
- **Risk:** the transcript format is internal to Claude Code and may change. The reader is one module with recorded fixture files and tests, and if it fails to parse, Kage falls back to a plain monospace rendering of `capture-pane` text. Version 1 must work in fallback mode too.

### 5.5 Live updates

- **One SSE stream** (`GET /api/events`) per browser tab. The server pushes `snapshot` on connect, then small events: `session.updated` (status, counts, the "now doing" line), `session.lines` (new display lines, only for the session the tab has selected), `session.files`, `session.ports`, and `session.removed`. (amended 2026-11-22, phase 4): an `archive {count}` event carries the number of archived sessions whenever it changes, and the `snapshot` carries `archived`, the same number (the list itself is `GET /api/archive`). The `snapshot` carries a `streamId` for that tab and the `projectsRoot`, and its sessions carry no lines (`lines: []`) — lines come only through `session.lines` for the viewed session. The tab tells the server which session it's viewing with `POST /api/view {streamId, id}`; the server answers on that stream with `session.lines {id, lines, reset: true}` (the last 200 lines), then appends new lines as they arrive. A stream whose queue backs up (a stalled tab) is dropped; the tab reconnects and gets a fresh snapshot.
- **Nothing is polled while nobody watches.** Hooks and `fs.watch` drive everything. The only timers are the port scan (every 5 s, only while a tab is viewing a session that's running) and a 30 s heartbeat comment on the SSE stream. Two more timers are allowed (amended 2026-11-21, phase 2): `TranscriptTail` polls the file size every 2 s, and every 1 s while the file doesn't exist yet, because `fs.watch` misses events on WSL and network file systems. Pane captures (`capture-pane`) happen only for sessions a tab is viewing, apart from the prompt and startup-screen checks (amended 2026-11-21, phase 2). A pane fallback capture that continues the last one sends only the appended lines; a redrawn screen resets them. A `claude` window still in its startup checks gets one extra capture a second after Kage first sees it, and activity in a shell window re-lists at most once a second, because `pane_current_command` changes fire no tmux event (amended 2026-11-21, phase 2). Ended sessions keep their last transcript lines and get no further captures (amended 2026-11-21, phase 2).
- **Actions** are small JSON POSTs: new task, answer, reply, stop, pin, archive, delete. Each action returns at once, and its result arrives as an event. **Except delete** (amended 2026-11-22, phase 4): `DELETE /api/sessions/:id` waits for the removal and answers 204 after it, so a failure can say why (B10). **Except new task** (amended 2026-11-21, phase 3): `POST /api/sessions` waits for `git worktree add` (up to 60 s) and the window launch, then answers 201 with the session's id. It is synchronous so that a failure can say why and roll back.
- **Ports and files** (amended 2026-11-21, phase 3): `session.ports` and `session.files` go out for the viewed session on every refresh, also when empty or unchanged, and in the reconnect snapshot, so a held value never goes stale. The port scan runs while a tab views a session that is **running or needs you** (the spec said running only; a dev server stays up while Claude waits for an answer), every 5 s, and once at a turn end. Caps: 100 files per session (`session.files` also carries the total), and line counts are read for at most 100 untracked files.

### 5.6 The terminal view (lazy)

Opening Terminal (`T`) loads xterm.js the first time (about 90 KB gzipped, then cached) and opens `GET /api/sessions/:id/terminal` as a WebSocket. As built (amended 2026-11-22, phase 4):

- **Control mode, no native modules.** One tmux control-mode client (`tmux -C attach -t kage`, a plain child process, no pseudo-terminal) serves every terminal. It is **lazy**: it starts with the first terminal, and closes 1 s after the last (R80), so a reload reuses it. Every line Kage writes to it must match a short list of known commands, so a stray byte can't become a tmux command. The spike confirmed this works with Claude's interface, so the per-terminal `tmux attach` fallback was not needed.
- **Opening.** The socket speaks the sub-protocol `kage.term.v1` and may carry `?cols=&rows=` (20–500 columns, 5–200 rows). The server sends a text frame `{t:'reset', cols, rows, mode}`, then one binary frame with the pane's snapshot, then the pane's `%output` as binary frames. `%output` is filtered by pane id: there is no per-pane opt-in in tmux 3.4 (host §4). The browser sends `{t:'in', d}` for keys and `{t:'size', cols, rows}` for a new size, and the server answers a size change with `{t:'size'}`.
- **Snapshot.** `capture-pane -p -e -N -S -1000` (the screen and up to 1,000 rows of history, at most 1 MiB, oldest rows dropped first). It is **count-framed**: the bridge learns how many rows to expect and reads exactly that many lines, so a pane that prints `%end …` can't end the reply early. The snapshot also replays the private modes Claude sets and tmux can't report back: bracketed paste (`?2004h`), focus reports (`?1004h`) and colour-scheme reports (`?2031h`) (R61).
- **Keys are hex.** Input goes to the pane as `send-keys -t %<pane> -H <hex bytes>`, at most 7,999 bytes a line, so every byte arrives raw (host §4.2). A frame holds at most 64 KiB once encoded, and the browser splits larger pastes by encoded size, never inside a character.
- **Size.** While a read-write terminal is open, the browser's size drives the window: `resize-window -t @W -x <cols> -y <rows>`, debounced 100 ms. When the last terminal on that window closes, Kage restores sizing with `set-option -w -u -t @W window-size` **only for a window it resized** (R61). Never `resize-window -A`: it sets `window-size` back to `manual` (host §4). With no normal client attached, the window then stays at the terminal's last size.
- **Backpressure and resync.** A socket with more than 1 MiB unsent stops receiving output. Once it is under 256 KiB (checked every 100 ms) it gets a fresh snapshot, and output resumes after it. If tmux's input holds more than 1 MiB unread, the terminal closes with 1009.
- **Limits.** 8 terminals in all and 3 on one pane (one more closes with 4429). Input frames 64 KiB. Snapshots 1 MiB. A hidden tab closes its terminal after 5 minutes (R81), and `T` opens it again.
- **External windows are view-only** (R54). A window Kage didn't create opens in mode `ro`: the bridge and the server both drop its input and its resizes, and the panel says "View only: Kage didn't start this window, so it doesn't type into it."
- **Leaving.** Every key goes to Claude, `Esc` included, so plain `Esc` never leaves. **`Shift+Esc` or `Ctrl+Shift+X`** returns to the board (R56, R64), and the footer says so. Chrome's Task Manager may take `Shift+Esc` on Windows and Linux: use `Ctrl+Shift+X` there. While the terminal view is open, the board's own keys do nothing (F9). The terminal closes by itself when its session ends.
- **No `unsafe-inline`, ever** (R55, R60). xterm 6 has no nonce option, and a nonce never covers the style attributes its DOM renderer writes for true-colour cells. Kage uses the **DOM renderer** and a 370-byte **CSSOM shim**, loaded only with the terminal chunk. The shim replaces `document.createElement('style')` with one that returns an inert `<template>` whose text goes into a constructable stylesheet, and it stays installed for the page's life. It touches `style` elements only. The CSP is unchanged and a test asserts that it never contains `unsafe-inline`. WebGL was rejected: 123 KB gzipped, over the budget.
- **Close codes.** Before the upgrade, a failed check answers plain HTTP (400, 401, 403, 404, or 503 while Kage stops). After it, the server closes with one of these:

| Code | Meaning | Reason sent |
|---|---|---|
| 1001 | Kage is stopping | Kage is stopping. |
| 1003 | A message Kage doesn't understand | Kage didn't understand that. |
| 1009 | Too much at once (a frame over the limit, or tmux's input backed up) | That was too much at once. |
| 1011 | tmux stopped, or the open failed | tmux stopped. / Kage couldn't open the terminal. |
| 4403 | The window isn't Kage's (read-write needs ownership) | That window isn't Kage's any more. |
| 4404 | No such session | No session with id <id> |
| 4409 | The session ended, or its window closed | This session has ended. / The session's window has closed. |
| 4429 | Too many terminals | Too many terminals are open. Close one and try again. |
| 4501 | Demo mode | Demo mode has no terminal. |

  The browser reconnects after 1011 (after 1 s, then 3 s) and then gives up. Every other close ends the terminal and shows the reason, or "The terminal closed." when there is none.
- **Any `Connection: Upgrade` request is handled by the terminal server**, which refuses every one that isn't a valid terminal upgrade, so no other path can be upgraded. The Host check compares names exactly, so a trailing-dot FQDN (`my-pc.tailXXXX.ts.net.`) is refused.

### 5.7 Preview ports and changed files

- **Ports:** on Linux, `ss -ltnpH`; on macOS, `lsof -iTCP -sTCP:LISTEN -nP`. Kage keeps only the ports whose process is a descendant of the window's pane process (`#{pane_pid}`), walked with `ps -A -ww -o pid=,ppid=,args=` (as built, amended 2026-11-21, phase 3). The card's label is the program name from the `ps` of the listener's own process tree, because `ss` names a Node process "MainThread". A daemon that detached from the pane (its parent is now `init`) isn't found. Links point to `http://<tailscale-host>:<port>`. If a port listens only on 127.0.0.1, its card says "Only on this machine" and shows the `ssh -L` command instead of a link.
- **Files:** refresh after edit hooks and `Stop`. View diff opens a read-only diff. As built (amended 2026-11-21, phase 3), the file list is **the merge base to the working tree, plus untracked files**: `git diff --numstat <merge base of refs/heads/<base> and HEAD>` (so uncommitted edits count, which `<base>...` would leave out) and `git ls-files --others --exclude-standard`, with line counts for small untracked files. Every git call runs with `GIT_OPTIONAL_LOCKS=0`, so Kage's status checks never take the index lock away from Claude. **Phase 4's diff must use the same form** (merge base to working tree, plus untracked), or the list and the diff will disagree. As built (amended 2026-11-22, phase 4):
  - **One list function.** The diff uses `listChanges`, the list's own function, so the two can't disagree: merge base, uncommitted changes and untracked files (untracked ones as new-file hunks).
  - **Flags.** Every git call is `--no-ext-diff --no-textconv --no-color`, and the status and diff calls add `--ignore-submodules=none`, so a submodule pointer change is never hidden by `diff.ignoreSubmodules` or `.gitmodules`. Repository-configured diff programs never run.
  - **Clean filters** (R67). `git status` may run a repository's clean filters (`filter.<name>.clean`). That is the same trust level as phase 3's worktree diff, so it is documented here and not prevented.
  - **Pages.** `GET /api/sessions/:id/diff?from=<n>` answers a page of whole files, starting at file number `n` (0 by default): at most `LIMITS.diffLines` (1,000) lines and 512 KiB, with lines cut at 2,000 characters. A page ends at the first file the budget can't fit, and `next` is that file's number, or null on the last page. A file longer than a page is clipped and says "N more lines in this file aren't shown." Binary files and symbolic links show a one-line note. The answer is never cached.
  - **Load.** At most two diff requests per session at once, the running one included (R76); a third gets 429, "Kage is still working on the last diff." A request whose tab went away is dropped. `listChanges` reads up to 100 MiB of untracked files on each request (backlog B37).

### 5.8 Finishing sessions

- **Stop:** `tmux kill-window -t <id>`, for windows Kage created only. The worktree and branch stay.
- **Pin** (amended 2026-11-22, phase 4): a flag in the state file. Pinned sessions sort first in Done and are never archived automatically. It needs a record (an external window gets 403, "Kage only pins sessions it started."). Unpinning stamps `unpinnedAt`.
- **Archive** (amended 2026-11-22, phase 4): closes `claude` if it's still running, and hides the session from the list, but keeps its worktree and branch. It refuses a running or needs-you session (409, "Stop the session before archiving it."), and inside the session's action lock it re-checks, immediately before the kill, that the session is still idle and that the pane shows no busy footer (a follow-up typed in between wins). Archived sessions are listed under "archived N" (`GET /api/archive`, newest first, at most 200) and can be restored: Restore stamps `restoredAt`, and auto-archive then leaves the session alone until its next move into done (F2).
- **Auto-archive** (amended 2026-11-22, phase 4): a done or ended session is archived once its branch is **merged** into the base (`autoArchive.onMerge`), or when it has been done for `autoArchive.afterDays` days (`0` turns the age rule off). It is event-driven. Nothing polls (this replaces "checked on `Stop` and every 10 minutes"):
  - **Triggers:** a session moving into done or ended; server start; a change to the project's git directory (the names `FETCH_HEAD`, `ORIG_HEAD`, `packed-refs` and `HEAD`, with or without `.lock`, so a merge, pull, fetch or rebase counts), checked after 5 s of quiet; and one timer, set to the earliest age deadline. A directory that can't be watched is logged once, and merges there are seen at the next turn end or restart. At most two git checks run at once, never two for one project.
  - **Age** counts from the latest of `doneAt`, `restoredAt` and `unpinnedAt` (R69), so unpinning or restoring an old session never archives it at once.
  - **Exempt:** pinned sessions, sessions restored since they last finished (F2), and **sessions with a terminal open** (F11, R70: checked again inside the lock, after the pane capture). A session the archive refuses (its busy footer shows anywhere on screen) is tried again at the next trigger or restart.
  - **Merged** means all of: the worktree is on the branch (a detached HEAD with commits of its own is never merged); the branch has a commit past `baseCommit`; and either its tip is an ancestor of `refs/heads/<base>` or `refs/remotes/origin/<base>`, or every path the branch changed since `baseCommit` is identical in the tip and in that base (a squash or rebase merge). The path check lists both changes with `git diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=none --name-only -z` and compares them in Kage, so it runs no repository program. `git merge-tree` is never used: it runs a repository's merge drivers (R59, F7; host §5.5). Any git failure means not merged.
  - **A revert** (R66): a branch that was merged and whose merge was later reverted still counts as merged when the merge was a real one, because its commits stay reachable from the base and nothing is lost. A squash merge that was later reverted is not merged: its paths differ again.
- **Delete** (amended 2026-11-22, phase 4): shows the confirmation from the design. The warning counts three things, each only when above 0: **unpushed** commits (the ones only this branch, or the worktree's HEAD, reaches: `git rev-list --count refs/heads/<branch> HEAD --not --exclude=<branch> --branches --remotes --tags`, so a commit on any other branch, remote or tag counts as safe), **uncommitted** files (`git status --porcelain=v1 -z --untracked-files=normal --ignored=matching --ignore-submodules=none`, every entry but the ignored ones, an untracked folder once), and **ignored** files (R73, R75: `.env`, `node_modules/`, which the removal deletes too; an ignored folder counts once). Confirming sends `DELETE /api/sessions/:id` with those three counts as the body. In order:
  1. A running or needs-you session is refused (409, "Stop the session before deleting it.").
  2. **Containment.** The worktree must lie below `<project>/<worktreeDir>` (also through symlinks), be listed by `git worktree list --porcelain` and not be the main checkout, and the branch must start with the configured `branchPrefix` (R74). With `branchPrefix: ""` that last guard is off. Otherwise 409, "Kage won't touch <worktree>: it isn't one of Kage's worktrees." A listed worktree on another branch, or on a detached HEAD, is a 409 with its own sentence (R71, §6.6).
  3. **Recount.** The counts are read again and must equal the confirmed ones. If not, nothing is touched, the session's new counts go out as a `session.updated`, and the answer is 409, "The branch changed since you looked. Look again before deleting."
  4. `kill-window` if the window is alive, then the counts are read **once more** (F10), because a follow-up typed into an idle `claude` between steps 3 and 4 could have changed the tree. A mismatch gives the same 409, with the worktree intact.
  5. `git worktree remove --force` (60 s limit), then `git branch -D`, then the record is removed. `--force` and `-D` are safe only because the confirmed counts matched in step 4. Kage **never runs `git worktree prune`** (R72): it would unregister other, external worktrees.
  6. 204. If the worktree went but the branch didn't, the answer is 422, "Removed the worktree, but git couldn't delete the branch: …".

### 5.8a Restarts and reboots

- On start, Kage creates the tmux session `kage` if it's missing (`tmux new-session -d -s kage`), then reconciles: every window with a known `@kage_id` is re-linked, and every record without a live window becomes **ended**.
- An ended session keeps its worktree, branch and last output (from its transcript file). Its footer offers **Resume** on the left (`U`; it opens a new tagged window in the worktree and runs `claude --settings <file> --permission-mode <the record's mode> --resume <session id>`, or `--continue` when the record has no session id or one that isn't a strict UUID (amended 2026-11-22, phase 4); the P3F1 rule applies, §5.3, so the session reads "Starting Claude…" until it is ready) and Archive and Delete on the right.
- Kage never resumes sessions by itself after a reboot; the developer chooses which ones to resume.
- **Resume, as built** (amended 2026-11-22, phase 4): `POST /api/sessions/:id/resume`, 204. It runs under the same per-session action lock as archive and delete (409, "Kage is still finishing the last action on this session."). It checks the same **containment** as delete (B7): the worktree below `<project>/<worktreeDir>`, on its own branch (R71), the branch under `branchPrefix`. 403 for a window Kage didn't create; 409 for an archived session ("Restore the session before resuming it."), one that is still running, one that already has a window, or a worktree that is gone; 503 with no `claude`.
- The systemd user unit starts Kage after the network and Tailscale are up. Kage owns starting the tmux session, so no tmux unit is needed.

### 5.9 Notifications

When a session moves to needs you, Kage sends a browser notification (Web Notifications, after the user allows them on the page) and, if `ntfyTopic` is set, a POST to ntfy. Clicking the notification opens that session.

### 5.10 Security

Kage can run commands on the machine, so the defaults are strict:
- **Network:** listen on the Tailscale IPv4 address only (from `tailscale ip -4`, or `host` in the config). Refuse to start on `0.0.0.0` unless `--unsafe-listen-all` is passed.
- **DNS rebinding:** reject requests whose `Host` header isn't the configured host name or IP.
- **CSRF:** every POST and WebSocket needs the header `X-Kage: 1` and a matching `Origin`. As built (amended 2026-11-22, phase 4): a browser can't add `X-Kage` to a WebSocket, so the terminal's upgrade is checked **before it happens**, in this order: the path, `GET` with `Upgrade: websocket`, the `Host` (403), the **exact** `Origin` (`http://<allowed name>:<port>`; a missing one is refused, 403), the token cookie when a token is set (401), the sub-protocol `kage.term.v1` (400) and the size in the query (400). A page on another origin can't open a terminal.
- **Optional token** (as built, amended 2026-11-21, phase 3): `token` in the config, at least 16 characters (a shorter one stops Kage at start). When set, every `/api/*` route needs the cookie `kage_auth`, except `GET /api/auth`, `POST /api/login` and `POST /api/logout`.
  - The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, 30 days, and `Secure` over https. Its value is an HMAC-SHA256 of a fixed label keyed with the token, so it reveals nothing of the token. It is compared in constant time.
  - `GET /api/auth` answers 204 when signed in and 401 when not. `POST /api/login {token}` sets the cookie and answers 204, or 401 for a wrong token. `POST /api/logout` needs only the CSRF header, always clears the cookie, and answers 204.
  - **Limiter.** 5 failed logins from one address block that address for 60 s (429). A global ceiling of 30 failures a minute blocks everyone, so one peer can't lock the others out one by one. Only failures count.
  - A 401 anywhere returns the board to the login screen.
  - **There is no server-side expiry.** The cookie lasts its 30 days. To sign out every device, change the token and restart Kage.
  - **Without a token**, live mode prints one line on stderr at startup: "No token set: anyone on your tailnet can start and approve tasks." The demo mode doesn't print it.
- **Hook socket:** a Unix socket with `0600` permissions, owned by the user.
- **Shell safety:** all tmux and git calls use `execFile` with argument arrays, never a shell string. Task text reaches `claude` as a single argument.
- **Ownership:** stop, pin, archive, delete and resume are refused unless the target window's `@kage_id` matches one of Kage's records (§5.2). Answer and reply also work on external windows.

### 5.11 Configuration

`~/.config/kage/config.json`:

```json
{
  "name": "my-pc",
  "projectsRoot": "~/projects",
  "host": "my-pc",
  "port": 8080,
  "tmuxSession": "kage",
  "worktreeDir": ".worktrees",
  "branchPrefix": "kage/",
  "autoArchive": { "onMerge": true, "afterDays": 14 },
  "ntfyTopic": "",
  "token": ""
}
```

`worktreeDir` and `branchPrefix` are checked when the config loads (amended 2026-11-21, phase 3). `worktreeDir` is a relative folder name made of plain segments: no `..`, no `.git`, no leading `/`. `branchPrefix` is empty or looks like `kage/`: letters, digits, `.`, `_`, `-` and `/`, no segment starting with `-` or `.`, none ending in `.lock`. The environment variable `KAGE_CLAUDE_BIN` names the `claude` program for new tasks (a path, or a name on `PATH`).

`name` is the machine name shown in the host pill (default: the short host name). `host` is the address Kage listens on (default: the Tailscale IP). Projects are the git repositories directly inside `projectsRoot`. The New task picker defaults to the project used last and to that repo's default branch.

### 5.12 HTTP API

| Method and path | Purpose |
|---|---|
| `GET /` | The board (HTML, CSS and JS inlined or preloaded) |
| `GET /api/events` | SSE stream (§5.5) |
| `POST /api/view` | `{streamId, id}`: which session this tab shows (`id: null` for none) |
| `GET /api/projects` | Projects and their branches, for New task. 501 in demo mode |
| `GET /api/auth` | 204 when signed in, else 401 (always open) |
| `POST /api/login` | `{token}`: sets the cookie (204); 401 wrong token, 429 too many tries |
| `POST /api/logout` | Clears the cookie (CSRF only; 204) |
| `POST /api/sessions` | `{project, base, task, acceptEdits}`: start a task. 201 with the new session's id; 400 bad body; 404 unknown project or branch; 422 git or tmux failed (rolled back); 503 no `claude` |
| `POST /api/sessions/:id/answer` | `{option, question}`: option 1–9 and the question text the card showed. 409 if the question changed or isn't waiting |
| `POST /api/sessions/:id/reply` | `{text}`: a typed answer, or a follow-up task for a done session |
| `POST /api/sessions/:id/stop` | Stop (no body). 403 for a window Kage didn't create |
| `POST /api/sessions/:id/pin` | `{pinned}` (204). 403 for an external window (amended 2026-11-22, phase 4) |
| `POST /api/sessions/:id/archive` | `{archived}`: `true` archives, `false` restores (204). 409 for a running or needs-you session (amended 2026-11-22, phase 4) |
| `GET /api/archive` | `{sessions: [{id, project, task, branch, archivedAt}]}`, newest first, at most 200 (amended 2026-11-22, phase 4) |
| `DELETE /api/sessions/:id` | `{unpushed, uncommitted, ignored}`: the counts the confirmation showed, whole numbers up to 1,000,000. Answers 204 after the removal; 409 if the counts changed (nothing removed) or the worktree isn't Kage's; 422 for git or tmux failures (amended 2026-11-22, phase 4) |
| `POST /api/sessions/:id/resume` | No body (204). 409 unless the session is ended and has no window (amended 2026-11-22, phase 4) |
| `GET /api/sessions/:id/diff?from=<n>` | One page of the unified diff (§5.7). `from` is a whole number, 0 by default; 400 if not. 429 when two are already running (amended 2026-11-22, phase 4) |
| `GET /api/sessions/:id/terminal` | WebSocket (§5.6). A plain GET answers 426 "Open the terminal with a WebSocket." (amended 2026-11-22, phase 4) |
| `POST /hook` (Unix socket only) | Hook events from `kage hook` |

**Status codes** (amended 2026-11-21, phase 3): a failure's body is `{error}`, one plain sentence.
- 400: a bad body (exact keys only; control characters, length and prefix rules).
- 401: no or wrong token. 403: a window or origin Kage doesn't own. 404: no such session, project or branch.
- 409: the session isn't in the state the action needs (the question changed, still working, ended, text still in the input box).
- 413: a body over 16 KB. 422: git or tmux refused. 426: the terminal path needs a WebSocket (amended 2026-11-22, phase 4). 429: too many logins, or two diff requests already running (amended 2026-11-22, phase 4). 503: no `claude`.
- 501: demo mode has no tasks or controls.

### 5.13 Install and distribution

**For users, one command:**

```sh
curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh
```

`install.sh` is a short POSIX shell script, readable before you run it. It:
1. detects the OS and CPU (Linux x64/arm64, macOS arm64/x64; on Windows it explains that WSL is required);
2. downloads the matching `kage` program from the latest GitHub Release and verifies its SHA-256 checksum against the release's `SHA256SUMS`;
3. installs it to `~/.local/bin/kage`, with no `sudo` (or `$KAGE_INSTALL_DIR`), and says how to add that folder to `PATH` if needed;
4. runs `kage setup`.

**`kage setup`** (interactive, and also usable later to change settings):
1. checks the requirements and says exactly what's missing, with the command to install it: tmux 3.2+, git 2.40+, Claude Code (signed in), Tailscale (up);
2. asks for the projects folder (it suggests `~/projects` or the folder that holds most git repos), confirms the Tailscale host name and port, and asks whether to set an access token;
3. writes `~/.config/kage/config.json`;
4. installs and starts a service: a systemd user unit on Linux (and offers `loginctl enable-linger`, so Kage runs without a login), or a launchd agent on macOS;
5. prints the address to open, for example `http://my-pc:8080`, and checks that it answers.

**Other commands:** `kage status` (the service, the address, the session count), `kage update` (downloads the latest release the same verified way, then restarts the service), `kage uninstall` (removes the service and the program; it keeps sessions, worktrees and the config unless `--purge` is given), and `kage doctor` (runs the requirement checks again).

**Release artifacts** (built by GitHub Actions for every tag `v*`):
- a single-executable `kage` for each platform, made with Node's single executable applications (SEA) from the esbuild bundle, with the UI files embedded as assets;
- `SHA256SUMS`, plus build provenance attestations;
- the npm package `@eridian-io/kage` as a second way in, for people who already use Node (`npm install -g @eridian-io/kage`, then `kage setup`).

**Risk:** SEA on macOS needs code signing (ad-hoc signing at least, and notarisation for a smooth first run). The plan starts with a spike that builds and runs a SEA binary on Linux and macOS. If it fails there, the fallback is the npm package with the same `kage setup`.

## 6. The UI, exactly as designed

The design target is the source of truth. Open `docs/design/kage-board.html`; where this text and the page disagree, the page wins.

### 6.1 Layout (desktop, at least 1100 px wide)

- **Top bar, 44 px:** the logo (`assets/kage-logo.png`, 22 px, rounded 6 px) and the off-white "kage" wordmark; the host pill "my-pc · N sessions" with a status dot; the counts "N needs you" (amber dot) and "N running" (lime dot); `⌘K` at the right.
- **Left column, 250 px:** "＋ New task  N" in lime; then the groups "needs you", "running" and "done" (lowercase labels). Each row shows `project /` in muted text, the task, and the age at the right. A waiting row adds the amber line "waiting for your reply". The selected row has a lime 2 px left edge. Pinned rows start with ★. Done shows pinned first.
- **Middle column (the session):**
  - Header: `project / task` at 18 px, with the status chip (amber "needs you", lime "running", grey "done"). Below it, the meta line in mono, `branch …   worktree …   started … ago`, with a short worktree path and the full path in a tooltip. A thin line underneath.
  - Output: display lines (§5.4) on the page background, with no box. A lime block cursor while running.
  - Question (when waiting): "Waiting for you" in amber, the question at 15 px, outlined option buttons with their number, and "or press R to reply".
  - Delete confirmation (when asked): a muted-red outlined panel with the paths, the unpushed warning, and "Delete session" and "Cancel".
  - Follow-up (done sessions): a quiet one-line field, "Follow up in this session…" with `R`, above the footer. Typing and pressing Enter sends the text and the session goes back to running.
  - Footer, always present: Terminal `T` on the left; on the right, Stop `X` (running or waiting), or Archive `E` and Delete… (done).
- **Right column, 250 px:** "Preview" with a card for each port (`:5173 vite` and a lime "Open ↗"), or "No ports open yet."; then "Files changed · N" with +/− counts and "View diff →".

### 6.2 Tokens

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0f1114` | page background |
| `--line` | `#1b1e23` | dividers |
| `--line-strong` | `#2a2f37` | button and chip outlines |
| `--fg` | `#c9ced6` | body text |
| `--fg-strong` | `#eef0f3` | titles, selected row, the wordmark |
| `--fg-2` | `#8a919c` | secondary text, meta values |
| `--fg-3` | `#5f6672` | labels, project prefixes, hints |
| `--lime` | `#cdf35a` | alive or actionable (§6.3) |
| `--amber` | `#d9a650` | needs you |
| `--red` | `#e08a8a` | Stop, Delete |
| `--add` / `--del` | `#9cc59f` / `#c98d8d` | diff lines and counts |
| Fonts | Geist 400/500/600/700, Geist Mono 400/500 | sans for prose and UI, mono for code, paths and meta |

### 6.3 Colour rules

- **Lime** only for what's alive or actionable: New task, the selected row's edge, the live cursor, the thinking line, preview links, the running chip, and hover states on links.
- **Amber** only for "needs you".
- **Muted red** only for Stop and Delete.
- The "kage" wordmark is never lime. No glows, pulses, gradients or filled colour blocks, except the solid red "Delete session" button inside the confirmation.

### 6.4 Keyboard

`N` new task · `J`/`K` next and previous session · `1`–`9` answer · `R` reply · `T` terminal · `X` stop (twice) · `S` pin · `E` archive · `U` resume (an ended session) · `Esc` closes the diff view, the dialog or the confirmation (in the terminal `Esc` goes to Claude; `Shift+Esc` or `Ctrl+Shift+X` leaves it, §5.6) · `⌘K`/`Ctrl K` command palette (version 1: jump to a session, new task). Shortcuts are ignored while typing in a field. **Stop on `X` needs a second press within 2 s** (amended 2026-11-21, phase 3): a stray key must not kill a session. The first press shows "Press X again to stop" in the muted text colour, and the Stop button still stops at once. Held keys don't repeat an action (`J`/`K` still repeat: that is list navigation). Stop shows only for a running or needs-you session that Kage created. (amended 2026-11-22, phase 4): `S`, `E`, `U` and `T` follow the same rules (no repeat, ignored while typing) and act only on sessions Kage started. Pin also has a quiet **★ toggle** in the session panel header (R77): grey, filled when pinned, `aria-pressed`, so a mouse user can pin. In the diff view `J` and `K` jump between files.

### 6.5 States the design doesn't show (builder's calls)

- **First run with no sessions:** the middle column says "No sessions yet" and offers the New task form with a short explanation.
- **New task:** clicking New task turns the left column's top into a form (task text, Project ▾, Branch off ▾, an "Accept edits automatically" checkbox, Start). `Enter` starts it, and `Esc` cancels.
- **New task, as built** (amended 2026-11-21, phase 3): the form loads the projects ("Loading…", or "No git repositories in <projectsRoot>." when there are none), picks the last-used project and its default branch, and disables Start while the stream is down. Start shows "Starting…" until the 201, then selects the new session. An error shows in one line under the form, in the server's own words. The form is inline and non-modal, with no focus trap, and `Esc` is always visible. In demo mode the server's 501 sentence shows as that line.
- **Login** (amended 2026-11-21, phase 3): when a token is set and the browser has no valid cookie, the page shows only an "Access token" field and **Sign in** (in the strong text colour, not lime). A wrong token shows "That token isn't right."; too many tries show "Too many tries. Wait a minute and try again."
- **Local-only port** (amended 2026-11-21, phase 3): the card says "Only on this machine" and shows `ssh -L <port>:localhost:<port> <host>` to copy. When the board itself is open on that machine, the port links to `localhost`.
- **Server unreachable:** a thin bar under the top bar says "Reconnecting to my-pc…". The UI stays readable, and actions are disabled until the connection is back.
- **Terminal open** (amended 2026-11-22, phase 4): the output area becomes the terminal. Its footer shows "Back to session" with `⇧Esc`, and the hint "Shift+Esc (or Ctrl+Shift+X) to leave". While it loads: "Loading the terminal…". A view-only window shows "View only: Kage didn't start this window, so it doesn't type into it." A failure returns to the output and shows a line there: "Couldn't load the terminal.", "Couldn't open the terminal.", or the server's close reason.
- **Diff view** (amended 2026-11-22, phase 4): it replaces the output area with a read-only unified diff, one page at a time (Previous, Next), with "No changes yet." when empty and "Back to session  Esc" as the footer. An error keeps the last page and its buttons and adds "Couldn't load the diff. …" and a **Try again** button.
- **Archived list, toasts, warning** (amended 2026-11-22, phase 4): "archived N" sits at the bottom of the left column and opens the list (project, task, age, **Restore**). Archiving shows a toast "Archived <name> · worktree and branch kept", deleting "Deleted <name> · worktree and branch removed". Only a removal this page asked for shows one. The delete confirmation names the loss (§5.8, §6.6), and Delete session ignores a click within 400 ms of its counts changing.
- **Ended session** (after a reboot, or when `claude` exited): the chip says "ended" in grey. The footer shows Resume `U` on the left, and Archive `E` and Delete… on the right.

### 6.6 Copy added in phase 4 (amended 2026-11-22, phase 4)

Every new sentence a user can read, collected. A change here is a change in the code and its tests.

- **Action errors on the board** are `Couldn't <verb>. <the server's sentence>` (a lower-case first letter raised), with the verb `send`, `pin`, `unpin`, `archive`, `restore`, `resume` or `delete`, shown above the session's footer. Also `Couldn't load the archive. …` and `Couldn't load the diff. …`. With no answer at all: "Kage didn't answer."
- **Server fallbacks** (a 500 with the first line of the error): "Kage couldn't change the session: …", "Kage couldn't delete the session: …", "Kage couldn't resume the session: …", "Kage couldn't send that to the session: …", "git couldn't show the diff: …".
- **Containment, one sentence for delete and resume:** "Kage won't touch <worktree>: it isn't one of Kage's worktrees." (It first read "won't delete", which was wrong for resume.)
- **Off-branch worktree** (R71, delete and resume): "This worktree isn't on its branch any more. Switch it back in the terminal, or remove it there."
- **Partial delete:** "Removed the worktree, but git couldn't delete the branch: …"
- **Busy:** "The screen is still drawing. Try again in a moment." (409, when the pane changed while Kage checked it), "Kage is still finishing the last action on this session." (409, another action holds the session) and "Kage is still working on the last diff." (429).
- **Delete:** "Stop the session before deleting it."; "The branch changed since you looked. Look again before deleting."; the confirmation: "Delete this session? This removes the tmux window, the worktree <path> and the branch <branch>." followed by the loss line, which joins up to three sentences: "N commits aren’t pushed and will be lost." (or "1 commit isn’t pushed…"), "N files have uncommitted changes and will be lost." (or "1 file has…"), "N ignored files (like .env) will be deleted too." (or "1 ignored file…"), or, when all are 0, "Everything on the branch is pushed, so nothing is lost." The ignored line shows whenever the count is above 0 (R75). The apostrophes in the first are curly.
- **Archive and resume:** "Stop the session before archiving it."; "Restore the session before resuming it."; "This session is still running."; "This session already has a window."; "The worktree is gone, so Kage can't resume this session."; "Kage only pins sessions it started." (and archives, deletes, resumes).
- **422 from git and tmux:** "git couldn't count the work on the branch: …", "git couldn't list the worktrees: …", "git couldn't read the branch: …", "git couldn't remove the worktree: …", "git couldn't delete the branch: …", "tmux couldn't read the window: …", "tmux couldn't close the window: …".
- **Toasts:** "Archived <name> · worktree and branch kept"; "Deleted <name> · worktree and branch removed".
- **Diff:** "Binary file, not shown."; "Symbolic link, not shown."; "N more lines in this file aren't shown."; "No changes yet."; the button "Try again"; and, for a bad `from`, "from must be a whole number."
- **Terminal:** "Loading the terminal…"; "Couldn't load the terminal."; "Couldn't open the terminal."; "The terminal closed."; "That was too much at once."; the leave hint "Shift+Esc (or Ctrl+Shift+X) to leave"; the view-only line (§6.5); and the close reasons of §5.6. Plain HTTP refusals of the upgrade: "Open the terminal with a WebSocket.", "Unknown host", "Bad origin", "Kage's terminal speaks kage.term.v1.", "The terminal size is out of range."
- **Demo mode:** "Demo mode can't show diffs." for the diff; the other demo sentences are unchanged.

### 6.7 Copy added in phase 5 (draft, phase 5 Task 9; Task 11 finalises)

The same rule as §6.6: every new sentence a user can read, and a change here is a change in the code. `packages/web/src/spec-copy.test.ts` checks that each quoted sentence below is in the code.

- **Pings** (ntfy and the board's notifications carry the same text, N2): "<project> needs you" and "<project> is done", with the task as the message. An external window has no task to show (R93): the board says "Claude needs you" and ntfy "A Claude session needs you on <host>". `kage ping` sends "Kage test ping" with "ntfy is set up for <name>."
- **`kage ping` and `kage serve`:** "Sent a test ping to <host>."; "Couldn't send the ping (<reason>)."; "No ntfyTopic in ~/.config/kage/config.json."; at start, "Pings go to ntfy at <host>."
- **ntfy, in Kage's log:** "ntfy: couldn't send a ping (<reason>)."; "ntfy: the server refused the ping (HTTP N)." followed by " Check ntfyToken." for 401 and 403; "ntfy: too many pings; skipped N."; "ntfy: ntfyServer must be https: unless it is on this machine or your tailnet; no ping sent."; "The ntfy request timed out."
- **Config errors** (after "Config error: "): "ntfyTopic must be at least 16 letters, digits, - or _ on ntfy.sh: anyone who guesses it can read your pings"; "<key> must be up to N letters, digits, - or _"; "<key> must be an https: URL (http: only on this machine or your tailnet), with no user name, query or fragment".
- **Command palette:** the field "Jump to a session or run a command…"; "No matches."; "Keep typing to see more."; the footer "↑↓ to move · Enter to open · Esc to close"; the group "this session"; the commands "View diff", "Open the terminal", "Show archived", "Turn on browser notifications" (noted "shows project and task"), and "Browser notifications need HTTPS; use ntfy instead" where the page can't ask. A palette chunk that fails to load: "Couldn't open the palette. Press <key> to try again."
- **Diff loading** (R78): "Loading the diff…"; "Couldn't load the diff." with "Try again", and from the second failure "Reload the page".
- **Terminals:** "Too many terminals are open. Close one and try again." (B35).
- **Files changed:** "No files changed yet." (no View diff then); for an external window with nothing to list, "Kage didn't start this window, so there's no branch to compare."
- **API refusals** now end in a full stop like the rest: "No session with id <id>.", "Unknown stream.", "Not found.", "Request too large."

## 7. Performance budgets

These are checked in CI (§8):
- **First load:** HTML, CSS and JS at most **30 KB gzipped**, not counting fonts and the logo. Fonts are at most 60 KB (two woff2 subsets).
- **Time to a usable board:** under **300 ms** on the tailnet (LAN), measured from navigation to the first `snapshot` being rendered.
- **Hook to screen:** a status change appears in the browser within **150 ms** of the hook firing.
- **Idle server:** less than 1% CPU and under 80 MB RSS with 10 sessions and no tab open.
- **Rendering:** new output lines are appended, never a full re-render. Long outputs keep at most 500 nodes in the DOM.
- **Terminal:** loaded only on demand (about 90 KB gzipped, once).
- **After phase 4** (amended 2026-11-22, phase 4): the first load is about 25.4 KB gzipped (the build test's cap is 25.5 KB, below the 30 KB above), the terminal chunk about 92 KB, and the loader that fetches it at most 600 bytes. A diff page keeps at most 1,000 lines in the DOM.

## 8. Making sure it matches the design

- **Demo mode:** `kage --demo` serves the exact sample sessions from the design target (the same data object), with no tmux needed.
- **Visual tests:** Playwright renders the design target in frameless mode (`kage-board.html#full`) and the app in demo mode, both at 1320×900 and scale 1, in the same browser. Google Fonts requests from the target are redirected to the app's own self-hosted Geist files, so both use identical fonts. The test drives both to four states (needs you, running, done, the delete confirmation) and compares the two screenshots pixel by pixel; more than 0.5% differing pixels fails. Comparing live, rather than against stored images, means operating-system font rendering can't cause false failures. The screenshots in `docs/design/reference/` are the human-readable record of the same states. Changing the design means updating the target page and the screenshots in the same pull request.
- **Token test:** a unit test checks that `public/kage.css` defines every token in §6.2 with the listed value.
- **Behaviour tests:** end-to-end tests drive a fake `claude` (a script that fires the same hooks, writes a transcript fixture, and prints a numbered question), with real tmux and git, through: start a task, see running, see needs you, answer, see done, delete.
- **Budget tests:** a script measures the gzipped size of the first load and fails over budget, and a test measures hook-to-screen time.

## 9. Delivery in phases

The phases follow the owner's whiteboard. Each phase ends with a check that proves it works.
1. **Skeleton:** the server, config, Tailscale bind and security checks, and the board UI in demo mode, pixel-matched to the target. Check: the visual tests pass, and the board loads over Tailscale.
2. **Sessions:** the tmux bridge, hooks, transcript reader and SSE. Check: a Claude session started by Kage appears with live status and output.
3. **Control:** new task (worktree), answer, reply, stop, ports and files. Check: start, answer and stop a task from the laptop.
4. **Finish and terminal:** pin, archive, auto-archive, delete with warning, diff view, and the lazy terminal. Check: the full lifecycle, and the terminal works with Claude's interface.
5. **Polish:** notifications, the command palette, and the budget checks. Check: Kage pings the phone, and every budget in §7 passes.
6. **Install and release:** `kage setup`, `status`, `update`, `uninstall` and `doctor`; the systemd and launchd services; `install.sh`; SEA builds, checksums and the npm package in a release workflow. Check: on a clean Linux machine and a clean Mac, the one-line install leads to a working board, and Kage survives a reboot.

## 10. Left to the builder

- Exact copy for empty and error states, following the tone of the design.
- The internal module layout, as long as the transcript reader and the tmux bridge stay isolated behind small interfaces.
- How to vendor and subset fonts and xterm.js.
- Keyboard focus styling (visible, using lime at low opacity), within the colour rules.

## 11. Decisions from review (2026-11-21)

An independent builder check raised five questions. The owner answered two; the rest were settled as builder's calls:
- **Done sessions** (owner): they can take a follow-up; the idle notification never turns them amber; Archive closes `claude` (§5.3, §5.8, §6.1).
- **Permission mode** (owner): Claude Code's default, plus a per-task "Accept edits automatically" checkbox; never skip permissions (§5.2).
- **Build and install** (owner, later the same day): the "no build step" rule is dropped. TypeScript throughout, built with esbuild. A one-line installer sets Kage up as a service, and releases ship a single executable per platform plus an npm package (§3, §5.1, §5.13).
- **Restarts** (builder): windows are tagged with `@kage_id`; dead sessions become ended, with Resume on request (§5.2, §5.8a).
- **Reference screenshots** (builder): recaptured frameless at 1320×900 from `kage-board.html#full` (§8).

Auto-archive defaults (on merge, plus 14 days) are the builder's call and are configurable. Nothing else is open.
