# Phase 4: Finish and terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the board, the developer finishes sessions:
- pins them;
- archives and restores them, and has merged or stale ones archived for them;
- deletes them, with a warning before unpushed or uncommitted work is lost;
- resumes ended ones;
- reads the branch's diff.

They also open a full interactive terminal on a session, loaded only when asked for, that works with Claude Code's interface.

**Architecture:** Five new server parts sit next to `LiveSource`. It gains a few narrow entry points (`finishTarget`, `setFlags`, `forget`, `resumed`, `archivedList`, `terminalTarget`).
- `branchState` (in `git/branch.ts`) counts a branch's unpushed commits and uncommitted files, and decides whether it is merged. The preview tracker publishes the counts for viewed sessions.
- `FinishActions` pins, archives, restores and deletes, with ownership re-read before every kill and every git removal. `TaskLauncher.resume` reopens an ended session's window.
- `AutoArchiver` archives done sessions whose branch was merged, or that sat finished for `afterDays`. It is driven by events: turn ends, Kage's start, a watch on each project's git directory, and one deadline timer.
- `diffPage` (in `preview/diff.ts`) serves the branch's diff in pages. It is computed on request, in the same form as the file list.
- `TerminalBridge` runs one lazily started tmux control-mode client. It turns `%output` into bytes, sends keys as `send-keys -H`, and takes snapshots with count framing. `TerminalServer` guards and serves the WebSocket.

The board wires the controls that phases 1–3 left inert (Terminal, Archive, Resume, View diff), adds the archived list, the diff view and `S`/`E`/`U`/`T`. It loads xterm.js as a separate chunk the first time a terminal opens.

**Tech Stack:** as phase 3 (Node ≥ 24.2, TypeScript strict, Hono, Preact + signals, vitest, Playwright, real tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and in the Docker test image). New runtime dependencies: `ws` on the server, and `@xterm/xterm` with `@xterm/addon-fit` in the web's lazy chunk. Task 1 pins the exact versions. All three are pure JavaScript.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md):
- §5.1 (state, `ws`, the lazy chunk), §5.2 (ownership);
- §5.6 (terminal), §5.7 (files and the diff), §5.8 (finishing), §5.8a (Resume);
- §5.10 (security, WebSockets included), §5.11 (`autoArchive`), §5.12 (API);
- §6.1, §6.4, §6.5 (UI), §7 (budgets), §9 (phase 4 check), §11.

Backlog items B7, B9 and B10 in [`docs/backlog.md`](../backlog.md) land here. Facts: [`claude-code-integration.md`](../specs/claude-code-integration.md) and [`host-integration.md`](../specs/host-integration.md).

## Global Constraints

- Everything in the phase 1–3 Global Constraints still applies:
  - Node ≥ 24.2, strict mode plus `erasableSyntaxOnly`, no native modules;
  - `execFile`/`spawn` with argument arrays, never a shell;
  - copy from the design target, colours through tokens;
  - invented test data;
  - tests never touch the user's tmux server, config, state, git config or `~/.claude`;
  - `describe.runIf(hasTmux)` for tmux tests; git tests in temp repos with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and a temp `HOME`;
  - hooks stay silent;
  - the rulings R25–R50 and K1–K10 of the phase 3 ledger.
- **Start point:** branch `phase-4` from `phase-3`, once the phase 3 final fix wave has landed (Task 0 lists what it hands over).
- **Dependencies:**
  - `ws` (server) and `@xterm/xterm` plus `@xterm/addon-fit` (web), at exact versions.
  - `ws`'s optional native helpers (`bufferutil`, `utf-8-validate`) are never installed. A test asserts that neither resolves.
  - No other new dependencies.
- **Ownership (spec §5.2, §5.10):**
  - Pin, archive, restore, delete and resume need a record. External sessions get 403.
  - Every kill goes through `TmuxClient.killOwnedWindow`, which re-reads `@kage_id`.
  - Delete and auto-archive never touch a branch or worktree that Kage didn't create, nor a window whose live `@kage_id` differs.
- **Delete (owner's constraint):**
  - The request carries the counts the confirmation showed (`{unpushed, uncommitted}`), and the server recomputes them. Any difference is 409, and nothing is removed.
  - `git worktree remove --force` only when the confirmed `uncommitted` is above 0. `git branch -D` only when the confirmed `unpushed` matches the fresh count; 0 means nothing would become unreachable.
  - The worktree must be listed by `git worktree list --porcelain` on the record's branch, must not be the main worktree, and must lie inside `<repo>/<worktreeDir>/`.
  - A running or needs-you session is refused (409).
- **Terminal (spec §5.6, §5.10, backlog B9):**
  - The WebSocket upgrade checks, before any upgrade:
    - `hostAllowed`;
    - an exact `originAllowed`, where a missing Origin is refused (browsers can't send `X-Kage` on a WebSocket);
    - the `kage_auth` cookie when a token is set;
    - the subprotocol `kage.term.v1`.
  - A failed check answers a plain HTTP 400, 401, 403 or 404 and closes the socket.
  - Input and resize only reach a window whose live `@kage_id` matches the session's record (read at attach).
  - External windows are **view-only**: their output is shown, and their input and resize frames are dropped. Ruling T1 below gives the reasons.
  - The pane id always comes from the server's own state, never from the client.
  - Lines written to the control client never contain user text: keys travel as hex bytes (`send-keys -H`), and every line must match `SAFE_LINE`.
  - Command output is read with count framing, so a pane can't forge `%end`.
  - Limits:
    - 8 terminals in all and 3 per pane;
    - frames up to 64 KiB;
    - `perMessageDeflate` off;
    - a ws ping every 30 s, only while a socket is open.
- **Ruling T1 (external windows are view-only):** Kage may already show and answer external windows (spec §5.2), so showing their screen reveals nothing new. Raw input is a different power, for three reasons:
  - An external window in the `kage` session can hold anything the developer started by hand: a shell with `sudo` cached, an ssh session, another tool. Kage only ever sends it the narrow, screen-checked keys of answer and reply (§5.4).
  - Resizing would also change the developer's own layout.
  - Viewing costs nothing extra and covers "what is it doing", while `tmux attach` still covers typing.

  Cost if wrong: one condition in `TerminalServer` and one line of copy.
- **Ruling T2 (leaving the terminal):** inside the terminal, `Esc` belongs to Claude: it declines prompts, and a double `Esc` opens its rewind menu. So `Shift+Esc` leaves the terminal, and so does the footer's "Back to session". `Esc` still closes the diff view, a dialog and the confirmation. §6.4 and §6.5 get the amendment in Task 15.
- **Auto-archive (spec §5.8, owner's constraint "events, not polling"):**
  - Triggers:
    - Kage's start, after reconcile;
    - a session turning done or ended;
    - an `fs.watch` on each candidate project's git common directory (debounced 5 s);
    - one deadline timer for the earliest `doneAt + afterDays`, re-armed whenever it changes and clamped to 2³¹−1 ms.
  - There is no periodic scan; this replaces the spec's "every 10 minutes".
  - Pinned, archived, external, running and needs-you sessions are never candidates.
  - Merged needs a commit past `baseCommit` and a clean worktree.
- **git:**
  - Every call runs through `gitExec`/`gitStream`, with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, `-c core.fsmonitor=false` and the cleaned environment.
  - Diffs also pass `--no-ext-diff --no-textconv --no-color`, so a repository's configuration or attributes can't run programs.
  - Branch names from records must match `SAFE_REF` before they reach git.
  - Timeouts: 10 s; `worktree remove` 60 s; diff streams 15 s.
- **Request bodies:** strict as in phase 3: exact keys, exact types, one-sentence `{error}` bodies, and the phase 3 status codes. Every mutating route keeps `hostGuard`, `csrfGuard` and `authGuard`.
- **Idle cost:**
  - No terminal open means no control client and no ws timers.
  - No candidates means no auto-archive watchers or timer.
  - Diffs only on request.
  - A test asserts `vi.getTimerCount()` for each.
- **Colours:**
  - Lime only for the alive and actionable marks phase 3 uses, the terminal's cursor and the Restore link's hover.
  - Amber only for needs you.
  - Muted red only for Stop, Delete and the delete warning.
  - Diff lines use `--add`/`--del`; hunk headers use `--fg-3`.
  - Error lines use `--fg` or `--fg-2`.
- **Budget:**
  - The first load stays ≤ 30 KB gzipped (spec §7). It is about 21.4 KB at the end of phase 3, and phase 4 must end at ≤ 25.5 KB, leaving room for phase 5.
  - If the diff view pushes past that, it moves into its own lazy chunk, like the terminal.
  - The terminal chunk (JS plus CSS) is ≤ 100 KB gzipped, and never in `index.html`'s script or link tags.
  - Each UI task reports the build test's `first load gzipped` line.
- **Real Claude runs:** at most 4 short prompts in Task 1, and at most 8 in the Phase 4 check. Every other test uses `e2e/fake-claude.mjs`.

## Review Focus

1. **Terminal security.** Covered in Tasks 11, 12 and 14.
   - A cross-site page, a page on another port, a request with no Origin, and a signed-out browser can't open a terminal.
   - The checks run before the upgrade.
   - A pane id can't be chosen by the client.
   - No user byte reaches tmux's command parser.
   - A pane that prints `%end …` or `%output %9 …` can't end a capture early or inject bytes into another pane's view.
   - External windows never receive input or resizes.
2. **Destructive git.** Covered in Tasks 3, 6 and 14.
   - Delete removes only the record's own registered worktree and branch.
   - It never uses `--force` or `-D` beyond what the user confirmed.
   - Nothing is touched when the counts changed.
   - A tampered state file (a branch `-x`, a worktree `../../home`, the main checkout as worktree, a base equal to the branch) is refused with no git removal.
3. **Repository configuration can't run code.** Diff, status, rev-list and merge-tree never run textconv, external diff, fsmonitor or hooks. `merge-tree --write-tree` writes only unreachable objects (accepted: gc removes them). Covered in Tasks 3 and 8.
4. **Auto-archive correctness.** Covered in Task 5.
   - A branch with no commits is never "merged".
   - A dirty worktree is never merge-archived.
   - Squash and rebase merges count; a conflicting branch doesn't.
   - Pinned, external and active sessions are exempt.
   - It never polls.
5. **Claude's interface in the terminal.** Covered in Tasks 1, 11 and 13 and the Phase 4 check.
   - Keys (arrows, Enter, Ctrl+C, UTF-8), `Esc`, and a multi-line paste that must not submit early (bracketed paste).
   - Resize redraws.
   - The window size comes back after close.
   - Kage's pane parsers still read prompts at other widths (R39's renderer refusal stays).
6. **Idle cost and lazy loading.** No control client, socket timer, watcher or deadline timer without a reason. The xterm chunk is requested only on `T`. Covered in Tasks 5, 11, 13 and 14.
7. **Races.** Covered in Tasks 4–7, 11 and 12:
   - delete during a hook;
   - archive while auto-archive runs;
   - a double Resume;
   - a terminal attaching while its window closes;
   - a resize from two tabs;
   - a stalled tab (resync, not unbounded buffering).

## File structure

```
docs/specs/host-integration.md          Task 1: §4 tmux control mode for the terminal, §5 git for finishing
docs/specs/claude-code-integration.md   Task 1: §8 "Terminal and resume"
packages/shared/src/types.ts            Task 2: protocol v4 (uncommitted, archive count, bodies, DiffPage, terminal frames, LIMITS)
packages/shared/src/demo.ts             Task 2: uncommitted: 0
packages/server/src/
  state/store.ts          Task 2: SessionRecord gains baseCommit, doneAt, archivedAt
  git/exec.ts             Task 8: gitStream (spawn, byte cap, kill)
  git/branch.ts           Task 3: SAFE_REF, unpushedCount, uncommittedCount, isMerged, branchState
  preview/files.ts        Tasks 3, 8: mergeBase and listChanges shared with the diff
  preview/tracker.ts      Task 3: branch counts with the files refresh
  preview/diff.ts         Task 8: parseUnified, untrackedDiff, diffPage
  finish/actions.ts       Tasks 4, 6: FinishActions (pin, archive, restore, remove)
  finish/auto-archive.ts  Task 5: AutoArchiver
  control/launcher.ts     Tasks 3, 7: baseCommit at start; resume, resumeArgv
  terminal/control.ts     Task 11: ControlClient, parseControlLine, unescapeOutput, sendKeysLines, SAFE_LINE
  terminal/bridge.ts      Task 11: TerminalBridge, PANE_INFO_FORMAT, parsePaneInfo, snapshotBytes
  terminal/upgrade.ts     Task 12: TERMINAL_PATH, checkUpgrade
  terminal/server.ts      Task 12: TerminalServer (ws, noServer)
  security.ts             Task 12: hostAllowed, originAllowed (shared by the guards and the upgrade)
  live-source.ts          Tasks 2–7, 12: the entry points above; doneAt; archive count
  live/session-view.ts    Tasks 2, 3: uncommitted, unpushed, PreviewTarget gains branch fields
  source.ts, events.ts    Tasks 2, 4: archive count in the snapshot and the 'archive' event
  app.ts, serve.ts        Tasks 4–8, 12: routes and wiring
packages/server/test/fixtures/          panes/real-edit-60.txt, real-edit-160.txt; terminal/burst.txt, capture.txt
packages/web/
  build.ts, build.test.ts               Task 13: the terminal entry, the kage-term meta, budgets
  src/api.ts, store.ts, keys.ts         Tasks 9, 10, 13
  src/components/SessionPanel.tsx, SessionList.tsx, PreviewPane.tsx, Toast.tsx   Tasks 9, 10, 13
  src/components/Archived.tsx           Task 9
  src/components/DiffView.tsx           Task 10
  src/term-loader.ts                    Task 13 (main bundle)
  src/terminal/index.ts, terminal.css   Task 13 (lazy chunk)
  src/styles/board.css                  Tasks 9, 10, 13
e2e/harness.ts (moved out of live.spec.ts), e2e/finish.spec.ts, e2e/fake-claude.mjs, playwright.config.ts   Task 14
```

---

### Task 0: Phase 3 residuals

P3F1 (`firstPromptPending`) landed in the phase 3 fix wave. Its re-review left one regression and two minors.

**Files:** `packages/server/src/live-source.ts`, `packages/server/src/control/launcher.ts`, `packages/server/src/serve.ts`, and their tests.

- [ ] **Step 1: Write the failing tests.**
  - **The first-prompt fallback (10 s) must never leave a launched task stuck in running.**
    - If the capture is null (a tmux error), it retries once after 2 s.
    - If the pane shows a startup screen or a dialog that `parseStartupScreen`/`parsePermissionPrompt` recognises, the session becomes needs-you with that question.
    - Otherwise, if the pane shows no busy footer (`esc to interrupt`), the session becomes done.
    - Only a busy footer keeps it running.
    - `now` clears with the flag.
  - **`#killLeftover`:** it is skipped when the listing before the launch failed. An empty "before" set must never authorise a kill.
  - **Doc comment:** the B15 doc comment sits on `STOPPED` again, not on `NO_TOKEN`. Doc-only; no test.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows, in the WSL fresh clone and with `corepack pnpm test:linux`. Expected: PASS. Then the controller runs a short real-Claude check that a launched task never shows done before its first turn.
- [ ] **Step 5: Commit.** `fix(server): phase 3 residuals (first-prompt fallback, leftover-window guard)`

---

### Task 1: Spike: tmux control mode for the terminal, xterm.js under Kage's CSP, Resume and git for finishing (throwaway code, tracked notes)

Runs in WSL Ubuntu 24.04 with tmux 3.4, git 2.43 and Claude Code 2.1.330 (at `~/.local/node/bin`, signed in):
- the private tmux socket `tmux -L kage-spike4 -f /dev/null`;
- scratch repos under `/tmp/kage-spike4`;
- the hooks settings from `kage hooks-path`, with a temp `XDG_STATE_HOME`;
- at most 4 Claude prompts.

Throwaway scripts live in `/tmp/kage-spike4/scripts`, never in the repo.

**Files:**
- Modify: `docs/specs/host-integration.md` (new §4 "tmux control mode for the terminal" and §5 "git for finishing")
- Modify: `docs/specs/claude-code-integration.md` (new §8 "Terminal and resume")
- Create these fixtures, with invented content in the observed shapes:
  - `packages/server/test/fixtures/panes/real-edit-60.txt` and `real-edit-160.txt` (an Edit permission prompt captured at 60 and 160 columns);
  - `terminal/burst.txt`: raw control-mode lines, with `%begin`/`%end`, `%output` with octal escapes, a UTF-8 character split across two `%output` lines, `%layout-change` and `%window-close`;
  - `terminal/capture.txt`: a `display-message` block followed by a count-framed `capture-pane -e` block in which one data row starts with `%end`.

**Interfaces:**
- Produces a table of answers for each question below, the fixtures, and the exact versions of `ws`, `@xterm/xterm` and `@xterm/addon-fit`.

- [ ] **Step 1: Output.** Attach `tmux -C attach -t =s` with Node's `spawn`, read stdout as bytes, and record:
  - which bytes `%output` escapes (expected: below 0x20 and `\` as `\ooo`; 0x80 and above raw);
  - whether a UTF-8 character can split across two `%output` lines;
  - whether `%extended-output` appears without `pause-after`;
  - what `refresh-client -f no-output` and `refresh-client -A '%<pane>:on'` do on tmux 3.4 (per-pane subscription), and whether `refresh-client -f pause-after=2` gives `%pause`/`%continue`;
  - the format of `%layout-change`, `%window-close`, `%unlinked-window-close` and `%exit`.
- [ ] **Step 2: Keys.** In a `cat -v` pane, and then in Claude's idle box, write `send-keys -t %N -H …` lines to the client's stdin and record:
  - whether bytes above 0x7f arrive raw (`c3 a9` → `é`, a 4-byte emoji);
  - whether `1b 5b 41` arrives as one Up press in Claude;
  - Ctrl+C (`03`), Enter (`0d`), Backspace (`7f`) and Tab;
  - bracketed-paste markers `1b 5b 32 30 30 7e … 1b 5b 32 30 31 7e` with an embedded `0a` (does Claude keep the newline in the box instead of submitting?);
  - the longest `-H` line that tmux accepts;
  - the median round trip from a write to its echoed `%output`, over 50 keys.
- [ ] **Step 3: A consistent snapshot.** On one client line, `display-message -p -t %N '<format>' ; capture-pane -p -e -N -S -1000 -t %N`. Record:
  - whether the capture block holds exactly `min(history_size, 1000) + pane_height` lines;
  - whether `%output` for bytes already in the capture can arrive after the capture's `%end`. Use a pane running `yes | head -c 50000000` and repeat 200 times;
  - whether a pane printing a line `%end <time> <n> 1` shows up raw inside the capture block (so the parser must frame by count);
  - which of these format variables tmux 3.4 has: `cursor_x`, `cursor_y`, `cursor_flag`, `alternate_on`, `keypad_cursor_flag`, `keypad_flag`, `mouse_standard_flag`, `mouse_button_flag`, `mouse_any_flag`, `mouse_sgr_flag`, `focus_flag`, and a bracketed-paste flag under any name.

  If there is no bracketed-paste flag, record which DECSET modes Claude sets at start (from its `%output`: `?2004h`, `?1004h`, `?25l` and so on). Task 11 then replays `?2004h` for a pane whose command is `claude`.
- [ ] **Step 4: Size.** With the control client and a normal client attached (`script -qfc "tmux -L kage-spike4 attach -t s" /dev/null`, at 100×30), record:
  - whether `resize-window -t @W -x 120 -y 40` sets the window option `window-size` to `manual`, and what the normal client sees;
  - which sequence brings the window back to normal sizing once the terminal closes: `set-option -w -u -t @W window-size` alone, then `resize-window -A`, then `refresh-client -S` on the normal client;
  - whether `refresh-client -C @W:120x40` from the control client is an alternative, and what it leaves behind;
  - whether control-mode clients affect window size at all without `-C`;
  - the `%layout-change` that a resize produces.
- [ ] **Step 5: Claude in the terminal** (at most 2 prompts). Drive Claude through the control client only, as the bridge would. Record:
  - whether Claude redraws cleanly after `resize-window` to 60, then 160 columns, at an idle box and at a permission prompt. Save `real-edit-60.txt` and `real-edit-160.txt` (anonymised), and confirm that `parsePermissionPrompt` reads both;
  - whether arrows plus Enter (`-H`) answer the permission prompt;
  - whether `Esc` declines it;
  - whether the fullscreen renderer stays off (R39).
- [ ] **Step 6: Fallback B, only if Steps 1–4 show that control mode can't work.** Test `script -qfc "tmux attach -f ignore-size -t =s" /dev/null` (BSD `script -q /dev/null …` on macOS) as a pure-Node pseudo-terminal, with `resize-window` for size. Record what breaks. Otherwise write "not needed".
- [ ] **Step 7: xterm.js.**
  - Pick the newest stable `@xterm/xterm` and `@xterm/addon-fit` that are at least two weeks old, and record their exact versions and the gzipped size of an esbuild bundle of `new Terminal()` plus `FitAddon` plus `xterm.css`.
  - Serve a test page with Kage's exact CSP (`app.ts` `CSP`) and record every CSP violation in the console.
  - If the DOM renderer needs inline `<style>` elements, measure the alternatives:
    - (a) `style-src 'self' 'unsafe-inline'` for the whole page;
    - (b) a CSP nonce, if xterm can take one;
    - (c) `@xterm/addon-canvas` or `@xterm/addon-webgl`, with their sizes.
- [ ] **Step 8: Resume** (at most 2 prompts). In a worktree whose session has a prompt and has exited, record:
  - whether `claude --settings <f> --permission-mode default --resume <session_id>` resumes it;
  - `SessionStart`'s `source`, and whether `session_id` and `transcript_path` stay the same (same file, appended);
  - what `--continue` picks;
  - what an unknown id prints and its exit code;
  - whether the trust screen reappears.
- [ ] **Step 9: git for finishing.** In a repo with one worktree on `kage/x` (one commit), record:
  - the exact refusals of `git worktree remove` for a modified file, an untracked file and a locked worktree, and that `--force` removes the first two;
  - `git branch -D` while the worktree still exists ("checked out at");
  - `git worktree list --porcelain` for a normal and a missing folder, and what `worktree prune` does;
  - `git rev-list --count refs/heads/kage/x --not --exclude=kage/x --branches --remotes --tags` for:
    - an unpushed commit;
    - after `git push` to a local bare remote (0);
    - after a merge into `main` (0);
    - a commit also on another branch (0);
  - `git status --porcelain=v1 -z --untracked-files=normal` entry counts;
  - merged detection for:
    - a fast-forward merge, a `--no-ff` merge, a squash merge and a rebase merge into `main`;
    - a conflicting branch;
    - a branch with no commits.

    Check `merge-base --is-ancestor` and `merge-tree --write-tree refs/heads/main kage/x` against `main^{tree}`, and whether merge-tree leaves anything but loose objects;
  - which files directly inside `git rev-parse --git-common-dir` change on `git fetch`, `git pull --ff-only`, `git merge --no-ff`, `git merge --squash` plus commit, and `git rebase`;
  - whether `fs.watch` on that folder (not recursive) fires for them on WSL ext4 and on `/mnt/c`.
- [ ] **Step 10: Write the notes.**
  - `host-integration.md` §4: control mode (output, keys, snapshot framing, size, latency). §5: the git facts.
  - `claude-code-integration.md` §8: Claude in the terminal (resize, keys, paste, Esc) and Resume.
  - Each with versions, and a "Read first: where this differs from the phase 4 plan" list.
- [ ] **Step 11: Commit.** `docs: record tmux control mode, xterm.js under the CSP, resume and git behaviour for finishing; fixtures`

If a fact breaks a plan assumption, stop and report before Task 11 (terminal facts) or Task 3 (git facts) starts; the controller rules. The fallbacks are already planned:
- `-H` mangles bytes above 0x7f: text runs travel as `send-keys -l --` through `execFile` (as phase 3's `sendText`), and only control bytes through `-H`;
- the capture isn't count-exact: run `display-message` again after the capture, and retry until the two agree (at most 3 times);
- no per-pane subscription: filter by pane id;
- `resize-window` leaves the window manual: restore with whichever sequence Step 4 found;
- no bracketed-paste flag: replay `?2004h` for `claude` panes;
- xterm needs inline styles: the controller rules between (a), (b) and (c). Recommendation: (b), else (a) scoped to `style-src`, with scripts staying `'self'`;
- `--resume` misbehaves: use `--continue`;
- `fs.watch` silent on `/mnt/c`: rely on the other triggers there, and say so in the docs.

---

### Task 2: Protocol v4 and the record's new fields

**Files:**
- Modify:
  - `packages/shared/src/types.ts`, `packages/shared/src/demo.ts`;
  - `packages/server/src/state/store.ts`, `source.ts`, `events.ts`, `live/session-view.ts`, `demo-source.ts`;
  - `packages/web/src/store.ts`, `sse.ts`
- Test: `packages/shared/src/types.test.ts`, `packages/server/src/state/store.test.ts`, `events.test.ts`, `packages/web/src/store.test.ts`

**Interfaces:**
- Produces:

```ts
// shared/types.ts (added or changed)
export interface Session { /* as before */ unpushed: number; /** Files with uncommitted changes, untracked ones included. */ uncommitted: number }
export type ServerEvent =
  | { type: 'snapshot'; host: string; streamId: string; projectsRoot: string; sessions: Session[]; archived: number }
  | /* phase 3 events */
  | { type: 'archive'; count: number };          // the number of archived sessions changed
export interface ArchivedSession { id: string; project: string; task: string; branch: string; archivedAt: number }
export interface ArchivedResponse { sessions: ArchivedSession[] }   // newest first, at most LIMITS.archived
export interface PinBody { pinned: boolean }
export interface ArchiveBody { archived: boolean }
export interface DeleteBody { unpushed: number; uncommitted: number }   // what the confirmation showed
export type DiffLineKind = 'hunk' | 'ctx' | 'add' | 'del';
export interface DiffFile {
  path: string; oldPath?: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'binary' | 'link';
  added: number; removed: number;
  lines: [DiffLineKind, string][];
  /** Lines of this file left out by the per-page cap. */
  clipped: number;
}
export interface DiffPage { base: string | null; branch: string; from: number; next: number | null; filesTotal: number; files: DiffFile[] }
export const TERM_PROTOCOL = 'kage.term.v1';
/** Text frames (JSON). Output travels as binary frames. */
export type TermServerMsg =
  | { t: 'reset'; cols: number; rows: number; mode: 'rw' | 'ro' }   // the next binary frame is the snapshot
  | { t: 'size'; cols: number; rows: number };
export type TermClientMsg = { t: 'in'; d: string } | { t: 'size'; cols: number; rows: number };
export const TERM_CLOSE = { gone: 4404, ended: 4409, forbidden: 4403, tooMany: 4429, demo: 4501 } as const;
export const LIMITS = { /* phase 3 */ archived: 200, diffLines: 1000, diffBytes: 524_288, diffLineChars: 2000,
  termInputBytes: 65_536, termMinCols: 20, termMaxCols: 500, termMinRows: 5, termMaxRows: 200, terminals: 8, terminalsPerPane: 3 } as const;
// server/state/store.ts
export interface SessionRecord { /* phase 3 */
  /** The commit the worktree was cut from; null for records saved before phase 4. */ baseCommit: string | null;
  /** Epoch ms of the last move into done or ended; null while active. */ doneAt: number | null;
  /** Epoch ms of the last archive; null when not archived. */ archivedAt: number | null }
// server/source.ts
// SourceEvent gains { type: 'archive'; count: number }; SessionSource gains archivedCount?(): number
```

- [ ] **Step 1: Write the failing tests.**
  - Every demo session has `uncommitted === 0`, and the docs session keeps `unpushed: 1`.
  - A phase 3 state file (no `baseCommit`, `doneAt` or `archivedAt`) loads with `null` for all three. A `baseCommit` that isn't 40 or 64 hex characters loads as `null`. An archived record without `archivedAt` gets its `createdAt`.
  - The hub's snapshot carries `archived` from `archivedCount()`, or 0 when the source has none. An `archive` source event goes to every stream.
  - `sameSession` sees a change in `unpushed` or `uncommitted`.
  - The web store: `snapshot.archived` and `archive` set `archivedCount`. `sse.ts` listens for `archive`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `toSession` fills `uncommitted: 0` until Task 3 brings real data.
- [ ] **Step 4: Run the tests and the e2e visual spec.** Expected: PASS; visuals unchanged.
- [ ] **Step 5: Commit.** `feat(shared,server,web): protocol v4 — archive count, branch counts, finish and diff bodies, terminal frames`

---

### Task 3: Branch state: unpushed, uncommitted and merged

**Files:**
- Create: `packages/server/src/git/branch.ts`
- Modify:
  - `packages/server/src/preview/tracker.ts` (branch counts with each files run, for record sessions);
  - `packages/server/src/live/session-view.ts` (`PreviewTarget` gains `branch` and `baseCommit`; `toSession` carries the counts);
  - `packages/server/src/live-source.ts` (`setPreview` takes the counts and emits `session.updated` on a change; `doneAt` on transitions);
  - `packages/server/src/control/launcher.ts` (records `baseCommit`);
  - `packages/server/src/serve.ts`
- Test: `git/branch.test.ts` (temp repos, with a local bare remote), `preview/tracker.test.ts`, `live-source.test.ts`, `control/launcher.test.ts`

**Interfaces:**
- Produces:

```ts
// git/branch.ts
/** A branch or base name Kage passes to git: no leading "-", no "..", no "@{", plain segments. */
export const SAFE_REF: RegExp;   // /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}$/ and no segment starting with "." or ending in ".lock"
export interface BranchState { unpushed: number; uncommitted: number; merged: boolean }
/** Commits only this branch reaches: rev-list --count refs/heads/<b> --not --exclude=<b> --branches --remotes --tags. */
export function unpushedCount(cwd: string, branch: string, exec?: GitExec): Promise<number>;
/** Entries of status --porcelain=v1 -z --untracked-files=normal (ignored files don't count). */
export function uncommittedCount(worktree: string, exec?: GitExec): Promise<number>;
/**
 * The branch has a commit past baseCommit, and its tip is an ancestor of refs/heads/<base> or of
 * refs/remotes/origin/<base>, or merging it into either changes nothing (merge-tree --write-tree
 * gives that ref's tree: a squash or rebase merge). False for a null baseCommit or base.
 */
export function isMerged(cwd: string, o: { branch: string; base: string | null; baseCommit: string | null }, exec?: GitExec): Promise<boolean>;
export function branchState(worktree: string, o: { branch: string; base: string | null; baseCommit: string | null }, exec?: GitExec): Promise<BranchState>;
// preview/tracker.ts
export interface PreviewTarget { /* phase 3 */ branch: string | null; baseCommit: string | null }   // null for external sessions
export type PreviewPatch = { ports?: Port[]; files?: FileChange[]; filesTotal?: number; unpushed?: number; uncommitted?: number };
// tracker deps gain: branch: (worktree, o) => Promise<{ unpushed: number; uncommitted: number }>
// launcher: after `git worktree add`, baseCommit = `git -C <path> rev-parse HEAD` (validated hex)
```

Rules:
- The counts are refreshed with the files: on view, after edit hooks, at a turn end, and after a failed delete (Task 6). External sessions get none, so they keep 0.
- A failed count keeps the last value: phase 3's "a failed git run never blanks the list" rule applies here too.
- A branch or base that fails `SAFE_REF` gives counts 0 and merged false, with no git call.
- `doneAt` is set when a record's session moves into done or ended, and cleared when it moves to running or needs you. It is saved with the debounced save. On start, a done or ended record with a null `doneAt` gets the load time.

- [ ] **Step 1: Write the failing tests.**
  - `unpushedCount`, in a temp repo with a bare remote: 2 new commits → 2; after `push` → 0; after merging into `main` → 0; a commit also on `other` → not counted; a branch named `-x` → refused by `SAFE_REF` with no git call.
  - `uncommittedCount`: one modified, one staged, one untracked and one ignored file → 3.
  - `isMerged`:
    - false with no commits past `baseCommit`;
    - true after a fast-forward merge, a `--no-ff` merge, a squash merge and a rebase merge;
    - true when only `origin/main` holds the merge (the local `main` is behind);
    - false for a conflicting branch, and false when `baseCommit` or `base` is null.
  - `branchState` runs its three parts in parallel and passes `-c core.fsmonitor=false`. A recording fake asserts the exact arguments.
  - Tracker: a files run for a record target also publishes `unpushed` and `uncommitted`; external targets never call `branch`; a rejected count publishes nothing.
  - LiveSource:
    - a changed count emits `session.updated` once, and an unchanged one emits nothing;
    - `doneAt` is set on Stop, cleared on `UserPromptSubmit` and saved;
    - a phase 3 record that is done at load gets `doneAt` equal to the load time.
  - Launcher: the adopted record holds the worktree's HEAD as `baseCommit`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): branch state (unpushed, uncommitted, merged) with the preview refresh; record the base commit`

---

### Task 4: Pin, archive, restore and the archived list

**Files:**
- Create: `packages/server/src/finish/actions.ts`
- Modify:
  - `packages/server/src/live-source.ts` (`finishTarget`, `setFlags`, `archivedList`, `archivedCount`; `list()` keeps leaving out archived sessions);
  - `packages/server/src/control/validate.ts` (`parsePin`, `parseArchive`);
  - `packages/server/src/app.ts`, `serve.ts`
- Test: `finish/actions.test.ts` (fake tmux and source), `control/validate.test.ts`, `live-source.test.ts`, `app.test.ts`

**Interfaces:**
- Consumes: `TmuxClient.killOwnedWindow`; `ActionError` (from `control/actions.ts`).
- Produces:

```ts
// live-source.ts
export interface FinishTarget { id: string; record: SessionRecord | null /* a copy */; windowId: string | null; status: SessionStatus; external: boolean }
finishTarget(id: string): FinishTarget | null;
/** Saves at once (awaited). Archiving emits session.removed, then archive {count}; restoring emits session.updated, then archive {count}. */
setFlags(id: string, f: { pinned?: boolean; archived?: boolean }): Promise<void>;
archivedList(): ArchivedSession[];
archivedCount(): number;
// finish/actions.ts
export class FinishActions {
  constructor(d: { tmux: Pick<TmuxClient, 'killOwnedWindow'>; source: Pick<LiveSource, 'finishTarget' | 'setFlags' | 'markStopped'>; /* Task 6 adds forget, git and the projects root */ });
  pin(id: string, pinned: boolean): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
}
// routes
// POST /api/sessions/:id/pin {pinned}       → 204 | 400 | 403 | 404 | 501
// POST /api/sessions/:id/archive {archived} → 204 | 400 | 403 | 404 | 409 | 422 | 501
// GET  /api/archive                          → 200 ArchivedResponse | 501
```

Rules:
- **Pin:** any record session, any status. 403 `Kage only pins sessions it started.`
- **Archive** (`archived: true`):
  - 403 `Kage only archives sessions it started.`
  - 409 `Stop the session before archiving it.` while it is running or needs you.
  - For a done session with a window, run `killOwnedWindow` first. When it returns false because the live `@kage_id` differs, answer 403 `That window isn't Kage's any more.`
  - Then `markStopped` (when a window was killed) and `setFlags({archived: true})`, which also sets `archivedAt`.
  - Archiving an archived session is a no-op 204.
- **Restore** (`archived: false`): `setFlags({archived: false})`. The session comes back in its status, usually ended. Restoring one that isn't archived is a no-op 204.
- One action at a time per session, shared with Task 6's delete and Task 7's resume: 409 `Kage is still finishing the last action on this session.`
- Bodies are exact: `Expected {"pinned": true|false}` and `Expected {"archived": true|false}`.
- Demo mode answers 501 `Demo mode can't run tasks.`

- [ ] **Step 1: Write the failing tests.**
  - `pin` on a record session sets `pinned` and saves; the next `session.updated` has `pinned: true`; external → 403 with no save.
  - `archive` on a done session with a live window kills it with the record's kage id, then archives it: `session.removed` and `archive {count: 1}`, and `list()` no longer has it while `archivedList()` does.
  - `archive` while running → 409, with no kill.
  - When `killOwnedWindow` returns false and the window still lists with another `@kage_id` → 403, and nothing is archived.
  - `archive` on an ended session with no window archives it with no tmux call.
  - Restore emits `session.updated` (status `ended`) and `archive {count: 0}`.
  - Two concurrent `archive` calls → the second is 409.
  - `archivedList()` is sorted newest first and capped at `LIMITS.archived`.
  - Validate: `{pinned: "yes"}`, `{pinned: true, x: 1}` and `[]` → 400.
  - App:
    - each route maps statuses, needs the CSRF headers, and sits behind the token guard;
    - `GET /api/archive` returns the list, and 501 in demo mode;
    - the snapshot's `archived` matches.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): pin, archive and restore Kage sessions; the archived list`

---

### Task 5: Auto-archive on merge and after `afterDays`

**Files:**
- Create: `packages/server/src/finish/auto-archive.ts`
- Modify: `packages/server/src/live-source.ts` (candidates; `touch` on transitions; `sync` when records change), `packages/server/src/serve.ts` (wiring from `cfg.autoArchive`)
- Test: `finish/auto-archive.test.ts` (fake clock, fake watch, fake state), `finish/auto-archive.int.test.ts` (temp repo, real `fs.watch` where it works), `live-source.test.ts`

**Interfaces:**
- Consumes: `branchState` (Task 3), `FinishActions.archive` (Task 4).
- Produces:

```ts
export interface AutoCandidate { id: string; repo: string; worktree: string; branch: string; base: string | null; baseCommit: string | null; doneAt: number }
export interface AutoArchiveDeps {
  config: { onMerge: boolean; afterDays: number };   // afterDays 0 turns the age rule off
  candidates: () => AutoCandidate[];                  // record sessions: done or ended, not pinned, not archived
  state: (c: AutoCandidate) => Promise<BranchState>;
  archive: (id: string) => Promise<void>;
  gitDir: (repo: string) => Promise<string>;          // rev-parse --git-common-dir, made absolute
  watch?: (dir: string, onChange: (name: string | null) => void) => { close(): void };   // default fs.watch, not recursive
  now?: () => number;
  debounceMs?: number;                                // 5000
  log?: (line: string) => void;
}
export class AutoArchiver {
  constructor(d: AutoArchiveDeps);
  start(): void;              // one pass over every candidate (at most 2 git checks at once)
  touch(id: string): void;    // a session turned done or ended: check it
  sync(): void;               // candidates changed: re-arm the deadline timer, open and close the watchers
  stop(): void;
}
// LiveSource: deps gain autoArchive?: (host) => Pick<AutoArchiver, 'start' | 'touch' | 'sync' | 'stop'>
```

Rules:
- **Merge rule:** applies when `onMerge` is on, `merged` is true and `uncommitted === 0`. A dirty worktree means work continues.
- **Age rule:** applies when `afterDays > 0` and `now ≥ doneAt + afterDays × 86,400,000`. The worktree and branch stay, so nothing is lost.
- **Checks:** at most one pending check per candidate, and a re-trigger during a check queues one more. A candidate that stopped being one before its check is skipped. `archive` refusals (409, 403) are logged once per session and not retried until the next trigger.
- **Watchers:** one per git common directory that has candidates, closed when it has none. They react to the names Task 1 found (expected: `FETCH_HEAD`, `ORIG_HEAD`, `packed-refs`, `HEAD`), and to `null`. Several changes within `debounceMs` give one check of that directory's candidates. A watch that throws is logged once (`Auto-archive can't watch <dir>; merges there are seen at the next turn end or restart.`), and that directory isn't watched again until restart.
- **Timer:** one timer for the earliest age deadline, only while some candidate has one. It is clamped to 2,147,483,647 ms and re-armed on `sync`.

- [ ] **Step 1: Write the failing tests.**
  - No candidates → no timers and no watchers (`vi.getTimerCount() === 0`, the fake watch is never called).
  - A candidate with `merged: true` and `uncommitted: 0` is archived on `touch`. With `uncommitted: 2` it isn't. With `onMerge: false` it isn't.
  - Age: `afterDays: 14`, with `doneAt` 13 days ago → nothing now, and archived once the fake clock passes 14 days, with exactly one timer armed. `afterDays: 0` arms nothing.
  - Ten watch events in 1 s → one check, 5 s after the last; an unrelated name (`index`) → no check.
  - A watcher closes when its last candidate is pinned (`sync`).
  - The watch throwing logs once and doesn't throw.
  - `start()` checks 5 candidates with at most 2 checks in flight.
  - `archive` rejecting with 409 logs once; the next trigger tries again.
  - `stop()` clears the timer and closes the watchers.
  - LiveSource:
    - a record session's Stop → `touch(id)`;
    - pin, archive, delete, a new record and a resume → `sync()`;
    - external sessions are never candidates;
    - a running session is never a candidate.
  - Integration (WSL, temp repo):
    - a done session whose branch is merged with `git merge --no-ff` in the main checkout is archived within 10 s of the merge, with no timer involved;
    - a squash-merged one is archived after the next `touch`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows (units) and in WSL (units and integration). Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): auto-archive merged or stale sessions, driven by events and one deadline`

---

### Task 6: Delete with the warning (B10 server side)

**Files:**
- Modify:
  - `packages/server/src/finish/actions.ts` (`remove`);
  - `packages/server/src/live-source.ts` (`forget`);
  - `packages/server/src/control/validate.ts` (`parseDelete`);
  - `packages/server/src/app.ts` (DELETE takes the body; demo mode keeps `DemoSource.remove`);
  - `packages/server/src/serve.ts`
- Test: `finish/actions.test.ts`, `finish/actions.int.test.ts` (temp repos, real git; tmux where present), `control/validate.test.ts`, `live-source.test.ts`, `app.test.ts`

**Interfaces:**
- Consumes: `branchState` (Task 3); `findProject` (phase 3); `killOwnedWindow`.
- Produces:

```ts
// finish/actions.ts: FinishActions deps gain
//   git: GitExec; projectsRoot: string; worktreeDir: string;
//   counts: (worktree: string, branch: string) => Promise<{ unpushed: number; uncommitted: number }>;
//   publish: (id: string, patch: { unpushed: number; uncommitted: number }) => void   // LiveSource.setPreview
remove(id: string, seen: DeleteBody): Promise<void>;
// live-source.ts
forget(id: string): Promise<void>;   // drops the record and the session (session.removed), saves at once, sync()s auto-archive
// control/validate.ts
export function parseDelete(body: unknown): Parsed<DeleteBody>;   // exactly {unpushed, uncommitted}, integers 0–1,000,000
// DELETE /api/sessions/:id {unpushed, uncommitted} → 204 | 400 | 403 | 404 | 409 | 422 | 501
```

`remove` runs these steps under the session's action lock:
1. 404 for an unknown id. 403 `Kage only deletes sessions it started.` for external sessions. 409 `Stop the session before deleting it.` while it is running or needs you.
2. Check the record:
   - the branch must pass `SAFE_REF` and differ from the base;
   - when the project is found, the worktree must resolve (through `realpath` when it exists) inside `<repo>/<worktreeDir>/`.

   Otherwise 409 `Kage won't delete <worktree>: it isn't one of Kage's worktrees.`, with nothing touched.
3. Recount when the worktree folder exists (uncommitted), and when the branch exists (unpushed). If the counts differ from `seen`, `publish` the fresh ones and answer 409 `The branch changed since you looked. Look again before deleting.`
4. If there is a window, run `killOwnedWindow(windowId, kageId)`. When it returns false and the window still lists, answer 403 `That window isn't Kage's any more.`
5. Remove the worktree when `git worktree list --porcelain` lists the record's path on `refs/heads/<branch>` and it isn't the first (main) entry:
   - `git worktree remove [--force] -- <path>` (60 s), with `--force` only when `seen.uncommitted > 0`;
   - not listed and the folder is missing: `git worktree prune`;
   - not listed and the folder exists: 409 with the step 2 message.

   A git failure → 422 `git couldn't remove the worktree: <first line>`, and the record stays.
6. When `refs/heads/<branch>` exists, run `git branch -D -- <branch>`. The counts were confirmed in step 3. A failure → 422 `git couldn't delete the branch: <first line>`; the record stays, and its worktree is already gone.
7. `forget(id)`.

When the project folder is gone, steps 2–6 are skipped after the window kill, and the record is forgotten.

- [ ] **Step 1: Write the failing tests.**
  - Validate: `{}`, `{unpushed: -1, uncommitted: 0}`, `{unpushed: 1.5, …}` and extra keys → 400.
  - Unit (fake git, recording calls):
    - a matching `{1, 0}` runs, in order, kill → `worktree remove -- <path>` (no `--force`) → `branch -D -- kage/x` → forget;
    - `{0, 2}` with matching counts → `worktree remove --force`;
    - a stale `{0, 0}` when the fresh counts are `{1, 0}` → 409, `publish` called with `{1, 0}`, and no kill, removal or forget;
    - external → 403 with no git call; running → 409;
    - a branch `-x`, a branch equal to the base, a worktree `../../home/x`, and a worktree equal to the repo itself → 409 with no removal;
    - a worktree that isn't listed but exists → 409;
    - a listed main worktree → refused;
    - `killOwnedWindow` false with the window still listed under another id → 403 and nothing removed;
    - a `branch -D` failure → 422, and the record stays.
  - Integration (temp repo; tmux where present):
    - a real delete of a worktree with one unpushed commit, a modified file and an untracked file, confirmed as `{1, 2}`, removes the folder and the branch, leaves the other branches and the main checkout untouched, and the record is gone from the state file;
    - a pre-existing branch `feature/keep` and its worktree, made outside Kage, are never touched;
    - an unconfirmed delete (`{0, 0}`) of that same dirty worktree touches nothing.
  - App: the DELETE body is validated in live and demo modes; demo mode still removes with the toast (the phase 1 board test); statuses map; CSRF and token guards apply.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): delete a Kage session's window, worktree and branch only as confirmed (B10)`

---

### Task 7: Resume (B7 server side)

**Files:**
- Modify:
  - `packages/server/src/control/launcher.ts` (`resume`, `resumeArgv`);
  - `packages/server/src/live-source.ts` (`resumed`; a resumed record shows running "Starting Claude…" until its first `UserPromptSubmit` or its idle box, using the P3F1 rule from Task 0);
  - `packages/server/src/app.ts`, `serve.ts`
- Test: `control/launcher.test.ts`, `control/launcher.int.test.ts` (runIf tmux), `live-source.test.ts`, `app.test.ts`

**Interfaces:**
- Produces:

```ts
// control/launcher.ts
export function resumeArgv(bin: string, settingsPath: string, mode: 'default' | 'acceptEdits', sessionId: string | null): string[];
//   [bin, '--settings', s, '--permission-mode', mode, '--resume', id] when id matches /^[0-9A-Fa-f-]{8,64}$/, else [..., '--continue']
// TaskLauncher deps gain source: Pick<LiveSource, 'finishTarget' | 'resumed' | 'claim' | 'hasWindow'>
resume(id: string): Promise<void>;   // throws LaunchError 403 | 404 | 409 | 422 | 503
// live-source.ts
resumed(kageId: string): void;       // ended → running, now "Starting Claude…", statusSince now; emits; auto-archive sync
hasWindow(kageId: string): boolean;  // a listed window carries this @kage_id (or a claim does)
// POST /api/sessions/:id/resume (no body) → 204 | 400 | 403 | 404 | 409 | 422 | 501 | 503
```

Rules, in order, serialised per session (the shared finish lock):
1. 404 `No session with id <id>`.
2. 403 `Kage only resumes sessions it started.`
3. 409 `This session is still running.` unless it is ended.
4. 409 `This session already has a window.` when `hasWindow`.
5. 503 when there is no `claude`, with phase 3's message.
6. 409 `The worktree is gone, so Kage can't resume this session.` unless the record's folder is a directory.
7. Open the window, exactly as a start does: `newWindow({name: <the worktree's folder name>, cwd: worktree, env: {KAGE_SOCKET, PATH}, argv: resumeArgv(…), kageId: record.kageId})`.
8. `resumed`, then `claim`.

A tmux failure → 422 `tmux couldn't open a window: <first line>`. There is nothing to roll back, so the session stays ended. An archived session is refused with 409 `Restore the session before resuming it.`

- [ ] **Step 1: Write the failing tests.**
  - `resumeArgv` with a UUID → `--resume <uuid>`; with null or `--x` → `--continue`. The mode comes from the record, never from the request.
  - Unit (fake tmux and source):
    - an ended record with a folder opens one window with the record's kage id, cwd and exact argv, then `resumed`, then `claim`;
    - running → 409; external → 403; a live window → 409; a missing folder → 409; no `claude` → 503 with no tmux call;
    - two concurrent resumes open one window, and the second gets 409;
    - archived → 409.
  - LiveSource: `resumed` emits running with "Starting Claude…"; a `SessionStart` (source `resume`) doesn't flip it to done before the first `UserPromptSubmit` or the idle box (P3F1); the transcript keeps its lines.
  - Integration (WSL): `claudeBin` = a temp script that writes its argv and `exec sleep 30`. The resume's window has the record's `@kage_id`, and the argv ends `--resume <id>`.
  - App: 204, the mapped statuses, CSRF and token guards, and 501 in demo mode.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): resume an ended Kage session in a new tagged window (B7)`

---

### Task 8: The diff, computed on request and paged

**Files:**
- Create: `packages/server/src/preview/diff.ts`
- Modify:
  - `packages/server/src/git/exec.ts` (`gitStream`);
  - `packages/server/src/preview/files.ts` (pull out `mergeBase` and `listChanges`, which `changedFiles` and `diffPage` share, unchanged in behaviour);
  - `packages/server/src/app.ts`, `serve.ts`
- Test: `preview/diff.test.ts` (parser fixtures, plus temp repos), `preview/files.test.ts` (unchanged results), `git/exec.test.ts`, `app.test.ts`

**Interfaces:**
- Produces:

```ts
// git/exec.ts
/** git through spawn: stdout up to maxBytes, then the child is killed; `clipped` says so. Same environment as gitExec. */
export function gitStream(args: string[], o: { cwd: string; maxBytes: number; timeoutMs?: number }): Promise<{ stdout: string; clipped: boolean }>;
// preview/files.ts
export function mergeBase(worktree: string, base: string | null, exec?: GitExec): Promise<string>;   // the hash, or 'HEAD'
export interface Change extends FileChange { oldPath?: string; untracked: boolean }
export function listChanges(worktree: string, base: string | null, exec?: GitExec): Promise<{ mb: string; changes: Change[] }>;   // sorted by path, uncapped
// preview/diff.ts
export function parseUnified(text: string, o: { maxLines: number; maxLineChars: number }): DiffFile[];
export function untrackedDiff(root: string, rel: string, o: { maxLines: number; maxLineChars: number }): Promise<DiffFile>;
export function diffPage(t: { worktree: string; base: string | null; branch: string }, from: number, deps?: { exec?: GitExec; stream?: typeof gitStream }): Promise<DiffPage>;
// GET /api/sessions/:id/diff?from=<n> → 200 DiffPage | 400 | 404 | 422 | 501
```

Rules:
- **The same form as the list** (spec §5.7). `listChanges` is the one source:
  - the merge base of `refs/heads/<base>` and HEAD (or HEAD);
  - `diff --numstat -z -M --relative --no-ext-diff` against it;
  - `ls-files --others --exclude-standard -z`;
  - sorted by path.

  `changedFiles` is `listChanges` capped at `LIMITS.files`, so the right column and the diff list the same paths in the same order.
- **Pages:**
  - A page starts at file index `from` and takes files while the running weight stays ≤ `LIMITS.diffLines`. A file's weight is `min(added + removed, diffLines)`, plus 1 per file. A page always holds at least one file.
  - `next` is the index after the page, or null at the end.
  - `from` beyond the end → an empty page with `next: null`.
- **Tracked files:**
  - One `gitStream` per page: `git -c core.fsmonitor=false diff <mb> -M --relative --no-ext-diff --no-textconv --no-color -U3 -- :(literal)<path> [:(literal)<oldPath>]…`, with `maxBytes` `LIMITS.diffBytes`.
  - `parseUnified` reads the kinds from the headers (`new file mode`, `deleted file mode`, `rename from/to`, `Binary files … differ`).
  - It caps each file at `maxLines`, setting `clipped` to the number left out, and clips lines over `maxLineChars` with `…`.
  - Text after a stream clip marks the remaining files of the page `clipped` with no lines.
- **Untracked files** use phase 3's `untrackedLines` safety rules:
  - inside the worktree, with no symlink followed (a link → kind `link`, no lines);
  - ≤ 1 MiB;
  - a NUL in the first 8 KiB → `binary`;
  - otherwise one hunk `@@ -0,0 +1,N @@` of `add` lines.
- **Limits:** one diff at a time per session (a second request waits for the first), and 2 at a time server-wide. Git failures → 422 `git couldn't show the diff: <first line>`.
- **External sessions:** they diff their pane's folder with a null base, as their file list does. An ended record session diffs its worktree when the folder exists, else 422.

- [ ] **Step 1: Write the failing tests.**
  - `parseUnified` on fixtures:
    - a modified file with two hunks;
    - a new file, a deleted file, a rename with changes, a binary file;
    - a file of 1,500 changed lines (clipped 500 at `maxLines: 1000`);
    - a 5,000-character line (clipped to 2,000 characters plus `…`);
    - a path with spaces and a quoted path (`"a\tb"`).
  - `untrackedDiff`: a 3-line file → one hunk of 3 `add` lines; a symlink to `/etc/passwd` → `link`, never read; a 2 MiB file → `binary`, no lines (over the size cap); a NUL file → `binary`.
  - `diffPage` in a temp repo (branch off `main`; one commit; an uncommitted edit; a rename; an untracked file):
    - the page's paths equal `changedFiles(…).files` paths, in the same order;
    - `from` past the end → empty;
    - 30 files of 100 lines each → pages of 9, 9, 9 and 3 files, with the right `next` values;
    - a `.gitattributes` with `diff=evil` and a config `diff.evil.textconv = touch /tmp/pwned-<rand>` → the file is never created;
    - a missing base → diffs against HEAD.
  - `gitStream`: a 10 MiB output with `maxBytes` 1 MiB resolves `clipped: true` and kills the child (no zombie: `exit` seen).
  - `changedFiles` results are unchanged on the phase 3 fixtures.
  - App: `?from=-1`, `?from=x` and `?from=1.5` → 400 `from must be a whole number.`; unknown id → 404; demo → 501; behind the token guard; a GET needs no CSRF header.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): the branch's diff in pages, in the same form as the file list`

---

### Task 9: Board: pin, archive, restore, delete with the warning, resume

**Files:**
- Create: `packages/web/src/components/Archived.tsx`
- Modify:
  - `packages/web/src/api.ts` (`pin`, `archive`, `resume`, `remove` with the body);
  - `packages/web/src/store.ts` (`archivedCount`, `archiveOpen`, `toast` as `{kind, name}`);
  - `packages/web/src/keys.ts` (`S`, `E`, `U`);
  - `packages/web/src/components/SessionPanel.tsx`, `SessionList.tsx`, `Toast.tsx`;
  - `packages/web/src/styles/board.css`
- Test: `packages/web/src/components/board.test.tsx`, `archived.test.tsx` (new), `keys.test.ts`, `store.test.ts`

**Interfaces:**
- Consumes: the Task 4, 6 and 7 routes; `archive` events (Task 2).
- Produces:

```ts
export const archivedCount: Signal<number>;
export const archiveOpen: Signal<boolean>;
export const toast: Signal<{ kind: 'deleted' | 'archived'; name: string } | null>;
export function pin(s: Session): Promise<boolean>;                  // toggles
export function archive(s: Session, archived: boolean): Promise<boolean>;
export function resume(s: Session): Promise<boolean>;
export function remove(s: Session): Promise<boolean>;               // DELETE with {unpushed: s.unpushed, uncommitted: s.uncommitted}
```

Behaviour (the copy is exact; the design target where it shows the element):
- **Pin:** `S` toggles pin on the selected record session; `★ ` shows as in the target. It does nothing for external sessions.
- **Archive:**
  - The footer's Archive (`E`) on a done or ended record session posts `{archived: true}`.
  - On 204 the session leaves the list, and the toast reads `Archived <b>name</b> · worktree and branch kept` (`.k-toast`, in the same place as the delete toast).
  - Errors use the phase 3 error line: `Couldn't archive: <error>`.
- **Archived list:**
  - It appears only when `archivedCount > 0`, at the bottom of the left column: a `k-g`-styled `<button>` reading `archived <N>` with `aria-expanded`.
  - Opening it fetches `GET /api/archive` and shows rows like done rows (`project /` muted, task, age since `archivedAt`), each with a `Restore` link (`--fg-3`, lime on hover).
  - Restore posts `{archived: false}` and selects the session once its `session.updated` arrives (`selectWhenSeen`).
  - A fetch error shows `Couldn't load the archive: <error>` in `--fg-2`.
  - The list refetches when `archivedCount` changes while it is open.
- **Delete:**
  - The confirmation keeps the target's copy, adding the uncommitted sentence inside the same `.warn` span:
    - `1 file has uncommitted changes and will be lost.`
    - `<n> files have uncommitted changes and will be lost.`
  - With both counts 0 it keeps `Everything on the branch is pushed, so nothing is lost.`
  - "Delete session" sends the body. On failure (B10) the confirmation stays open, and the error line shows `Couldn't delete: <error>`. After a 409 the counts shown update from the next `session.updated`.
- **Resume:** the footer's Resume (`U`) on an ended record session posts resume. On 204 the chip goes running through the events. Errors: `Couldn't resume: <error>`.
- **Gating:** all of these are disabled while the stream is down or the session is busy (phase 3's `busy`). Keys do nothing while typing.
- `INERT` is removed from Archive and Resume. Terminal and View diff stay inert until Tasks 10 and 13.

- [ ] **Step 1: Write the failing tests.**
  - `S` posts `{pinned: true}` for an unpinned done session, then `{pinned: false}` once `pinned` is true; external → no request.
  - Archive click and `E` post `{archived: true}`; on 204 and the `session.removed`, the archived toast shows; running sessions have no Archive and `E` does nothing.
  - `archivedCount` 0 → no archived button; 2 → `archived 2`. Opening it fetches once and renders two rows; Restore posts `{archived: false}` and selects the id after its `session.updated`.
  - The confirmation with `unpushed: 1, uncommitted: 3` shows both sentences in `.warn`; with `0, 0` it shows the pushed sentence.
  - "Delete session" sends exactly `{"unpushed":1,"uncommitted":3}`; a 409 keeps the confirmation and shows `Couldn't delete: …`; a 204 plus `session.removed` shows the delete toast.
  - `U` and the Resume click post resume for an ended record session only.
  - Everything is disabled while busy or disconnected.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the unit tests, then build and the e2e visual and board specs.** Expected: PASS; visual diffs under 0.5% in all four states (the demo has no archived sessions, and its delete confirmation keeps its copy). Report the first-load size.
- [ ] **Step 5: Commit.** `feat(web): pin, archive and restore, delete with the uncommitted warning and its errors, resume`

---

### Task 10: Board: the diff view

**Files:**
- Create: `packages/web/src/components/DiffView.tsx`
- Modify:
  - `packages/web/src/store.ts` (`mainView`, reset on select);
  - `packages/web/src/components/SessionPanel.tsx` (the view replaces the output area; the footer shows Back);
  - `packages/web/src/components/PreviewPane.tsx` (View diff opens it);
  - `packages/web/src/keys.ts` (`Esc`);
  - `packages/web/src/styles/board.css` (`.k-diff-*`)
- Test: `packages/web/src/components/diff.test.tsx` (new), `keys.test.ts`

**Interfaces:**
- Consumes: `GET /api/sessions/:id/diff` (Task 8).
- Produces:

```ts
export const mainView: Signal<'output' | 'diff' | 'terminal'>;   // 'output' after every select
```

Behaviour (the copy is exact):
- `View diff →` sets `mainView` to `diff`. The view replaces the output, question, follow-up and confirmation.
- The footer's left becomes `Back to session` with kbd `Esc`, and its right stays the session's actions.
- The view's top line, in mono `--fg-3`: `<branch> against <base>`, or `<branch>` when there is no base.
- Each file:
  - a mono `--fg-strong` header with the path (`old → new` for a rename) and the `+N −M` counts in `--add`/`--del`;
  - then its lines: hunk headers in `--fg-3`, `add` in `--add`, `del` in `--del`, context in `--fg-2`. Each line is one `<div>` with a `+`, `−` or space gutter.
  - `binary` → `Binary file, not shown.`; `link` → `Symbolic link, not shown.`
  - `clipped > 0` → `<n> more lines in this file aren't shown.` (`--fg-3`).
- Empty → `No changes yet.`
- Paging: `Files <a>–<b> of <total>`, with `← Previous` and `Next →` (`.k-act`). Exactly one page is in the DOM at a time, at most `LIMITS.diffLines` lines plus headers. Going back refetches.
- While loading: `Loading the diff…`. On error: `Couldn't load the diff: <error>` (`--fg-2`).
- Selecting another session, or `Esc` (when not typing), returns to the output. The diff isn't live: a `session.files` event shows `The files changed. Reload the diff.` as a link that refetches the current page.

- [ ] **Step 1: Write the failing tests.**
  - Clicking `View diff →` fetches `/api/sessions/<id>/diff?from=0` once and renders the files, with the kinds' copy.
  - An add line has class `add` and the `+` gutter; a clipped file shows the clipped sentence.
  - `Next →` fetches `from=<next>`; `← Previous` from page 2 fetches `from=0`. Only one page's lines are in the DOM.
  - `Esc` and Back return to the output; selecting another session resets `mainView`.
  - A `session.files` event while the view is open shows the reload link, and clicking it refetches.
  - An error shows the error line.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** If the build test's first load passes 25.5 KB, move `DiffView` into a lazy chunk with Task 13's mechanism, and say so in the report.
- [ ] **Step 4: Run the unit tests, then build and the e2e visual spec.** Expected: PASS; visual diffs unchanged. Report the first-load size.
- [ ] **Step 5: Commit.** `feat(web): read-only diff view, paged, in the list's form`

---

### Task 11: Terminal bridge: the control-mode client and terminal sessions

**Files:**
- Create: `packages/server/src/terminal/control.ts`, `packages/server/src/terminal/bridge.ts`
- Modify: `packages/server/src/tmux/watcher.ts` (export `SpawnFn` and the default spawn for reuse; no behaviour change)
- Test:
  - `terminal/control.test.ts` (the `burst.txt` and `capture.txt` fixtures, a fake spawn);
  - `terminal/bridge.test.ts` (a fake client, fake sinks, a fake clock);
  - `terminal/bridge.int.test.ts` (runIf tmux: a private socket, `cat` and `sh` panes);
  - `pane/prompt.test.ts` (the 60- and 160-column fixtures)

**Interfaces:**
- Produces:

```ts
// terminal/control.ts
export type ControlLine =
  | { kind: 'output'; paneId: string; data: Buffer }                       // %output or %extended-output, unescaped
  | { kind: 'begin' | 'end' | 'error'; time: string; num: string; flags: string }
  | { kind: 'layout'; windowId: string }
  | { kind: 'window-close'; windowId: string }
  | { kind: 'exit' }
  | { kind: 'other' };
export function parseControlLine(line: Buffer): ControlLine;
export function unescapeOutput(escaped: Buffer): Buffer;                    // \ooo → one byte; other bytes as they are
/** `send-keys -t %N -H 1b 5b 41` lines of at most `perLine` bytes (default 256). Throws on a bad pane id. */
export function sendKeysLines(paneId: string, bytes: Uint8Array, perLine?: number): string[];
/** Every line written to the client matches this: a known command, pane/window ids, integers, hex bytes, and Kage's constant formats. */
export const SAFE_LINE: RegExp;
export class ControlClient {
  constructor(o: { target: TmuxTarget; session: string; spawn?: SpawnFn; onLine: (l: ControlLine) => void; onExit: () => void });
  start(): Promise<void>;                     // `tmux [-L s] [-f cfg] -C attach -t =<session>`; resolves after the attach's own %begin/%end
  /**
   * Writes `cmds` joined by " ; " as one line and resolves with each command's output rows. countFor(i, earlier)
   * returns how many rows command i prints (count framing), or null to read until its matching %end.
   * A row is never parsed as a notification while a count is open. %end must repeat its %begin's time, number and flags.
   */
  run(cmds: string[], countFor?: (i: number, earlier: Buffer[][]) => number | null): Promise<Buffer[][]>;
  write(line: string): void;                  // fire-and-forget (keys); throws TypeError when SAFE_LINE refuses the line
  close(): void;
}
// terminal/bridge.ts
export interface PaneInfo { width: number; height: number; history: number; cursorX: number; cursorY: number; cursorVisible: boolean; alternate: boolean; command: string; modes: string /* DECSET bytes to replay */ }
export const PANE_INFO_FORMAT: string;        // constant; the variables Task 1 confirmed
export function parsePaneInfo(row: string): PaneInfo | null;
/** Alternate screen on (if set), the rows joined by \r\n with no trailing newline, the modes, then the cursor position and visibility. */
export function snapshotBytes(info: PaneInfo, rows: Buffer[]): Buffer;
export interface TermSink {
  reset(cols: number, rows: number, snapshot: Buffer): void;
  output(data: Buffer): void;
  size(cols: number, rows: number): void;
  close(code: number, reason: string): void;
  /** Bytes queued and not yet sent (ws.bufferedAmount). */
  buffered(): number;
}
export interface TermHandle { input(data: string): void; resize(cols: number, rows: number): void; close(): void }
export class TerminalBridge {
  constructor(d: { client: (o: { onLine: (l: ControlLine) => void; onExit: () => void }) => ControlClient; clock?: () => number });
  /** mode 'ro' ignores input() and resize(). Throws BridgeError(4429) over the limits. */
  open(o: { windowId: string; paneId: string; mode: 'rw' | 'ro'; cols: number | null; rows: number | null; sink: TermSink }): Promise<TermHandle>;
  get count(): number;
  stop(): void;                               // closes every sink with 1001 and the client
}
export class BridgeError extends Error { constructor(readonly code: number, message: string) }
```

Rules:
- **The client:**
  - It is started by the first `open` and closed when the last terminal closes, so there is no client while no terminal is open.
  - stdout is read as bytes and split on `\n`.
  - Its exit closes every sink with 1011 `tmux stopped.`, and the next `open` starts a new client.
  - It subscribes per pane when Task 1 found `refresh-client -A` works; otherwise it filters by pane id.
- **Snapshot:**
  - One `run(['display-message -p -t %N <PANE_INFO_FORMAT>', 'capture-pane -p -e -N -S -1000 -t %N'], countFor)`, with the capture's count `min(history, 1000) + height` taken from the first block.
  - While the run is in flight, that pane's output for this sink is held back. `%output` that arrives before the capture block is dropped for it, and output after the capture's `%end` is forwarded. The ordering is the one Task 1 confirmed.
  - The snapshot is capped at 1 MiB (the oldest history rows go first).
- **Input (rw):**
  - UTF-8 bytes of `data`, at most `LIMITS.termInputBytes` (more → the handle closes the sink with 1009 `That was too much at once.`), written as `sendKeysLines`.
  - Lines for one pane go in order. A `%error` for a key line is logged once per sink.
- **Resize (rw):**
  - Clamped to `LIMITS.termMinCols`–`termMaxCols` and `termMinRows`–`termMaxRows`, and debounced 100 ms.
  - Sent as `resize-window -t @W -x <cols> -y <rows>`.
  - On the `%layout-change` for `@W`, every sink on a pane of `@W` gets `size` from a fresh `display-message`.
- **Restore:** when the last rw sink of a window closes, the restore sequence from Task 1 runs (expected: `set-option -w -u -t @W window-size`).
- **Window close:** `%window-close @W` closes its sinks with 4409 `The session's window has closed.`
- **Backpressure:** a sink with `buffered() > 1 MiB` stops getting output. A 100 ms timer runs only while some sink is held back. Once the sink is below 256 KiB, it gets a fresh snapshot (`reset`) and output resumes. Nothing is queued in the bridge.
- **Limits:** `LIMITS.terminals` in all, `LIMITS.terminalsPerPane` per pane → `BridgeError(4429, 'Too many terminals are open. Close one and try again.')`.

- [ ] **Step 1: Write the failing tests.**
  - `unescapeOutput`: `\033[1m\134x` → ESC `[1m\x`. `parseControlLine` on every `burst.txt` line, with a split UTF-8 character kept as raw bytes.
  - `sendKeysLines('%3', é + ESC[A + 03)` → one line `send-keys -t %3 -H c3 a9 1b 5b 41 03`; 600 bytes → 3 lines of ≤ 256 bytes; `'%3; kill-server'` → throws.
  - `SAFE_LINE` accepts every line the bridge builds and refuses:
    - `send-keys -t %3 -l -- x`;
    - `run-shell 'x'`;
    - anything with `;` outside the `" ; "` joiner;
    - a quote outside Kage's constant format;
    - `#(`;
    - a newline.
  - `run` with `capture.txt`: a data row reading `%end 1700000000 7 1` inside a count-framed block is returned as data; a `%end` with another number doesn't end the block; the block ends only at the count plus the matching `%end`.
  - Bridge (fake client):
    - the first `open` starts the client, and closing the last stops it (`client.close` called, `vi.getTimerCount() === 0`);
    - `reset` carries the pane's size, with a snapshot that ends with the cursor position;
    - output for another pane never reaches the sink;
    - output queued before the capture block isn't forwarded, and output after it is;
    - `ro`: `input` and `resize` write nothing;
    - `rw`: `input('é')` writes the `-H c3 a9` line;
    - five resizes in 50 ms → one `resize-window`, clamped (`9999x1` → `500x5`);
    - the last rw close writes the restore line, and a ro close doesn't;
    - `%window-close` → 4409; client exit → 1011, and the next `open` starts a new client;
    - a sink over 1 MiB gets no output until it drains, then a new `reset`;
    - the 9th terminal → 4429, and the 4th on one pane → 4429.
  - Prompt parser: `real-edit-60.txt` and `real-edit-160.txt` give the same options as `real-edit-80.txt` (R39 stays).
  - Integration (WSL, real tmux):
    - a `cat` pane: `open` rw, `input('héllo\r')`, and the sink's output contains `héllo`;
    - the snapshot of a pane that printed 50 numbered lines holds them in order;
    - resize to 100×30 makes `#{window_width}` 100, and closing restores the window option;
    - a pane printing `%end 0 0 0` lines while being snapshotted doesn't break the snapshot.
- [ ] **Step 2: Run them.** Windows: unit tests FAIL, and the integration tests are skipped. In WSL: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): terminal bridge over tmux control mode: byte-exact output, hex keys, count-framed snapshots, sizing`

---

### Task 12: The terminal WebSocket: guards, attach and wiring (B9)

**Files:**
- Create: `packages/server/src/terminal/upgrade.ts`, `packages/server/src/terminal/server.ts`
- Modify:
  - `packages/server/src/security.ts` (export `hostAllowed` and `originAllowed`; the middlewares use them);
  - `packages/server/src/live-source.ts` (`terminalTarget`);
  - `packages/server/src/app.ts` (a plain GET on the terminal path → 426);
  - `packages/server/src/serve.ts` (`server.on('upgrade')`; close sockets on stop);
  - `packages/server/package.json` (`ws`, `@types/ws`)
- Test: `terminal/upgrade.test.ts`, `terminal/server.test.ts` (a real `http.Server` on 127.0.0.1 with a fake bridge; the `ws` client), `security.test.ts`, `app.test.ts`, `deps.test.ts` (new: `bufferutil` and `utf-8-validate` don't resolve)

**Interfaces:**
- Consumes: `TerminalBridge` (Task 11), `isAuthorised` (phase 3), `TmuxClient.windowKageId`.
- Produces:

```ts
// security.ts
export function hostAllowed(host: string | undefined, allowed: Allowed): boolean;
export function originAllowed(origin: string | undefined, allowed: Allowed): boolean;   // exactly http://<allowed name>:<port>; undefined → false
// terminal/upgrade.ts
export const TERMINAL_PATH: RegExp;   // ^/api/sessions/([^/]{1,200})/terminal$ ; the decoded id must match /^[A-Za-z0-9@_-]{1,100}$/
export type UpgradeCheck =
  | { ok: true; id: string; cols: number | null; rows: number | null }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string };
export function checkUpgrade(req: { method?: string; url?: string; headers: IncomingHttpHeaders }, o: { allowed: Allowed; token: string }): UpgradeCheck;
// live-source.ts
terminalTarget(id: string): { windowId: string; paneId: string; kageId: string | null; external: boolean; status: SessionStatus } | null;   // null: unknown id or no window
// terminal/server.ts
export class TerminalServer {
  constructor(d: { allowed: Allowed; token: string;
    source: Pick<LiveSource, 'terminalTarget'> | null;   // null in demo mode
    bridge: Pick<TerminalBridge, 'open'> | null;
    tmux: Pick<TmuxClient, 'windowKageId'> | null;
    pingMs?: number /* 30000 */ });
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;   // every socket closes with 1001
}
```

The checks run in this order, before the upgrade. The first that fails answers `HTTP/1.1 <status>` with a one-line body and destroys the socket:
1. The path matches `TERMINAL_PATH` (404 `Not found`).
2. The method is GET with `Upgrade: websocket` (400).
3. `hostAllowed` (403 `Unknown host`).
4. `originAllowed` (403 `Bad origin`).
5. `isAuthorised(token, Cookie)` (401 `Sign in to Kage`).
6. `Sec-WebSocket-Protocol` lists `kage.term.v1` (400).
7. `cols` and `rows`, when present, are integers within the limits (400).

Then `ws` upgrades (`noServer`, `maxPayload` = `LIMITS.termInputBytes` + 1 KiB, `perMessageDeflate: false`, protocol `kage.term.v1`) and the session checks run. Each closes with a code and a sentence that the board shows:
- demo mode → 4501 `Demo mode has no terminal.`;
- unknown id → 4404 `No session with id <id>`;
- ended, or no window → 4409 `This session has ended.`;
- a record session whose window's live `@kage_id` differs → 4403 `That window isn't Kage's any more.`;
- external → mode `ro`, and record sessions → mode `rw`.

`bridge.open` follows, with a sink over the socket: `reset` as a text frame then the snapshot as a binary frame; output as binary frames; `size` as text frames.

Client frames:
- `{t: 'in', d}` (string) and `{t: 'size', cols, rows}` (integers);
- anything else, or binary frames, → close 1003 `Kage didn't understand that.`;
- `in` and `size` on a `ro` terminal are dropped silently.

A ws ping goes every 30 s per socket; a socket with no pong by the next ping is terminated.

- [ ] **Step 1: Write the failing tests.**
  - `checkUpgrade`:
    - a good request → ok, with `cols` and `rows`;
    - a foreign Host → 403;
    - Origins `http://evil.example`, `http://my-pc:9999`, `https://my-pc:8080`, `null`, and a missing Origin → 403 each;
    - with a token: no cookie, or a wrong cookie → 401;
    - a missing subprotocol → 400;
    - `cols=0`, `cols=abc` → 400;
    - the path `/api/sessions/a/b/terminal` → 404;
    - the id `ext-%407` decodes to `ext-@7` and passes; `..%2F` fails.
  - `hostAllowed` and `originAllowed` give the same answers as the phase 3 middleware tests (the shared table).
  - `TerminalServer` (a real socket, the `ws` client, a fake bridge):
    - a guard failure answers the HTTP status, and `bridge.open` is never called;
    - a record session opens `rw`, with the pane id from `terminalTarget`, never from the URL;
    - an external session opens `ro`, and its `in` frames never reach the handle;
    - `windowKageId` mismatch → 4403;
    - demo → 4501; an ended session → 4409;
    - a binary client frame → 1003;
    - a 70 KiB frame → 1009;
    - `close()` closes every socket with 1001;
    - no ping timer while no socket is open.
  - App: `GET /api/sessions/x/terminal` without an upgrade → 426 `{"error":"Open the terminal with a WebSocket."}`.
  - Deps: `import.meta.resolve('bufferutil')` and `import.meta.resolve('utf-8-validate')` both throw from the server package.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `serve.ts` builds the bridge only in live mode (the client factory uses the tmux target), attaches `server.on('upgrade', …)` in both modes, and adds `terminalServer.close()` and `bridge.stop()` to the cleanups before the HTTP server closes.
- [ ] **Step 4: Run the tests** on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): terminal WebSocket with Host, exact Origin, token and protocol checks before the upgrade; view-only external windows (B9)`

---

### Task 13: Board: the lazy terminal

**Files:**
- Create: `packages/web/src/term-loader.ts` (main bundle), `packages/web/src/terminal/index.ts`, `packages/web/src/terminal/terminal.css` (lazy chunk)
- Modify:
  - `packages/web/build.ts` (a second entry, `term-[hash].js`/`.css`; `<meta name="kage-term" content="/term-….js /term-….css">` in `index.html`; `HASHED` and the output check);
  - `packages/server/src/assets.ts` (`term-` files are immutable);
  - `packages/server/src/app.ts` (the CSP ruling from Task 1, if any);
  - `packages/web/src/components/SessionPanel.tsx` (Terminal opens it; Back; the view-only line);
  - `packages/web/src/keys.ts` (`T`);
  - `packages/web/src/store.ts` (`termNote`);
  - `packages/web/src/styles/board.css`;
  - `packages/web/package.json` (`@xterm/xterm`, `@xterm/addon-fit`)
- Test: `packages/web/build.test.ts`, `packages/web/src/components/terminal.test.tsx` (new: the loader and panel with a fake module), `keys.test.ts`

**Interfaces:**
- Consumes: the terminal WebSocket (Task 12), the `Term*` types (Task 2).
- Produces:

```ts
// term-loader.ts (main bundle, ≤ 600 bytes gzipped)
export function loadTerminal(): Promise<TerminalModule>;   // reads meta[name=kage-term], adds the stylesheet once, then import()s the chunk; cached
// terminal/index.ts (the chunk)
export interface TerminalModule { mountTerminal(el: HTMLElement, o: { id: string; onEnd: (reason: string | null) => void }): { focus(): void; dispose(): void } }
// store.ts
export const termNote: Signal<string | null>;   // the terminal's last close reason or load error, shown in the error line
```

Behaviour:
- **Opening:** `T` (not while typing) or the footer's Terminal sets `mainView` to `terminal` for a session that has a window. For an ended session the footer shows Resume instead (Task 9), and `T` does nothing.
- **Loading:** the output area shows `Loading the terminal…` (`--fg-3`) until the chunk and Geist Mono (`document.fonts.load('13px "Geist Mono"')`) are ready.
- **Connecting:**
  - `new WebSocket(ws(s)://<location.host>/api/sessions/<id>/terminal?cols=<c>&rows=<r>, 'kage.term.v1')`, where `cols` and `rows` come from `FitAddon.proposeDimensions()` on the area.
  - `binaryType = 'arraybuffer'`.
  - `reset` resizes xterm to the pane size, `reset()`s, then writes the snapshot. Binary frames are written as `Uint8Array`, and `size` resizes xterm.
- **Keys:**
  - `onData` → `{t: 'in', d}`.
  - A `ResizeObserver` on the area, debounced 100 ms, sends `{t: 'size'}` (rw only).
  - The custom key handler gives `Shift+Esc` to the board (T2). Every other key, `Esc` included, goes to the pane.
- **Theme:** background `--bg`, foreground `--fg`, cursor and its accent `--lime`, selection `--line-strong`. Font Geist Mono 13 px, scrollback 5,000 lines. xterm's ANSI palette stays at its defaults.
- **Footer:** left `Back to session` with kbd `⇧Esc`; the right is unchanged.
- **View-only (`mode: 'ro'`):** the line `View only: Kage didn't start this window, so it doesn't type into it.` (`--fg-3`) shows above the footer. xterm takes the pane's size and doesn't resize it.
- **Closing:**
  - Back, `Shift+Esc` or selecting another session disposes xterm and closes the socket (1000).
  - A server close shows its reason in the error line (`termNote`) and returns to the output.
  - A handshake failure calls `GET /api/auth`: 401 → the login screen; otherwise `Couldn't open the terminal.`
  - A chunk load failure → `Couldn't load the terminal.`
- **Build:**
  - The terminal is its own esbuild entry: `term-[hash].js`, plus `term-[hash].css` from `xterm.css` and `terminal.css`.
  - Only the `kage-term` meta names them. No `<script>`, `modulepreload` or `<link>` in `index.html` points at them.
  - Demo mode: Terminal shows `Demo mode has no terminal.` (the 4501 reason).

- [ ] **Step 1: Write the failing tests.**
  - `build.test.ts`:
    - `index.html`'s scripts and links name only `app-*` files, and its `kage-term` meta names files that exist;
    - the first load (as phase 3 measures it) is ≤ 25.5 KB and excludes `term-*`;
    - `term-*.js` plus `term-*.css` gzipped ≤ 100 KB;
    - both builds are hashed and cached immutable by `assets.ts`.
  - `terminal.test.tsx` (a fake `TerminalModule` and a fake WebSocket):
    - `T` on a running session loads the module once, mounts it into the output area, and shows the footer `Back to session ⇧Esc`;
    - a second open reuses the loaded module;
    - `T` while typing does nothing;
    - `T` on an ended session does nothing;
    - `Shift+Esc` and Back dispose the module and set `mainView` to `output`;
    - selecting another session disposes it;
    - `onEnd('This session has ended.')` shows that sentence in the error line;
    - a load failure shows `Couldn't load the terminal.`;
    - the view-only line shows when the module reports `ro`.
  - Chunk unit test (`terminal/index.test.ts`, happy-dom with xterm mocked at the module boundary):
    - `reset` resizes before it writes;
    - `onData('x')` sends `{"t":"in","d":"x"}`;
    - `ro` sends no size frames;
    - `Shift+Escape` is not sent to the pane, and `Escape` is.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use the CSP ruling from Task 1. With option (b), `app.ts` sets a per-response nonce only on `index.html`, and the loader hands it to xterm.
- [ ] **Step 4: Run the unit tests, then build and the e2e visual spec.** Expected: PASS; visuals unchanged. Report the first-load size and the terminal chunk size.
- [ ] **Step 5: Commit.** `feat(web): lazy xterm.js terminal over the WebSocket, view-only for external windows`

---

### Task 14: Live e2e: pin, archive, auto-archive, delete with the warning, resume, diff and the terminal

**Files:**
- Create: `e2e/harness.ts` (the live spec's setup and helpers moved out unchanged: temp root, private socket, repos, serve, `kageWindow`, git env), `e2e/finish.spec.ts`
- Modify:
  - `e2e/live.spec.ts` (imports the harness, no behaviour change);
  - `e2e/fake-claude.mjs`;
  - `playwright.config.ts` (the `live` project matches `live.spec.ts` and `finish.spec.ts`)

**Interfaces:**
- Consumes: everything above. Kage launches the fake through `KAGE_CLAUDE_BIN`.

**Fake Claude changes:**
- **Resume:** `--resume <id>` and `--continue` are accepted. With `--resume`, it reuses `<id>` as its session id and appends to that transcript, fires `SessionStart` with `source: "resume"`, then draws the idle box with no turn. The argv file is written as before.
- **`commit-and-edit`:** after `UserPromptSubmit`, in its cwd (the worktree), it:
  - writes `notes.md` and commits it (`git -c user.name=Fake -c user.email=fake@example.invalid commit`);
  - then modifies `README.md` and writes `scratch.txt` (untracked);
  - then fires `Stop`.

  The result: 1 unpushed commit and 2 uncommitted files.
- **`commit-only`:** commits `notes.md`, then fires `Stop`, with a clean worktree.

- [ ] **Step 1: Move the harness and extend the fake** as above. Run `live.spec.ts`: it is unchanged and green.
- [ ] **Step 2: Write `finish.spec.ts`.** Its `beforeAll` uses the harness: a fresh root, repos `demo` and `shop`, `KAGE_CLAUDE_BIN`, and `autoArchive` `{onMerge: true, afterDays: 14}`. Then, in order:
  1. **Pin:**
     - start `edit-and-test Pin me` and wait for done;
     - press `S`: the row starts `★ ` and sorts first in done, and `state.json` has `pinned: true`;
     - press `S` again: unpinned.
  2. **Diff:**
     - start `commit-and-edit Write notes` and wait for done;
     - the right column lists `README.md`, `notes.md` and `scratch.txt`;
     - click `View diff →`: the view lists the same three paths in the same order;
     - `notes.md` and `scratch.txt` show `+` lines in the add colour, and `README.md` a `−` and a `+` line;
     - press `Esc`: the output is back.
  3. **Delete with the warning:**
     - on that session, click `Delete…`: the warning reads `1 commit isn’t pushed and will be lost.` and `2 files have uncommitted changes and will be lost.`;
     - write `extra.txt` into the worktree from the test, then click `Delete session`;
     - the error line shows `Couldn't delete: The branch changed since you looked. Look again before deleting.`, the confirmation stays, and the warning updates to `3 files`;
     - click again: the delete toast shows, the worktree folder and the branch are gone, the window is gone, and the record is gone from `state.json`;
     - a branch `feature/keep` that the test made beforehand still exists.
  4. **Archive and restore:**
     - on test 1's session (unpin it first), press `E`: the archived toast shows, the row is gone, `archived 1` shows, and the window is gone while the worktree and branch remain;
     - open `archived 1` and click `Restore`: the session is back, selected, with the chip `ended` and Resume in the footer.
  5. **Resume:**
     - press `U`: the chip goes `running`, then `done` (the fake's idle box);
     - the argv file ends with `--resume <sessionId>`, and the window's `@kage_id` equals the session id.
  6. **Auto-archive on merge:**
     - start `commit-only Add changelog` and wait for done;
     - in the main checkout, `git merge --no-ff -m merge kage/commit-only-add-changelog`;
     - within 15 s the row leaves the list, and the archived count goes up by one;
     - a pinned `commit-only Keep this` merged the same way stays in the list.
  7. **Terminal on a Kage session:**
     - select test 5's done session, and record that no `term-*.js` request happened yet;
     - press `T`: `.xterm` shows, `term-*.js` is requested once, and the footer reads `Back to session ⇧Esc`;
     - type `hello` with the keyboard: `capture-pane` of the window shows `❯ hello`, and the xterm rows (`.xterm-rows`) contain `hello`;
     - press Enter: the fake runs a turn, and the board's output shows `You said: hello` after `Shift+Esc`;
     - resize the viewport to 1100×800: `#{window_width}` follows xterm's cols within 2 s;
     - after `Shift+Esc`, `show-options -wqv -t <window> window-size` is empty, or the restore value Task 1 recorded.
  8. **Terminal on an external window:**
     - open a plain `sh` window in the `kage` session and select it, then press `T`;
     - the view-only line shows;
     - typing `echo hi` and Enter leaves the pane's capture without `echo hi`.
  9. **Guards:** through `http.request` with upgrade headers to the live server:
     - Origin `http://evil.example` → 403;
     - no Origin → 403;
     - a good Origin without the subprotocol → 400;
     - a good request → 101.
- [ ] **Step 3: Add a token case to `login.spec.ts`.** With the token server, a good upgrade with no cookie → 401, and with the cookie → 101, or a 4501 close in demo mode after the upgrade.
- [ ] **Step 4: Run.** `corepack pnpm test:linux`: everything passes in the container, three runs in a row. Then on Windows: the unit tests and the chromium e2e (visual, board, login) pass.
- [ ] **Step 5: Commit.** `test(e2e): pin, diff, delete with the warning, archive and restore, resume, auto-archive on merge, the terminal and its guards`

---

### Task 15: Docs

**Files:**
- Modify:
  - `docs/specs/2026-11-21-kage-design.md`: amendments marked "(amended 2026-11-21, phase 4)":
    - §5.1: `ws` and xterm versions; the record gains `baseCommit`, `doneAt` and `archivedAt`; the terminal is its own esbuild entry, named by a meta tag.
    - §5.5: Delete answers synchronously (204 after the removal), so a failure can say why (B10); the `archive` event and the snapshot's `archived`.
    - §5.6, as built:
      - the lazy control client;
      - hex keys;
      - count-framed snapshots;
      - `resize-window` while a rw terminal is open, and the restore;
      - backpressure resync;
      - limits;
      - view-only external windows (T1).
    - §5.7: the diff uses `listChanges` (the list's form), pages of `LIMITS.diffLines`, `--no-textconv`, and untracked files as new-file hunks.
    - §5.8:
      - pin needs a record;
      - archive refuses active sessions;
      - "unpushed" means commits only this branch reaches;
      - the uncommitted warning;
      - the delete request carries the confirmed counts, plus the `--force` and `-D` rules;
      - auto-archive triggers (events, the git directory watch and one deadline timer, replacing "every 10 minutes"), `merged` (past `baseCommit`, ancestor or merge-tree, clean worktree) and `afterDays: 0`.
    - §5.8a: Resume runs `--resume <session id>`, or `--continue` without one, with the record's permission mode; P3F1.
    - §5.10: the WebSocket checks before the upgrade (Host, exact Origin, cookie, subprotocol); ownership covers pin.
    - §5.12: the new routes (pin, archive, `GET /api/archive`, the DELETE body, resume, the diff's `from`, 426 on the terminal path), and the terminal close codes.
    - §6.4: `S`, `E`, `U`, `T`; `Shift+Esc` leaves the terminal (T2).
    - §6.5: the archived list, the archived toast, the uncommitted warning, the diff view's copy, and the terminal's footer, view-only and error copy.
    - §7: the first load after phase 4, the terminal chunk size, and one diff page in the DOM.
  - `docs/specs/host-integration.md` and `claude-code-integration.md`: pointers from the "Read first" lists to the new sections.
  - `docs/backlog.md`: mark B7, B9 and B10 done; add anything found and deferred.
  - `docs/plans/README.md`: phase 4 built.
  - `README.md`: "Finish a session" (pin, archive, delete, resume, diff), the terminal (`T`, `Shift+Esc`, view-only external windows), and `autoArchive` in the config example.

- [ ] **Step 1: Update the docs** as listed, in the house style (short sentences, exact commands).
- [ ] **Step 2: Run** `corepack pnpm lint`. Expected: clean.
- [ ] **Step 3: Commit.** `docs: finish and terminal — pin, archive, auto-archive, delete, resume, diff, the terminal`

---

**Phase 4 check (spec §9: "the full lifecycle, and the terminal works with Claude's interface"):** in WSL, run `kage serve` (bound to 127.0.0.1, or the Tailscale IP when it is up) with `projectsRoot` holding a scratch git repo, and real `claude` 2.1.330. Use at most 8 prompts. From the Windows browser:
1. Start a task (`Create notes.md with one line and commit it`), answer its prompts from the board, and see it done. Pin it with `S`.
2. Press `T`:
   - in the terminal, type a follow-up and submit it with Enter;
   - answer its next permission prompt with the arrow keys and Enter;
   - press `Esc` at a prompt and see Claude decline it (Esc went to Claude, not to the board);
   - paste three lines and see them stay in Claude's input box until Enter (bracketed paste);
   - resize the browser window and see Claude redraw, while the board still turns the session amber at the next prompt;
   - `Shift+Esc` returns to the board.
3. Open `View diff →`: it lists the same files as the right column.
4. Stop the session; Resume it with `U`; see it running, then done.
5. Archive it with `E`, restore it from `archived 1`, then Delete it: the warning names the unpushed commit, and after confirming, the worktree and branch are gone.
6. Start a second task that commits, merge its branch in the main checkout, and see it archived without a reload.

Then check that a page on another origin can't open a terminal: the e2e guard test, rerun against the check's server.
