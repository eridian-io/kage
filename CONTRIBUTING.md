# Contributing to Kage

Thanks for your interest in Kage. Issues, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas:** open an issue first, using the templates. For anything bigger than a small fix, agree on the approach in the issue before writing code.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Design:** the UI must match the design target in [`docs/design/kage-board.html`](docs/design/kage-board.html). A change to how Kage looks updates that page and the screenshots in `docs/design/reference/` in the same pull request.

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign a short Contributor License Agreement (CLA). A bot comments on your pull request with a link; signing takes a minute. The CLA lets the project offer Kage under the AGPL-3.0 and under commercial licences. You keep the copyright to your contribution.

## Development setup

You need Node 24.2 or newer (see `.nvmrc`), pnpm through corepack, tmux 3.2 or newer, and git.

```sh
corepack enable
pnpm install
pnpm dev          # runs Kage in demo mode with sample sessions, no tmux needed
```

`pnpm dev` serves the demo on `127.0.0.1` and rebuilds as you edit, so it needs no Tailscale. `pnpm demo` builds once and serves the same demo from the build. Your own settings go in `~/.config/kage/config.json` (see [Configuration](README.md#configuration)), outside the repo.

Before you open a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build        # the e2e tests run against the build
pnpm test:e2e     # Playwright, including the visual checks against the design target
```

The tmux and Unix-socket tests, and the live e2e, need Linux or macOS. On Windows, use one of these:

- `pnpm test:linux` runs the whole check in a fresh Docker container (install, lint, typecheck, unit, build and every e2e project). It needs Docker, and works from Git Bash.
- Or use WSL with tmux installed: clone the repo again inside WSL's own file system (for example `~/kage`, not `/mnt/c/...`), run `corepack enable && pnpm install`, then `pnpm test`. A fresh clone avoids Windows `node_modules` and file-watching problems.

## Pull requests

- Keep each pull request to one change, and explain what it changes and why.
- Add or update tests for behaviour you change.
- Keep the performance budgets in the design document (§7) green.
- Use clear commit messages, for example `fix(server): …`, `feat(ui): …` or `docs: …`.

## Releasing

For maintainers, and only on the owner's go:

1. Set the new version in `packages/server/package.json`.
2. Tag the commit `v<version>` and push the tag.

The release workflow (`.github/workflows/release.yml`) does the rest: it builds and smoke-tests the program for each platform, makes the npm package, `VERSION` and `SHA256SUMS`, attests them, creates the GitHub release and publishes to npm. A version with a `-` (`1.2.0-rc.1`) is a pre-release, which `kage update` and the installer don't pick up. `pnpm release:local` builds the same files for this machine into `dist/release`.

The workflow's gates live in the repository's settings, so set them before the first tag:

- **The `release` environment** needs required reviewers (the owner), and its deployment branches and tags limited to `v*` tags. The publish job runs in it, so nothing is published until a reviewer approves.
- **A tag ruleset** for `v*` lets only the owner create, move or delete those tags.

The one-line install fetches `install.sh` from `main`, so the branch that holds it must be merged into `main` before the first tag.

## What goes in the repo

| Committed | Ignored (see `.gitignore`) |
|---|---|
| Source code, tests and test fixtures (with made-up data only) | `node_modules/`, build output, coverage and Playwright reports |
| Docs: `docs/design/` (UI target and screenshots), `docs/specs/` (designs), `docs/plans/` (implementation plans), `docs/backlog.md` (deferred work) | `.env` files and keys (your Kage config lives in `~/.config/kage/`, outside the repo) |
| Shared editor and agent settings, such as `.editorconfig` and `AGENTS.md` | Personal settings: `.vscode/*` (except shared files), `.idea/`, `.claude/settings.local.json` |
| Brand assets in `assets/` | Logs, sockets, `tmp/` and Kage's own `.worktrees/` |

Never commit real hostnames, tokens, transcripts from your own Claude sessions, or anything from a private project. Test fixtures use invented data.
