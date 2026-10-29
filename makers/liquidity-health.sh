#!/usr/bin/env bash
# The SeqDEX makers' and the Arca operator's health: run by seqob-liquidity-health.timer every
# ten minutes.
#
# 1. The depth audit (bin/seqdex-depth-audit.py) of every directed market and rail: one table
#    and a verdict, kept as run/depth-audit.json and run/depth-audit.txt, the verdict lines
#    appended to run/liquidity-health.log, and every crossed market (best bid at or above best
#    ask in the book the wallets show) with the two offers that cross.
# 2. The treasury's floors: treasury2026 is kept at its floor of each mintable faucet asset
#    (USDX, EURX, GOLD, SILVR, OILX; `treasury_floors` in makers/liquidity-targets.json), minted
#    with its reissuance token in wallet `recovered` and delivered to treasury2026
#    (maker_funds.py mint, the one mint route). tSEQ and the bridged USDC.e and EURC.e are never
#    minted.
# 3. Refills, each once a consumer holds less than its floor (half its target unless the
#    targets file says otherwise), back to its target, only from treasury2026 (node000) or
#    maker-bridged (dexnode, USDC.e and EURC.e), one transaction an asset, the fee in it; an
#    asset treasury2026 is short of is minted first when it can be:
#    - the consumers in makers/liquidity-targets.json: the Arca operator's pool, the covenant
#      seeder's wallet, the order crosser's wallet, and any added there;
#    - the interactive fleet's Ocean accounts (the list in /root/lq1/sc-accounts.json), to 1.5
#      times their ladders;
#    - the leaf makers (what they quote is what they hold), to their targets, at their addresses.
#    An asset short at its source that cannot be minted is logged AWAITING SUPPLY and skipped.
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
LEAF_MAKERS=${HEALTH_LEAF_MAKERS:-leaf-maker:9979:1000000 leaf-maker-btc:9978:300000 leaf-maker-agents:9977:1000000}
TARGETS=${HEALTH_TARGETS:-$OPS/makers/liquidity-targets.json}
SC_USD=${HEALTH_SC_USD:-390000}   # an interactive account side: 1.5 times a ten-level ladder from a $10,000 level 0
MINT=${HEALTH_MINT:---mint}
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

# 1b. a service the kernel throttles for memory: its cgroup's memory.events "high" count rose
#     since the last pass (above MemoryHigh a process is slowed until its calls hang)
for u in ${HEALTH_MEMORY_UNITS:-seqdex-wallet.service arcad.service leaf-maker.service leaf-maker-agents.service seqob-volume-takers.service}; do
  ev=${HEALTH_CGROUP:-/sys/fs/cgroup/system.slice}/$u/memory.events
  [ -r "$ev" ] || continue
  high=$(awk '$1=="high"{print $2}' "$ev"); last=$(cat "$W/$u.memhigh" 2>/dev/null || echo "$high")
  echo "$high" > "$W/$u.memhigh"
  if [ "${high:-0}" -gt "${last:-0}" ]; then
    log "MEMORY THROTTLED $u: memory.events high +$(( high - last )) since the last pass, at $(systemctl show -p MemoryCurrent --value "$u" 2>/dev/null) of MemoryHigh $(systemctl show -p MemoryHigh --value "$u" 2>/dev/null) bytes: raise its limit"
  fi
done

# 2. the treasury's floors
python3 -I -c 'import json,sys; [print(k, v) for k, v in json.load(open(sys.argv[1])).get("treasury_floors", {}).items()]' "$TARGETS" > "$W/floors.txt" \
  && tool floors --floors "$W/floors.txt" --assets "$STATE/assets-leaf.txt" --prices "$FEED" 2>&1 | grep -vE 'enough$' | while read -r l; do log "treasury2026: $l"; done

# 3a. the service wallets loaded, then the consumers of the targets file, in one funding run
#     (one transaction per source and asset for all of them together)
tool wallets --targets "$TARGETS" 2>&1 | while read -r l; do log "wallets: $l"; done
tool plan-targets --targets "$TARGETS" --out-dir "$W" 2>&1 | grep -E 'not planned' | while read -r l; do log "targets: $l"; done
python3 -I -c 'import glob,json,sys; json.dump([d for p in sorted(glob.glob(sys.argv[1] + "/target-*.json")) for d in json.load(open(p))], open(sys.argv[1] + "/targets-plan.json", "w"))' "$W"
tool fund --sources "$SOURCES" --assets "$STATE/assets-leaf.txt" --prices "$FEED" --plan "$W/targets-plan.json" $MINT --out "$W/targets-sent.json" 2>&1 \
  | grep -vE 'enough$' | while read -r l; do log "targets: $l"; done

# 3b. the interactive fleet's accounts
if [ -s "$STATE/sc-accounts.json" ] && [ -x "$OCTL" ]; then
  tool plan-sc --accounts "$STATE/sc-accounts.json" --assets "$STATE/assets-sc.txt" --usd "$SC_USD" --out "$W/sc-plan.json" >/dev/null 2>&1 \
    && tool fund --sources "$SOURCES" --assets "$STATE/assets-sc.txt" --prices "$FEED" --plan "$W/sc-plan.json" $MINT --octl "$OCTL" --ocean "$OCEAN" \
         --out "$W/sc-sent.json" 2>&1 | grep -vE 'enough$' | while read -r l; do log "interactive: $l"; done
else log "interactive: no account list at $STATE/sc-accounts.json (written when the fleet's accounts are made)"; fi

# 3c. the leaf makers: what each quotes is what it holds
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
    && tool fund --sources "$SOURCES" --assets "$STATE/assets-leaf.txt" --prices "$FEED" --plan "$W/$name-plan.json" $MINT --out "$W/$name-sent.json" 2>&1 \
       | grep -vE 'enough$' | while read -r l; do log "$name: $l"; done
done
