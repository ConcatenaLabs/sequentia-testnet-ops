#!/bin/sh
# Install this checkout's download pages, point their cards at the newest files, and check every file they link exists.
# Usage: bin/apply-downloads.sh            (run on the box, from the checkout; SEQ_DOWNLOAD_DIR and SEQ_PUBLISHER move it elsewhere)
set -eu
case "${1:-}" in -h|--help) sed -n 2,3p "$0" | sed 's/^# //'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT="${SEQ_DOWNLOAD_DIR:-/root/sequentia/downloads}"
# The release publisher's own clone. Its run rewrites every card to the newest
# file present, so the pages installed here never offer an older version than
# the box holds, whatever version this checkout's copy names.
PUBLISHER="${SEQ_PUBLISHER:-/root/sequentia/release-build/publisher/contrib/sequentia/release-publisher/publish-release.sh}"
missing=0
# Two pages: the full one at /download/ and the Sequentia Core one at
# /download/core/, whose links reach the same files through "../".
for page in index.html core/index.html; do
  dest="$ROOT/$page"
  mkdir -p "$(dirname "$dest")"
  cp -p "$dest" "$dest.bak-apply-$(date +%s)" 2>/dev/null || true
  install -m 644 "$HERE/downloads/$page" "$dest"
done
# A recipe list that names no product: the run builds nothing; it repoints the
# cards and rewrites the checksums and their signature. When a release build
# holds the publisher's lock, this run stops at once, and that build repoints
# both pages itself as it ends.
if [ -x "$PUBLISHER" ]; then
  SEQ_ONLY=repoint-only SEQ_DOWNLOAD_DIR="$ROOT" "$PUBLISHER"
else
  echo "apply-downloads: no release publisher at $PUBLISHER; the cards name this checkout's files" >&2
fi
for page in index.html core/index.html; do
  for f in $(grep -oE 'href="(\.\./)?[^"/:]+\.(apk|zip|tar\.gz|dmg|exe|AppImage)"' "$ROOT/$page" | sed 's/href="//; s/"$//; s#^\.\./##' | sort -u); do
    [ -e "$ROOT/$f" ] || { echo "apply-downloads: $page links $f, which is not on the box" >&2; missing=1; }
  done
done
[ "$missing" = 0 ] && echo "apply-downloads: installed both pages; every linked file is present" || exit 1
