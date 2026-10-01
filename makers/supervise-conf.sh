#!/bin/bash
# Confidential (blinded) maker fleet: one funded confidential ocean account per
# directed pair, both sides. Run by seqob-conf-maker.service. Accounts are
# NEVER shared with the transparent same-chain fleet (coin races corrupt
# fills). Keys are box-local.
set +u
cd /root/seqob-test || exit 1

# The node RPC URL carries a password, so it lives on the box only.
ENV_FILE=/etc/sequentia/seqob-makers.env
SEQ_NODE_RPC=$(sed -n 's/^SEQ_NODE_RPC=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
[ -n "$SEQ_NODE_RPC" ] || { echo "SEQ_NODE_RPC is not set in $ENV_FILE" >&2; exit 1; }

RELAY=http://127.0.0.1:9975
OCEAN=127.0.0.1:19500
REGISTRY=http://127.0.0.1:8080/registry/index.minimal.json

SEQ=c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40
USDX=2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de
GOLD=3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1
OILX=4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f
SILVR=57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48

is_atoms() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }
registry_id() { # ticker -> the asset id sequentia.io registered under it
  python3 -c "import json,sys,urllib.request
idx=json.load(urllib.request.urlopen('$REGISTRY', timeout=8))
print([k for k,v in idx.items() if isinstance(v,list) and v[0]=='sequentia.io' and v[1]==sys.argv[1]][0])" "$1" 2>/dev/null
}

# The registry and the price feed are other services and start on their own
# schedule: at boot this script can run before either listens. An asset id or
# an amount that came back empty makes the maker's own flag parser refuse the
# command line, print its whole usage text and get relaunched for ever. So
# nothing starts until both have answered.
until EURX=$(registry_id EURX) && [[ $EURX =~ ^[0-9a-f]{64}$ ]]; do
  echo "registry $REGISTRY has not answered with the EURX asset id; retrying in 5s" >&2
  sleep 5
done
until is_atoms "$(python3 feed_atoms.py SEQ 50 2>/dev/null)"; do
  echo "price feed (feed_atoms.py) has not answered with a SEQ price; retrying in 5s" >&2
  sleep 5
done

# Keep one maker running for as long as the service lives. A maker that ran for
# a minute is relaunched after 8s. One that exits sooner is failing on
# something a relaunch does not change at once, so each quick exit doubles the
# wait, up to 5 minutes, and a run that lasts resets it.
keep_running() { # logfile command...
  local log=$1 delay=8 started rc ran
  shift
  while true; do
    started=$SECONDS
    echo "[conf] $(date -u +%FT%TZ) start" >> "$log"
    "$@" >> "$log" 2>&1
    rc=$?
    ran=$((SECONDS - started))
    if [ "$ran" -ge 60 ]; then
      delay=8
    else
      delay=$((delay * 2))
      [ "$delay" -gt 300 ] && delay=300
    fi
    echo "[conf] $(date -u +%FT%TZ) exited rc=$rc after ${ran}s; relaunch in ${delay}s" >> "$log"
    sleep "$delay"
  done
}

run_side() { # acct base quote side base_amount quote_amount [keyfile [logfile]]
  local acct=$1 b=$2 q=$3 side=$4 bamt=$5 qamt=$6
  local key=${7:-keys/conf-$acct-$side.priv} log=${8:-run/conf-$acct-$side.log}
  is_atoms "$bamt" && is_atoms "$qamt" || { echo "$acct $side: amounts '$bamt'/'$qamt' are not whole atoms; not started" >&2; return; }
  # 20 bps each side of the feed so the touch is a spread, not bid == ask.
  if [ "$side" = sell ]; then qamt=$(python3 -c "print(int($qamt*1.002))"); else qamt=$(python3 -c "print(int($qamt*0.998))"); fi
  [ -f "$key" ] || { head -c32 /dev/urandom | xxd -p -c64 > "$key"; chmod 600 "$key"; }
  keep_running "$log" \
    ./seqob-maker-sc -relay $RELAY -ocean $OCEAN -node-rpc "$SEQ_NODE_RPC" -account $acct \
    -base "$b" -quote "$q" -side $side -base-amount "$bamt" -quote-amount "$qamt" \
    -confidential=true -levels 20 -level-bps 40 -level-growth 1.12 -msats-per-byte 300 \
    -maker-priv "$(cat "$key")" &
}

pair() { # acct base baseT usd_notional quote quoteT
  local acct=$1 b=$2 bt=$3 bu=$4 q=$5 qt=$6
  local BAMT=$(python3 feed_atoms.py $bt $bu 2>/dev/null)
  local QAMT=$(python3 feed_atoms.py $qt $bu 2>/dev/null)
  run_side $acct $b $q sell "$BAMT" "$QAMT"
  run_side $acct $b $q buy  "$BAMT" "$QAMT"
  sleep 1
}

# The first pair keeps the key and log names it was created with.
BAMT=$(python3 feed_atoms.py SEQ 50 2>/dev/null); QAMT=$(python3 feed_atoms.py USDX 50 2>/dev/null)
run_side conf2-SEQ-USDX $SEQ $USDX sell "$BAMT" "$QAMT" keys/conf-SEQ-USDX.priv     run/conf-SEQ-USDX-sell.log
run_side conf2-SEQ-USDX $SEQ $USDX buy  "$BAMT" "$QAMT" keys/conf-SEQ-USDX-buy.priv run/conf-SEQ-USDX-buy.log

pair conf2-SEQ-GOLD   $SEQ SEQ 60 $GOLD GOLD
pair conf2-SEQ-EURX   $SEQ SEQ 60 $EURX EURX
pair conf2-SEQ-SILVR  $SEQ SEQ 60 $SILVR SILVR
pair conf2-SEQ-OILX   $SEQ SEQ 60 $OILX OILX
pair conf2-USDX-EURX  $USDX USDX 60 $EURX EURX
pair conf2-USDX-GOLD  $USDX USDX 60 $GOLD GOLD
pair conf2-USDX-SILVR $USDX USDX 60 $SILVR SILVR
pair conf2-USDX-OILX  $USDX USDX 60 $OILX OILX
pair conf2-EURX-GOLD  $EURX EURX 60 $GOLD GOLD
pair conf2-EURX-SILVR $EURX EURX 60 $SILVR SILVR
pair conf2-EURX-OILX  $EURX EURX 60 $OILX OILX
pair conf2-GOLD-SILVR $GOLD GOLD 60 $SILVR SILVR
pair conf2-GOLD-OILX  $GOLD GOLD 60 $OILX OILX
pair conf2-SILVR-OILX $SILVR SILVR 60 $OILX OILX

# REVERSE ORIENTATION of every pair. A relay market is keyed by the DIRECTED
# (base,quote) tuple, so offers resting on SEQ/GOLD are invisible to a client
# that asks for GOLD/SEQ. The on-chain book carries both directions and the
# blinded book must too, or half the pairs read as empty. Its own account per
# direction: sharing one would race the same coins between two makers.
pair conf2-USDX-SEQ   $USDX USDX 60 $SEQ SEQ
pair conf2-GOLD-SEQ   $GOLD GOLD 60 $SEQ SEQ
pair conf2-EURX-SEQ   $EURX EURX 60 $SEQ SEQ
pair conf2-SILVR-SEQ  $SILVR SILVR 60 $SEQ SEQ
pair conf2-OILX-SEQ   $OILX OILX 60 $SEQ SEQ
pair conf2-EURX-USDX  $EURX EURX 60 $USDX USDX
pair conf2-GOLD-USDX  $GOLD GOLD 60 $USDX USDX
pair conf2-SILVR-USDX $SILVR SILVR 60 $USDX USDX
pair conf2-OILX-USDX  $OILX OILX 60 $USDX USDX
pair conf2-GOLD-EURX  $GOLD GOLD 60 $EURX EURX
pair conf2-SILVR-EURX $SILVR SILVR 60 $EURX EURX
pair conf2-OILX-EURX  $OILX OILX 60 $EURX EURX
pair conf2-SILVR-GOLD $SILVR SILVR 60 $GOLD GOLD
pair conf2-OILX-GOLD  $OILX OILX 60 $GOLD GOLD
pair conf2-OILX-SILVR $OILX OILX 60 $SILVR SILVR
wait
