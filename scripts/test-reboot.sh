#!/usr/bin/env bash
# The reboot check (pnpm test:reboot; pre-flight F1, ruling R106): a container of
# Dockerfile.reboot boots with systemd as PID 1, builds the release, turns on linger for dev
# (the container's own state, never the host's), and dev installs Kage with the real install.sh
# from a local fake release and starts a task through the board's API (the fake claude). Then
# `docker restart`: within 30 s the user unit is active again, the board answers, and the task
# shows as ended (its tmux window didn't survive the restart).
#
# No --privileged and no added capability. systemd needs a writable cgroup tree, which Docker
# gives an unprivileged container only through the host's (the Docker VM's) cgroup namespace:
#   --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
#   --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec,mode=1777
# (--cgroupns=private, read-only or with that volume, stops systemd at "Failed to allocate
# manager object".) Only the files git tracks are copied in. Needs Docker. Prints
# "== reboot check passed", or stops at the first broken stage.
#
# The same file runs the stages inside: --prepare (root), --install, --back and --after (dev).
set -euo pipefail

PORT=4397
BOARD=http://127.0.0.1:$PORT
DEMO=/home/dev/projects/demo

stage() { echo; echo "== $*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

# until <seconds> <command…>: polls every 0.25 s until the command succeeds.
until_ok() {
  local end=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt $end ] || return 1
    sleep 0.25
  done
}

prepare() {
  cd /work
  stage 'pnpm install'
  corepack pnpm install --frozen-lockfile
  stage 'release:local (linux-x64)'
  corepack pnpm release:local
  install -d /opt/fakes
  install -m 755 scripts/install-fakes/tailscale /opt/fakes/
  install -d -o dev -g dev /home/dev/.npm-global /home/dev/.npm-global/bin
  install -o dev -g dev -m 755 scripts/install-fakes/claude /home/dev/.npm-global/bin/claude
  stage 'linger for dev (inside the container)'
  loginctl enable-linger dev
  until_ok 15 systemctl is-active -q user@1000.service || fail "dev's user manager didn't start"
  loginctl show-user dev -p Linger
}

# The board's cookie for the token in dev's config, in $1.
board_login() {
  local token
  token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' \
    "$HOME/.config/kage/config.json")
  curl -fsS -c "$1" -o /dev/null -X POST -H 'X-Kage: 1' -H "Origin: $BOARD" \
    -H 'Content-Type: application/json' --data "{\"token\":\"$token\"}" "$BOARD/api/login"
}

# The statuses of the board's sessions (from its first event), one per line.
board_statuses() {
  local jar
  jar=$(mktemp)
  board_login "$jar"
  # The event stream stays open: curl ends it after 2 s (exit 28, expected).
  { curl -sS -N --max-time 2 -b "$jar" "$BOARD/api/events" 2>/dev/null || true; } |
    node -e '
      let text = "";
      process.stdin.on("data", (b) => (text += b)).on("end", () => {
        const line = text.split("\n").find((l) => l.startsWith("data: "));
        const snap = line ? JSON.parse(line.slice(6)) : { sessions: [] };
        for (const s of snap.sessions) console.log(s.status);
      });'
  rm -f "$jar"
}

install_kage() {
  cd /work
  local tmp
  tmp=$(mktemp -d)
  node scripts/release-server.mjs dist/release >"$tmp/release.log" 2>&1 &
  local server=$!
  until_ok 10 grep -q '^listening ' "$tmp/release.log" || fail 'the release server never said listening'
  local base
  base=http://127.0.0.1:$(sed -n 's/^listening //p' "$tmp/release.log")

  stage 'a project to start a task in'
  git config --global user.name 'Kage Check'
  git config --global user.email check@example.invalid
  git config --global init.defaultBranch main
  mkdir -p "$DEMO"
  (cd "$DEMO" && git init -q && echo '# Demo' >README.md && git add README.md && git commit -qm 'Start the demo')

  # R116: our checks pass --no-linger; root turned linger on already, as F1 says.
  local line="curl -fsSL $base/install.sh | KAGE_RELEASE_BASE=$base KAGE_INSTALL_DIR=\"\$HOME/my bin\" sh -s -- --yes --no-linger --host 127.0.0.1 --port $PORT --projects ~/projects"
  stage "install with the real systemd: $line"
  local out
  out=$(script -qec "$line" /dev/null 2>&1) || { echo "$out"; fail 'install.sh or kage setup failed'; }
  echo "${out//$'\r'/}"
  kill "$server"
  grep -qF "Kage is running at $BOARD" <<<"$out" || fail 'setup did not see Kage answer'
  [ "$(systemctl --user is-active kage.service)" = active ] || fail 'kage.service is not active'
  systemctl --user is-enabled kage.service | grep -qx enabled || fail 'kage.service is not enabled'

  stage 'a task started from the board'
  local jar code
  jar=$(mktemp)
  board_login "$jar"
  code=$(curl -sS -o "$tmp/start.json" -w '%{http_code}' -b "$jar" -X POST -H 'X-Kage: 1' \
    -H "Origin: $BOARD" -H 'Content-Type: application/json' \
    --data '{"project":"demo","base":"main","task":"Write the notes","acceptEdits":false}' \
    "$BOARD/api/sessions")
  cat "$tmp/start.json"; echo
  [ "$code" = 201 ] || fail "starting a task answered HTTP $code"
  until_ok 15 grep -qx 'SessionStart: exit 0 output \[\]' "$HOME/fake-claude.log.hooks" ||
    fail "the task's claude never ran its SessionStart hook"
  # shellcheck disable=SC2016 # expanded by that sh
  until_ok 15 sh -c '"$HOME/my bin/kage" status | grep -qx "Sessions: 1"' || fail 'kage status never showed Sessions: 1'
  "$HOME/my bin/kage" status
  board_statuses
}

# The service is back: the unit is active and the board answers.
back() {
  [ "$(systemctl --user is-active kage.service 2>/dev/null)" = active ] &&
    curl -fsS -o /dev/null "$BOARD/"
}

after() {
  "$HOME/my bin/kage" status
  "$HOME/my bin/kage" status | grep -qx 'Service: running (systemd user unit kage.service)' ||
    fail 'kage status does not see the service running'
  local statuses=
  for _ in $(seq 60); do
    statuses=$(board_statuses | tr '\n' ' ')
    [ "$statuses" = 'ended ' ] && break
    sleep 0.25
  done
  [ "$statuses" = 'ended ' ] || fail "the task doesn't show as ended: $statuses"
  echo "the task shows as: $statuses"
}

case ${1:-} in
  --prepare) prepare; exit ;;
  --install) install_kage; exit ;;
  --back) back; exit ;;
  --after) after; exit ;;
esac

# Git Bash would rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/.."
node_version=$(tr -d ' \r\n' <.node-version)
image=kage-reboot:node-$node_version
name=kage-reboot-check-$$
# shellcheck disable=SC2054 # the commas are tmpfs options
flags=(--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec,mode=1777)
as_dev=(-u dev -w /work -e HOME=/home/dev -e USER=dev -e LOGNAME=dev -e SHELL=/bin/bash
  -e TERM=xterm -e XDG_RUNTIME_DIR=/run/user/1000
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
  -e PATH=/home/dev/.npm-global/bin:/opt/fakes:/usr/local/bin:/usr/bin:/bin)

echo "== building $image"
docker build --quiet --build-arg "NODE_VERSION=$node_version" --tag "$image" - <Dockerfile.reboot >/dev/null

trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
echo "== booting $name with systemd as PID 1: docker run ${flags[*]}"
docker run -d --name "$name" "${flags[@]}" "$image" >/dev/null
booted() { docker exec "$name" systemctl is-system-running 2>/dev/null | grep -qxE 'running|degraded'; }
until_ok 60 booted || { docker logs "$name" | tail -n 30; fail 'systemd did not boot'; }
docker exec "$name" systemctl --failed --no-legend

echo "== copying $(git ls-files | wc -l | tr -d ' ') tracked files into it"
git ls-files -z | tar --null -T - -c -f - |
  docker exec -i "$name" bash -c 'mkdir -p /work && tar -x --no-same-owner -f - -C /work'
docker exec "$name" bash /work/scripts/test-reboot.sh --prepare
docker exec "${as_dev[@]}" "$name" bash /work/scripts/test-reboot.sh --install

stage 'docker restart: the service must be back within 30 s'
start=$SECONDS
docker restart "$name" >/dev/null
restarted=$((SECONDS - start))
up() { docker exec "${as_dev[@]}" "$name" bash /work/scripts/test-reboot.sh --back; }
until_ok $((30 - restarted)) up || {
  docker exec "${as_dev[@]}" "$name" bash -c 'systemctl --user status kage.service --no-pager; journalctl --user -u kage --no-pager | tail -n 30' || true
  fail "the service wasn't back within 30 s of docker restart"
}
echo "docker restart took ${restarted} s; the service and the board were back $((SECONDS - start)) s after it began"
docker exec "${as_dev[@]}" "$name" bash /work/scripts/test-reboot.sh --after

echo
echo '== reboot check passed'
