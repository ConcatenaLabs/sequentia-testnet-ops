#!/bin/sh
# Keep dated copies of the box's hand-edited host configuration: the
# Caddyfile and the systemd drop-ins. Secrets files are NOT copied here; they
# are backed up with the offline backups, and the Caddyfile holds none.
set -eu
case "${1:-}" in -h|--help) sed -n 2,4p "$0" | sed 's/^# //'; exit 0 ;; esac
DEST=${BOX_BACKUP_DIR:-/var/backups/box}
KEEP=${BOX_BACKUP_KEEP:-60}
mkdir -p "$DEST"; chmod 700 "$DEST"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tar -czf "$DEST/.partial.$$" -C / etc/caddy/Caddyfile etc/systemd/system/caddy.service.d $(cd / && ls -d etc/systemd/system/*.service.d 2>/dev/null | grep -v caddy || true)
mv "$DEST/.partial.$$" "$DEST/box-config-$stamp.tar.gz"
ls -1 "$DEST"/box-config-*.tar.gz | sort | head -n -"$KEEP" | xargs -r rm -f
echo "box-config-backup: $DEST/box-config-$stamp.tar.gz"
