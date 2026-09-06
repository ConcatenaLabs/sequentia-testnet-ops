#!/bin/sh
# Keep dated copies of the reverse proxy's configuration: the Caddyfile and
# Caddy's own systemd drop-in. Nothing else under /etc is copied: another
# unit's drop-in may carry a token, and this copy is meant to hold no secret.
set -eu
case "${1:-}" in -h|--help) sed -n 2,4p "$0" | sed 's/^# //'; exit 0 ;; esac
DEST=${BOX_BACKUP_DIR:-/var/backups/box}
KEEP=${BOX_BACKUP_KEEP:-60}
mkdir -p "$DEST"; chmod 700 "$DEST"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tar -czf "$DEST/.partial.$$" -C / etc/caddy/Caddyfile etc/systemd/system/caddy.service.d
mv "$DEST/.partial.$$" "$DEST/box-config-$stamp.tar.gz"
ls -1 "$DEST"/box-config-*.tar.gz | sort | head -n -"$KEEP" | xargs -r rm -f
echo "box-config-backup: $DEST/box-config-$stamp.tar.gz"
