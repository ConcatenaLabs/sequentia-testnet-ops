#!/bin/sh
# Publish the tester guide at /docs/: pull the sequentia-docs clone, build it
# with its own build.sh (a pinned, checksummed mdBook) and install the result
# in /srv/docs, which the Caddyfile serves.
# Usage: bin/apply-docs.sh            (run on the box)
set -eu
case "${1:-}" in -h|--help) sed -n 2,5p "$0" | sed 's/^# //'; exit 0 ;; esac
SRC=${DOCS_SRC:-/root/sequentia/sequentia-docs}
DEST=/srv/docs
if [ ! -d "$SRC/.git" ]; then
  git clone -q https://github.com/ConcatenaLabs/sequentia-docs.git "$SRC"
fi
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { echo "apply-docs: uncommitted changes in $SRC" >&2; exit 1; }
git -C "$SRC" fetch -q origin
git -C "$SRC" checkout -q main
git -C "$SRC" merge -q --ff-only origin/main
"$SRC/build.sh" >/dev/null
[ -f "$SRC/book/index.html" ] || { echo "apply-docs: the build left no book/index.html" >&2; exit 1; }
rm -rf /srv/docs.new
cp -a "$SRC/book" /srv/docs.new
chmod -R a+rX /srv/docs.new
[ ! -d "$DEST" ] || mv "$DEST" /srv/docs.old
mv /srv/docs.new "$DEST"
rm -rf /srv/docs.old
echo "apply-docs: /srv/docs holds sequentia-docs $(git -C "$SRC" rev-parse --short HEAD), $(find "$DEST" -name '*.html' | wc -l) pages"
