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

- **B20** The token cookie has no server-side expiry: it lasts its 30 days. To revoke every device, change the token and restart. A server-side session list or a rotating secret would give a real sign-out.
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
- **B42** A crash leaves resized windows at a manual size. The terminal's resize sets `window-size manual` on the window, and only a clean close unsets it, so after a crash the window stays at the browser's size when you attach at the PC. Fix: at startup, unset `window-size` (`set-option -w -u`) on every Kage-tagged window that has no terminal open.
- **B43** A merge done in a linked worktree is seen only at the session's next turn end, so auto-archive on merge waits until then. The watcher looks at the top of the git common dir (`HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `packed-refs`), and such a merge writes its `ORIG_HEAD` under `worktrees/<name>/` and a loose ref under `refs/heads/`. Fix: watch the linked worktrees' own git dirs too.

## Found in phase 5

- **B44** A trust screen drawn after the 60 s first-prompt look (phase 5 Task 0's cap on a still-starting launch) is seen only by the capture that pane activity triggers. A screen drawn with no activity after it stays unseen until the next activity. Fix if it shows up: one more look when the cap ends, or a slow look (every 10 s) until the first hook.

- **B45** Hooks don't say which tmux server they came from. A pane id such as `%3` is only unique within one tmux server, so with a second server (`KAGE_TMUX_SOCKET`, or a user's own tmux) a hook from `%3` there can be taken for Kage's `%3`, and a hook set aside for a later claim can be claimed by the wrong window. Fix: `kage hook` sends the socket from `$TMUX` with the event, and the server matches it against its own.
- **B46** The set-aside of hooks from unknown panes (the B34 claim) keeps up to 32 in all and has no cap per pane, so one noisy pane can push out the others. Cap it per pane, or keep only `SessionStart` and `SessionEnd`, the two a claim needs. A `SessionEnd` that arrives after the lost reconcile is still not matched.
- **B47** (done, phase 5 final review) Pressing Ctrl+K (or ⌘K) while the diff is still loading lets the diff view's mount effect (`DiffView.tsx`, the `el.focus()` at line 96) take focus from the open palette's field: the palette stays open but typing goes to the diff. Fix: skip that focus while the palette holds it.
- **B48** Smaller things from the phase 5 reviews, each optional: a test for a hook from another pane inside the 5 s window; (done) `closeDiff`'s fallback selector, `[data-id].k-it.on`, was broader than it needed to be; an ignored-mark that has expired can be seen out of order with the session's next event; the revert pair `808e21a`/`029d197` is in the branch history (squash at merge if wanted).
- **B49** Pings can be quieter. Skip a ping while a board tab for that session is visible and focused (the board already says so with the title count). Collect a burst of pings (several sessions at once) into one, "3 sessions need you".
- **B50** A sign-out action on the board. It needs to know whether a token is set, which the API doesn't say today, so the button can be hidden when there is none.
- **B51** A phone layout for the page a ping opens: the link `#s=<id>` lands on the desktop layout (at least 1100 px), which is cramped on a phone.
- **B52** (done, phase 6 Tasks 0 and 10: `kage ping` and serve's "Tailscale isn't running" line both name the config file Kage actually reads) `kage ping` names a fixed path, "No ntfyTopic in ~/.config/kage/config.json." (`main.ts`, and the spec §6.7 copy), even when `XDG_CONFIG_HOME` puts the config elsewhere. Fix: print the path the config was actually read from.
- **B53** `tailQuestionKey` can stay null when the attach guard (`live-source.ts`, `st.hookCount === hooks`) skips `#rebuildFromTail` because a hook landed while the tail started; then the transcript's open question at that moment is not remembered, and the next tail change that still shows it is taken for a new question. Fix: record the key even when the rebuild is skipped.
- **B54** `resumeAborted` sets the status back to ended through `#setStatus`, which resets `statusSince`, the clock auto-archive measures an ended session's age by: a resume whose window failed to open restarts the 14 days. Fix: keep the `statusSince` the session had before `resumed()`.

B53 and B54 are still open after phase 6.

## Found in phase 6

Deferred from the phase 6 plan and reviews. None blocks the first release.

- **B55** macOS notarisation. The SEA is ad-hoc signed, which is enough for a binary `curl` fetched (no quarantine attribute), but a browser download meets Gatekeeper. Notarising needs an Apple developer account, the owner's call.
- **B56** A Homebrew tap (`brew install eridian-io/tap/kage`), as a third way in on macOS.
- **B57** `kage update` checks only `SHA256SUMS`, fetched over HTTPS from the same release: that catches corruption, not a compromised release host. Check the build provenance attestation too, as `gh attestation verify` does by hand, without needing `gh`.
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

- **B67** (from hardening Task 2, R130) Warn at startup, on stderr, when an explicit `host` is a single label or a `.local` name: Kage then trusts everyone on the local network to answer for that name (spec §5.10).
- **B68** (from hardening Task 2, R130) Print one stderr line when `--unsafe-listen-all` starts with Tailscale down and no configured host name: the allow-list is then empty, so every request gets 403.
- **B69** (pre-flight F1, hardening) HTTPS through `tailscale serve` doesn't work and isn't advised: the CSRF guard takes only `http://<name>:<port>` Origins, so `https://box.tail….ts.net` is refused, and `Secure` never sets because Kage sees http. Any reverse proxy, `tailscale serve` included, also makes every device one peer address: that voids the per-login address binding (a cookie is then good from every device behind the proxy) and the per-address login limiter and stream cap. Making it work needs https Origins for the MagicDNS name and trusted `X-Forwarded-*` handling.
- **B70** (R127, security M1, parked) Read a transcript only when its real path lies under `~/.claude/projects/`, so a forged hook can't point a card at any `.jsonl` file the user can read. Every e2e fake has to write its transcripts there first.
- **B11** Small hardening and tidying, each optional: per-encoding or weak ETags (one ETag now covers every encoding); case-insensitive `q=` parsing in Accept-Encoding; pixelmatch `includeAA` in the visual tests; CI `cancel-in-progress` only off `main`; add esbuild to `onlyBuiltDependencies` (the owner's call).
