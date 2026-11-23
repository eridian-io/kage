#!/usr/bin/env bash
# Runs the whole check in a fresh Linux container: install, lint, typecheck, unit (including the
# tmux and Unix-socket tests), build and every e2e project (including the live one).
# Only the files git tracks are copied in (as they are in the working tree); nothing from the
# host is mounted. Works from Git Bash on Windows and from Linux or macOS. Needs Docker.
set -euo pipefail

# Git Bash would rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/.."
image=kage-test:playwright-1.64.1

# R135: dangling images (old builds of the test image) only; tagged images and caches stay.
echo "== removing dangling images"
docker image prune -f >/dev/null

echo "== building $image"
# No build context: the Dockerfile needs no files from here.
docker build --quiet --tag "$image" - < Dockerfile.test >/dev/null

echo "== copying $(git ls-files | wc -l | tr -d ' ') tracked files into a fresh container"
# R134: at most 4 GB of memory, so an overrun fails inside the container instead of the host
# killing the run, and vitest on 2 workers (Playwright stays on 1, playwright.config.ts).
git ls-files -z | tar --null -T - -c -f - | docker run --rm -i --init --memory 4g "$image" bash -c '
  set -euo pipefail
  mkdir -p /work && tar -x --no-same-owner -f - -C /work && cd /work
  stage() { echo; echo "== $*"; "$@"; }
  stage corepack pnpm install --frozen-lockfile
  stage corepack pnpm lint
  stage corepack pnpm typecheck
  stage corepack pnpm test --maxWorkers=2
  stage corepack pnpm build
  # R135: one Playwright project per run, so only one browser set (and its servers) is alive at a
  # time. The names come from playwright.config.ts, so a project added there runs here too.
  projects=$(node --input-type=module -e "const c = (await import(\"./playwright.config.ts\")).default; console.log(c.projects.map((p) => p.name).join(\" \"))")
  [ -n "$projects" ] || { echo "no Playwright projects found"; exit 1; }
  for p in $projects; do stage corepack pnpm test:e2e --project="$p"; done
  echo; echo "== all stages passed"
'
