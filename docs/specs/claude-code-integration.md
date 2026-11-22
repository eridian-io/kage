# Claude Code integration: observed behaviour

Recorded on 2026-11-21 against **Claude Code 2.1.330** (WSL Ubuntu 24.04, tmux 3.4, Node 24), in a scratch git repo driven through a private tmux socket. This file holds facts only: field names, event order, timings and keystrokes. The fixtures in `packages/server/test/fixtures/` are hand-written and use invented content in the observed shapes, except the `real-*` ones: `panes/real-trust-80.txt`, `panes/real-edit-80.txt`, `panes/real-done-80.txt` and `transcripts/real-short-turn.jsonl` were recorded from 2.1.330 at 80 columns in the phase 2 fix wave, with paths, ids and account fields replaced by invented values and the shapes kept.

## Read first: where this differs from the design spec (§5.2–§5.4)

1. **The default permission mode is now `auto`, not the prompting mode.**
   - On first start, 2.1.330 says: "Auto mode is now Claude Code's default permission mode." Its footer reads `⏵⏵ auto mode on`.
   - In auto mode, Claude decides on edits and commands itself and shows no prompts.
   - To get the behaviour §5.2 assumes (ask before edits and commands), Kage must pass **`--permission-mode default`** explicitly. The footer then reads `⏸ manual mode on`.
   - "Accept edits automatically" stays `--permission-mode acceptEdits`.
   - Every Bash permission prompt now offers an option "Yes, and switch to auto mode". Whether Kage should show that option as a button is for the controller to rule on.
2. **The permission `Notification` arrives about 11 s after the prompt appears on screen** (11.0 s, 10.9 s, 11.0 s and 11.1 s in four observations).
   - A **`PermissionRequest`** hook exists and fires about 0.1 s after `PreToolUse`. It carries `tool_name`, `tool_input` and `permission_suggestions`.
   - Recommendation: register `PermissionRequest` and turn the session amber on it, and keep `Notification` as a fallback.
3. **`AskUserQuestion` raises the same Notification as a permission prompt**: `notification_type: "permission_prompt"`, `message: "Claude needs your permission"`.
   - To tell a question from a permission prompt, use the preceding `PreToolUse`: its `tool_name` is `AskUserQuestion`, and the question and options are in its `tool_input`.
4. **The idle Notification was never observed.** It did not arrive within about 3 minutes after `Stop`, measured twice in a detached tmux pane, once with tmux `focus-events on`.
   - The spec ignores it anyway. `hooks/notification-idle.json` is therefore built from the documented values (`idle_prompt`, "Claude is waiting for your input"), not from an observation.
5. **There are no `Glob` or `Grep` tools in this build.** Asked to use them, Claude replied that it had none and ran `find` and `grep` through Bash. The pane summarised this as "Searched for 2 patterns".
   - The input fields of Grep and Glob were therefore not observed. The reader should accept those names if they appear, and otherwise treat them like any other tool.
6. **Onboarding blocks a fresh `claude` before any hook fires.** The screens are described in "Startup screens" below.
   - `SessionStart` fires only after the folder-trust prompt is answered.
   - A Kage window stuck on one of these screens therefore has no hooks. Kage should fall back to reading the pane.
   - A new worktree folder (`<repo>/.worktrees/<slug>`) does **not** show the trust prompt when the repo root is trusted; see §7.
7. **The transcript file is created lazily.** `transcript_path` arrives with `SessionStart`, but the file may not exist yet.
   - A session killed before its first prompt never had a file.
   - A session that only ran `/exit` got one at exit.
   - The reader must wait for the file to appear instead of failing.

All other §5.2–§5.4 assumptions held:
- `--settings <file>` works;
- `TMUX_PANE` is in the hook's environment;
- `send-keys <n>` answers numbered prompts;
- `send-keys -l -- "<text>"` followed by `Enter` submits a typed prompt;
- the transcript is JSONL with `tool_use` and `tool_result` blocks.

## 1. Settings and hooks

| Question | Answer |
|---|---|
| Is `--settings <file>` accepted? | Yes. `claude --help` lists it as `--settings <file-or-json>`. |
| Does it merge with other settings? | Yes. A `UserPromptSubmit` hook from `<project>/.claude/settings.json` and the one from `--settings` both ran for the same prompt. The order between the two differed from prompt to prompt, so don't rely on hook order across sources. The user-level file was not read, by rule; it merges by the same mechanism. |
| Is a hook's stdout shown? | The logger printed nothing. The transcript records each Stop hook run in a `system/stop_hook_summary` record. |
| Is `TMUX_PANE` in the hook environment? | Yes, the pane of the `claude` process (`%0`, `%2`). `TMUX` is set too. |
| Does an initial task in argv work? | Yes. `claude --settings f --permission-mode default "task"` fires `SessionStart` and then, 0.6 s later, `UserPromptSubmit` with that prompt. No Enter is needed. |
| Hook command form | `{"hooks": {"<Event>": [{"matcher": "", "hooks": [{"type": "command", "command": "..."}]}]}}`. The event JSON arrives on stdin. Exit 0 with no output is a no-op. |

### Fields per event

All events carry `session_id`, `transcript_path`, `cwd`, `scratchpad_dir` and `hook_event_name`. Events inside a turn also carry `prompt_id`.

| Event | Extra fields |
|---|---|
| `SessionStart` | `source` (`"startup"`), `model` |
| `UserPromptSubmit` | `prompt_id`, `permission_mode` (`"default"`), `prompt` |
| `PreToolUse` | `prompt_id`, `permission_mode`, `effort: {level}`, `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | `prompt_id`, `permission_mode`, `effort`, `tool_name`, `tool_input`, `permission_suggestions` (e.g. `[{type: "setMode", mode: "acceptEdits", destination: "session"}]`). It has no `tool_use_id`. |
| `PostToolUse` | as for `PreToolUse`, plus `tool_response` and `duration_ms`. `tool_response` for Bash is `{stdout, stderr, interrupted, isImage, noOutputExpected}`; for Read it is `{type: "text", file: {filePath, content, numLines, startLine, totalLines}}`; for Edit it is `{filePath, oldString, newString, originalFile, structuredPatch: [{oldStart, oldLines, newStart, newLines, lines[]}], userModified, replaceAll}`; for Write it is `{type: "create", filePath, content, structuredPatch, originalFile: null, userModified}`. |
| `Notification` | `prompt_id`, `message`, `notification_type`. The permission prompt and AskUserQuestion both gave `permission_prompt` with "Claude needs your permission". It has no `permission_mode`. |
| `Stop` | `prompt_id`, `permission_mode`, `effort`, `stop_hook_active: false`, `last_assistant_message` (Markdown), `background_tasks: []`, `session_crons: []` |
| `SessionEnd` | `reason`: `"prompt_input_exit"` after `/exit`, `"other"` after `tmux kill-window`. It carries `prompt_id` when the session had one. |
| `PostToolUseFailure` | as for `PreToolUse`, plus `error` (e.g. `"Exit code 1\n<stderr>"`), `is_interrupt` (`false`) and `duration_ms`. It has no `tool_response`. |

`PermissionRequest.permission_suggestions` varies by tool:
- for Write: `[{type: "setMode", mode: "acceptEdits", destination: "session"}]`;
- for `touch` in Bash: `[{type: "addDirectories", directories: [<cwd>], destination: "session"}, {type: "setMode", …}]`.

### Denial, cancel and failure

| Case | Hooks that fire | Pane afterwards | `Stop`? | Transcript |
|---|---|---|---|---|
| Command fails (exit 1, no prompt) | `PreToolUse`, then **`PostToolUseFailure`** about 0.4 s later. No `PostToolUse`. | `⎿  Error: Exit code 1 …`, and Claude carries on | yes, at the end of the turn | `tool_result` with `is_error: true`; `toolUseResult` is a string `"Error: Exit code 1\n…"` |
| Permission answered **No** (`send-keys 4` on a Bash prompt) | `PreToolUse` and `PermissionRequest` before the answer. **Nothing after it**: no `PostToolUseFailure`, `PostToolUse` or `Stop` (waited 30 s). | `⎿  Interrupted · What should Claude do instead?` under the tool line, then the empty input box | **no** | `tool_result` with `is_error: true`, content "The user doesn't want to proceed with this tool use. … STOP …", envelope `toolUseResult: "User rejected tool use"`, `toolDenialKind: "user-rejected"`, `toolDenialBeforeRun: true`. Then a user record with a text block `[Request interrupted by user for tool use]`. |
| Permission cancelled with **Esc** | the same as No: nothing after the key (waited 25 s) | the same as No | **no** | the same records as No. Esc and No cannot be told apart. |

Consequence for Kage: after sending a No or an Esc, no hook moves the session on. Kage must set the status itself when it sends the answer: the turn is over and `claude` is waiting. Alternatively, it can react to the `[Request interrupted by user for tool use]` record. The next prompt runs normally.

### Event order for one prompt that reads, edits and runs a command

Prompt: "Fix the bug in add.js, then run: node test.js" (default mode). The times are seconds after `UserPromptSubmit`.

| t (s) | Event | Notes |
|---|---|---|
| 0.0 | `UserPromptSubmit` (both sources) | |
| 2.9 | `PreToolUse` Bash (`ls && cat …`) | read-only, auto-allowed |
| 3.9 | `PostToolUse` Bash | |
| 6.1 | `PreToolUse` Read | |
| 6.2 | `PostToolUse` Read | |
| 6.9 | `PreToolUse` Edit | the edit prompt shows in the pane now |
| 17.9 | `Notification` permission_prompt | 11.0 s after the prompt appeared |
| 21.3 | `PostToolUse` Edit | answered with `1` |
| 21.4 | `PreToolUse` Bash (`node test.js`) | the Bash prompt shows now |
| 32.3 | `Notification` permission_prompt | 10.9 s later |
| 43.8 | `PostToolUse` Bash | answered with Down + Enter |
| 45.4 | `Stop` | |

In a later run with `PermissionRequest` registered, it fired 0.1 s after `PreToolUse` Write, and the Notification followed 11.0 s later. `SessionStart` comes when the input box is ready, before any prompt.

## 2. Permission prompts in the pane

Fixtures: `panes/permission-bash.txt`, `panes/permission-edit.txt`. Both are `capture-pane -p -J` at 200x50.

| Question | Answer |
|---|---|
| Layout | A full-width `─` rule, then a title (` Bash command` or ` Edit file`). Bash prompts then show a line ` Tip: auto mode handles these prompts for you — choose "switch to auto mode" below`, which is not an option. Then a description or file name, the command or diff between `╌` rules, and the question (` Do you want to proceed?` or ` Do you want to make this edit to <file>?`). Then numbered options, the selected one prefixed `❯ `. The footer is ` Esc to cancel · Tab to amend`. |
| Bash options | `1. Yes`, `2. <varies>`, `3. Yes, and switch to auto mode · …`, `4. No`. The option-2 text depends on the command: `Yes, and don’t ask again for: node *` for `node test.js`, and `Yes, and always allow access to <dir> from this project` for `touch`. |
| Edit and Write options | `1. Yes`, `2. Yes, and switch to accept edits (…) for this session (shift+tab)`, `3. No` |
| Answering option 1 | `send-keys 1`. It is selected and submitted at once; no Enter is needed. |
| Answering option 2 | **Observed:** `send-keys 2` on a Bash prompt chose option 2 and ran the command at once, with no Enter. Alternatively, `send-keys Down` moves the `❯` to option 2, then `send-keys Enter` submits. `send-keys 4` (No) is also immediate. |
| Cancelling | `send-keys Escape` cancels the prompt. It has the same effect as No; see §1, "Denial, cancel and failure". |
| Lines | `-J` joins wrapped lines, but rows keep trailing spaces, often padded to near the pane width. Trim each line before parsing. Option lines are ` ❯ 1. Yes` or `   2. …`, so match `^\s*(❯\s*)?(\d+)\.\s+(.*)$`. |
| Wrapping | Claude's TUI wraps long text itself, so `-J` doesn't join it. At 80 columns the Edit prompt's option 2 ends `…file edits and common file` and goes on, indented to the label's column, on the next line (`commands) for this session (shift+tab)`). An AskUserQuestion option's description is also indented under its label, but its label line is short. A long question or path wraps the same way. |

## 3. AskUserQuestion

Fixtures: `transcripts/ask-question.jsonl`, `hooks/pre-tool-use-ask-question.json`, `panes/ask-question.txt`.

| Question | Answer |
|---|---|
| Transcript shape | An assistant record whose `message.content[0]` is `{type: "tool_use", id, name: "AskUserQuestion", input: {questions: [{question, header, multiSelect, options: [{label, description}]}]}, caller: {type: "direct"}}` |
| Question text | `input.questions[i].question`. The short tab title is `header`. |
| Options | `input.questions[i].options[j].label`, with an optional `description`. Option `j` is key `j+1`. |
| Pane | A `☐ <header>` line, the question, then `❯ 1. <label>`, each followed by an indented description line. The UI adds `N+1. Type something.`, and after a rule `N+2. Chat about this`. The footer is `Enter to select · ↑/↓ to navigate · Esc to cancel`. |
| Answering | `send-keys 1` picks and submits at once; no Enter is needed. |
| Result | The user record's `tool_result.content` is the text `Your questions have been answered: "<question>"="<label>"…`. Its `toolUseResult` is `{questions, answers: {"<question>": "<label>"}, annotations: {}}`. |
| Hooks | `PreToolUse` with `tool_name: "AskUserQuestion"`, then a `Notification` (`permission_prompt`) about 11 s later, then `PostToolUse` after the answer. |

## 4. Transcript shapes (JSONL)

**Location.** The file is `~/.claude/projects/<cwd with "/" replaced by "-">/<session_id>.jsonl`; `transcript_path` gives the exact path. Every line is one JSON object and ends with `\n`.

**Envelope.** Conversation records (`user`, `assistant`, `system`, `attachment`) carry `parentUuid`, `isSidechain`, `type`, `uuid`, `timestamp` (ISO), `cwd`, `sessionId`, `version`, `gitBranch` and `userType`/`entrypoint`, plus many internal fields to ignore.

### Records Kage reads

| Record | How to recognise it | What to read |
|---|---|---|
| User prompt | `type: "user"`, `message.content` is a **string**, no `isMeta` | `message.content`, `promptSource: "typed"`, `origin.kind: "human"` |
| Assistant text (say) | `type: "assistant"`, `message.content[0].type === "text"` | `.text` (Markdown) |
| Assistant thinking (think) | `message.content[0].type === "thinking"` | `.thinking` is **empty** and only `signature` is set, so use it only as an "is thinking" signal. `thinkingDurationMs` is on the envelope. |
| Tool call | `message.content[0].type === "tool_use"` | `name`, `id`, `input` (see below) |
| Tool result | `type: "user"`, `message.content` is an array of `{type: "tool_result", tool_use_id, content, is_error?}` | `content` is a string. `is_error: true` marks a failure. The parsed `toolUseResult` is on the envelope. |
| Turn end | `type: "system"`, `subtype: "turn_duration"` | `durationMs`. In the recorded short turn the order was: the reply (an assistant record with `stop_reason: "end_turn"`), `system/stop_hook_summary` (when Stop hooks ran), then `turn_duration`. Kage treats each of the three as the turn's end. |

Claude Code writes **one record per content block**. Several consecutive assistant records share one `message.id`: text, then tool_use, then tool_use. Parallel tool calls are written as consecutive `tool_use` records, and their results follow, each in its own user record. `message` also has `model`, `stop_reason` (`"tool_use"` or `"end_turn"`) and `usage`.

**Tool inputs:**

| Tool | `input` fields |
|---|---|
| Read | `file_path` (absolute) |
| Edit | `file_path`, `old_string`, `new_string`, `replace_all` |
| Write | `file_path`, `content` |
| Bash | `command`, `description` |
| AskUserQuestion | `questions[]`, as in §3 |
| Grep, Glob | not present in this build (see contradiction 5) |

**Tool result content:**
- Read: line-numbered text (`"1\t…\n2\t…"`). In `toolUseResult.file`, `numLines` and `totalLines` count the empty piece after a final newline. A 4-line file ending in `\n` gave `5`, and the tool_result showed a numbered empty line `5\t`.
- Edit: `"The file <path> has been updated successfully. …"`, with `toolUseResult.structuredPatch[].lines` (` `, `-` and `+` prefixes), which is the diff source for `add`/`del`.
- Write: `"File created successfully at: <path> …"`.
- Bash success: the stdout text and `is_error: false`.
- Bash failure: `"Exit code 1\n<stderr>"`, `is_error: true`, and `toolUseResult` is a plain **string** (`"Error: Exit code 1\n…"`).

**Session start.** The first lines are `mode` (`{mode: "normal"}`), `permission-mode` (`{permissionMode}`), `session-owner`, `atis-latch` and `file-history-snapshot`, then the first user prompt and a burst of `attachment` records. There is no explicit "session started" record.

**Session end.** After `/exit`, three `user` records follow:
- `isMeta: true` with `<local-command-caveat>…`;
- `<command-name>/exit</command-name>…`;
- `<local-command-stdout>Goodbye!</local-command-stdout>`. The farewell text varies ("Goodbye!", "See ya!", "Bye!").

They usually come after a `cost-state` record. `tmux kill-window` writes nothing. Use the `SessionEnd` hook, not the transcript, for end-of-session.

### Records to ignore

`mode`, `permission-mode`, `session-owner`, `atis-latch`, `file-history-snapshot`, `file-history-delta`, `attachment` (subtypes seen: `environment`, `model`, `deferred_tools_delta`, `agent_listing_delta`, `mcp_instructions_delta`, `skill_listing`, `session_context`, `date`, `credential_org`, `remote_session_change`, `prompt_snapshot`, `deferred_tools_record`), `data-flow-records`, `api-request-shape`, `api-request-blob` (it contains `message.content` arrays that look like conversation records, so key on `type`, never on `message`), `api-request`, `last-prompt`, `ai-title`, `tools-used`, `cost-state`, `system/stop_hook_summary`, and `user` records with `isMeta: true` or with string content starting `<command-name>`, `<local-command-stdout>` or `<local-command-caveat>`.

The reader must tolerate a partial last line, since the file is appended while Claude runs (`transcripts/noise.jsonl` ends with one).

## 5. Idle, exit and the pane

| Question | Answer |
|---|---|
| Idle Notification | Not observed. Nothing arrived about 3 minutes after `Stop`, twice, in a detached tmux pane. |
| Pane when idle | Above the footer, the input box sits between two `─` rules: `❯ ` plus an optional **ghost suggestion** (e.g. `❯ commit this`). That is not typed text, and Enter on an empty box may submit it. The footer is `⏸ manual mode on · ? for shortcuts`, and the last reply is followed by `✻ <verb> for 8s · done 4:28 PM`. |
| Pane while working | Tool lines `● Update(add.js)`, `● Bash(node test.js)`, with `⎿  Waiting…` / `⎿  PASS 1 test` under them. |
| After `/exit` | The last TUI frame stays on screen, followed by `Resume this session with:` and `claude <original args> --resume <session_id>` (only if the session had a prompt), then the shell prompt. |
| `#{pane_current_command}` | `claude` while it runs (including onboarding). After `/exit` it is the shell (`bash`), with `pane_dead` 0. |
| `SessionEnd` timing | Right after `/exit` (`prompt_input_exit`). On `tmux kill-window` the hook still runs (`reason: "other"`). |

## 6. Startup screens (fresh install or new folder)

Each screen appeared before `SessionStart`:

| Screen | Text | Answer |
|---|---|---|
| Theme | "Choose the text style that looks best with your terminal" | `Enter` (Auto) |
| Login | "Select login method" (when signed out) | the owner signs in. Kage must not answer it. |
| Security notes | "Security notes: … Press Enter to continue" | `Enter` |
| Folder trust | "Accessing workspace: <path> … Is this a project you created or one you trust?". At 80 columns the question sits mid-paragraph: `Quick safety check: Is this a project you created or one you trust? (Like your` (it can wrap at other widths). `Accessing workspace:` and `Yes, I trust this folder` each render on a line of their own. The options are unnumbered: `❯ No, exit` (the default) and `Yes, I trust this folder`. | `Down`, then `Enter` |
| Renderer offer | "Try the new fullscreen renderer?", options `1. Yes, try it` and `2. Not now` | `2` (no Enter). Saying yes would change what `capture-pane` returns. |

The theme, security notes and renderer offer appeared once per install. The trust prompt is per folder, and a trusted folder also covers the folders inside it (§7).

## 7. Starting and answering

Recorded on 2026-11-21 (phase 3 spike) against 2.1.330 in WSL Ubuntu 24.04 and tmux 3.4, at 80x40.
- Claude was started the way Kage will start it: `tmux new-window -d … -c <worktree> -e KAGE_SOCKET=… -e PATH=… -- <claude> --settings <kage hooks-path> --permission-mode default -- "<task>"`, with no shell in between.
- Six prompts were used in all.
- The git, tmux and port facts are in `host-integration.md`.

Fixtures, all with invented paths and the observed layout:
- `panes/trust.txt`;
- `panes/ask.txt`, a live AskUserQuestion with its conversation above it;
- `panes/idle-typed.txt`;
- `panes/idle-pasted.txt`.

### Starting

| Question | Answer |
|---|---|
| Is `--` before the task accepted? | Yes. `claude --settings <f> --permission-mode default -- "say hi in one word"` submitted the task as the first prompt, and Claude answered "Hi". |
| What does `#{pane_current_command}` show? | `claude`. In 2.1.330, `~/.local/node/bin/claude` is a native ELF executable, not a Node script. |
| How fast does the screen appear? | The idle box with the running prompt showed 0.8 s after `new-window` (trusted folder, no startup screens). |
| Does a new worktree show the folder-trust screen? | **No, when the repo root is trusted.** `<repo>/.worktrees/hi` started straight into the task. Claude wrote no trust entry for the worktree path; only the root's `hasTrustDialogAccepted: true` exists. Trust covers the folders below a trusted folder. |
| A worktree of an untrusted repo | The trust screen appears and names the worktree path (`Accessing workspace:` / `/…/other/.worktrees/t`). So Kage meets the trust screen only for a project whose root was never trusted. |
| Trust screen layout and option order | As in `panes/trust.txt`. The options are unnumbered, in this order: `❯ No, exit` (the default, selected first), then `Yes, I trust this folder`. The footer is ` Enter to confirm · Esc to cancel`. |
| Trust screen keys | `Down` moves `❯` to `Yes, I trust this folder`. **`Down` on the last option wraps** to `No, exit`, and `Up` on the first wraps to the last. A digit (`2`) does nothing. `Enter` on `Yes` accepts, and the idle box appears about 1 s later. `Escape` on the trust screen exits Claude, and the window closes. |

### Answering a prompt

| Question | Answer |
|---|---|
| AskUserQuestion pane | As in `panes/ask.txt` and §3: ` ☐ <header>`, the question, then `❯ 1. <label>` with indented descriptions, `N+1. Type something.`, a `─` rule, `N+2. Chat about this`, and ` Enter to select · ↑/↓ to navigate · Esc to cancel`. |
| Does a digit answer it? | **Yes.** `send-keys 2` picked option 2 (not the one under `❯`) and submitted at once, with no Enter. The pane showed `● Answered Claude's questions:` / `⎿  · <question> → Underscores`, and the transcript recorded `"<question>"="Underscores"`. |
| Escape at a Bash permission prompt | The pane shows `⎿  Interrupted · What should Claude do instead?` under the tool line, then the empty idle box. **The idle box was back at the first poll, 113 ms after `Escape`.** |
| Escape at an AskUserQuestion | The pane shows **`● Declined to answer Claude's questions:`** / `⎿  · <question>` / `(<label> / <label>)`, not "Interrupted". The idle box was back after 115 ms. The transcript is the same as for a Bash denial: a `tool_result` with `is_error: true`, `toolDenialKind: "user-rejected"`, `toolUseResult: "User rejected tool use"`, then the text `[Request interrupted by user for tool use]`. |
| Escape, then `send-keys -l -- "<text>"`, then `Enter` | The text became the next prompt, verbatim, as the transcript's next user string (`promptSource: "typed"`). It worked after both kinds of prompt. After the AskUserQuestion, Claude went on to run `b.sh` ("use the other script"). |
| Text typed while a permission prompt is showing | It doesn't reach the input box. 200 letters typed at a Read prompt did nothing, and after `Escape` the box was empty. |

### The idle box

| Question | Answer |
|---|---|
| The `❯` in the idle box | It is followed by a **no-break space (U+00A0)**, not a plain space: `❯ fix the typo`. The `❯ ` in the conversation above (old prompts, option lines) uses a plain space. |
| Ghost suggestion | The box can show a suggestion such as `Try "edit <filepath> to…"` or `commit this`. In a plain capture it looks exactly like typed text. Only `capture-pane -e` tells them apart: the ghost is dim (`ESC[2m`). Typing replaces the ghost at once, and the typed text shows after `❯ ` (`panes/idle-typed.txt`). When the box is emptied, the ghost comes back. |
| Is the box visible while Claude works? | Yes. The empty `❯ ` box stays between its rules, and the footer reads `⏸ manual mode on · esc to interrupt`. |
| Footer variants | The second line under the bottom rule changes with state, so `? for shortcuts` is not a reliable idle marker. Seen: `⏸ manual mode on · ? for shortcuts · ← for agents` (with `◐ medium · /effort` on the right), `ctrl+y to paste deleted text`, `esc again to clear`, `paste again to expand` and `esc to interrupt`. A tip line can follow it: `tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and re…`. |

### Clearing typed text (Ctrl+U and Escape)

| Keys | Effect |
|---|---|
| `send-keys C-u` | Deletes from the cursor to the start of the **current visual row** and never submits. With one row of text the box is empty again: the ghost returns, and the footer shows `ctrl+y to paste deleted text`. **A wrapped multi-row text needs one `C-u` per row:** 200 characters at 80 columns took three. `C-u` on an empty box is harmless. |
| One `Escape` with text in the box | Nothing is cleared. The footer shows `esc again to clear`. |
| `send-keys Escape Escape` (one call), or two `Escape` calls 0.2 s apart | Clears the whole box, including `[Pasted text #N]` placeholders, without submitting. Two `Escape` calls several seconds apart don't clear (the second only re-arms). |
| Two `Escape` on an empty idle box | Nothing visible happened (no rewind menu) in this session. Claude's documentation says a double `Escape` opens the rewind menu, so Kage treats it as possible and never sends it (design spec §5.4, ruling K8). |

### Paste placeholder

`send-keys -l` delivers its text in one burst, and Claude treats a burst as a paste.

| Question | Answer |
|---|---|
| When does the placeholder replace the text? | When one burst is **longer than 800 UTF-16 code units** (JavaScript string length). 800 ASCII characters showed as text, and 801 as `[Pasted text #1]`. 400 emoji (800 units) showed as text, and 401 (802 units, 1,604 bytes) as a placeholder. 801 `é` (801 units) gave a placeholder too. |
| Placeholder forms | `[Pasted text #N]` for one line, and `[Pasted text #N +K lines]` when the text has newlines. `N` counts up per Claude session (it reached #19 in one session) and restarts in a new one. Placeholders sit inline with typed text: `❯ short words typed first here: [Pasted text #9]`. While one shows, the footer reads `paste again to expand` (`panes/idle-pasted.txt`). |
| Chunked sends (Kage's ≤ 2,000-byte `send-keys -l` calls, sent back to back) | Each chunk over 800 units becomes its own placeholder, **but bursts that arrive close together merge**, so the number of placeholders depends on timing. 2,000 + 2,000 + 500 bytes gave `[Pasted text #14][Pasted text #15]` twice, with the 500 merged into the second; the third run gave two placeholders plus the 500 as plain text. Chunks of 400 and 500 sent 0.3 s apart showed as plain text. |
| Is the content intact? | Yes, as far as tested. A 3,907-character reply (4,207 bytes: ASCII plus 100 emoji), sent in chunks of 2,000, 1,998 and 209 bytes, showed `[Pasted text #1][Pasted text #2]`. By a script mistake, two multi-line text files followed in the same send; they became `[Pasted text #3 +21 lines][Pasted text #4 +38 lines]` and are left out of this check. In the transcript the first placeholder held chunk 1 exactly, and the second held chunks 2 and 3 joined. Nothing was lost or reordered. |
| **How the transcript records a pasted prompt** | The user record's `message.content` is still a string. Each placeholder is expanded as `\n\n<pasted_content id="<n>">\n<text>\n</pasted_content id="<n>">\n`, and all the blocks of one prompt carried the same id. Typed text keeps its place between the blocks. A reader that shows the user's prompt sees these wrappers unless it unwraps them. Kage's transcript reader unwraps them (phase 3): a pasted block shows as `> [pasted text]` plus the first line of the paste, clipped, and §5.4 of the design spec says how Kage sends text. |

## 8. Terminal and resume

Recorded on 2026-11-22 (phase 4 spike) against 2.1.330 in WSL Ubuntu 24.04 with tmux 3.4.
- Claude was started as Kage starts it (`new-window -d … -c <worktree> -- claude --settings <f> --permission-mode default`) in a worktree of a scratch repo whose root was never trusted.
- It was driven only through a tmux control-mode client, as the terminal bridge will drive it: keys as `send-keys -t %N -H <hex>`, size as `resize-window`. The control-mode facts are in `host-integration.md` §4.
- The hooks file had the same shape as `kage hooks-path`'s (all nine events), but each hook appended its event JSON to a file, because no Kage server was running to receive them.
- Four prompts were used in all: two in the terminal and two for resume.

Fixtures: `panes/real-edit-60.txt` and `panes/real-edit-160.txt` are `capture-pane -p -J` at 60×40 and 160×40 of a live Edit prompt, with the folder path and plan name replaced (as in `real-edit-80.txt`).

### Read first: where this differs from the phase 4 plan

The design spec records the resulting rules: the first-prompt fallback and resume in §5.3, resume in §5.8a and the Esc handling in the terminal in §5.6 (amended 2026-11-22, phase 4).

1. **Esc at an Edit permission prompt shows `⎿  Rejected update to notes.txt`** with the diff under it, not `Interrupted · What should Claude do instead?` (that is the Bash wording, §1). As for Bash, no hook fires after it. The R11 pane fallback ("the pane no longer shows a prompt") still covers it, but a matcher that looks for "Interrupted" would miss Edit.
2. **A start-up screen can drop a key sent the moment it first draws.** A `-H 1b 5b 42` (Down) sent as soon as the trust screen appeared was lost. The `0d` (Enter) that followed chose the default `No, exit`, Claude quit and the window closed. The same Down sent 0.8 s later worked. A sender must check that the selection moved before it sends Enter. That also applies to answering trust from the board (R25).
3. **`--resume <unknown uuid>` in a pane exits 1 with nothing readable left on screen**, and fires a `SessionEnd` (reason `other`) with a new, random `session_id` and no `SessionStart` before it.
4. Claude sets bracketed paste (`?2004h`) itself at start, and tmux has no flag to read it back, so the planned replay of `?2004h` for `claude` panes is needed (with `?1004h`, see below).

### Claude's terminal modes

| Question | Answer |
|---|---|
| Modes Claude sets at start (from `%output`, in order, repeats folded) | `?25h ?25l ?2004h ?2031h ?1004h ?1004l ?2031l ?2004l ?2004h ?2031h ?1004h ?25h ?25l ?25h`. It sets bracketed paste (`?2004h`), focus reporting (`?1004h`) and colour-scheme reports (`?2031h`) on the trust screen, resets them, and sets them again for the main screen. `?25l`/`?25h` toggle the cursor while it draws. No mouse mode, no `?1h` and no `?1049h` were seen. |
| tmux flags | `alternate_on` 0 and `keypad_cursor_flag` 0 throughout (trust screen, idle box, permission prompt, after). Arrows therefore arrive as `ESC [ A`…, which is what xterm.js sends in normal cursor mode. `cursor_flag` was 0 while the prompt showed and 1 at the idle box. |
| Fullscreen renderer (R39) | It stayed off: the offer never appeared (this install had answered it already), and `alternate_on` stayed 0. |

### Resize (`resize-window -t @W -x <cols> -y 40`)

| Question | Answer |
|---|---|
| At the idle box: 60, then 160, then 80 columns | Claude redrew cleanly every time. Both `─` rules took the new width (60, 160, 80), and the box and its ghost suggestion stayed intact. |
| At an Edit permission prompt: 60, then 160 | Clean redraws. The whole conversation above reflowed to the new width: the typed prompt took three rows at 60 columns and one at 160, and option 2 wrapped onto three rows at 60. |
| Do Kage's parsers still read it? | Yes. `parsePermissionPrompt` gives the same text and options for `real-edit-60.txt`, `real-edit-80.txt` and `real-edit-160.txt`. |

### Keys (`send-keys -H`)

| Keys | Effect |
|---|---|
| Trust screen: `1b 5b 42` (CSI Down) | Moves `❯` to `Yes, I trust this folder` (once the screen is ready, see Read first 2). `1b 4f 42` (SS3) moves it too, and `send-keys Down` likewise. A lone `1b` exits Claude. |
| Idle box: `61 62 63`, then `7f` | `❯ abc`, then `❯ ab`. |
| `09` (Tab) with `ab` in the box | No visible change. |
| `03` (Ctrl+C) with text in the box | Clears the box, and the footer says `Press Ctrl-C again to exit`; a second `03` soon after would quit Claude. |
| Bracketed paste `1b 5b 32 30 30 7e` + `first pasted line` + `0a` + `second pasted line` + `1b 5b 32 30 31 7e` | Both lines sit in the box (`❯ first pasted line` / `  second pasted line`). **Not submitted:** no `UserPromptSubmit`. |
| `1b 1b` in one write | Clears the box (the pasted lines, or a recalled prompt), as `send-keys Escape Escape` does (§7). |
| Typed text, then `0d` | Submits it: `UserPromptSubmit` carries the text. |
| `1b 5b 41` (Up) in the empty box after a prompt | Recalls the previous prompt into the box: one press, one step. |
| Edit prompt: `1b 5b 42`, `1b 5b 41`, `0d` | Down moved `❯` to option 2, Up moved it back to option 1, and Enter accepted it: `PostToolUse` Edit, and the file changed. |
| Edit prompt: `1b` (Esc) | Declined: `● Update(notes.txt)` / `⎿  Rejected update to notes.txt` and the diff, then the empty idle box. Hooks: `UserPromptSubmit`, `PreToolUse` Edit and `PermissionRequest` Edit before the key, nothing after it (13 s). The file was unchanged. |

### Resume

Session A had two prompts in worktree `<repo>/.worktrees/a` and was ended with `/exit`.

| Question | Answer |
|---|---|
| `claude --settings <f> --permission-mode default --resume <session_id>` in the same worktree | Resumes it. The screen redraws the earlier conversation (the prompts and the edit) above the idle box. |
| `SessionStart` | `source: "resume"`, the **same `session_id`** and the **same `transcript_path`**. |
| Transcript | The same file, appended: 67 lines before, 77 after one more prompt, and 83 after `/exit`. No new file was created. The next prompt's hooks carry the same `session_id`. |
| Trust screen | Not shown again (the folder was trusted when session A started). |
| `--continue` | After a second session (one prompt, `/exit`) in the same worktree, `--continue` picked that most recent session: `SessionStart` with `source: "resume"`, its `session_id` and its transcript path. Its screen showed that session's conversation. `/exit` without a prompt still appended a few records. |
| Unknown id (a valid UUID) in a tmux pane | `claude` exited within 4 s with status 1. With `remain-on-exit on`, the pane showed only tmux's `Pane is dead (status 1, …)`; Claude's message didn't stay on screen. Hooks: one `SessionEnd`, reason `other`, with a new random `session_id`, and no `SessionStart`. |
| The same without a terminal (`spawn`, stdin closed) | stderr `No conversation found with session ID: <id>`, nothing on stdout, exit 1. Without a terminal Claude behaves as `--print`, so a value that is not a UUID gives `Error: --resume requires a valid session ID or session title when used with --print. …`, exit 1. Kage only ever passes UUID-shaped ids. |
