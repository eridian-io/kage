# Backlog

Work deliberately left out of a phase, with the reason it's needed. Each item names the phase it belongs to; when one ships, mark it done here, and delete it once the plan or the spec records it.

## Phase 2

- **B1** (done, phase 2) Accept the MagicDNS FQDN (`name.tailXXXX.ts.net`) by reading it from `tailscale status --json`: today the host guard knows the IP, the hostname and its short form only, so the full tailnet name gets 403.
- **B2** (done, phase 2) A stream id so `POST /api/view` can target one tab's SSE stream (the hub sends it in the snapshot; the tab echoes it), and amend spec §5.12: without it the server can't tell which tab's view changed.
- **B3** (done, phase 2) Split the SSE events into `session.lines`, `session.files` and `session.ports`, send lines only for the viewed session, and leave lines out of the snapshot for unselected sessions: live output would otherwise stream every session's lines to every tab.
- **B4** (done, phase 2) SSE backpressure: drop a client whose queue grows past a limit, so one stalled tab can't grow the server's memory without bound.
- **B5** (done, phase 2) Output: append-only rendering with stable keys and a 500-node cap (spec §7), so a long-running session doesn't re-render or grow the DOM without limit.
- **B6** (done, phase 2) Send `projectsRoot` in the snapshot (or send `~`-relative paths) so `shortWorktree` works with real paths, not only with the demo's `~/projects/…`.
- **B8** (done, phase 2) Live mode refuses to start with a config `token` set, so the config never suggests protection that isn't there. The login itself is B13.

## Phase 3

- **B13** (done, phase 3) Token login (B8 follow-up): a login page and a cookie that enforce the config `token`, then lift the refusal to start with one set.
- **B14** (done, phase 3) Split panes in external windows: only the first pane of a window is known, so a prompt in another pane is missed.
- **B15** (done, phase 3) Signal handling during `kage serve` startup: a SIGINT while tmux and the socket are starting should stop what has started, and a second SIGINT should exit at once. Late errors (assets, app creation) should print one line, not a stack trace.

## Found in phase 3

Deferred from the phase 3 reviews. None blocks use; each is a small change.

- **B20** (done, hardening Task 1, security I1: a random session per login, kept hashed in memory, bound to the address that signed in, ended after 7 idle days or 30 days, by Sign out, or by a restart) The token cookie has no server-side expiry: it lasts its 30 days. To revoke every device, change the token and restart. A server-side session list or a rotating secret would give a real sign-out.
- **B21** (done, hardening Task 5, security M2: an address with no recent failure always gets its try) A peer can use up the global login ceiling (30 failures a minute) and lock everyone out of signing in for 60 s. Cookies that exist keep working. Behind a reverse proxy, all clients share one address and one bucket.
- **B22** The multi-select question (checkboxes) is unrecorded: Kage disables answering it and says to use the terminal. Capture a real one, record the keys, and then support it.
- **B23** The port scan misses a daemon that detached from the pane (its parent became init). Match by working directory or process group as well.
- **B24** A project reached through a symlink is recorded under the alias name. Record the real folder's name.
- **B25** processLabel cosmetics: some long or wrapped commands give an odd label on the port card.
- **B26** (done, hardening Task 7: an interrupt inside the window arms the 2 s turn-end check, so an idle pane ends in done) The 5 s window after a reply ignores a real Esc that the user presses in the terminal during it.
- **B27** Two hooked claude processes in one window: the first wins. Side-pane activity re-lists the windows.
- **B28** (done, phase 5 Task 9) The web doesn't clamp the files list to its limit. The server owns the bound, so this only matters if the server changes.
- **B29** The 404 for an unknown project or branch echoes the name without a length cap (cosmetic).
- **B30** K2's guard is narrow: after a failed `git worktree add`, Kage deletes `kage/<slug>` unless git's message says the branch already existed. A branch someone else creates between the slug check and the `worktree add`, followed by a failure for another reason, would be deleted. Compare the branch's ref before and after instead of reading git's message.
- **B31** If Kage dies between `git worktree add` and `adopt`, the worktree and branch stay with no record, so the board never shows them. A start-up sweep for `kage/*` worktrees with no record (listed, never deleted by itself) would surface them.
- **B32** The live e2e specs depend on their order: later tests reuse sessions an earlier one left (for example the follow-up test needs the answered task's done session). A fixture helper that makes its own done session would let each test run alone.
- **B33** (done, phase 5 Task 10) Double-X Stop and the stale-card 409 are unit-tested only. Add live e2e cases: one X does nothing, a second within 2 s stops; a card answered after its question changed gets 409.

## Phase 2 or 4

- **B7** (done, phase 4) The "ended" chip and the Resume footer (spec §6.5): sessions whose process exits need their own state and a way back in.
- **B12** (done, phase 2) Only accept `name` from the config as a Host and Origin name when it's a single label or ends in `.ts.net` or `.local`: a public domain the owner doesn't control would let that domain pass the guards after DNS rebinding. (Superseded 2026-11-23, hardening, security I2: `name` is no longer trusted at all; see spec §5.10.)

## Phase 4

- **B9** (done, phase 4) The WebSocket terminal route needs its own Origin check: `csrfGuard` skips GET upgrades, and browsers can't send `X-Kage` on a WebSocket.
- **B10** (done, phase 4) Show an error when DELETE fails (copy to be designed): today a failed delete just re-enables the button, with no word why.

## Found in phase 4

Deferred from the phase 4 reviews. None blocks use.

- **B34** (done, phase 5 Task 9) The resume race (R63): a resumed window that dies before Kage's first listing of it loses the failed-resume `SessionEnd`, so the record can't tell a failed resume from a quiet one. Fix: claim the window with the pane id that `new-window` printed, so the first hook or the window's death is matched without a listing.
- **B35** (done, phase 5 Task 0) Pending terminal upgrades have no cap. `LIMITS.terminals` caps open terminals, but sockets that have passed the upgrade check and are still opening aren't counted. Cap them at about twice `LIMITS.terminals` and answer 4429.
- **B36** (done, phase 5 Task 9) `FileChange.path` is not stripped of control and bidi characters in the files list (the diff strips its own paths). Strip it where the list is built.
- **B37** (done, phase 5 Task 4) `listChanges` reads up to 100 MiB of untracked files on every request (the list and the diff both call it). Cache the untracked counts by file size and mtime, or read less.
- **B38** A time-of-check to time-of-use gap on Windows, inherited from phase 3's file list: a path is checked and then read, and a swap between the two is not closed there. A fix needs an open-then-check on the file handle.
- **B39** (done, phase 4 fix wave) The delete e2e races after `extra.txt` is written: it should poll the board for "3 files" before it opens the confirmation. It failed once in three Docker runs.
- **B40** An e2e for auto-archive skipping a session that has a terminal open (F11/R70). Unit tests cover it; no browser test opens a terminal and then merges.
- **B41** Smaller e2e tidying from the Task 14 review: check that a pinned session stays before the archive step, give each fake scenario distinct file content, and assert the `sentIn` frames on the terminal socket.
- **B42** (live half done, hardening Task 11, reliability M7: a terminal control client that exits leaves no window at the browser's size once the next client starts, since it first restores every window Kage resized; B71 would restore them at once. A crash of Kage itself still needs the start-up sweep below) A crash leaves resized windows at a manual size. The terminal's resize sets `window-size manual` on the window, and only a clean close unsets it, so after a crash the window stays at the browser's size when you attach at the PC. Fix: at startup, unset `window-size` (`set-option -w -u`) on every Kage-tagged window that has no terminal open.
- **B43** A merge done in a linked worktree is seen only at the session's next turn end, so auto-archive on merge waits until then. The watcher looks at the top of the git common dir (`HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `packed-refs`), and such a merge writes its `ORIG_HEAD` under `worktrees/<name>/` and a loose ref under `refs/heads/`. Fix: watch the linked worktrees' own git dirs too.

## Found in phase 5

- **B44** A trust screen drawn after the 60 s first-prompt look (phase 5 Task 0's cap on a still-starting launch) is seen only by the capture that pane activity triggers. A screen drawn with no activity after it stays unseen until the next activity. Fix if it shows up: one more look when the cap ends, or a slow look (every 10 s) until the first hook.

- **B45** Hooks don't say which tmux server they came from. A pane id such as `%3` is only unique within one tmux server, so with a second server (`KAGE_TMUX_SOCKET`, or a user's own tmux) a hook from `%3` there can be taken for Kage's `%3`, and a hook set aside for a later claim can be claimed by the wrong window. Fix: `kage hook` sends the socket from `$TMUX` with the event, and the server matches it against its own.
- **B46** The set-aside of hooks from unknown panes (the B34 claim) keeps up to 32 in all and has no cap per pane, so one noisy pane can push out the others (R152 adds a young `ext-` window's hooks to it, for its first 5 s). Cap it per pane, or keep only `SessionStart` and `SessionEnd`, the two a claim needs. A `SessionEnd` that arrives after the lost reconcile is still not matched for a launch (a resume's is, within 5 s: transitions Task 0's late SessionEnd). (The queued half done, transitions Task 0: a `SessionEnd` queued behind a listing that still showed the window, which the next listing found gone, was set aside and never applied, so a failed resume ended without its R63 line. `#reconcile` now applies a pane's queued hooks (`#takeQueued`) before it detaches the session, as the lost path already did.)
- **B47** (done, phase 5 final review) Pressing Ctrl+K (or ⌘K) while the diff is still loading lets the diff view's mount effect (`DiffView.tsx`, the `el.focus()` at line 96) take focus from the open palette's field: the palette stays open but typing goes to the diff. Fix: skip that focus while the palette holds it.
- **B48** Smaller things from the phase 5 reviews, each optional: a test for a hook from another pane inside the 5 s window; (done) `closeDiff`'s fallback selector, `[data-id].k-it.on`, was broader than it needed to be; an ignored-mark that has expired can be seen out of order with the session's next event; the revert pair `808e21a`/`029d197` is in the branch history (squash at merge if wanted).
- **B49** Pings can be quieter. Skip a ping while a board tab for that session is visible and focused (the board already says so with the title count). Collect a burst of pings (several sessions at once) into one, "3 sessions need you".
- **B50** (done, hardening Task 1: "Sign out" in the command palette while a token is set; the snapshot's `auth` says whether one is) A sign-out action on the board. It needs to know whether a token is set, which the API doesn't say today, so the button can be hidden when there is none.
- **B51** A phone layout for the whole board, as a future phase of its own (widened 2026-11-23, hardening; usability U1). The owner chose desktop first (R126). The board is laid out for at least 1100 px: a phone at 390 px shows it, but its columns don't fit, and a ping's `#s=<id>` link lands there. The README says "Desktop first. A phone shows the board, and a phone layout is planned." It needs its own design and reference screenshots (spec §8).
- **B52** (done, phase 6 Tasks 0 and 10: `kage ping` and serve's "Tailscale isn't running" line both name the config file Kage actually reads) `kage ping` names a fixed path, "No ntfyTopic in ~/.config/kage/config.json." (`main.ts`, and the spec §6.7 copy), even when `XDG_CONFIG_HOME` puts the config elsewhere. Fix: print the path the config was actually read from.
- **B53** `tailQuestionKey` can stay null when the attach guard (`live-source.ts`, `st.hookCount === hooks`) skips `#rebuildFromTail` because a hook landed while the tail started; then the transcript's open question at that moment is not remembered, and the next tail change that still shows it is taken for a new question. Fix: record the key even when the rebuild is skipped.
- **B54** `resumeAborted` sets the status back to ended through `#setStatus`, which resets `statusSince`, the clock auto-archive measures an ended session's age by: a resume whose window failed to open restarts the 14 days. Fix: keep the `statusSince` the session had before `resumed()`.

B53 and B54 are still open after hardening.

## Found in phase 6

Deferred from the phase 6 plan and reviews. None blocks the first release.

- **B55** macOS notarisation. The SEA is ad-hoc signed, which is enough for a binary `curl` fetched (no quarantine attribute), but a browser download meets Gatekeeper. Notarising needs an Apple developer account, the owner's call.
- **B56** A Homebrew tap (`brew install eridian-io/tap/kage`), as a third way in on macOS.
- **B57** (see B72, the owner's decision) `kage update` checks only `SHA256SUMS`, fetched over HTTPS from the same release: that catches corruption, not a compromised release host. Check the build provenance attestation too, as `gh attestation verify` does by hand, without needing `gh`.
- **B58** Pin `node:<version>-trixie-slim` in `Dockerfile.install` and `Dockerfile.reboot` by digest, not only by tag, with their apt packages (see B18), so `pnpm test:install` and `pnpm test:reboot` are reproducible.
- **B59** WSL doesn't start at Windows boot, so neither does Kage in it, linger or not. It is out of Kage's hands; the README says so. A documented way (a Task Scheduler entry that runs `wsl.exe -d <distro> --exec true` at logon) would help WSL users.
- **B60** If someone deletes Kage's unit file by hand while the service runs, `kage uninstall` can't tell the running unit is Kage's and leaves it running. `systemctl --user stop kage.service` is the manual fix, and doctor shows the state.
- **B61** Smaller things in `kage update` and `kage uninstall`, each optional: two updates that both find a stale lock can both take it over (at worst a duplicate download); an empty lock left by a failed write blocks updates for 10 s, then counts as stale; uninstall could check locally that the file it removes is `process.execPath`'s target (belt and braces; `installedExe` already guarantees it).
- **B62** A test that the fingerprints in `.github/node-release-keys.asc` match the keys in it (skipped without `gpg`).
- **B63** `assertSafeOut` in `release/build.ts` compares resolved paths, not real ones, so a symlink to the home folder or the repo passes as `--out`. Use `realpath` for the parts that exist.
- **B64** When `systemd-run --user --scope` fails, Kage starts tmux inside the unit (one log line, R123), and then a service restart, `kage update` or `kage uninstall` ends every Claude session. Doctor could say so: a warn line when the service runs but the tmux server isn't in a `kage-tmux-*.scope` (`tmux display -p '#{pid}'` on Kage's socket, then `/proc/<pid>/cgroup`).
- **B65** `systemd-run --user --scope` was checked on systemd 257 only (the reboot container). Check it on systemd 255 (Ubuntu 24.04) and on a host without `dbus-user-session`.
- **B66** On macOS the launchd agent appends stdout and stderr to `~/Library/Logs/kage.log` forever: launchd doesn't rotate it (the journal does on Linux). Rotate it, for example with a `newsyslog.d` entry (that needs root, so setup would print it) or by Kage writing a size-capped log itself, and say so in the README.

## Later

- **B16** Re-check the pane parser against a real capture on each Claude Code version. The fixtures are idealised; the last real check was Claude Code 2.1.330. A manual smoke step per Claude release, or a recorded-capture test.
- **B17** (done, phase 3) A live e2e for No and Esc on a prompt (R11): today the transcript and pane fallbacks are covered by unit tests and one manual run.
- **B18** Pin the Playwright base image in `Dockerfile.test` by digest, not only by tag, and pin the apt packages it installs (tmux, git, iproute2 and procps are unpinned), so `pnpm test:linux` is reproducible.
- **B19** Split `live-source.ts`: it carries tmux events, hooks, transcripts and pane checks. Pull the pane-capture decision out as a pure function first.

## Found in hardening

Left out of hardening by its scope ruling (R126), or parked by its reviews. None blocks the first release.

- **B67** (from hardening Task 2, R130) Warn at startup, on stderr, when an explicit `host` is a single label or a `.local` name: Kage then trusts everyone on the local network to answer for that name (spec §5.10).
- **B68** (from hardening Task 2, R130) Print one stderr line when `--unsafe-listen-all` starts with Tailscale down and no configured host name: the allow-list is then empty, so every request gets 403.
- **B69** (pre-flight F1, hardening) HTTPS through `tailscale serve` doesn't work and isn't advised: the CSRF guard takes only `http://<name>:<port>` Origins, so `https://box.tail….ts.net` is refused, and `Secure` never sets because Kage sees http. Any reverse proxy, `tailscale serve` included, also makes every device one peer address: that voids the per-login address binding (a cookie is then good from every device behind the proxy) and the per-address login limiter and stream cap. Making it work needs https Origins for the MagicDNS name and trusted `X-Forwarded-*` handling.
- **B70** (R127, security M1, parked) Read a transcript only when its real path lies under `~/.claude/projects/`, so a forged hook can't point a card at any `.jsonl` file the user can read. Every e2e fake has to write its transcripts there first.
- **B71** (hardening Task 11 review, R139; reliability M7 follow-up) When the terminal control client exits, the windows Kage resized stay at the browser's size until the next terminal opens (that client restores them first). Restore them at once in `TerminalBridge`'s `#clientGone`, through the one-shot tmux client (`set-option -w -u -t @W window-size`), instead of waiting for a new control client.
- **B72** (the owner's decision; security I4, with B57) Release signing. `install.sh` and `kage update` check the program against `SHA256SUMS` from the same release, which catches corruption, not a compromised release host or account. Sign `SHA256SUMS` with a key the owner holds offline (minisign or ed25519), embed the public key in `install.sh` and the program, and verify before hashing; or verify the GitHub attestation's Sigstore bundle offline in `kage update`, pinned to the repository and `release.yml` at a `v*` tag. Then publish `install.sh` as a release asset covered by the signature (the second half of security M9; the README already gives a tag-pinned template).
- **B73** (the owner's decision; usability U10) The contrast tokens. `--fg-3` (#5f6672, 3.27:1 on the background, 2.92:1 on the selected row) and the row age colour (#565d68, 2.85:1) are below WCAG AA for their 12 px text: the group labels, the `project /` prefixes, the ages and every key hint. The review suggests `--fg-3: #7d8490` (5.02:1) and the age colour at `--fg-3`. It is a design change: the target page and the reference screenshots change with it (spec §8).
- **B74** (security M6) Title-only pings. A ping carries the task's text, the project, the host and the session's id to the ntfy server, and on ntfy.sh to anyone who learns the topic. Offer a mode that sends the project and "needs you" only, with no task text and no session id in `click`. Setup already says each ping carries the task's text.
- **B75** (security I1, the longer term) Sign in by Tailscale identity: ask the local Tailscale daemon who a peer address belongs to (LocalAPI `whois`) instead of, or as well as, the token.
- **B76** Usability minors the hardening scope didn't take, each optional (the usability review's U11 to U13 and U15 to U30):
  - U11: "No git repositories in …" is a dead end. Say that repos must sit directly inside the folder and how to change it, and disable the task field while there are none.
  - U12: the login screen doesn't say where the token is (Kage's config file on the PC; setup printed it). Select the field's text after a wrong try.
  - U13: a long disconnect never says what to check. After about 15 s, say what to check (the PC, Tailscale on this device); a grey host dot while not live; Terminal disabled with the other actions.
  - U15: "Starting Claude…" never says it's taking a while. After 20 s with no hook, a muted line that suggests T.
  - U16: screen readers: no live region for a new needs-you, rows without their status in their name, group labels that aren't headings, no h1.
  - U17: a disabled option's reason lives only in a tooltip.
  - U18: the old "Available in a later version" tooltip on an ended external session's Terminal button.
  - U19: the external window's sign-in note points at `tmux attach`, not T.
  - U21: the generated token is printed with a full stop after it; put it on its own line.
  - U22: setup ends on the "start Claude yourself" line, not on opening the address and pressing N.
  - U23: the projects and host questions are terse.
  - U24: `kage status` names the socket path instead of saying Kage isn't running.
  - U25: config errors give a character offset and an absolute path, not a line and column with `~`.
  - U26: the archive toast has no Restore button.
  - U27: a ping for a session that's gone lands silently.
  - U28: a digit approves a prompt with one key (the README says so); show the chosen option for about a second first.
  - U29: "1 needs you" on the board against doctor's "0 need you"; "external" unexplained; "Follow up" against "Reply". (Spec §8's `kage --demo` is fixed.)
  - U30: small hints: Enter sends the reply, Shift+Enter makes a new line in New task, a copy button for the `ssh -L` line, "No output yet." for a done session with no lines.

  U20 (the message when the token is turned off) was fixed in hardening Task 3.
- **B77** Performance minors the hardening scope didn't take, each optional:
  - P8: the terminal's control client unescapes every pane's `%output` before it filters by pane. Read the pane id first.
  - P10: the watcher's `#lastActivity` never drops closed panes, and `#byPane` is a linear scan per hook. Prune on `windows-changed`, and keep a pane-to-session map.
  - P11: `Output` reads `scrollHeight` on every render of the selected session. Scroll only when a line was added or the session changed.
- **B78** Parked from the review of the restart fixes (eebfcb7, 3044e5f):
  - in the restart branch that keeps a done session done, a busy footer in the attach capture doesn't count as running, so a turn already in progress shows done until its first tool hook;
  - (done, transitions Task 5: the `rebuilt` rows in `live/status.test.ts` and two restart tests in `live-source.test.ts`) two tests to add: a restarted done session whose transcript shows a question becomes needs-you, and one that shows a turn in progress becomes running;
  - `doneAt` can be stale after a crash before the debounced state save.
- **B79** Parked from the setup review (hardening Task 17): an error thrown, not returned, after the config is written skips showing the saved ntfy topic, so a saved topic may never be shown. Handle it like a returned failure.
- **B80** (hardening Task 19, R150) A unit folder with a space can't be read from systemd's `UnitPath`, which is space-separated. Such a home gives a unit that doesn't load, which doctor shows.
- **B81** `pnpm test:install` checks the SEA's one V8 worker but not the service's `--max-semi-space-size=1`. Add it.
- **B82** (hardening final review) The session cookie reaches every port on the same host, since cookies aren't bound to a port, so another local web app on that host could be sent it. Fix later with HTTPS and a `__Host-` cookie, or by asking Tailscale whois who is calling.
- **B83** (hardening final review) The MagicDNS name is asked once, at start. If that lookup fails, the full name gets 403 for the rest of that run (the short name and the address still work). Ask again later, or on a refused Host.
- **B84** (hardening final review, theoretical) An `XDG_RUNTIME_DIR` that isn't under /run is used as it is. Check its owner and mode before putting the socket there.
- **B85** (transitions Task 0) With `remain-on-exit` on, a failed resume's dead pane stays listed: the attach ends the session in its window (`#claudeGone`, which clears the resume) before its `SessionEnd` is applied, so there is no R63 line and the record links the random session id that `SessionEnd` names, which breaks the next resume. Fix: keep the resume through a dead-pane end until that pane's `SessionEnd` or UNKNOWN_PANE_MS, as the late SessionEnd does for a window that is gone.
- **B86** (transitions Task 0, the cause of R63's e2e failures) Claude's `SessionEnd` ends a session a moment before its window closes and Kage's next listing lets the window go. A U in between is refused: "Couldn't resume. This session already has a window." (409, `hasWindow`). In the traced Docker repeat the gap was 12–23 ms, and the spec pressed U inside it 2 times in 20; on ubuntu-latest it did so on the failing main push. The board offers Resume all the while. The spec now presses U again after that refusal (`resume()` in finish.spec.ts). Fix: the resume re-lists once before refusing, or Resume waits until the session has no window.

## Later, small

- **B11** Small hardening and tidying, each optional: per-encoding or weak ETags (one ETag now covers every encoding); case-insensitive `q=` parsing in Accept-Encoding; pixelmatch `includeAA` in the visual tests; CI `cancel-in-progress` only off `main`; add esbuild to `onlyBuiltDependencies` (the owner's call).
