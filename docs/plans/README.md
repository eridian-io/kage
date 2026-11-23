# Kage implementation plans

The design is in [`../specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md). Each phase in its §9 gets its own plan. A plan is written when the phase before it has landed, so it builds on what the code and the spikes actually showed.

| Phase | Plan | Status |
|---|---|---|
| 1. Foundation and board (demo mode, pixel-matched) | [2026-11-21-phase-1-foundation-and-board.md](2026-11-21-phase-1-foundation-and-board.md) | Built (branch `phase-1`) |
| 2. Live sessions: tmux bridge, hooks, transcript reader, per-tab streams. Starts with a spike on hooks, `--settings` and the transcript format | [2026-11-21-phase-2-live-sessions.md](2026-11-21-phase-2-live-sessions.md) | Merged into main |
| 3. Control: new task in a worktree, answer, reply and follow-up, stop, ports, files, token login. Starts with a spike on worktrees, tmux launch and tagging, replies at prompts, and port scans | [2026-11-21-phase-3-control.md](2026-11-21-phase-3-control.md) | Merged into main |
| 4. Finish and terminal: pin, archive, auto-archive, delete, resume, diff view, lazy terminal. Starts with a spike on tmux control mode | [2026-11-21-phase-4-finish-and-terminal.md](2026-11-21-phase-4-finish-and-terminal.md) | Merged into main |
| 5. Polish: notifications (ntfy and the browser), command palette, performance budgets | [2026-11-22-phase-5-polish.md](2026-11-22-phase-5-polish.md) | Merged into main |
| 6. Install and release: `kage setup`, the services, `install.sh`, SEA builds. Starts with a SEA spike on Linux and macOS | [2026-11-22-phase-6-install-and-release.md](2026-11-22-phase-6-install-and-release.md) | Merged into main |
| Hardening: what four reviews of the whole product found (security, reliability, performance, usability), within ruling R126, and phase 6's parked items. Release signing, the phone layout and the contrast tokens are left to the owner (backlog B72, B51, B73) | [2026-11-23-hardening.md](2026-11-23-hardening.md) | Merged into main |

Before the first release: the one-line install fetches `install.sh` from `main`, so phase 6 must be merged into `main` before the first `v*` tag is pushed.
