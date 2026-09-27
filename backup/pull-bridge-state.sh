#!/bin/sh
# Pull a dated copy of the bridge services' state files off the box: the
# Compages daemon's and watcher's state, and the SBTC peg service's. Run on an
# operator's machine (see backup/pull-bridge-state.timer), so a lost box disk
# does not lose the record of every deposit, redemption and peg.
# The files hold no keys; they are kept mode 600 all the same.
set -eu
case "${1:-}" in -h|--help) sed -n 2,6p "$0" | sed 's/^# //'; exit 0 ;; esac
HOST=${BRIDGE_STATE_HOST:-seq}
DEST=${BRIDGE_STATE_DIR:-$HOME/.local/share/sequentia/bridge-state}
KEEP=${BRIDGE_STATE_KEEP:-60}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$DEST/$stamp"
scp -q "$HOST:/root/sequentia/compages/daemon/state/compages-state.json" "$DEST/$stamp/"
scp -q "$HOST:/root/sequentia/compages/watcher/state/watch-state.json" "$DEST/$stamp/"
scp -q "$HOST:/root/sequentia/sbtc-bridge/state.json" "$DEST/$stamp/sbtc-state.json"
ls -1d "$DEST"/*/ | sort | head -n -"$KEEP" | xargs -r rm -rf
echo "pull-bridge-state: $DEST/$stamp"
