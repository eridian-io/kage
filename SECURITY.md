# Security policy

Kage can start programs and send keystrokes on the machine it runs on, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub instead:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the steps to reproduce it, and the impact you expect.

You'll get an answer within 7 days. Once a fix is ready, we'll agree with you on when to publish the advisory, and credit you if you'd like.

## Supported versions

Kage is in early development. Only the latest release on `main` gets security fixes.

## What Kage protects against by default

- It listens only on your Tailscale address, not on `0.0.0.0`.
- It rejects requests with an unexpected `Host` header (DNS rebinding) and cross-site requests (CSRF).
- It never runs tmux or git through a shell, so task text can't inject commands.
- It never stops or deletes tmux windows, worktrees or branches it didn't create.

Anyone who can reach Kage can run Claude Code on your machine. Only add devices you trust to your tailnet, and set a `token` in the config if others share your tailnet.
