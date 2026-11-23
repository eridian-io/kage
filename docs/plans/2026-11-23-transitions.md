# Transitions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pure module decides every status transition, and archive, restore and stop each run as one operation, with no change a person can see except two bug classes closed: a restart or a reattach that pings (R141), and a listing that splits an archive (R140).

**Architecture:**
- **One door for status.** `packages/server/src/live/status.ts` holds `step(facts, observation)`: given a session's status facts and one Observation, it returns the next facts and the move, if any. It does no I/O and owns no timer. `LiveSource` keeps every session's state, every timer and every capture, turns what it learns into Observations, and passes each through one method, `#apply`, the only writer of a session's status.
- **One transition event.** `#apply` stamps each move as a Transition `{ id, from, to, cause, at }`, runs the in-process consumers (done-time, auto-archive, preview), and emits `session.transition`. The notifier consumes that event. The board gets `cause` on the existing `session.updated`. Neither the notifier nor the board store diffs snapshots any more.
- **Whole operations.** `LiveSource.archive`, `restore` and `stop` own kill → end → save → emit. `FinishActions` and `SessionControls` keep the policy: refusals, the still-idle check and the per-session lock. They hand the kill in as a `close` callback, so tmux errors stay theirs.
- **Migration by group.** A temporary `set` Observation carries the call sites not yet moved. Each group task moves its sites, adds table tests, and keeps `live-source.test.ts` (about 5,000 lines) green at every commit. Task 6 deletes the shim.

**Tech Stack:** as hardening (Node ≥ 24.2, TypeScript strict with `erasableSyntaxOnly`, Hono, Preact with signals, esbuild, vitest, Playwright 1.64.1, tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and Docker). No new dependency.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md): §5.3 (status), §5.5 (live updates and the allowed timers), §5.8 (finishing), §5.8a (restarts), §5.9 (pings and browser notifications), §7 (budgets).

Terms: [`GLOSSARY.md`](../../GLOSSARY.md). Use Session, Record, External session, Placeholder, Status, Observation, Transition, Cause, Archive, Auto-archive and Ping exactly as it defines them, in code comments, tests and docs. Background: the architecture review's candidates 1 and 2, and regressions R140 and R141 (`.superpowers/sdd/2026-11-23-hardening/progress.md`, `regression-archive.md`; git-ignored, this PC only). Backlog: B46, B78.

**Settled design decisions (binding):**
1. **Order.** Candidate 1 (the status module) first, then candidate 2 (whole operations), on branch `transitions`. main moves only on the owner's go.
2. **The status module is a pure function.** Facts and one Observation in; next facts and any move out. No I/O, no timers. LiveSource holds all session state and does all I/O.
3. **Causes.** Exactly three: live, reconcile, act. Only live transitions can ping or raise a browser notification.
4. **One transition event on the server.** LiveSource emits it; the notifier, auto-archive and done-time consume it. On the board, `cause` rides on the existing `session.updated`, and browser notifications follow the same rule. The notifier and the board store stop diffing snapshots.
5. **Migration.** Group by group, behaviour identical, the existing live-source tests green at every commit. New table tests come with each group. A timer-faking test is pruned only once a named table test covers the same rule.
6. **FinishActions keeps policy:** the 403/409 refusals, the still-idle check and the per-session lock. LiveSource offers archive, restore and stop as whole operations owning kill → end → save → emit. A tmux listing can't remove a session while its archive is in flight.
7. **Transition shape:** `{ id, from, to, cause, at }`. The notifier's ≥ 60 s rule is measured from the move into running (see Task 7 for the exact stretch). `doneAt` and the auto-archive age come from the transition into done.
8. **Timers and checks stay in LiveSource.** The turn-end check, the startup checks and the idle checks feed Observations ("the screen confirms the turn ended") instead of setting status.
9. **External sessions** use the same module, with no record facts.
10. **Auto-archive and Kage's own Escape are cause act.**
11. **Reports.** Archive: at most one act Transition to ended, then exactly one `session.removed`. Restore: one act Transition back to ended (from off the board). Stop: one act Transition to ended. A listing can't split any of them.
12. **Task 0 stabilises `e2e/finish.spec.ts:364`** (R63), test first.
13. **Budgets unchanged.** Every §7 budget, including the SSE frame counts (at most 43 per session and 1,290 in all; measured 41 and 1,218) with the extra `cause` field. No new idle timer (§5.5 lists every allowed timer).
14. **Process.** The phases' SDD process: per-task reviews, a final review, and Docker checkpoints (R137).

## Global Constraints

- **Everything in the phase 1–6 and hardening Global Constraints still applies:** strict mode plus `erasableSyntaxOnly`, no native modules, no new runtime dependency; `execFile`/`spawn` with argument arrays; invented test data under a temporary `HOME`, `XDG_*` and a fake `Run`; `describe.runIf(hasTmux)` for tmux tests; hooks stay silent; the rulings R1–R150 still hold.
- **Start point:** branch `transitions` from main `3a5e93a`; this plan is committed on top of `d489d23`.
- **Behaviour identical through Task 6.** Tasks 1–6 change no event a subscriber sees except the new `session.transition`. Every existing test in `live-source.test.ts`, `finish/*.test.ts`, `notify/*.test.ts`, `events.test.ts` and `packages/web/src/*.test.ts` passes unchanged at each commit, except a test a task names and replaces.
- **Pruning (decision 5):** a `live-source.test.ts` test may go only when a named `status.test.ts` row covers the same rule. The task report lists each pruned test beside its covering row. Pruning is optional.
- **Every budget of spec §7 holds, measured by its rules.** First load at most 27,338 B gzipped; idle server under 1% CPU, under 80 MB RSS and 32 MB anonymous; `kage hook` at most 60 ms; hook to screen under 150 ms; SSE under load at most 43 `session.updated` frames per session and 1,290 in all. `session.transition` never goes on a stream.
- **No new timer** (§5.5). The status module has none; the in-flight guard of Task 9 is a set, not a timer.
- **Kage never writes Claude's configuration (R25).**
- **Tests never contact an external host (R85).** The vitest fetch guard stays; ntfy is always a fake on `127.0.0.1`.
- **The owner's machine (R106, F17):** no task or check changes linger, runs `wsl --terminate` or `wsl --shutdown`, or touches the default tmux server. One Docker run at a time.
- **Releases are the owner's step (R107):** no tag, no GitHub Release, no npm publish, no push to `main`.
- **Per task (R137):** Windows `corepack pnpm lint`, `corepack pnpm typecheck`, the touched unit tests and the chromium e2e, then the unit tests in a fresh WSL clone. `pnpm test:linux` runs only at the checkpoints, after a host free-memory check of at least 5,000 MB (wait up to 20 minutes, else report).
- **Copy:** this plan adds no sentence a person reads. `spec-copy.test.ts` must stay green. A task that finds it needs a sentence stops and asks the controller.
- **Spec amendments** are marked "(amended <date>, transitions)", in the section they change, in the task that changes the behaviour (Task 10 sweeps what is left).

## Review Focus

1. **A listing lands while an archive kills and saves** (the watcher's `windows-changed`, or the 300 ms recheck; R140). A person expects the row to leave with its toast, once, and the session never to blink ended from the listing first.
   Tests: Task 9 (`it('a listing during the kill and the save neither ends nor drops the session: one act transition, then one session.removed')`).
2. **Kage restarts while a session is done and its pane redraws** (R141). No running blink, no done ping, `doneAt` kept.
   Tests: Task 5 (`it('attached: a record that was done stays done, whatever the pane drew (R141)')`), Task 7 (`it('a restart with a done session whose pane drew pings nothing (R141, through transitions)')`).
3. **Two transitions before one frame, or a transition whose frame is never sent** (archived, or back to the same status). The board must not see a `cause` on a later frame that carries no transition, or it raises a notification for nothing.
   Tests: Task 8 (`it('a frame carries cause only when its status or status time changed since the last frame')`).
4. **A reply at a prompt (Kage's own Escape), then an idle pane.** Done with cause act: no done ping, no browser notification. A real question after the reply is still live and pings.
   Tests: Task 3 (`it("Kage's own Escape, then an idle pane: done with cause act")`), Task 7 (`it('an act done never pings; a live needs-you right after it does')`).
5. **The tmux server goes down and comes back while a session waits on a question.** The reattach is reconcile: no second ping, no notification.
   Tests: Task 1 (`it("an attach at start or after the watcher's up catches up; one while Kage watches doesn't")`), Task 7 (`it('tmux down and up while a session waits: no second ping')`).

---

## File structure

```
packages/shared/src/types.ts           Task 1: Cause, Transition; Task 8: session.updated.cause
packages/server/src/live/status.ts     Tasks 1–6: StatusFacts, Observation, step, causeOf, helpers (new)
packages/server/src/live/status.test.ts  Tasks 1–6: the table tests (new)
packages/server/src/hooks/status.ts    unchanged: step calls nextStatus
packages/server/src/source.ts          Task 1: session.transition; Task 8: session.updated.cause
packages/server/src/live-source.ts     Task 0: reconcile; Tasks 1–6: #apply and the groups; Task 8: cause on frames; Task 9: archive, restore, stop
packages/server/src/events.ts          Task 1: drops session.transition
packages/server/src/notify/notifier.ts Task 7: consumes transitions; listen/seeded go
packages/server/src/serve.ts           Tasks 7, 9: wiring
packages/server/src/finish/actions.ts  Task 9: policy only
packages/server/src/control/actions.ts Task 9: stop through source.stop
packages/web/src/store.ts, notify.ts, link.ts, lazy.tsx   Task 8: onApplied(e), the cause rule
e2e/finish.spec.ts, e2e/fake-claude.mjs  Task 0
docs/…                                 Tasks 0, 7, 9, 10
```

---

### Task 0: A failed resume's line on Ubuntu 26.04 (R63, finish.spec.ts:364)

On GitHub's ubuntu-latest (Ubuntu 26.04, tmux 3.6a, uutils coreutils) `a resume Claude can't find (R63)…` fails on every main push: the last line is the old transcript, not "Claude couldn't find this conversation, so the session wasn't resumed." It passed once on a workflow_dispatch run, so it is a race or an environment difference, not a constant break.

**Leading hypothesis (B46's last sentence).** The fake's `SessionEnd` arrives before any listing shows the new window, so it waits in `#unknown`. The claim's own listing still shows the window and attaches it; the re-list that `#resolveUnknown` asked for runs next, finds the window gone, and `#detach`es the session (ended, no line). The queued hook then finds no pane and is set aside, never applied. The `lost` path of `#reconcile` already applies a dead claim's queued hooks; `#detach` doesn't. **Second hypothesis:** the fake on uutils (like `3a5e93a`): `#!/usr/bin/env node`, `pane_current_command` naming the multicall binary, or the transcript removal racing the fake's `existsSync`.

**Files:**
- Modify: `packages/server/src/live-source.ts` (`#reconcile`), or `e2e/fake-claude.mjs` if the second hypothesis holds
- Modify: `docs/backlog.md` (B46's last sentence)
- Test: `packages/server/src/live-source.test.ts`, `e2e/finish.spec.ts`

**Interfaces:**
- Produces (leading hypothesis): `#takeQueued(st: Live, paneId: string): void` in `live-source.ts`: applies and removes the `#unknown` hooks of that pane, in order, through `#applyHook`. `#reconcile` calls it for a record session it is about to `#detach`, and the `lost` path uses it too.

- [ ] **Step 1: Diagnose.** In WSL, run `corepack pnpm exec playwright test e2e/finish.spec.ts --project=live --workers=1 --repeat-each=20 -g "R63"` while a parallel `corepack pnpm test` loads the CPU (install nothing for it), with a temporary (uncommitted) log line in `#onHook`, `#reconcile` and `#detach` naming the pane and the listing number. If an `ubuntu:26.04` image is already present, run the spec there too; pulling one is the controller's call. Record which order fails.
- [ ] **Step 2: Write the failing test** for the order Step 1 found. For the leading hypothesis, in `live-source.test.ts` under `describe('LiveSource: resume fix round 2 (a window that dies unseen)')`:
  - `it("a failed resume whose SessionEnd waits on a listing that still shows the window, gone by the next, ends with the R63 line (Task 0)")`: `resumed('k1', 's-old')`, `claim`, a `SessionEnd` with `sessionId: 's-new'` from the claimed pane while `tmux.windows` still lists it, then the window removed before the queued re-list. Assert: `lineEvents('k1').at(-1)?.lines.at(-1)?.text === RESUME_FAILED`, the last update's status is `'ended'`, the record's `sessionId` is still `'s-old'`, and the log holds one "wasn't resumed" line.
- [ ] **Step 3: Run it.** `corepack pnpm vitest run packages/server/src/live-source.test.ts -t "Task 0"`. Expected: FAIL (no RESUME_FAILED line).
- [ ] **Step 4: Fix.** For the leading hypothesis, `#takeQueued` as above. For the second, change only the fake (test-only), as `3a5e93a` did.
- [ ] **Step 5: Run** the unit test, `live-source.test.ts` whole, and Step 1's repeat run in WSL. Expected: PASS, 20 of 20.
- [ ] **Step 6: Commit.** `fix(server): a failed resume's SessionEnd queued behind a listing still ends with its line (R63, Ubuntu 26.04)` (or `test(e2e): …` for the fake). Pushing the branch and a workflow_dispatch run are the controller's steps.

---

### Task 1: The status module and one door

Adds the module with a temporary `set` Observation, routes every `#setStatus` call through `#apply`, and moves `#setStatus`'s side effects and `#trackDone` into `#apply` and its consumers. Behaviour is identical; the only new event is `session.transition`.

**Files:**
- Create: `packages/server/src/live/status.ts`, `packages/server/src/live/status.test.ts`
- Modify: `packages/shared/src/types.ts`, `packages/server/src/source.ts`, `live-source.ts`, `events.ts`
- Test: `live/status.test.ts`, `live-source.test.ts`, `events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/types.ts
  export type Cause = 'live' | 'reconcile' | 'act';
  /** `from` is null when the session wasn't on the board: a launch, a first listing, the start, a restore. `at` is epoch ms. */
  export interface Transition { id: string; from: SessionStatus | null; to: SessionStatus; cause: Cause; at: number }

  // source.ts: SourceEvent gains
  | { type: 'session.transition'; transition: Transition }

  // live/status.ts
  export interface RecordFacts {
    firstPromptPending: boolean;                       // P3F1
    resuming: { sessionId: string | null } | null;     // B7, R63
  }
  export interface StatusFacts {
    status: SessionStatus | null;                      // null: not on the board yet
    mode: 'activity' | 'hooks';
    startup: boolean;                                  // the question is a startup screen (R9)
    shellEnded: boolean;
    replying: boolean;                                 // inside Kage's reply window
    catchingUp: boolean;                               // an attach at start or after the watcher's up
    pending: ReadonlySet<string>;                      // R12, M11
    toolsDone: ReadonlySet<string>;
    record: RecordFacts | null;                        // null for an external session (decision 9)
  }
  export type Move = Pick<Transition, 'from' | 'to' | 'cause'>;
  export interface StatusStep { facts: StatusFacts; move: Move | null }
  export type Observation =
    | { kind: 'set'; to: SessionStatus; cause: Cause }   // migration shim; Task 6 deletes it
    | { kind: 'loaded' };                                 // the start places a windowless session
  export function causeOf(facts: StatusFacts, obs: Observation): Cause;
  export function step(facts: StatusFacts, obs: Observation): StatusStep;   // returns new objects; never mutates
  ```
- **`causeOf`**, the whole rule (later tasks add kinds to these lines, not new lines): act kinds (Task 6) are `act`; `turn-ended` is its `armedBy` (Task 3); `window-gone` with `serverDown` (Task 5) and `loaded` are `reconcile`; `set` is its own `cause`; every other kind is `reconcile` while `catchingUp`, else `live`.
- **A move** exists only when the next status differs from `facts.status` (null counts as different). Any move resets `shellEnded` to false and, when `to` isn't needs-you, `startup` to false, as `#setStatus` did.
- **LiveSource:**
  - `Live` gains `placed: boolean` (false from `#fresh`) and `catchingUp: boolean`.
  - `#factsOf(st: Live): StatusFacts` (status is `st.placed ? st.status : null`) and `#apply(st: Live, obs: Observation): Transition | null`, the only writer of `st.status`. On a move it does what `#setStatus` did (statusSince = `at`, gen, `tail.setIdle`, the ended and leaving-needs-you clean-ups), writes the facts back, and calls `#onTransition(st, t)`. When `step` clears `record.firstPromptPending`, `#apply` runs `#endFirstPromptWait`'s side effects (the timer, the "Starting Claude…" line).
  - `#onTransition(st: Live, t: Transition): void`: done-time (a record's `doneAt = t.at` on a move into done or ended while null, null again on running or needs-you, then `#saveSoon`), `preview.statusChanged` and auto-archive (`touch` into done or ended; `sync` when leaving done, ended or null) while ready, then `#emit({ type: 'session.transition', transition: t })`.
  - `#setStatus(st, status, cause?)` stays only as the shim: `#apply(st, { kind: 'set', to: status, cause: cause ?? (st.catchingUp ? 'reconcile' : 'live') })`. The act sites pass `'act'` (adopt, `resumed`, `resumeAborted`, `markAnswered`, `markReplied`, `markStopped`, the restore in `setFlags`). `adopt`'s direct `st.status = 'running'` goes through it too.
  - `start()` replaces its `#trackDone` loop with `#apply(st, { kind: 'loaded' })` for each session still unplaced after the reconcile. The restore in `setFlags` replaces `#trackDone(fresh)` with the shim (null → ended, act).
  - **Catching up:** `#attach` sets `st.catchingUp = !this.#ready || this.#resyncing` at its start and clears it on every way out. `#resyncing` is true from the watcher's `up` until the re-list it starts has finished.
- `EventHub` drops `session.transition`: it never reaches a stream.

- [ ] **Step 1: Write the failing tests.**
  - `status.test.ts`: `it('set moves to its status with its cause, and never when the status is already that')`; `it('step never mutates the facts it is given')` (deep-frozen input); `it('loaded places an unplaced session as ended with cause reconcile; a placed one moves nothing')`; `it('causeOf: set keeps its cause, loaded is reconcile, other kinds are reconcile while catching up and live otherwise')`; `it('any move clears shellEnded, and startup unless it moves into needs-you')`.
  - `live-source.test.ts`, a new `describe('LiveSource: transitions (Task 1)')`: `it('every status change emits one session.transition with from, to, cause and at')`; `it('the start places each session once: a windowless record goes null → ended, reconcile')`; `it('doneAt comes from the transition into done or ended and clears on running or needs-you')`; `it("an attach at start or after the watcher's up catches up; one while Kage watches doesn't")`.
  - `events.test.ts`: `it('session.transition never goes out on a stream')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/live packages/server/src/live-source.test.ts packages/server/src/events.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the same command, then `corepack pnpm vitest run packages/server packages/web`. Expected: PASS, with every existing test unchanged.
- [ ] **Step 5: Commit.** `refactor(server): one door for status: a pure status module, #apply and a transition event`

---

### Task 2: Group 1, hooks

Moves `#applyHook`'s status rule, the R12 count, the tool tracking (M11) and the R63 check into the module.

**Files:**
- Modify: `packages/server/src/live/status.ts`, `live-source.ts` (`#applyHook`, `#resumeFailed`, `#trackTools`, `#clearPending`)
- Test: `live/status.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: `step`, `causeOf`, `StatusFacts`, `#apply` (Task 1).
- Produces:
  ```ts
  export const UNNAMED_TOOL = '';                                     // moved from live-source.ts
  Observation |= { kind: 'hook'; event: HookEvent } | { kind: 'resume-failed' };
  /** R63: resuming with an id, and a SessionEnd naming another. */
  export function resumeFails(facts: StatusFacts, e: HookEvent): boolean;
  /** P3F1: a non-compact SessionStart while the record waits for its first prompt, not ended. */
  export function holdsFirstPrompt(facts: StatusFacts, e: HookEvent): boolean;
  ```
- **`hook`:** any hook clears `record.resuming`, sets mode hooks and `startup` false, and tracks tools as `#trackTools` did. UserPromptSubmit, PreToolUse and SessionEnd clear `record.firstPromptPending`. A permission Notification with no pending tool moves nothing. Otherwise the next status is `nextStatus(status, event)`, or running when `holdsFirstPrompt`. Cause live.
- **`resume-failed`:** ended, mode hooks, pending cleared, first-prompt wait over.
- LiveSource keeps the question, the prompt capture, the "Starting Claude…" line and the `firstPrompt` timer, the tail, the re-list and the preview and auto-archive touches of `#applyHook`. It calls `resumeFails` before `step` and, when true, feeds `resume-failed` and adds the RESUME_FAILED line as now. `st.pending` and `st.toolsDone` are written only from `step`'s facts.

- [ ] **Step 1: Write the failing tests** in `status.test.ts`, `describe('step: hooks (group 1)')`:
  - `it.each` over the nine hook events × the four statuses and null: `it('%s from %s moves as nextStatus says, with cause live')`;
  - `it('a permission Notification counts only while a tool is pending (R12)')`;
  - `it('a PostToolUse before its PreToolUse leaves that PreToolUse adding nothing (M11)')`; `it('a PermissionRequest counts as a pending tool when none is')`; `it('Stop, SessionEnd and a new session clear the pending tools; a compact SessionStart keeps them')`;
  - `it("a launch's SessionStart keeps it running until its first prompt (P3F1)")`; `it('UserPromptSubmit, PreToolUse and SessionEnd end the first-prompt wait; any hook ends the resume')`;
  - `it('resumeFails: a SessionEnd naming another id while resuming; --continue never fails (R63)')`; `it('resume-failed: ended, hooks mode, nothing pending, the wait over')`;
  - `it('an external session takes every hook with no record facts')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/live`. Expected: FAIL.
- [ ] **Step 3: Implement.** `#applyHook` and `#resumeFailed` call `#apply` with `hook` and `resume-failed`; `#trackTools` and the pending writes go.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live packages/server/src/live-source.test.ts packages/server/src/hooks`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(server): hooks reach status through the status module (group 1)`

---

### Task 3: Group 2, the transcript

**Files:**
- Modify: `packages/server/src/live/status.ts`, `live-source.ts` (`#ensureTail`'s interrupt listener, `#onTailChange`, `#armTurnEndCheck`, `#turnEndCheck`, `#rebuildFromTail`'s arm)
- Test: `live/status.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2's `UNNAMED_TOOL`.
- Produces:
  ```ts
  Observation |=
    | { kind: 'transcript-question' }               // a new open question in the transcript
    | { kind: 'transcript-interrupt' }              // "[Request interrupted…" or a user-rejected tool result (R11)
    | { kind: 'turn-ended'; armedBy: Cause };       // the turn-end check's capture confirms it (I2)
  // live-source.ts
  #armTurnEndCheck(st: Live, armedBy: Cause): void;
  ```
- **Rules:** a question makes a session that isn't ended needs-you. An interrupt clears the pending tools and makes a session that isn't ended done; inside Kage's reply window it moves nothing (LiveSource arms the check, B26). `turn-ended` makes a running hooks-mode session done and clears the pending tools; anything else moves nothing.
- **Who arms with what:** the transcript's turn end arms with `live` (`reconcile` while catching up); an interrupt inside the reply window with `act` (decision 10); `#rebuildFromTail` with `reconcile`. The arming cause is kept with the timer and handed to `turn-ended`.

- [ ] **Step 1: Write the failing tests.**
  - `status.test.ts`, `describe('step: the transcript (group 2)')`: `it('an open question makes a session needs-you unless it is ended')`; `it("an interrupt is done unless ended, and inside Kage's reply window moves nothing (R11, B26)")`; `it.each(['live', 'act', 'reconcile'])('a confirmed turn end is done with the cause that armed it: %s')`; `it('a turn end confirmed on a session no longer running, or in activity mode, moves nothing')`.
  - `live-source.test.ts`: `it("Kage's own Escape, then an idle pane: done with cause act")`; `it('a lost Stop confirmed by the pane is done with cause live')`; `it('a restart within 5 s of a lost Stop settles to done with cause reconcile')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live packages/server/src/live-source.test.ts packages/server/src/transcript`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(server): transcript questions, interrupts and turn ends reach status through the module (group 2)`

---

### Task 4: Group 3, the screen and activity

The checks keep their timers and captures; each feeds what it saw.

**Files:**
- Modify: `packages/server/src/live/status.ts`, `live-source.ts` (`#onActivity`, `#scheduleIdle`, `#checkAfterAnswer`, `#firstPromptFallback`, `#processCapture`)
- Test: `live/status.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  Observation |=
    | { kind: 'activity' }                                    // pane output
    | { kind: 'idle' }                                        // the 5 s rule found the pane quiet and not still starting
    | { kind: 'answer-denied' }                               // the check after an answer shows the denial line
    | { kind: 'first-prompt-check'; screen: 'startup' | 'prompt' | 'busy' | 'idle' | 'failed' }   // P3F1 fallback, R57, R58
    | { kind: 'startup-shown' }                               // R9
    | { kind: 'startup-gone'; active: boolean }               // a startup screen was answered
    | { kind: 'prompt-shown' }                                // a prompt on screen at start, or in activity mode
    | { kind: 'prompt-gone'; denial: boolean };               // R11's pane fallback
  ```
- **Rules:** `activity` makes an activity-mode session running unless it shows a startup screen. `idle` makes an activity-mode running session done and clears `record.resuming` (R104). `answer-denied` makes a running session done and clears the pending tools. `first-prompt-check` always ends the first-prompt wait, and moves only a running session: startup → needs-you with `startup`; prompt → needs-you with `UNNAMED_TOOL` pending; busy → no move; idle or failed → done. `startup-shown` → needs-you with `startup`. `startup-gone` clears `startup` and goes running when `active`, else done. `prompt-shown` → needs-you with `UNNAMED_TOOL` pending. `prompt-gone` moves a needs-you session outside the reply window: done with the pending tools cleared when `denial`, else running. All are live, or reconcile while catching up (the attach's first capture).
- LiveSource still parses the pane (`parseStartupScreen`, `parsePermissionPrompt`, `showsDenial…`, `BUSY_FOOTER`) and keeps the question and prompt kind.

- [ ] **Step 1: Write the failing tests** in `status.test.ts`, `describe('step: the screen and activity (group 3)')`: one `it` per kind, named by its rule, for example `it('first-prompt-check: a busy footer keeps it running; a failed capture is done (R58)')` and `it('prompt-gone inside the reply window moves nothing')`; plus `it('an attach capture that shows a prompt is needs-you with cause reconcile')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live packages/server/src/live-source.test.ts packages/server/src/pane`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(server): screen checks and activity feed observations to the status module (group 3)`

---

### Task 5: Group 4, windows and restarts

**Files:**
- Modify: `packages/server/src/live/status.ts`, `live-source.ts` (`#attach`, `#rebuildFromTail`, `#endInWindow`, `#detach`, the `lost` path of `#reconcile`, the watcher's `down`)
- Modify: `docs/backlog.md` (B78's second bullet done)
- Test: `live/status.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  Observation |=
    | { kind: 'attached'; active: boolean; wasDone: boolean }                                  // §5.8a; R141
    | { kind: 'rebuilt'; question: boolean; turn: boolean; active: boolean; wasDone: boolean } // from the transcript at an attach
    | { kind: 'claude-exited' }                                                                 // R17: the pane is back at a shell
    | { kind: 'window-gone'; serverDown: boolean };                                             // the window is gone, or tmux is
  ```
- **Rules:** `attached` sets mode activity, clears the pending tools, and goes done when `wasDone`, else running when `active`, else done. `rebuilt` sets mode hooks and goes needs-you for a question, running for a turn in progress, else as `attached`. `claude-exited` ends it with `shellEnded` true, mode hooks, nothing pending. `window-gone` ends it with mode hooks and nothing pending (the mode of a session with no pane is never read; an attach resets it). Causes per `causeOf`.
- `#endInWindow`, `#detach` and the `lost` path keep their timers, tails and question clean-ups; only the status goes through `#apply`.

- [ ] **Step 1: Write the failing tests.**
  - `status.test.ts`, `describe('step: windows and restarts (group 4)')`: `it('attached: a record that was done stays done, whatever the pane drew (R141)')`; `it('attached: running when the pane drew in the last 5 s, else done')`; `it('rebuilt: a question is needs-you and a turn in progress is running, also for a session that was done (B78)')`; `it('claude-exited: ended, shellEnded, hooks mode, nothing pending')`; `it('window-gone: ended, live; with the server down, reconcile')`.
  - `live-source.test.ts`: `it('watcher down then up with a session on a question: every reattach transition is reconcile')`; `it('a window first listed while Kage watches attaches with cause live')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live packages/server/src/live-source.test.ts packages/server/src/tmux`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(server): attaches, restarts and ends reach status through the module (group 4)`

---

### Task 6: Group 5, Kage's acts; the shim goes

**Files:**
- Modify: `packages/server/src/live/status.ts`, `live-source.ts` (`adopt`, `resumed`, `resumeAborted`, `markAnswered`, `markReplied`, `markStopped`, the restore in `setFlags`)
- Test: `live/status.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  Observation |=
    | { kind: 'launched' }                              // adopt: null → running, first-prompt wait on
    | { kind: 'resumed'; sessionId: string | null }     // ended → running, wait on, resuming, nothing pending
    | { kind: 'resume-aborted' }                        // R101: still resuming → ended
    | { kind: 'answered' }                              // needs-you → running
    | { kind: 'replied' }                               // not ended → running, nothing pending
    | { kind: 'stopped' }                               // not ended → ended, hooks mode, nothing pending
    | { kind: 'restored' };                             // null → ended
  // removed: Observation 'set', #setStatus
  ```
- All are cause `act`. Each moves nothing outside the status it names (`resumed` only from ended with a record; `answered` only from needs-you).
- **Done means:** `rg "#setStatus|kind: 'set'" packages/server/src` finds nothing, and `rg "st\.status = |\.status = " packages/server/src/live-source.ts` finds only `#apply`.

- [ ] **Step 1: Write the failing tests** in `status.test.ts`, `describe('step: acts (group 5)')`: one `it` per kind, named by its rule; `it('every act is cause act')`; `it('resumed moves only an ended record; answered only needs-you')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, then delete the shim and `#setStatus`.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server packages/web` and the two `rg` checks. Expected: PASS; no matches.
- [ ] **Step 5: Commit.** `refactor(server): Kage's acts reach status through the module; the migration shim goes (group 5)`

**Checkpoint 1 (R137):** after Task 6, the controller runs `corepack pnpm test:linux` once (host memory check first), live and perf projects one at a time. Every test passes unchanged and every budget holds: behaviour is identical so far.

---

### Task 7: The notifier consumes transitions

The notifier stops tracking `session.updated` snapshots. Pings follow causes, which closes R141's class for good.

**Files:**
- Modify: `packages/server/src/notify/notifier.ts`, `serve.ts`, `live-source.ts` (`onLoaded` goes)
- Modify: spec §5.9 (When, At start)
- Test: `notify/notifier.test.ts`, `live-source.test.ts`

**Interfaces:**
- Consumes: `session.transition` (Task 1), `SessionSource.get`.
- Produces:
  ```ts
  constructor(d: { source: Pick<SessionSource, 'get' | 'subscribe'>; send; link; hostName; options; clock?; log });
  start(): void;      // subscribes; listen() and seeded() go
  stop(): void;
  // LiveSourceDeps.onLoaded goes; serve calls notifier.start() before source.start()
  ```
- **Tracking:** per session id, the status, the episode (bumped by each transition), the hold, the last ping time and `activeFrom`. `session.removed` cancels the hold and forgets the session.
- **Needs you:** a transition into needs-you with cause live holds and pings as now (3 s hold, 120 s quiet period with the R94 deferral, 10 in 10 minutes).
- **Done:** a transition into done with cause live, from running, with `onDone`, for a record session, after `activeFrom` at least `doneAfterMs` (60 s) ago, holds and pings as now.
- **The stretch (`activeFrom`):** set by a live or act transition from null, done or ended into running or needs-you; kept while the session moves between running and needs-you; cleared on done or ended. A reconcile transition never starts a stretch, so a restart or a reattach can't lead to a done ping by itself. (Counting act starts keeps the done ping after a reply sent from the board: Kage's own move into running is act, and the UserPromptSubmit that follows moves nothing.)
- **Ping text:** read from `source.get(id)` when the hold ends (project, task, external); a session that is gone sends nothing.

- [ ] **Step 1: Write the failing tests.** Rewrite `notifier.test.ts`'s feeder to emit `session.transition` with a fake `get`; keep every existing rule's test, renamed where the old one fed snapshots. New:
  - `it('a live move into needs-you pings after the hold; a reconcile or act one never does')`;
  - `it('an act done never pings; a live needs-you right after it does')`;
  - `it('a live done from running after 60 s of a stretch pings; a reconcile done never does')`;
  - `it('the stretch starts at a live or act move out of done or ended; a reconcile move starts none (R141)')`; `it("moving between running and needs-you doesn't restart the stretch")`;
  - `it("the ping text comes from the session when the hold ends; an external session's is the fixed text")`;
  - `live-source.test.ts`: replace the R141 test's `onLoaded` and `seeded()` with `start()`: `it('a restart with a done session whose pane drew pings nothing (R141, through transitions)')`; `it('sessions already waiting at start ping nothing; a hook that arrived while they loaded does')`; `it('tmux down and up while a session waits: no second ping')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/notify packages/server/src/live-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and amend §5.9: only live transitions ping; the stretch rule; "At start" says reconcile transitions never ping, in place of seeding.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): pings follow transitions and their cause; the notifier stops diffing snapshots`

---

### Task 8: The board takes `cause`

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/server/src/source.ts`, `live-source.ts` (`#emitNow`), `packages/web/src/store.ts`, `notify.ts`, `link.ts`, `lazy.tsx`
- Modify: spec §5.5 (session.updated), §5.9 (The board)
- Test: `live-source.test.ts`, `events.test.ts`, `packages/web/src/notify.test.ts`, `store.test.ts`

**Interfaces:**
- Consumes: `Transition`, `Cause` (Task 1).
- Produces:
  ```ts
  // shared ServerEvent and server SourceEvent
  | { type: 'session.updated'; session: Session; cause?: Cause }
  // live-source.ts: Live gains lastCause: Cause (set by #apply on each move)
  // web store.ts
  type AppliedHook = (e: ServerEvent) => void;      // the replaced status (`was`) goes
  ```
- **The frame rule:** `#emitNow` adds `cause: st.lastCause` only when the frame's status or `statusSince` differs from the last frame sent for that session (or it is the session's first frame). `statusSince` changes only in `#apply`, so a frame with a `cause` always carries a transition, and a suppressed frame leaves nothing behind. `Session` itself gains no field, so `sameSession` and `viewChange` are unchanged, and a transition frame already goes at once (`viewChange` 'other'): the frame count doesn't change.
- **Browser notifications:** `notify.ts` notifies on `session.updated` with `cause === 'live'` and status needs-you. A snapshot, a frame without a `cause` and a reconcile or act frame never notify. The demo sends no `cause`.

- [ ] **Step 1: Write the failing tests.**
  - `live-source.test.ts`: `it('a frame carries cause only when its status or status time changed since the last frame')`; `it('a transition whose frame was suppressed leaves no cause on the next frame')`.
  - `events.test.ts`: `it('session.updated keeps its cause on the wire')`.
  - `notify.test.ts`: `it('a live session.updated into needs-you notifies; reconcile, act and frames without a cause do not')`; `it('a snapshot with a session already waiting notifies nothing')`.
  - `store.test.ts`: `it('onApplied hands each applied event, and only the event')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server packages/web`, `corepack pnpm build`, and in WSL `e2e/notify-browser.spec.ts` and `e2e/perf.spec.ts`'s SSE test. Expected: PASS; first load under 27,338 B; at most 43 frames per session and 1,290 in all.
- [ ] **Step 5: Commit.** `feat: session.updated carries its transition's cause; browser notifications follow live transitions only`

---

### Task 9: Archive, restore and stop as whole operations

`setFlags` and `markStopped` go. R140's patch (`now || st`) is no longer needed: no listing can drop the session mid-archive.

**Files:**
- Modify: `packages/server/src/live-source.ts`, `finish/actions.ts`, `control/actions.ts`, `serve.ts`
- Modify: spec §5.8 (Stop, Archive), §5.8a if it names `markStopped`
- Test: `live-source.test.ts`, `finish/actions.test.ts`, `finish/actions.int.test.ts`, `control/actions.test.ts`

**Interfaces:**
- Consumes: `stopped`, `restored` (Task 6); `#apply`.
- Produces:
  ```ts
  // live-source.ts
  /** Kills the window: true when killed, false when it was gone already; a throw aborts with nothing changed. */
  export type Close = () => Promise<boolean>;
  setPinned(id: string, pinned: boolean): Promise<void>;     // pin and unpinnedAt, as setFlags did
  archive(id: string, close: Close | null): Promise<void>;
  restore(id: string): Promise<void>;
  stop(id: string, close: Close): Promise<void>;
  // removed: setFlags, markStopped
  // finish/actions.ts
  export type FinishSource = Pick<LiveSource, 'finishTarget' | 'setPinned' | 'archive' | 'restore' | 'stop' | 'forget'>;
  // control/actions.ts: its source Pick loses markStopped and gains stop
  ```
- **In flight:** `#finishing: Set<string>` holds the id from the operation's first line to its last. `#reconcile` leaves such a session alone (no attach, detach, drop or remove). Hooks from its pane wait in a per-session list and are applied after the operation (a `SessionEnd` then moves nothing). The operation ends with `#recheckSoon(STOP_RECHECK_MS)`, so a listing catches up after it.
- **Archive:** calls `close` first, with no await before it (R70). Then `stopped` (one act Transition, unless already ended), with `markStopped`'s timers, mode and tail clean-ups; `archived` and `archivedAt` set; `await` the save (a failure restores the flags and rethrows; the session stays, ended if it was killed, and no `session.removed` goes); then exactly one `session.removed`, the preview forgotten, the session dropped (I4), `archive {count}` and `auto.sync()`.
- **Restore:** the flags (`archived` false, `archivedAt` null, `restoredAt` now), the save, a fresh session with `restored` (null → ended, act), its frame, `archive {count}`, then the deferred transcript read, as now.
- **Stop:** `close`, then `stopped`. SessionControls passes a `close` that throws its 409 ("This session has already ended.") when `killOwnedWindow` answers false. Delete's kill goes through `stop` too.
- **FinishActions.archive** keeps, in order: 404 and the lock, 403, already-in-that-state, the 409 for running or needs you, `#stillIdle`, the R70 terminal skip for `auto`, then `source.archive(id, t.windowId ? () => this.#close(t.windowId, kageId) : null)`. Restore is `source.restore(id)`. Auto-archive keeps calling `finish.archive(id, true, { auto: true })`, so it is act through `stopped`.

- [ ] **Step 1: Write the failing tests.**
  - `live-source.test.ts`, `describe('LiveSource: whole operations (Task 9)')`:
    - `it('a listing during the kill and the save neither ends nor drops the session: one act transition, then one session.removed')` (FakeStore `during` runs a `windows-changed` with the window gone, and another during `close`);
    - `it('archive of an ended session sends no transition and one session.removed')`;
    - `it('a SessionEnd from the killed Claude waits for the archive and moves nothing')`;
    - `it('a close that throws changes nothing, sends nothing, and asks for a listing')`;
    - `it('a failed save restores the flags and sends no session.removed; the killed session reads ended')`;
    - `it('restore sends one act transition null → ended, its frame, then archive {count}')`;
    - `it('stop sends one act transition to ended; a listing during it changes nothing until it ends')`.
  - `finish/actions.test.ts`: `it('archive hands the kill to the source as close, after the still-idle check and the R70 skip')`; `it('restore calls source.restore')`; `it('delete stops through source.stop before its recount')`.
  - `control/actions.test.ts`: `it('stop hands killOwnedWindow to source.stop; a window already gone is 409 with nothing changed')`.
  - The R140 test stays and passes.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, and amend §5.8.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server`, then in WSL `e2e/finish.spec.ts` (live). Expected: PASS, including finish.spec.ts:305 (the archive toast).
- [ ] **Step 5: Commit.** `refactor(server): archive, restore and stop are whole operations in LiveSource; FinishActions keeps the policy (R140)`

**Checkpoint 2 (R137):** after Task 9 and before the final review, `corepack pnpm test:linux` once, as checkpoint 1, with the budgets table in the ledger.

---

### Task 10: Docs

**Files:**
- `docs/specs/2026-11-21-kage-design.md`, whatever Tasks 7–9 left, each marked "(amended <date>, transitions)":
  - §5.3: a short "Transitions" paragraph: Observations go through one pure status module; each move is a Transition with a cause (live, reconcile, act); timers and checks feed Observations; external sessions have no record facts;
  - §5.5: `session.updated` carries `cause` with a transition; `session.transition` stays on the server; no new timer;
  - §5.8: archive, restore and stop as whole operations, the in-flight rule and their reports; §5.8a: an attach at start or after the watcher's `up` is reconcile;
  - §5.9: only live transitions ping or notify, and the stretch rule (if Task 7 left any);
  - §9: an item 8, "Transitions (after hardening)", with this plan's link, pointing at the Transitions check.
- `docs/rulings.md`: a section `## 2026-11-23-transitions` with this build's ledger rulings, copied in order, as for hardening.
- `docs/backlog.md`: B46's unmatched `SessionEnd` (Task 0), B78's two tests (Task 5); add anything the reviews parked.
- `docs/plans/README.md`: a row "Transitions: one module for status transitions, then archive as one operation", linking this plan, `Built, not merged (branch transitions)`.
- `GLOSSARY.md`: unchanged unless a review finds a term used against it.

- [ ] **Step 1: Update the docs** as listed, short and calm.
- [ ] **Step 2: Run** `corepack pnpm lint` and `corepack pnpm vitest run packages/web/src/spec-copy.test.ts`. Expected: clean, PASS.
- [ ] **Step 3: Commit.** `docs: transitions as built — one status module, causes, whole operations`

---

**Transitions check (every status change through one door, every budget held, nothing of the owner's touched):**

1. **Windows:** `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test --maxWorkers=4`, `corepack pnpm build`. Rerun a file that times out under load on its own, and report both runs.
2. **WSL:** the unit tests again in a fresh clone (tmux, sockets, git). `rg "#setStatus|setFlags|markStopped|kind: 'set'" packages/server/src` finds nothing.
3. **Docker, one at a time, after the host memory check (R137):** `corepack pnpm test:linux` all green, with the budgets table in the ledger (SSE frames at most 43 per session and 1,290 in all, first load, idle RSS and anonymous memory, `kage hook`'s wall time); then `corepack pnpm test:reboot` (the restart path is reconcile now: after `docker restart` the task shows as ended).
4. **By hand in WSL**, on `127.0.0.1` only, with a temporary `HOME`, a private tmux socket and the fake ntfy on loopback; browser-page screenshots only:
   - **Restart:** a done session, its pane redrawn, then `kage restart`: the row never shows running, the fake ntfy gets nothing, and `doneAt` in the state file is unchanged.
   - **Archive:** E on a done session: the row leaves with its toast, once; the server log shows one transition to ended (act).
   - **A reply at a prompt:** answer with text, let Claude go idle: done, no done ping. A new question after it pings once.
   - **tmux down:** `tmux -L <socket> kill-server` with a session waiting, then a new task: no second ping for the old one.
5. **Not done here:** pushing `main`, tagging and releasing wait for the owner's explicit go.
