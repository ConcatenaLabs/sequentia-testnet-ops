#!/bin/sh
# Restore the Arca operator's PostgreSQL from its newest base backup and every
# WAL segment after it into a scratch cluster, and show that the last commit
# made before the restore is there. The live database is not touched: the
# scratch cluster runs on its own port and socket, and is deleted afterwards.
# Usage: bin/arca-pg-restore-drill.sh            (run as root on the box)
set -eu
case "${1:-}" in -h|--help) sed -n 2,6p "$0" | sed 's/^# //'; exit 0 ;; esac
PG_BIN=${ARCA_PG_BIN:-/usr/lib/postgresql/16/bin}
PG_HOST=${ARCA_PG_HOST:-/var/run/postgresql}
PG_PORT=${ARCA_PG_PORT:-5432}
PG_USER=${ARCA_PG_SUPERUSER:-postgres}
BACKUP=${ARCA_PG_BACKUP:-/var/backups/arca-pg}
DRILL_PORT=${ARCA_PG_DRILL_PORT:-5499}
SCRATCH_PARENT=${ARCA_PG_DRILL_DIR:-/var/tmp}
RUNAS=${ARCA_PG_RUNAS-postgres}
run() { if [ -n "$RUNAS" ]; then runuser -u "$RUNAS" -- "$@"; else "$@"; fi; }
live() { run "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -X -q -At -v ON_ERROR_STOP=1 "$@"; }

base=$(ls -1d "$BACKUP"/base/2*/ 2>/dev/null | sort | tail -1)
[ -n "$base" ] || { echo "arca-pg-restore-drill: no base backup under $BACKUP/base; run backup/arca-pg-basebackup.sh first" >&2; exit 1; }

echo "=== a commit to look for ==="
live -d postgres -c "SELECT 1 FROM pg_database WHERE datname = 'arca_drill'" | grep -q 1 \
  || live -d postgres -c "CREATE DATABASE arca_drill"
live -d arca_drill -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS drill (token text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())"
token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
live -d arca_drill -c "INSERT INTO drill (token) VALUES ('$token')"
lsn=$(live -d postgres -c "SELECT pg_current_wal_flush_lsn()")
echo "committed token $token at WAL $lsn (the commit returned once the WAL receiver had flushed it)"
live_counts=$(live -d arca -c "SELECT string_agg(relname || '=' || n_live_tup, ' ' ORDER BY relname) FROM pg_stat_user_tables" 2>/dev/null || true)

echo "=== restore $base and the WAL after it ==="
scratch=$(run mktemp -d "$SCRATCH_PARENT/arca-pg-drill.XXXXXX")
cleanup() {
  run "$PG_BIN/pg_ctl" -D "$scratch/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
run mkdir -m 700 "$scratch/data"
run tar -xzf "$base/base.tar.gz" -C "$scratch/data"
run mkdir -p "$scratch/data/pg_wal"
[ -f "$base/pg_wal.tar.gz" ] && run tar -xzf "$base/pg_wal.tar.gz" -C "$scratch/data/pg_wal"
# The cluster's own configuration lives outside its data directory on Debian
# and Ubuntu; the scratch copy gets just what recovery needs.
run sh -c "cat > '$scratch/data/postgresql.conf'" <<CONF
port = $DRILL_PORT
listen_addresses = ''
unix_socket_directories = '$scratch'
hba_file = '$scratch/data/pg_hba.conf'
ident_file = '$scratch/data/pg_ident.conf'
synchronous_standby_names = ''
archive_mode = off
max_wal_senders = 10
max_replication_slots = 10
wal_level = replica
restore_command = 'f=$BACKUP/wal/%f; if [ -f "\$f" ]; then cp "\$f" "%p"; elif [ -f "\$f.partial" ]; then cp "\$f.partial" "%p"; else exit 1; fi'
recovery_target_timeline = 'latest'
CONF
run sh -c "printf 'local all all trust\n' > '$scratch/data/pg_hba.conf'; : > '$scratch/data/pg_ident.conf'; : > '$scratch/data/recovery.signal'"
run rm -f "$scratch/data/postgresql.auto.conf"
run "$PG_BIN/pg_ctl" -D "$scratch/data" -l "$scratch/recovery.log" -w -t 300 start >/dev/null \
  || { echo "arca-pg-restore-drill: the restored copy did not start:" >&2; tail -20 "$scratch/recovery.log" >&2; exit 1; }
restored() { run "$PG_BIN/psql" -h "$scratch" -p "$DRILL_PORT" -U "$PG_USER" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
i=0
until [ "$(restored -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ]; do
  i=$((i + 1)); [ $i -lt 300 ] || { echo "arca-pg-restore-drill: recovery did not end in 300 s; see $scratch/recovery.log" >&2; tail -20 "$scratch/recovery.log" >&2; exit 1; }
  sleep 1
done
segments=$(grep -c 'restored log file' "$scratch/recovery.log" || true)
echo "recovered: $segments WAL segment(s) replayed from $BACKUP/wal"

echo "=== check ==="
found=$(restored -d arca_drill -c "SELECT count(*) FROM drill WHERE token = '$token'")
rows=$(restored -d arca -c "SELECT string_agg(t, ' ') FROM (SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM ' || quote_ident(table_name), false, true, '')))[1]::text AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name) s" 2>/dev/null || true)
echo "arca rows in the restored copy: ${rows:-none}"
[ -n "$live_counts" ] && echo "arca rows live (statistics, approximate): $live_counts"
if [ "$found" = 1 ]; then
  echo "arca-pg-restore-drill: the restored copy holds the last commit (token $token); restore works"
else
  echo "arca-pg-restore-drill: the restored copy LACKS the last commit (token $token)" >&2
  exit 1
fi
