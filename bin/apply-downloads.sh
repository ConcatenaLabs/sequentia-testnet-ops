#!/bin/sh
# Install this checkout's download page and check every file it links exists.
# Usage: bin/apply-downloads.sh            (run on the box, from the checkout)
set -eu
case "${1:-}" in -h|--help) sed -n 2,3p "$0" | sed 's/^# //'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=/root/sequentia/downloads/index.html
cp -p "$DEST" "$DEST.bak-apply-$(date +%s)" 2>/dev/null || true
install -m 644 "$HERE/downloads/index.html" "$DEST"
missing=0
for f in $(grep -oE 'href="[^"/:]+\.(apk|zip|tar\.gz|dmg|exe|AppImage)"' "$DEST" | sed 's/href="//; s/"$//' | sort -u); do
  [ -e "/root/sequentia/downloads/$f" ] || { echo "apply-downloads: the page links $f, which is not on the box" >&2; missing=1; }
done
[ "$missing" = 0 ] && echo "apply-downloads: installed; every linked file is present" || exit 1
