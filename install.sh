#!/bin/sh
# The Kage installer: https://github.com/eridian-io/kage
#
#   curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh -s -- --yes
#
# What it does, in order, and nothing else:
#   1. picks the build for this machine: Linux or macOS, x64 or arm64;
#   2. downloads it and SHA256SUMS from the latest stable release, over HTTPS only;
#   3. checks the build's sha256 against SHA256SUMS, and stops if they differ;
#   4. puts it at ~/.local/bin/kage (or $KAGE_INSTALL_DIR/kage) in one rename;
#   5. if that folder isn't on PATH, adds one export line to your shell's start-up file;
#   6. runs "kage setup" in your terminal (arguments after "sh -s --" go to it). Setup asks
#      before it changes anything. KAGE_NO_SETUP=1 skips this step.
# It runs as your own user and refuses root. KAGE_RELEASE_BASE names another release folder:
# https, or plain http on 127.x or localhost only (for tests).
#
# Everything happens inside main, called on the last line, so a download cut short runs nothing.

set -eu

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# The sha256 of a file, as lowercase hex.
sha() {
  if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'
}

# True for localhost or a 127.x address (the host part of a URL, port removed).
loopback() {
  case $1 in
    localhost) return 0 ;;
    *[!0-9.]*) return 1 ;;
    127.*) return 0 ;;
  esac
  return 1
}

# Download $1 to $2. Redirects must stay on HTTPS (GitHub serves files from another host).
fetch() {
  curl -fsSL --proto "$proto" --proto-redir '=https' --tlsv1.2 -o "$2" "$1" ||
    die "Couldn't download $1. Nothing was installed."
}

# R114: add the PATH line to one start-up file, once. Doctor names the same files (path-rc.ts).
add_path() {
  if [ -f "$1" ] && grep -qxF "$line" "$1"; then
    say "$1 already adds $dir to your PATH."
  elif printf '\n# Added by the Kage installer.\n%s\n' "$line" 2>/dev/null >>"$1"; then
    say "Added $dir to your PATH in $1."
  else
    say "Couldn't change $1. Add this line to it: $line"
  fi
}

main() {
  uid=$(id -u)
  [ "$uid" != 0 ] || die 'Run the installer as your own user, not root.'

  os=$(uname -s)
  arch=$(uname -m)
  case $os in
    Linux) target=linux ;;
    Darwin) target=darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      die 'On Windows, install Kage inside WSL: https://learn.microsoft.com/windows/wsl/install' ;;
    *) die "Kage has no build for $os $arch." ;;
  esac
  case $arch in
    x86_64 | amd64) target=$target-x64 ;;
    aarch64 | arm64) target=$target-arm64 ;;
    *) die "Kage has no build for $os $arch." ;;
  esac
  asset=kage-$target.gz

  missing=
  for tool in curl gunzip; do have "$tool" || missing=${missing:+$missing, }$tool; done
  have sha256sum || have shasum || missing=${missing:+$missing, }sha256sum
  [ -z "$missing" ] || die "Install $missing, then run the installer again."

  base=${KAGE_RELEASE_BASE:-https://github.com/eridian-io/kage/releases/latest/download}
  base=${base%/}
  proto='=https'
  case $base in
    https://*) ;;
    http://*)
      host=${base#http://}
      host=${host%%/*}
      loopback "${host%:*}" || die 'KAGE_RELEASE_BASE must be an https URL.'
      proto='=http' ;;
    *) die 'KAGE_RELEASE_BASE must be an https URL.' ;;
  esac

  dir=${KAGE_INSTALL_DIR:-$HOME/.local/bin}
  case $dir in /*) ;; *) dir=$(pwd)/$dir ;; esac
  dir=${dir%/}
  new=$dir/.kage-new.$$

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"; rm -f "$new"' EXIT
  trap 'exit 130' INT TERM

  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  fetch "$base/$asset" "$tmp/$asset"
  # The line naming exactly this file (sha256sum's text or binary form), never a partial match.
  want=$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/SHA256SUMS")
  got=$(sha "$tmp/$asset")
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    die "Checksum check failed for $asset. Nothing was installed."
  fi

  # Unpack next to the old program, then rename over it: same file system, so one atomic step.
  # A regular file at a path that lasts, because Claude's hooks name it (R110-5).
  mkdir -p "$dir"
  gunzip -c "$tmp/$asset" >"$new"
  chmod 755 "$new"
  mv -f "$new" "$dir/kage"
  rm -rf "$tmp" # exec below skips the EXIT trap

  case :$PATH: in
    *:"$dir":*) ;;
    *)
      line="export PATH=\"$dir:\$PATH\""
      case ${SHELL:-} in
        */zsh | zsh) add_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
        */bash | bash)
          add_path "$HOME/.bashrc"
          if [ -f "$HOME/.bash_profile" ]; then
            add_path "$HOME/.bash_profile"
          else
            add_path "$HOME/.profile"
          fi ;;
        *) add_path "$HOME/.profile" ;;
      esac
      say 'Open a new terminal to run kage by name.' ;;
  esac

  if [ "${KAGE_NO_SETUP:-}" != 1 ] && (: </dev/tty) 2>/dev/null; then
    say "Installed $dir/kage."
    exec "$dir/kage" setup "$@" </dev/tty
  fi
  say "Installed $dir/kage. Run \"kage setup\" in a terminal to finish."
}

main "$@"
