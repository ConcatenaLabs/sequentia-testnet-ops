#!/usr/bin/env bash
# Oracle-price a sub-asset or submarine maker while keeping it alive to serve
# Lightning lifts (-requote): launch the maker with a feed-derived
# -quote-amount, let it run for REPRICE_SECS, then reprice at a fresh feed
# price. Installed in /root/seqob-test; the seqob-submarine-* and
# seqob-subasset-maker units run it.
#
#   subasset-requote.sh <ticker> <base-atoms> <spread> <side> -- <maker command...>
#
# Each ticker and side keeps a stable identity key under
# /etc/sequentia/maker-keys: a fresh key at every reprice would orphan a taker
# that had already funded a BTC HTLC against the old maker, since the HTLC
# bakes the maker's claim key into its script. The key reaches the maker in
# its environment (SEQOB_MAKER_PRIV), never on its command line; so do the
# node URLs, which the unit's environment file gives it (SEQOB_XSEQ_RPC,
# SEQOB_BTC_RPC).
tk=$1 base=$2 sp=$3 side=$4; shift 4; [ "$1" = "--" ] && shift
KEYDIR=${KEYDIR:-/etc/sequentia/maker-keys}
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
KEYF="$KEYDIR/subas-${tk}-${side}.key"
if [ ! -s "$KEYF" ]; then (umask 077; openssl rand -hex 32 > "$KEYF"); fi
SEQOB_MAKER_PRIV=$(cat "$KEYF"); export SEQOB_MAKER_PRIV

REPRICE_SECS=${REPRICE_SECS:-900}
QUIET_SECS=${QUIET_SECS:-45}    # the maker must be log-idle this long before a reprice
DEFER_CAP=${DEFER_CAP:-600}     # but a reprice is never deferred more than this beyond REPRICE_SECS
while true; do
  Q=$(/root/seqob-test/oracle-price.sh --quote-for-base "$tk" "$base" "$sp" "$side")
  if [ -z "$Q" ] || [ "$Q" = "0" ]; then echo "[subas] $tk price fetch failed -> retry 8s"; sleep 8; continue; fi
  echo "[subas] $(date -u +%H:%M:%S) $tk $side base=$base quote=$Q (reprice in ${REPRICE_SECS}s)"
  logf=$(mktemp "/tmp/subas-$tk.XXXXXX")
  "$@" -quote-amount "$Q" > >(tee -a "$logf") 2>&1 &
  mpid=$!
  sleep "$REPRICE_SECS"
  # Never stop a maker mid-swap: one stopped after paying the asset over
  # Lightning but before claiming the BTC loses the asset. Reprice once the
  # maker's log has been idle for QUIET_SECS (a lift in flight logs its
  # progress), at most DEFER_CAP late.
  waited=0
  while kill -0 "$mpid" 2>/dev/null; do
    age=$(( $(date +%s) - $(stat -c %Y "$logf" 2>/dev/null || echo 0) ))
    [ "$age" -ge "$QUIET_SECS" ] && break
    if [ "$waited" -ge "$DEFER_CAP" ]; then echo "[subas] $tk reprice deferred past ${DEFER_CAP}s cap; stopping it anyway"; break; fi
    sleep 10; waited=$((waited+10))
  done
  kill -TERM "$mpid" 2>/dev/null; wait "$mpid" 2>/dev/null
  rm -f "$logf"
done
