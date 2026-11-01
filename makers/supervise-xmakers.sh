#!/bin/bash
# Deep cross-chain (BTC<->asset) maker fleet: K price levels per asset per side,
# run by seqob-xmakers.service from /root/seqob-test.
#
# SELL side (maker gives the asset, funded from the dexnode wallet xmm) lets
# users BUY the asset with BTC; BUY side (maker gives BTC, funded from the
# bitcoind wallet seqdex-mm-btc) lets users SELL the asset for BTC, gated on
# BUY_ENABLED. Each level keeps a stable identity key under
# /etc/sequentia/maker-keys: a maker that generated a fresh key on every
# requote would orphan a taker that had already funded an HTLC against the old
# one, since the HTLC bakes the maker's claim key into its script.
#
# No credential is on a command line: the node URLs come from
# /etc/sequentia/seqob-makers.env (SEQ_NODE_RPC, SEQ_BTC_RPC) and reach each
# maker, with its key, in its environment (SEQOB_XSEQ_RPC, SEQOB_BTC_RPC,
# SEQOB_MAKER_PRIV), which only root and the maker's own user can read.
set +u
. /root/reissue-loop/current-ids.env 2>/dev/null
ENV_FILE=/etc/sequentia/seqob-makers.env
SEQ_NODE_RPC=$(sed -n 's/^SEQ_NODE_RPC=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
SEQ_BTC_RPC=$(sed -n 's/^SEQ_BTC_RPC=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
[ -n "$SEQ_NODE_RPC" ] || { echo "SEQ_NODE_RPC is not set in $ENV_FILE" >&2; exit 1; }
[ -n "$SEQ_BTC_RPC" ] || { echo "SEQ_BTC_RPC is not set in $ENV_FILE" >&2; exit 1; }
SEQ=c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40
cd /root/seqob-test || exit 1
mkdir -p run
declare -A ID=( [SEQ]=$SEQ [USDX]=$USDX [EURX]=$EURX [GOLD]=$GOLD [SILVR]=$SILVR [OILX]=$OILX )
K=12                                 # price levels per side per asset
SPREADS=(0.004 0.009 0.016 0.025 0.036 0.05 0.067 0.087 0.11 0.14 0.175 0.22)
BUY_ENABLED=${BUY_ENABLED:-1}        # 1 once seqdex-mm-btc is funded and confirmed
KEYDIR=${KEYDIR:-/etc/sequentia/maker-keys}
run(){  # $1 asset  $2 side(sell|buy)  $3 level
  local t=$1 side=$2 lvl=$3 id=${ID[$t]}
  local bamt qsats sp=${SPREADS[$lvl]}
  local log=run/xmk-$t-$side-$lvl.log
  mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
  local KEYF=$KEYDIR/xmk-$t-$side-$lvl.key
  if [ ! -s "$KEYF" ]; then (umask 077; openssl rand -hex 32 > "$KEYF"); fi
  while true; do
    # Priced from the live feed at each requote, so the offer tracks the market.
    read bamt qsats < <(/root/seqob-test/oracle-price.sh "$t" 50 "$sp" "$side")
    if [ -z "$bamt" ] || [ -z "$qsats" ] || [ "$bamt" = "0" ] || [ "$qsats" = "0" ]; then echo "[xdeep] $(date -u +%H:%M:%S) $t $side L$lvl PRICE FETCH FAILED -> retry 8s" >> $log; sleep 8; continue; fi
    echo "[xdeep] $(date -u +%H:%M:%S) start $t $side L$lvl bamt=$bamt qsats=$qsats" >> $log
    SEQOB_BTC_RPC="$SEQ_BTC_RPC" SEQOB_XSEQ_RPC="$SEQ_NODE_RPC" SEQOB_MAKER_PRIV="$(cat "$KEYF")" \
    ./seqob-maker -mode cross -max-quote-age 5m -relay http://127.0.0.1:9955 -base "$id" \
      -base-amount "$bamt" -quote-amount "$qsats" -side "$side" \
      -btc-wallet seqdex-mm-btc -btc-chain testnet4 -xseq-wallet xmm \
      -xstate-dir /root/seqob-test/xmaker-sessions -confidential=false -msats-per-byte 300 \
      -spend-fee 1000 -seq-locktime-delta 240 -btc-locktime-delta 260 -expiry 2h >> $log 2>&1
    echo "[xdeep] $(date -u +%H:%M:%S) $t $side L$lvl exited rc=$? -> requote 6s" >> $log
    sleep 6
  done
}
for t in SEQ USDX EURX GOLD SILVR OILX; do
  [ -z "${ID[$t]}" ] && continue
  for ((l=0;l<K;l++)); do
    run "$t" sell "$l" &
    sleep 2
    if [ "$BUY_ENABLED" = "1" ]; then run "$t" buy "$l" & sleep 2; fi
  done
done
wait
