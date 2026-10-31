#!/usr/bin/env bash
# The DEX's health on the box, every five minutes (seq-health-probe.timer): one line a check, to
# the journal, then the verdict. Exits 0 when every check passes; otherwise exits 1, and its last
# line names each check that failed and what it read, so `systemctl status seq-health-probe`
# and `journalctl -u seq-health-probe` say why.
#
# It reads the nodes through their own data directories (the CLI takes each node's credentials
# from its configuration), so it holds none.
set -uo pipefail
export LC_ALL=C
CLI=${CLI:-/root/Sequentia/src/sequentia-cli}
NODES=${NODES:-/root/seq-testnet}
RELAY=${RELAY:-http://127.0.0.1:9955}
# What runs the DEX: the relays and order book, the asset makers, the BTC desk and agent makers,
# the cross-chain and confidential makers, the same-chain and pure-Lightning fleets, the LSP and
# the two asset Lightning nodes.
UNITS=${UNITS:-seqobd leaf-maker leaf-maker-btc leaf-maker-agents seqob-xmakers seqob-conf-maker seqob-samechain-fleet seqob-pureln-fleet lsp-b5b1 seqob-ln-asset seqob-ln-asset-b}
PORTS=${PORTS:-9955 9965 9966 9971 9975 9977 9978 9979 9981 9987 18200 18300 9740 9741}
MIN_MARKETS=${MIN_MARKETS:-20}

failed=()
line() { printf '%-24s %s\n' "$1" "$2"; }
check() {   # check NAME READING PASSED(0|1)
  if [ "$3" = 0 ]; then line "$1" "$2 ok"; else line "$1" "$2 FAIL"; failed+=("$1 ($2)"); fi
}

listening=$(ss -tln | awk 'NR > 1 {sub(/.*:/, "", $4); print $4}' | sort -u)
missing=()
for p in $PORTS; do grep -qx "$p" <<<"$listening" || missing+=("$p"); done
check ports "$(( $(wc -w <<<"$PORTS") - ${#missing[@]} ))/$(wc -w <<<"$PORTS") listening${missing:+, not :${missing[*]}}" "$([ ${#missing[@]} = 0 ] && echo 0 || echo 1)"

h=$("$CLI" -datadir="$NODES/node000" getblockcount </dev/null 2>/dev/null)
check chain_height "${h:-no answer from node000}" "$([ -n "$h" ] && echo 0 || echo 1)"

wallets() { "$CLI" -datadir="$NODES/$1" listwallets </dev/null 2>/dev/null; }
w=$(wallets node000)
n=$(python3 -I -c 'import json, sys; print(len(json.load(sys.stdin)))' <<<"$w" 2>/dev/null || echo 0)
check wallets_node000 "$n loaded" "$([ "$n" -ge 4 ] && echo 0 || echo 1)"
python3 -I -c 'import json, sys; sys.exit(0 if "sbtc-bridge" in json.load(sys.stdin) else 1)' <<<"$w" 2>/dev/null; sb=$?
check sbtc_bridge_wallet "$([ $sb = 0 ] && echo loaded || echo 'not loaded on node000')" "$sb"
n=$(wallets dexnode | python3 -I -c 'import json, sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
check wallets_dexnode "$n loaded" "$([ "$n" -ge 3 ] && echo 0 || echo 1)"

m=$(curl -s --max-time 10 "$RELAY/v1/markets" | python3 -I -c 'import json, sys
try:
    m = json.load(sys.stdin)["markets"]; print(len(m), sum(1 for x in m if x.get("last_price")))
except Exception: print("0 0")')
check relay_markets "${m% *} markets, ${m#* } with a last price" "$([ "${m% *}" -ge "$MIN_MARKETS" ] && echo 0 || echo 1)"

for u in $UNITS; do
  s=$(systemctl is-active "$u" 2>/dev/null); s=${s:-unknown}
  check "$u" "$s" "$([ "$s" = active ] && echo 0 || echo 1)"
done

if [ ${#failed[@]} = 0 ]; then echo "GREEN: every check passed"; exit 0; fi
printf 'RED: %d failed: %s\n' "${#failed[@]}" "$(IFS=';'; echo "${failed[*]}" | sed 's/;/; /g')"
exit 1
