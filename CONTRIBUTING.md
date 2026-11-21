# Contributing to Kage

Thanks for your interest in Kage. Issues, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas:** open an issue first, using the templates. For anything bigger than a small fix, agree on the approach in the issue before writing code.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Design:** the UI must match the design target in [`docs/design/kage-board.html`](docs/design/kage-board.html). A change to how Kage looks updates that page and the screenshots in `docs/design/reference/` in the same pull request.

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign a short Contributor License Agreement (CLA). A bot comments on your pull request with a link; signing takes a minute. The CLA lets the project offer Kage under the AGPL-3.0 and under commercial licences. You keep the copyright to your contribution.

## Development setup

You need Node 24 (see `.nvmrc`), pnpm through corepack, tmux 3.2 or newer, and git.

```sh
corepack enable
pnpm install
pnpm dev          # runs Kage in demo mode with sample sessions, no tmux needed
```

Before you open a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e     # Playwright, including the visual checks against the design target
```

## Pull requests

- Keep each pull request to one change, and explain what it changes and why.
- Add or update tests for behaviour you change.
- Keep the performance budgets in the design document (§7) green.
- Use clear commit messages, for example `fix(server): …`, `feat(ui): …` or `docs: …`.

## What goes in the repo

| Committed | Ignored (see `.gitignore`) |
|---|---|
| Source code, tests and test fixtures (with made-up data only) | `node_modules/`, build output, coverage and Playwright reports |
| Docs: `docs/design/` (UI target and screenshots), `docs/specs/` (designs), `docs/plans/` (implementation plans) | Your local `kage.config.json`, `.env` files and keys |
| Shared editor and agent settings, such as `.editorconfig` and `AGENTS.md` | Personal settings: `.vscode/*` (except shared files), `.idea/`, `.claude/settings.local.json` |
| Brand assets in `assets/` | Logs, sockets, `tmp/` and Kage's own `.worktrees/` |

Never commit real hostnames, tokens, transcripts from your own Claude sessions, or anything from a private project. Test fixtures use invented data.
