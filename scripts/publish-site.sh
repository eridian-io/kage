#!/usr/bin/env bash
# Publishes the committed site/ folder to the root of the gh-pages branch.
#
#   scripts/publish-site.sh [remote]        # remote defaults to origin
#   DRY_RUN=1 scripts/publish-site.sh       # build the commit, print it, push nothing
#
# It builds the gh-pages commit straight from the tree of HEAD:site, so the working tree,
# the index and every other branch stay untouched. It only ever pushes refs/heads/gh-pages.
# Uncommitted changes in site/ are not published: commit them first.
set -euo pipefail

remote="${1:-origin}"
readonly target="refs/heads/gh-pages"

cd "$(git rev-parse --show-toplevel)"

src="$(git rev-parse --verify HEAD)"
short="$(git rev-parse --short HEAD)"
if ! tree="$(git rev-parse --verify --quiet "HEAD:site")" ||
  [ "$(git cat-file -t "$tree")" != "tree" ]; then
  echo "publish-site: HEAD has no site/ folder." >&2
  exit 1
fi
if ! git cat-file -e "HEAD:site/index.html" 2>/dev/null; then
  echo "publish-site: site/index.html isn't committed." >&2
  exit 1
fi
if ! git diff --quiet HEAD -- site || [ -n "$(git ls-files --others --exclude-standard -- site)" ]; then
  echo "publish-site: site/ has uncommitted changes; publishing the committed version ($short)." >&2
fi

# Keep gh-pages history: the previous gh-pages commit, if any, becomes the parent.
parent=()
if git fetch --quiet --no-tags "$remote" "$target" 2>/dev/null; then
  old="$(git rev-parse FETCH_HEAD)"
  if [ "$(git rev-parse "$old^{tree}")" = "$tree" ]; then
    echo "publish-site: gh-pages on $remote already matches site/ at $short."
    exit 0
  fi
  parent=(-p "$old")
fi

commit="$(git commit-tree "$tree" ${parent[@]+"${parent[@]}"} \
  -m "Publish site from $short" \
  -m "Source commit: $src")"

if [ -n "${DRY_RUN:-}" ]; then
  echo "publish-site: built $commit from site/ at $short (dry run, nothing pushed)."
  git ls-tree -r --name-only "$commit"
  exit 0
fi

# The refspec names gh-pages explicitly, so no other branch can move.
git push --force "$remote" "$commit:$target"
echo "publish-site: pushed $commit to $remote gh-pages (from $short)."
