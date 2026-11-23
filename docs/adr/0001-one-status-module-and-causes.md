# Status is decided in one place, and every transition carries a cause

A session's status used to be set from many places, and the notifier, auto-archive and the board each worked out what changed by comparing snapshots. That let Kage catching up after a restart look like a finished turn and ping the owner (R141). So one pure status module now turns each observation into the next status, and every transition says why it happened: live (Claude just did something), reconcile (Kage catching up after a restart, a reattach or a relist) or act (the owner or Kage did something on purpose).

## Consequences

- Only live transitions raise a ping or a browser notification on their own. The "is done" ping's 60-second clock starts on a live or act move from done, ended or off the board into running or needs-you, so a turn started from the board still pings. A reconcile never starts it, so a restart never pings.
- A window that first appears while Kage is running is live; only start-up and a tmux reattach are reconcile.
- Don't "simplify" consumers back to diffing snapshots: the cause is the information a snapshot can't carry.
