# Kage

A dashboard for Claude Code sessions that run in tmux on one machine, reached from other devices over Tailscale.

## Sessions

**Session**:
One Claude Code conversation that Kage shows on the board, running in one tmux window.
_Avoid_: job, agent, run

**Task**:
The instruction a session was started with, shown as its title.
_Avoid_: prompt, job

**Record**:
What Kage remembers about a session it started: its project, task, branch, worktree and flags.
_Avoid_: entry, row

**External session**:
A Claude session in a tmux window Kage didn't start, shown without a record.
_Avoid_: foreign session, unmanaged session

**Placeholder**:
The empty window Kage opens to keep its tmux session alive; never shown on the board.

## Status

**Status**:
What a session is doing right now: running, needs you, done or ended.
_Avoid_: state, phase

**Needs you**:
The status of a session waiting on its owner: a permission prompt or a question.
_Avoid_: blocked, waiting, pending

**Done**:
The status of a session whose Claude finished its turn and is idle at its prompt.
_Avoid_: finished, idle, complete

**Ended**:
The status of a session whose Claude is no longer running in its window.
_Avoid_: stopped, dead, closed

**Observation**:
One thing Kage learned about a session from outside: a hook, a transcript line, the screen, a tmux listing, a restart, or an action.
_Avoid_: event, signal

**Transition**:
A session's move from one status to another, with its cause.
_Avoid_: status change, state change

**Cause**:
Why a transition happened: live (Claude just did something), reconcile (Kage catching up after a restart or a tmux reattach; a window first listed while Kage is running is live), or act (the owner or Kage itself did something on purpose).
_Avoid_: reason, source

## Finishing

**Archive**:
Taking a finished session off the board while keeping its worktree and branch, so it can be restored.
_Avoid_: hide, close

**Auto-archive**:
Kage archiving a done session on its own once its branch is merged or it has aged out.

## Notifications

**Ping**:
A notification sent to the owner's phone through ntfy.
_Avoid_: push, alert, notification (alone)
