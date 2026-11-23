#!/usr/bin/env bash
# The clean-install check (pnpm test:install): in a fresh container of Node's release image
# (Dockerfile.install, NODE_VERSION from .node-version) with no Kage, it builds the release, then
# as the user dev runs the real install.sh from a local fake release (scripts/release-server.mjs
# on 127.0.0.1), kage setup --yes, a fake claude through the hooks, kage update, a tampered
# update and kage uninstall. systemd doesn't run there: scripts/install-fakes/systemctl starts
# the unit's own ExecStart= with its own Environment= (pnpm test:reboot runs the real systemd).
# Only the files git tracks are copied in (as they are in the working tree); nothing from the
# host is mounted. Works from Git Bash on Windows and from Linux or macOS. Needs Docker.
#
# The same file runs the stages inside: --in-container (root) and --as-dev (every user stage).
# It prints "== install check passed", or stops at the first broken stage with what it saw.
# The trap and until_ok call some functions indirectly:
# shellcheck disable=SC2317
set -euo pipefail

stage() { echo; echo "== $*"; }

in_container() {
  cd /work
  stage 'pnpm install'
  corepack pnpm install --frozen-lockfile
  stage 'release:local (linux-x64)'
  corepack pnpm release:local
  [ -f dist/release/kage-linux-x64.gz ] || { echo 'FAILED: release:local made no kage-linux-x64.gz' >&2; exit 1; }
  # dev rebuilds the release in stage 6, so the tree becomes dev's.
  chown -R dev:dev /work
  install -d /opt/fakes
  install -m 755 scripts/install-fakes/systemctl scripts/install-fakes/loginctl \
    scripts/install-fakes/tailscale /opt/fakes/
  # Review Focus 5: claude where npm's user prefix puts it, not on systemd's default PATH.
  install -d -o dev -g dev /home/dev/.npm-global /home/dev/.npm-global/bin
  install -o dev -g dev -m 755 scripts/install-fakes/claude /home/dev/.npm-global/bin/claude
  exec runuser -u dev -- env -i HOME=/home/dev USER=dev LOGNAME=dev SHELL=/bin/bash TERM=xterm \
    LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1000 \
    PATH=/home/dev/.npm-global/bin:/opt/fakes:/usr/local/bin:/usr/bin:/bin \
    bash /work/scripts/test-install.sh --as-dev
}

as_dev() {
  cd /work
  local fakes=$XDG_RUNTIME_DIR/fake-systemd
  local tmp
  tmp=$(mktemp -d)
  local bin="$HOME/my bin"
  local kage="$bin/kage"
  local cfg=$HOME/.config/kage/config.json
  local unit=$HOME/.config/systemd/user/kage.service
  local state=$HOME/.local/state/kage
  local demo=$HOME/projects/demo
  local fake_log=$HOME/fake-claude.log
  server_pid= # global: the EXIT trap runs after as_dev returns

  cleanup() {
    tmux kill-server 2>/dev/null || true
    [ -z "${server_pid:-}" ] || kill "$server_pid" 2>/dev/null || true
  }
  trap cleanup EXIT
  fail() {
    echo "FAILED: $*" >&2
    for f in "$fakes/calls" "$fakes/kage.service.journal" "$fake_log.hooks" "$tmp/release.log"; do
      [ -f "$f" ] && { echo "--- $f" >&2; tail -n 40 "$f" >&2; }
    done
    exit 1
  }
  # until <seconds> <command…>: polls every 0.25 s until the command succeeds.
  until_ok() {
    local end=$((SECONDS + $1))
    shift
    until "$@" >/dev/null 2>&1; do
      [ $SECONDS -lt $end ] || return 1
      sleep 0.25
    done
  }
  has() { grep -qF -- "$2" <<<"$1"; }
  sessions() { "$kage" status 2>/dev/null | grep -qx "Sessions: $1"; }
  running_pid() { cat "$fakes/kage.service.pid" 2>/dev/null; }

  stage 'a fake release on 127.0.0.1 and a project with a worktree'
  node scripts/release-server.mjs dist/release >"$tmp/release.log" 2>&1 &
  server_pid=$!
  until_ok 10 grep -q '^listening ' "$tmp/release.log" || fail 'the release server never said listening'
  local port
  port=$(sed -n 's/^listening //p' "$tmp/release.log")
  local base=http://127.0.0.1:$port
  echo "release at $base"
  git config --global user.name 'Kage Check'
  git config --global user.email check@example.invalid
  git config --global init.defaultBranch main
  mkdir -p "$demo"
  (cd "$demo" && git init -q && echo '# Demo' >README.md && git add README.md &&
    git commit -qm 'Start the demo' && git worktree add -q .worktrees/x -b kage/x)
  command -v claude | grep -qx "$HOME/.npm-global/bin/claude" || fail 'claude is not the fake in ~/.npm-global/bin'
  command -v systemctl | grep -qx /opt/fakes/systemctl || fail 'systemctl is not the fake'

  # The documented one-liner, under script(1) for a terminal (install.sh runs setup on /dev/tty).
  local install_line="curl -fsSL $base/install.sh | KAGE_RELEASE_BASE=$base KAGE_INSTALL_DIR=\"\$HOME/my bin\" sh -s -- --yes --host 127.0.0.1 --port 4397 --projects ~/projects"
  stage "install: $install_line"
  local out
  out=$(script -qec "$install_line" /dev/null 2>&1) || { echo "$out"; fail 'install.sh or kage setup failed'; }
  out=${out//$'\r'/}
  echo "$out"
  [ -x "$kage" ] || fail "no program at $kage"
  has "$out" "Installed $kage." || fail 'install.sh did not say where it installed'
  has "$out" "Added $bin to your PATH in $HOME/.bashrc." || fail 'no PATH line in ~/.bashrc'
  has "$out" 'Kage is running at http://127.0.0.1:4397' || fail 'setup did not see Kage answer'
  # As a new terminal would have it.
  export PATH="$bin:$PATH"

  stage 'after install: config, unit, board, status, doctor'
  [ "$(stat -c %a "$cfg")" = 600 ] || fail "$cfg is not 0600"
  local token
  token=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.token === "string" ? c.token : "")' "$cfg")
  [ ${#token} -ge 16 ] || fail 'the config holds no token'
  echo "config: 0600 with a ${#token}-character token"
  cat "$unit"
  grep -qx "ExecStart=\"$kage\" \"serve\"" "$unit" || fail 'ExecStart is not the installed program and serve'
  grep -q '^Environment=.*"MALLOC_ARENA_MAX=2"' "$unit" || fail 'the unit has no MALLOC_ARENA_MAX=2'
  grep -q "^Environment=.*\"PATH=[^\"]*$HOME/.npm-global/bin" "$unit" || fail "the unit's PATH misses claude's folder"
  ! grep -qF -- "$token" "$unit" || fail 'the unit holds the token'
  until_ok 15 sessions 0 || fail 'kage status never showed Sessions: 0'
  local pid
  pid=$(running_pid)
  # R91 for the SEA: --v8-pool-size=1 lives in the executable's execArgv, so one V8 worker.
  local workers
  workers=$(cat /proc/"$pid"/task/*/comm | grep -c '^V8Worker' || true)
  echo "service pid $pid, V8 worker threads: $workers"
  [ "$workers" = 1 ] || fail "the service runs $workers V8 worker threads, not 1 (--v8-pool-size=1)"
  tr '\0' '\n' <"/proc/$pid/environ" | grep -qx MALLOC_ARENA_MAX=2 || fail 'the service has no MALLOC_ARENA_MAX=2'
  local page
  page=$(curl -fsS http://127.0.0.1:4397/) || fail 'the board does not answer'
  has "$page" '<title>' || fail 'the board did not answer with its page'
  "$kage" status
  local doctor code=0
  doctor=$("$kage" doctor 2>&1) || code=$?
  echo "$doctor"
  [ $code = 0 ] || fail "kage doctor exited $code"
  # The one warning a container gives: no Claude sign-in (an existence check, never read).
  local warns
  warns=$(grep '^! ' <<<"$doctor" || true)
  [ "$warns" = '! Claude Code may not be signed in. Run claude once and sign in.' ] ||
    fail "kage doctor warned about more than Claude's sign-in: $warns"

  stage 'a task as the README starts one: claude in a window of the tmux session kage'
  tmux new-window -t kage -c "$demo/.worktrees/x" "exec claude --settings '$(kage hooks-path)' --permission-mode default"
  until_ok 15 sessions 1 || fail 'kage status never showed Sessions: 1'
  "$kage" status
  cat "$fake_log.hooks"
  grep -qx 'SessionStart: exit 0 output \[\]' "$fake_log.hooks" || fail 'the SessionStart hook did not run cleanly'
  grep -qx 'Stop: exit 0 output \[\]' "$fake_log.hooks" || fail 'the Stop hook did not run cleanly'
  ! grep -q '^MALLOC_ARENA_MAX=' "$fake_log" || fail 'claude inherited MALLOC_ARENA_MAX'
  ! grep -q '^NODE_OPTIONS=' "$fake_log" || fail 'claude inherited NODE_OPTIONS'
  ! grep -q '^KAGE_SERVICE=' "$fake_log" || fail 'claude inherited KAGE_SERVICE'
  echo "claude's environment has no MALLOC_ARENA_MAX, NODE_OPTIONS or KAGE_SERVICE"

  stage 'kage update to 0.0.1-test.2'
  local old
  old=$("$kage" --version)
  node packages/server/src/release/build.ts --out dist/release --version-override 0.0.1-test.2
  out=$(KAGE_RELEASE_BASE=$base "$kage" update 2>&1) || { echo "$out"; fail 'kage update failed'; }
  echo "$out"
  has "$out" "Updated Kage $old → 0.0.1-test.2." || fail 'kage update did not say Updated Kage'
  [ "$("$kage" --version)" = 0.0.1-test.2 ] || fail 'kage --version is not 0.0.1-test.2'
  grep -qx 'systemctl --user restart kage.service' "$fakes/calls" || fail 'the service was not restarted'
  [ -f "$kage.previous" ] || fail 'no kage.previous kept for going back'
  until_ok 15 sessions 1 || fail 'the restarted service does not show the session'
  [ "$(running_pid)" != "$pid" ] || fail 'the service process is the old one'

  stage 'a tampered SHA256SUMS: kage update --force refuses'
  cp dist/release/SHA256SUMS "$tmp/SHA256SUMS"
  sed -i "s/^[0-9a-f]\{64\}  kage-linux-x64.gz\$/$(printf '0%.0s' $(seq 64))  kage-linux-x64.gz/" dist/release/SHA256SUMS
  ! cmp -s dist/release/SHA256SUMS "$tmp/SHA256SUMS" || fail 'SHA256SUMS did not change'
  code=0
  out=$(KAGE_RELEASE_BASE=$base "$kage" update --force 2>&1) || code=$?
  echo "$out"
  [ $code != 0 ] || fail 'kage update --force passed with a bad checksum'
  has "$out" 'checksum mismatch' || fail 'kage update did not say checksum mismatch'
  [ "$("$kage" --version)" = 0.0.1-test.2 ] || fail 'kage --version changed after a refused update'
  cp "$tmp/SHA256SUMS" dist/release/SHA256SUMS

  stage 'kage uninstall --yes keeps the work and the config'
  pid=$(running_pid)
  out=$("$kage" uninstall --yes 2>&1) || { echo "$out"; fail 'kage uninstall failed'; }
  echo "$out"
  [ ! -e "$kage" ] || fail 'the program is still there'
  [ ! -e "$kage.previous" ] || fail 'kage.previous is still there'
  [ ! -e "$unit" ] || fail 'the unit is still there'
  ! kill -0 "$pid" 2>/dev/null || fail 'the service still runs'
  [ -d "$demo/.worktrees/x" ] || fail 'the worktree is gone'
  git -C "$demo" rev-parse -q --verify kage/x >/dev/null || fail 'the branch is gone'
  tmux has-session -t kage || fail 'the tmux session kage is gone'
  [ -f "$cfg" ] || fail 'the config is gone without --purge'
  [ ! -e "$state/claude-settings.json" ] || fail "Kage's hooks file is still there"
  # R120: the marker and the PATH line stay, and uninstall names them.
  local n
  n=$(grep -nxF "export PATH=\"$bin:\$PATH\"" "$HOME/.bashrc" | cut -d: -f1)
  [ -n "$n" ] || fail 'uninstall edited ~/.bashrc'
  has "$out" "Kept: lines $((n - 1))-$n of ~/.bashrc, which the installer added for your PATH." ||
    fail 'uninstall did not name the PATH lines in ~/.bashrc'

  stage 'install again, then kage uninstall --yes --purge'
  out=$(script -qec "$install_line" /dev/null 2>&1) || { echo "$out"; fail 'the second install failed'; }
  out=${out//$'\r'/}
  echo "$out"
  has "$out" 'Kage is running at http://127.0.0.1:4397' || fail 'the second setup did not see Kage answer'
  out=$("$kage" uninstall --yes --purge 2>&1) || { echo "$out"; fail 'kage uninstall --purge failed'; }
  echo "$out"
  [ ! -e "$kage" ] || fail 'the program is still there'
  [ ! -e "$unit" ] || fail 'the unit is still there'
  [ ! -e "$HOME/.config/kage" ] || fail 'the config folder is still there'
  [ ! -e "$state" ] || fail 'the state folder is still there'
  [ -d "$demo/.worktrees/x" ] || fail 'the projects did not survive --purge'
  tmux has-session -t kage || fail 'the tmux session kage did not survive --purge'

  echo
  echo '== install check passed'
}

case ${1:-} in
  --in-container) in_container; exit ;;
  --as-dev) as_dev; exit ;;
esac

# Git Bash would rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/.."
node_version=$(tr -d ' \r\n' <.node-version)
image=kage-install:node-$node_version

echo "== building $image"
# No build context: the Dockerfile needs no files from here.
docker build --quiet --build-arg "NODE_VERSION=$node_version" --tag "$image" - <Dockerfile.install >/dev/null

echo "== copying $(git ls-files | wc -l | tr -d ' ') tracked files into a fresh container"
git ls-files -z | tar --null -T - -c -f - | docker run --rm -i --init "$image" bash -c '
  set -euo pipefail
  mkdir -p /work && tar -x --no-same-owner -f - -C /work
  exec bash /work/scripts/test-install.sh --in-container
'
