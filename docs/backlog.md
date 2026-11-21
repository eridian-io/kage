# Backlog

Work deliberately left out of a phase, with the reason it's needed. Each item names the phase it belongs to; when one ships, delete it here and record it in that phase's plan or the spec.

## Phase 2

- **B1** Accept the MagicDNS FQDN (`name.tailXXXX.ts.net`) by reading it from `tailscale status --json`: today the host guard knows the IP, the hostname and its short form only, so the full tailnet name gets 403.
- **B2** A stream id so `POST /api/view` can target one tab's SSE stream (the hub sends it in the snapshot; the tab echoes it), and amend spec §5.12: without it the server can't tell which tab's view changed.
- **B3** Split the SSE events into `session.lines`, `session.files` and `session.ports`, send lines only for the viewed session, and leave lines out of the snapshot for unselected sessions: live output would otherwise stream every session's lines to every tab.
- **B4** SSE backpressure: drop a client whose queue grows past a limit, so one stalled tab can't grow the server's memory without bound.
- **B5** Output: append-only rendering with stable keys and a 500-node cap (spec §7), so a long-running session doesn't re-render or grow the DOM without limit.
- **B6** Send `projectsRoot` in the snapshot (or send `~`-relative paths) so `shortWorktree` works with real paths, not only with the demo's `~/projects/…`.
- **B8** Enforce the config `token` (a login page and a cookie) before live sessions ship, or refuse to start with a token set: today a set token is only warned about, which suggests protection that isn't there.

## Phase 2 or 4

- **B7** The "ended" chip and the Resume footer (spec §6.5): sessions whose process exits need their own state and a way back in.

## Phase 4

- **B9** The WebSocket terminal route needs its own Origin check: `csrfGuard` skips GET upgrades, and browsers can't send `X-Kage` on a WebSocket.
- **B10** Show an error when DELETE fails (copy to be designed): today a failed delete just re-enables the button, with no word why.

## Later

- **B11** Small hardening and tidying, each optional: per-encoding or weak ETags (one ETag now covers every encoding); case-insensitive `q=` parsing in Accept-Encoding; pixelmatch `includeAA` in the visual tests; CI `cancel-in-progress` only off `main`; add esbuild to `onlyBuiltDependencies` (the owner's call).
