#!/bin/sh
# Pull a dated copy of the testnet faucet's claims ledger off the box: the
# record of which wallet, address and network each asset was paid to, which
# the faucet reads to pay each asset once per wallet. Run on an operator's
# machine (see backup/pull-faucet-ledger.timer), so a lost box disk does not
# reopen every wallet's claim. The tooling token beside it is not copied: it
# is a secret, and a new one is made on the box when it is lost.
set -eu
case "${1:-}" in -h|--help) sed -n 2,7p "$0" | sed 's/^# //'; exit 0 ;; esac
HOST=${FAUCET_LEDGER_HOST:-seq}
SRC=${FAUCET_LEDGER_SRC:-/root/sequentia/faucet-state/claims.jsonl}
DEST=${FAUCET_LEDGER_DIR:-$HOME/.local/share/sequentia/faucet-ledger}
KEEP=${FAUCET_LEDGER_KEEP:-60}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$DEST"
scp -q "$HOST:$SRC" "$DEST/.partial.$$"
mv "$DEST/.partial.$$" "$DEST/claims-$stamp.jsonl"
ls -1 "$DEST"/claims-*.jsonl | sort | head -n -"$KEEP" | xargs -r rm -f
echo "pull-faucet-ledger: $DEST/claims-$stamp.jsonl ($(grep -c . "$DEST/claims-$stamp.jsonl") payouts)"
