#!/bin/sh
# Install this checkout's download pages and check every file they link exists.
# Usage: bin/apply-downloads.sh            (run on the box, from the checkout)
set -eu
case "${1:-}" in -h|--help) sed -n 2,3p "$0" | sed 's/^# //'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=/root/sequentia/downloads
missing=0
# Two pages: the full one at /download/ and the Sequentia Core one at
# /download/core/, whose links reach the same files through "../".
for page in index.html core/index.html; do
  dest="$ROOT/$page"
  mkdir -p "$(dirname "$dest")"
  cp -p "$dest" "$dest.bak-apply-$(date +%s)" 2>/dev/null || true
  install -m 644 "$HERE/downloads/$page" "$dest"
  for f in $(grep -oE 'href="(\.\./)?[^"/:]+\.(apk|zip|tar\.gz|dmg|exe|AppImage)"' "$dest" | sed 's/href="//; s/"$//; s#^\.\./##' | sort -u); do
    [ -e "$ROOT/$f" ] || { echo "apply-downloads: $page links $f, which is not on the box" >&2; missing=1; }
  done
done
[ "$missing" = 0 ] && echo "apply-downloads: installed both pages; every linked file is present" || exit 1
