#!/usr/bin/env bash
# The SeqDEX makers' health: run by seqob-liquidity-health.timer every half hour.
#
# 1. The depth audit (bin/seqdex-depth-audit.py) of every directed market and rail: one table
#    and a verdict, kept as run/depth-audit.json and run/depth-audit.txt, the verdict lines
#    appended to run/liquidity-health.log, and every crossed market (best bid at or above best
#    ask in the book the wallets show) with the two offers that cross.
# 2. Top-ups, each only below half its target and only from treasury2026 (node000) or
#    maker-bridged (dexnode, USDC.e and EURC.e), one transaction an asset, the fee in it:
#    - the interactive fleet's Ocean accounts (the list in /root/lq1/sc-accounts.json), to 1.5
#      times their ladders;
#    - the leaf makers (what they quote is what they hold), to their targets, at their addresses;
#    - the covenant seeder's wallet, to what twenty levels a side of every pair needs, and the
#      Sequence token it pays its fundings' fees in.
#    An asset short at its source is logged AWAITING SUPPLY and skipped.
# Node credentials come from each node's elements.conf; nothing here prints a key or password.
set -uo pipefail
export LC_ALL=C
OPS=${OPS:-/root/sequentia/sequentia-testnet-ops}
RUN=${HEALTH_RUN:-/root/seqob-test/run}
STATE=${HEALTH_STATE:-/root/lq1}
TOOL=${HEALTH_TOOL:-$OPS/makers/maker_funds.py}
AUDIT=${HEALTH_AUDIT:-$OPS/bin/seqdex-depth-audit.py}
OCTL=${HEALTH_OCTL:-/root/seqob-test/seqob-octl-lq}
OCEAN=${HEALTH_OCEAN:-127.0.0.1:19500}
FEED=${HEALTH_FEED:-http://127.0.0.1:8088/prices}
SOURCES=${HEALTH_SOURCES:-treasury2026@node000,maker-bridged@dexnode}
BASE=${HEALTH_BASE:-https://sequentiatestnet.com}
LEAF_MAKERS=${HEALTH_LEAF_MAKERS:-leaf-maker:9979:2000 leaf-maker-btc:9978:500}
COVSEED=${HEALTH_COVSEED:-covenant-seeder@dexnode}
AWAITING=${HEALTH_AWAITING:-}
LOG=$RUN/liquidity-health.log
mkdir -p "$RUN" "$STATE/health"; chmod 700 "$STATE"
W=$STATE/health
exec 9> /run/lock/seqob-liquidity-health.lock 2>/dev/null || exec 9> "$W/.lock"
flock -n 9 || { echo "$(date -u +%FT%TZ) a run is in progress" >> "$LOG"; exit 0; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
tool() { python3 -I "$TOOL" "$@"; }

log "=== health run"
# 1. the audit
python3 -I "$AUDIT" --base "$BASE" ${AWAITING:+--awaiting "$AWAITING"} --json "$RUN/depth-audit.json" > "$RUN/depth-audit.txt.new" 2>&1
rc=$?; mv -f "$RUN/depth-audit.txt.new" "$RUN/depth-audit.txt"
grep -E '^verdict|passes|not liftable|problem|^crossed:|CROSSED' "$RUN/depth-audit.txt" | while read -r l; do log "audit: $l"; done
log "audit exit $rc (0 every market passes and none is crossed, 1 some fall short or are crossed, 2 it could not run)"

# 2a. the interactive fleet's accounts
if [ -s "$STATE/sc-accounts.json" ] && [ -x "$OCTL" ]; then
  tool plan-sc --accounts "$STATE/sc-accounts.json" --assets "$STATE/assets-sc.txt" --out "$W/sc-plan.json" >/dev/null 2>&1 \
    && tool fund --sources "$SOURCES" --assets "$STATE/assets-sc.txt" --prices "$FEED" --plan "$W/sc-plan.json" --octl "$OCTL" --ocean "$OCEAN" \
         --out "$W/sc-sent.json" 2>&1 | grep -vE 'enough$' | while read -r l; do log "interactive: $l"; done
else log "interactive: no account list at $STATE/sc-accounts.json (written when the fleet's accounts are made)"; fi

# 2b. the leaf makers: what each quotes is what it holds
for m in $LEAF_MAKERS; do
  name=${m%%:*}; rest=${m#*:}; port=${rest%%:*}; usd=${rest#*:}
  q=$(curl -sf -m 60 "http://127.0.0.1:$port/v1/quotes" 2>/dev/null) || { log "$name: does not answer on :$port"; continue; }
  addr=$(cat "$STATE/$name.address" 2>/dev/null || true)
  [ -n "$addr" ] || { log "$name: no address on record ($STATE/$name.address; written when the maker is set up)"; continue; }
  python3 -I -c '
import json, sys
q = json.loads(sys.argv[1]).get("quotes") or []
ids = {l.split()[2]: l.split()[0] for l in open(sys.argv[2]) if len(l.split()) >= 4}
held = {}
for x in q:
    t = ids.get(x["give_asset"])
    if t:
        held[t] = max(held.get(t, 0), int(x["max_give"]))
json.dump(held, open(sys.argv[3], "w"))' "$q" "$STATE/assets-leaf.txt" "$W/$name-held.json" || continue
  tool plan-leaf --name "$name" --node dexnode --address "$addr" --assets "$STATE/assets-leaf.txt" --held "$W/$name-held.json" --usd "$usd" \
      $( [ "$name" = leaf-maker-btc ] && echo "--skip USDC.e,EURC.e" ) --out "$W/$name-plan.json" >/dev/null 2>&1 \
    && tool fund --sources "$SOURCES" --assets "$STATE/assets-leaf.txt" --prices "$FEED" --plan "$W/$name-plan.json" --out "$W/$name-sent.json" 2>&1 \
       | grep -vE 'enough$' | while read -r l; do log "$name: $l"; done
done

# 2c. the covenant seeder's wallet
cw=${COVSEED%@*}; cn=${COVSEED#*@}
if [ -s "$STATE/covseed-plan.json" ]; then
  tool fund --sources "$SOURCES" --assets "$STATE/assets-leaf.txt" --prices "$FEED" --plan "$STATE/covseed-plan.json" --out "$W/covseed-sent.json" 2>&1 \
    | grep -vE 'enough$' | while read -r l; do log "$cw: $l"; done
else log "$cw: no plan at $STATE/covseed-plan.json (written when the seeder is set up)"; fi
log "=== health run done"
