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

echo "== building $image"
# No build context: the Dockerfile needs no files from here.
docker build --quiet --tag "$image" - < Dockerfile.test >/dev/null

echo "== copying $(git ls-files | wc -l | tr -d ' ') tracked files into a fresh container"
git ls-files -z | tar --null -T - -c -f - | docker run --rm -i --init "$image" bash -c '
  set -euo pipefail
  mkdir -p /work && tar -x --no-same-owner -f - -C /work && cd /work
  stage() { echo; echo "== $*"; "$@"; }
  stage corepack pnpm install --frozen-lockfile
  stage corepack pnpm lint
  stage corepack pnpm typecheck
  stage corepack pnpm test
  stage corepack pnpm build
  stage corepack pnpm test:e2e
  echo; echo "== all stages passed"
'
