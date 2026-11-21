# Claude Code integration: observed behaviour

Recorded on 2026-11-21 against **Claude Code 2.1.330** (WSL Ubuntu 24.04, tmux 3.4, Node 24), in a scratch git repo driven through a private tmux socket. This file holds facts only: field names, event order, timings and keystrokes. The fixtures in `packages/server/test/fixtures/` are hand-written and use invented content in the observed shapes.

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
   - Open question: does a new worktree folder (`<repo>/.worktrees/<slug>`) trigger the trust prompt again? Not tested.
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
| Turn end | `type: "system"`, `subtype: "turn_duration"` | `durationMs` |

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
| Folder trust | "Accessing workspace: <path> … Is this a project you created or one you trust?". The options are unnumbered: `❯ No, exit` (the default) and `Yes, I trust this folder`. | `Down`, then `Enter` |
| Renderer offer | "Try the new fullscreen renderer?", options `1. Yes, try it` and `2. Not now` | `2` (no Enter). Saying yes would change what `capture-pane` returns. |

The theme, security notes and renderer offer appeared once per install. The trust prompt is per folder.
