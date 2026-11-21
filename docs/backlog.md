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

- **B13** Token login (B8 follow-up): a login page and a cookie that enforce the config `token`, then lift the refusal to start with one set.
- **B14** Split panes in external windows: only the first pane of a window is known, so a prompt in another pane is missed.
- **B15** Signal handling during `kage serve` startup: a SIGINT while tmux and the socket are starting should stop what has started, and a second SIGINT should exit at once. Late errors (assets, app creation) should print one line, not a stack trace.

## Phase 2 or 4

- **B7** The "ended" chip and the Resume footer (spec §6.5): sessions whose process exits need their own state and a way back in.
- **B12** (done, phase 2) Only accept `name` from the config as a Host and Origin name when it's a single label or ends in `.ts.net` or `.local`: a public domain the owner doesn't control would let that domain pass the guards after DNS rebinding.

## Phase 4

- **B9** The WebSocket terminal route needs its own Origin check: `csrfGuard` skips GET upgrades, and browsers can't send `X-Kage` on a WebSocket.
- **B10** Show an error when DELETE fails (copy to be designed): today a failed delete just re-enables the button, with no word why.

## Later

- **B16** Re-check the pane parser against a real capture on each Claude Code version. The fixtures are idealised; the last real check was Claude Code 2.1.330. A manual smoke step per Claude release, or a recorded-capture test.
- **B17** A live e2e for No and Esc on a prompt (R11): today the transcript and pane fallbacks are covered by unit tests and one manual run.
- **B18** Pin the Playwright base image in `Dockerfile.test` by digest, not only by tag, so `pnpm test:linux` is reproducible.
- **B19** Split `live-source.ts`: it carries tmux events, hooks, transcripts and pane checks. Pull the pane-capture decision out as a pure function first.

- **B11** Small hardening and tidying, each optional: per-encoding or weak ETags (one ETag now covers every encoding); case-insensitive `q=` parsing in Accept-Encoding; pixelmatch `includeAA` in the visual tests; CI `cancel-in-progress` only off `main`; add esbuild to `onlyBuiltDependencies` (the owner's call).
