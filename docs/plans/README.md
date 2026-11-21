# Kage implementation plans

The design is in [`../specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md). Each phase in its §9 gets its own plan. A plan is written when the phase before it has landed, so it builds on what the code and the spikes actually showed.

| Phase | Plan | Status |
|---|---|---|
| 1. Foundation and board (demo mode, pixel-matched) | [2026-11-21-phase-1-foundation-and-board.md](2026-11-21-phase-1-foundation-and-board.md) | Built (branch `phase-1`) |
| 2. Live sessions: tmux bridge, hooks, transcript reader, per-tab streams. Starts with a spike on hooks, `--settings` and the transcript format | [2026-11-21-phase-2-live-sessions.md](2026-11-21-phase-2-live-sessions.md) | Built (branch `phase-2`) |
| 3. Control: new task in a worktree, answer, reply and follow-up, stop, ports, files, token login. Starts with a spike on worktrees, tmux launch and tagging, replies at prompts, and port scans | [2026-11-21-phase-3-control.md](2026-11-21-phase-3-control.md) | Built (branch `phase-3`) |
| 4. Finish and terminal: pin, archive, auto-archive, delete, resume, diff view, lazy terminal. Starts with a spike on tmux control mode | not written yet | |
| 5. Polish: notifications, command palette, performance budgets | not written yet | |
| 6. Install and release: `kage setup`, the services, `install.sh`, SEA builds. Starts with a SEA spike on Linux and macOS | not written yet | |
