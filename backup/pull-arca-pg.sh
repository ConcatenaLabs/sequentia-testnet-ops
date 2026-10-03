#!/bin/sh
# Pull the Arca operator's PostgreSQL backups off the box: every base backup
# and every streamed WAL segment under /var/backups/arca-pg. Run on an
# operator's machine (see backup/pull-arca-pg.timer). On the box every commit
# is in the WAL archive before it returns; this copy is as recent as its last
# run, so a lost box disk loses at most what came after that run. Nothing is
# deleted here when the box prunes its own copies: a box wiped by mistake
# does not wipe this one.
set -eu
case "${1:-}" in -h|--help) sed -n 2,9p "$0" | sed 's/^# //'; exit 0 ;; esac
HOST=${ARCA_PG_HOST_SSH:-seq}
DEST=${ARCA_PG_PULL_DIR:-$HOME/.local/share/sequentia/arca-pg}
umask 077
mkdir -p "$DEST"
rsync -a "$HOST:/var/backups/arca-pg/" "$DEST/"
echo "pull-arca-pg: $DEST ($(du -sh "$DEST" | cut -f1))"
