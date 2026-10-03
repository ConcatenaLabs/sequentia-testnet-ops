#!/bin/sh
# Take a base backup of the Arca operator's PostgreSQL into
# /var/backups/arca-pg/base/<UTC time>, keep the newest seven, and delete the
# streamed WAL older than the oldest one kept. A base backup and every WAL
# segment after it restore the database to its latest commit
# (bin/arca-pg-restore-drill.sh).
set -eu
case "${1:-}" in -h|--help) sed -n 2,6p "$0" | sed 's/^# //'; exit 0 ;; esac
PG_BIN=${ARCA_PG_BIN:-/usr/lib/postgresql/16/bin}
PG_HOST=${ARCA_PG_HOST:-/var/run/postgresql}
PG_PORT=${ARCA_PG_PORT:-5432}
PG_USER=${ARCA_PG_SUPERUSER:-postgres}
BACKUP=${ARCA_PG_BACKUP:-/var/backups/arca-pg}
KEEP=${ARCA_PG_KEEP:-7}
RUNAS=${ARCA_PG_RUNAS-postgres}
run() { if [ -n "$RUNAS" ]; then runuser -u "$RUNAS" -- "$@"; else "$@"; fi; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
part="$BACKUP/base/.partial-$stamp"
run mkdir -p "$part"
log=$(run "$PG_BIN/pg_basebackup" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -D "$part" -Ft -z -X stream \
  --checkpoint=fast --no-password -v 2>&1) || { echo "$log" >&2; run rm -rf "$part"; exit 1; }
# "write-ahead log start point: 0/2000028 on timeline 1" -> the segment it
# starts in: every segment from there on is needed to restore this backup.
start=$(echo "$log" | sed -n 's/.*write-ahead log start point: \([0-9A-F]*\)\/\([0-9A-F]*\) on timeline \([0-9]*\).*/\1 \2 \3/p')
[ -n "$start" ] || { echo "arca-pg-basebackup: no start point in pg_basebackup's output" >&2; echo "$log" >&2; exit 1; }
set -- $start
seg=$(printf '%08X%08X%08X' "$3" "0x$1" $(( 0x$2 / 0x1000000 )))
echo "$seg" | run tee "$part/START_WAL" >/dev/null
run mv "$part" "$BACKUP/base/$stamp"
ls -1d "$BACKUP"/base/2*/ | sort | head -n -"$KEEP" | xargs -r rm -rf
oldest=$(ls -1d "$BACKUP"/base/2*/ | sort | head -1)
run "$PG_BIN/pg_archivecleanup" "$BACKUP/wal" "$(cat "${oldest}START_WAL")"
echo "arca-pg-basebackup: $BACKUP/base/$stamp (WAL from $seg)"
