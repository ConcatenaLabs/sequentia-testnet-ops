#!/usr/bin/env bash
# Pure-LN maker fleet: six assets on both sides against BTC, and every
# asset/asset pair on both sides, eight price levels each. Run by
# seqob-pureln-fleet.service. Prices come from the feed once, at launch; a
# maker requotes its own remainder after a partial fill. Identities are stable
# per (pair, side, level), box-local, never in git.
#
# Every level is its OWN process because pure-LN keeps ONE swap in flight per
# maker, so every rung shown is a rung a taker can actually lift.
BIN=/root/sequentia/seqdex/bin/seqob-maker
ASOCK=/root/sequentia/lsp/ln-asset/sequentia-testnet/lightning-rpc
BSOCK=/root/sequentia/lsp/btc-maker/testnet4/lightning-rpc
RELAY=http://127.0.0.1:9965
FEED=http://127.0.0.1:8080/prices
KEYS=/etc/sequentia/maker-keys
LOGS=/root/seqob-test/run

# The price of a ticker, or 0 when the feed does not carry it.
px() { echo "$PRICES" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get(\"$1\") or d.get(\"t$1\") or 0; print(v[\"price\"] if isinstance(v,dict) else v)" 2>/dev/null; }
is_positive() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0 else 1)" "$1" 2>/dev/null; }
is_atoms() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }

# The feed is another service and starts on its own schedule: at boot this
# script can run before it listens. Every amount below is derived from it, and
# a maker launched with an empty amount is refused by its own flag parser,
# prints its whole usage text and gets relaunched for ever. So nothing starts
# until the feed has answered with a BTC price.
until PRICES=$(curl -sf -m 10 "$FEED") && BTCP=$(px BTC) && is_positive "$BTCP"; do
  echo "price feed $FEED has not answered with a BTC price; retrying in 5s" >&2
  sleep 5
done

# Keep one maker running for as long as the service lives. A maker that ran for
# a minute is relaunched after 8s. One that exits sooner is failing on
# something a relaunch does not change at once (a Lightning node that is down,
# the relay restarting), so each quick exit doubles the wait, up to 5 minutes,
# and a run that lasts resets it.
keep_running() { # logfile command...
  local log=$1 delay=8 started rc ran
  shift
  while true; do
    started=$SECONDS
    "$@" >> "$log" 2>&1
    rc=$?
    ran=$((SECONDS - started))
    if [ "$ran" -ge 60 ]; then
      delay=8
    else
      delay=$((delay * 2))
      [ "$delay" -gt 300 ] && delay=300
    fi
    echo "[fleet] $(date -u +%FT%TZ) exited rc=$rc after ${ran}s; relaunch in ${delay}s" >> "$log"
    sleep "$delay"
  done
}

maker_key() { # name -> path of its key file, created on first use
  local key=$KEYS/$1.key
  [ -f "$key" ] || { head -c32 /dev/urandom | xxd -p -c64 > "$key"; chmod 600 "$key"; }
  echo "$key"
}

run_maker() { # ticker assetid side base_atoms level(1..8), against BTC
  local T=$1 A=$2 S=$3 BASE=$4 LVL=${5:-1}
  local NAME=pureln-$T-$S-$LVL
  local AP=$(px $T)
  is_positive "$AP" || { echo "$NAME: the feed has no price for $T; not started" >&2; return; }
  local QUOTE=$(python3 -c "import math; print(max(200, math.ceil($BASE/1e8*$AP/$BTCP*1e8)))")
  # Ladder: 20 bps at the touch, +25 bps per level out, sizes growing 1.5x per
  # level capped at 5x: the shape of an actively traded book, dense near the
  # touch with real size building behind it.
  local OFF=$(python3 -c "print(0.002 + ($LVL-1)*0.0025)")
  if [ "$S" = buy ]; then QUOTE=$(python3 -c "print(int($QUOTE*(1-$OFF)))"); else QUOTE=$(python3 -c "print(int($QUOTE*(1+$OFF)))"); fi
  BASE=$(python3 -c "print(int($BASE*min(5, 1.5**($LVL-1))))")
  is_atoms "$BASE" && is_atoms "$QUOTE" || { echo "$NAME: amounts '$BASE'/'$QUOTE' are not whole atoms; not started" >&2; return; }
  keep_running "$LOGS/$NAME.log" \
    $BIN -mode pureln -side $S -base $A -base-amount $BASE -quote-amount $QUOTE \
    -asset-ln-socket $ASOCK -ln-socket $BSOCK -btc-asset "" -relay $RELAY \
    -hold-timeout 3m0s -maker-priv "$(cat "$(maker_key $NAME)")" -logtostderr &
}

# Asset/asset pure-LN pairs: both legs on ln-asset, the quote priced in the
# quote asset's own atoms from the same feed.
run_aa() { # baseT baseId base_atoms quoteT quoteId side level(1..8)
  local BT=$1 BA=$2 BASE=$3 QT=$4 QA=$5 S=$6 LVL=${7:-1}
  local NAME=pureln-$BT$QT-$S-$LVL
  local BP=$(px $BT) QP=$(px $QT)
  is_positive "$BP" && is_positive "$QP" || { echo "$NAME: the feed has no price for $BT or $QT; not started" >&2; return; }
  local QUOTE=$(python3 -c "import math; print(max(1000, math.ceil($BASE*$BP/$QP)))")
  # Same ladder shape as the BTC pairs, 40 bps at the touch.
  local OFF=$(python3 -c "print(0.004 + ($LVL-1)*0.0025)")
  if [ "$S" = buy ]; then QUOTE=$(python3 -c "print(int($QUOTE*(1-$OFF)))"); else QUOTE=$(python3 -c "print(int($QUOTE*(1+$OFF)))"); fi
  BASE=$(python3 -c "print(int($BASE*min(5, 1.5**($LVL-1))))")
  is_atoms "$BASE" && is_atoms "$QUOTE" || { echo "$NAME: amounts '$BASE'/'$QUOTE' are not whole atoms; not started" >&2; return; }
  keep_running "$LOGS/$NAME.log" \
    $BIN -mode pureln -side $S -base $BA -base-amount $BASE -quote-amount $QUOTE \
    -quote-asset $QA -asset-ln-socket $ASOCK -ln-socket $ASOCK -relay $RELAY \
    -hold-timeout 3m0s -maker-priv "$(cat "$(maker_key $NAME)")" -logtostderr &
}

TSEQ=c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40
USDX=2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de
EURX=e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13
SILVR=57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48
OILX=4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f
GOLD=3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1

for spec in "GOLD $GOLD 20000" "SEQ $TSEQ 2000000000" "USDX $USDX 50000000" "EURX $EURX 200000000" "SILVR $SILVR 50000000" "OILX $OILX 2000000"; do
  set -- $spec
  for LVL in 1 2 3 4 5 6 7 8; do
    run_maker $1 $2 sell $3 $LVL
    run_maker $1 $2 buy $3 $LVL
  done
done

# All 15 asset/asset combinations, both sides (base sizes in each base asset's
# own atoms, conservative against hub channel capacity).
for S in sell buy; do
 for LVL in 1 2 3 4 5 6 7 8; do
  run_aa SEQ  $TSEQ 1000000000 USDX  $USDX  $S $LVL
  run_aa SEQ  $TSEQ 1000000000 EURX  $EURX  $S $LVL
  run_aa SEQ  $TSEQ 1000000000 GOLD  $GOLD  $S $LVL
  run_aa SEQ  $TSEQ 1000000000 SILVR $SILVR $S $LVL
  run_aa SEQ  $TSEQ 1000000000 OILX  $OILX  $S $LVL
  run_aa USDX $USDX 20000000   EURX  $EURX  $S $LVL
  run_aa USDX $USDX 20000000   GOLD  $GOLD  $S $LVL
  run_aa USDX $USDX 20000000   SILVR $SILVR $S $LVL
  run_aa USDX $USDX 20000000   OILX  $OILX  $S $LVL
  run_aa EURX $EURX 100000000  GOLD  $GOLD  $S $LVL
  run_aa EURX $EURX 100000000  SILVR $SILVR $S $LVL
  run_aa EURX $EURX 100000000  OILX  $OILX  $S $LVL
  run_aa GOLD $GOLD 20000      SILVR $SILVR $S $LVL
  run_aa GOLD $GOLD 20000      OILX  $OILX  $S $LVL
  run_aa SILVR $SILVR 20000000 OILX  $OILX  $S $LVL
 done
done
wait
