#!/bin/sh
# The Kage installer (https://github.com/eridian-io/kage). Setup flags go after "sh -s --":
#   curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh -s -- --yes
#
# It picks the build for this machine (Linux or macOS, x64 or arm64), downloads it and SHA256SUMS
# from the latest stable release over HTTPS only, stops unless the sha256 matches and the program
# runs here, renames it into ~/.local/bin/kage (or $KAGE_INSTALL_DIR/kage) in one step, adds that
# folder to PATH in your shell's start-up file if needed (KAGE_NO_MODIFY_PATH=1 only prints the
# line), then runs "kage setup" in your terminal, which asks first (KAGE_NO_SETUP=1 skips it). It
# refuses root. KAGE_RELEASE_BASE names another release folder: https, or http on 127.x/localhost.
# Everything happens inside main, called on the last line, so a download cut short runs nothing.

set -eu

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

sha() { if have sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# True for http://localhost or http://127.x (2 to 4 digit groups) with an optional all-digit
# port, and nothing else (no user@ part, no other host, no trailing dot).
loopback() {
  h=${1#http://} && h=${h%%/*}
  case $h in *@*) return 1 ;; esac
  case $h in *:*) case ${h##*:} in '' | *[!0-9]*) return 1 ;; esac ;; esac
  h=${h%:*}
  case $h in localhost) return 0 ;; *[!0-9.]* | *. | *..* | *.*.*.*.*) return 1 ;; 127.*) return 0 ;; esac
  return 1
}

# Download $1 to $2. Redirects must stay on HTTPS (GitHub serves files from another host).
fetch() {
  curl -fsSLg --proto "$proto" --proto-redir '=https' --tlsv1.2 -o "$2" "$1" ||
    die "Couldn't download $1. Nothing was installed."
}

# R114: add the PATH line to one start-up file, once. Doctor names the same files (path-rc.ts),
# and kage uninstall finds the marker line to say what to remove.
add_path() {
  if [ -f "$1" ] && grep -qxF "$line" "$1"; then
    say "$1 already adds $dir to your PATH." && fresh=1
  elif [ "${KAGE_NO_MODIFY_PATH:-}" = 1 ]; then
    say "To add $dir to your PATH, add this line to $1: $line"
  elif printf '\n# Added by the Kage installer.\n%s\n' "$line" 2>/dev/null >>"$1"; then
    say "Added $dir to your PATH in $1." && fresh=1
  else
    say "Couldn't change $1. Add this line to it: $line"
  fi
}

main() {
  # Everything the traps and later lines read starts empty here, never from the environment.
  new='' tmp='' missing='' fresh='' line=''
  uid=$(id -u)
  [ "$uid" != 0 ] || die 'Run the installer as your own user, not root.'

  os=$(uname -s)
  arch=$(uname -m)
  # A shell under Rosetta on Apple silicon says x86_64; the arm64 build is the right one.
  [ "$os" != Darwin ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" != 1 ] || arch=arm64
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

  for tool in curl gunzip; do have "$tool" || missing=${missing:+$missing, }$tool; done
  have sha256sum || have shasum || missing=${missing:+$missing, }sha256sum
  [ -z "$missing" ] || die "Install $missing, then run the installer again."

  base=${KAGE_RELEASE_BASE:-https://github.com/eridian-io/kage/releases/latest/download}
  base=${base%/}
  proto='=https'
  case $base in
    https://*) ;;
    http://*) loopback "$base" || die 'KAGE_RELEASE_BASE must be an https URL.'; proto='=http' ;;
    *) die 'KAGE_RELEASE_BASE must be an https URL.' ;;
  esac

  # The folder goes into a PATH line in double quotes, so it must not need escaping there.
  dir=${KAGE_INSTALL_DIR:-$HOME/.local/bin}
  case $dir in
    \~) dir=$HOME ;;
    \~/*) dir=$HOME/${dir#\~/} ;;
    \~*) die 'Give KAGE_INSTALL_DIR as a full path.' ;;
    /*) ;;
    *) dir=$(pwd)/$dir ;;
  esac
  case $dir in *[\"\$\`\\:]* | *'
'*) die "The install folder can't contain a quote, \$, a backtick, a backslash, a colon or a line break." ;;
  esac
  while [ "${dir%/}" != "$dir" ]; do dir=${dir%/}; done
  [ -n "$dir" ] || die "Kage can't be installed into /."
  [ ! -d "$dir/kage" ] || die "$dir/kage is a folder. Move it away, then run the installer again."

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"; [ -z "${new:-}" ] || rm -f "$new"' EXIT
  trap 'exit 130' HUP INT TERM

  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  fetch "$base/$asset" "$tmp/$asset"
  # The line naming exactly this file (sha256sum's text or binary form), never a partial match.
  want=$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/SHA256SUMS")
  got=$(sha "$tmp/$asset")
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    die "Checksum check failed for $asset. Nothing was installed."
  fi

  # Unpack beside the old program and rename over it (one atomic step), as a regular file at a
  # path that lasts, because Claude's hooks name it (R110-5).
  mkdir -p "$dir"
  new=$(mktemp "$dir/.kage-new.XXXXXX")
  gunzip -c "$tmp/$asset" >"$new"
  chmod 755 "$new"
  "$new" --version >/dev/null 2>&1 || die "This build doesn't run here (Kage needs glibc on Linux). Nothing was installed."
  mv -f "$new" "$dir/kage" && new=''
  rm -rf "$tmp" # exec below skips the EXIT trap

  case :$PATH: in
    *:"$dir":*) ;;
    *)
      line="export PATH=\"$dir:\$PATH\""
      case ${SHELL:-} in
        */zsh | zsh) add_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
        */bash | bash)
          add_path "$HOME/.bashrc"
          if [ -f "$HOME/.bash_profile" ]; then add_path "$HOME/.bash_profile"; else add_path "$HOME/.profile"; fi ;;
        *) add_path "$HOME/.profile" ;;
      esac ;;
  esac
  [ -z "$fresh" ] || say 'Open a new terminal to run kage by name.'

  if [ "${KAGE_NO_SETUP:-}" != 1 ] && (: </dev/tty) 2>/dev/null; then
    say "Installed $dir/kage."
    exec "$dir/kage" setup "$@" </dev/tty
  fi
  say "Installed $dir/kage. Run \"kage setup\" in a terminal to finish."
}

main "$@"
