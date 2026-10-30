#!/usr/bin/env bash
# Interactive same-chain maker fleet: every pair of the listed Sequentia assets,
# both sides, a ladder of price levels on each, on the on-chain book's relay.
# Run by seqob-samechain-fleet.service.
#
# One Ocean account per pair (lq-sc-<BASE>-<QUOTE>): the sell maker gives the
# base and the buy maker gives the quote, so the two never reach for the same
# coins, and each pays its fees in the asset it gives. A maker's key is stable
# per (pair, side), so a restart re-posts under the same identity. Each launch
# reads the feed: level 0 is TOUCH_BPS off the feed's price, each deeper level
# LEVEL_BPS further and GROWTH times larger, and the maker retires its ladder
# after QUOTE_AGE to be relaunched at the price of that moment, or sooner, once the
# feed's price has moved to within GUARD_BPS of its level 0 (seqob-maker -guard-feed).
# Before it quotes, level 0 is kept GUARD_BPS clear of the pair's combined best bid and
# ask on the relay (its ticker: every rail of the on-chain book, both orientations),
# so a quote never crosses the book. A maker re-posts
# a rung that a lift filled (seqob-maker's own re-post) and never answers a lift
# with a coin one of its own swaps spends. The maker trims the deepest rungs to
# what its account holds, so the book shows only what can be filled; a maker whose
# account holds nothing of what it gives exits and is relaunched at the longest
# back-off, so a pair lights up once its account is funded.
#
# Every setting below can be overridden from the environment (a rehearsal does).
set +u
SEQOB_TEST=${SEQOB_TEST:-/root/seqob-test}
cd "$SEQOB_TEST" || exit 1
BIN=${SC_MAKER_BIN:-$SEQOB_TEST/seqob-maker-lq}
RELAY=${SC_RELAY:-http://127.0.0.1:9955}
OCEAN=${SC_OCEAN:-127.0.0.1:19500}
FEED=${SC_FEED:-http://127.0.0.1:8088/prices}
KEYS=${SC_KEYS:-/etc/sequentia/maker-keys}
LOGS=${SC_LOGS:-$SEQOB_TEST/run}
ENV_FILE=${SC_ENV_FILE:-/etc/sequentia/seqob-makers.env}
LEVELS=${SC_LEVELS:-10}          # price levels a side
LEVEL_BPS=${SC_LEVEL_BPS:-25}    # each level this much further from the touch
GROWTH=${SC_GROWTH:-1.2}         # each level this many times larger
USD=${SC_USD:-10000}             # level 0's size, in the feed's reference unit, where an asset names none:
                                 # with 20 bps at the touch and 25 more a level, $50,000 within 1%
TOUCH_BPS=${SC_TOUCH_BPS:-20}    # level 0's distance from the feed's price
QUOTE_AGE=${SC_QUOTE_AGE:-10m}   # how long a ladder rests before it is priced again
GUARD_BPS=${SC_GUARD_BPS:-10}    # margin from the feed's price and from the book's best bid and ask
PREFIX=${SC_ACCOUNT_PREFIX:-lq-sc}
# TICKER FEED_KEY ASSET_ID PRECISION [LEVEL0], one asset a line; every pair of them is
# quoted. LEVEL0 is that asset's level-0 size in the reference unit: a pair's level 0 is
# the smaller of its two assets', so a scarce asset (USDC.e and EURC.e are minted by
# the bridge a few units at a time) quotes small rungs on every pair it is in.
ASSETS=${SC_ASSETS:-"tSEQ SEQ c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40 8
USDX USDX 2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de 8
EURX EURX e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13 8
GOLD GOLD 3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1 8
SILVR SILVR 57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48 8
OILX OILX 4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f 8
USDC.e USDC 9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa 6 0.2
EURC.e EURC d1bb6f4d0d12dde93405c23da8da38c6d00270930d75b7cdcb91ad8f0646efef 6 0.2"}

# The node RPC URL carries a password, so it lives on the box only.
SEQ_NODE_RPC=${SEQ_NODE_RPC:-$(sed -n 's/^SEQ_NODE_RPC=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)}
[ -n "$SEQ_NODE_RPC" ] || { echo "SEQ_NODE_RPC is not set in $ENV_FILE" >&2; exit 1; }
[ -x "$BIN" ] || { echo "no maker binary at $BIN" >&2; exit 1; }
mkdir -p "$LOGS" "$KEYS"; chmod 700 "$KEYS"

is_atoms() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }

# The level-0 sizes of a pair, priced now: "BASE_ATOMS QUOTE_ATOMS", the quote moved
# TOUCH_BPS to the maker's side and kept GUARD_BPS clear of the book's best price on the
# other side (an ask at least best bid * (1 + GUARD_BPS), a bid at most best ask *
# (1 - GUARD_BPS), from the relay's ticker, in quote atoms per base atom); nothing when
# the feed lacks either price, or dates it (as_of) more than ten minutes ago. A ticker that
# does not answer leaves the feed's price.
price_pair() { # baseKey basePrec quoteKey quotePrec side usd baseId quoteId
  local feed ticker
  feed=$(curl -sf -m 10 "$FEED") || return 1
  ticker=$(curl -sf -m 10 "$RELAY/v1/market/$7/$8/ticker" 2>/dev/null || echo '{}')
  python3 -c '
import json, math, sys, time
d, t = json.loads(sys.argv[1]), json.loads(sys.argv[2] or "{}")
bk, bp, qk, qp, side, usd, touch, guard = sys.argv[3], int(sys.argv[4]), sys.argv[5], int(sys.argv[6]), sys.argv[7], float(sys.argv[8]), float(sys.argv[9]), float(sys.argv[10])
def px(k):
    v = d.get(k)
    if isinstance(v, dict) and not v.get("static") and v.get("as_of") and time.time() - float(v["as_of"]) > 600:
        return 0.0
    v = v.get("price") if isinstance(v, dict) else v
    return float(v)
b, q = px(bk), px(qk)
assert b > 0 and q > 0
base = int(round(usd / b * 10 ** bp))
quote = usd / q * 10 ** qp * (1 + touch / 1e4 if side == "sell" else 1 - touch / 1e4)
bid, ask = float(t.get("best_bid") or 0), float(t.get("best_ask") or 0)
if side == "sell" and bid > 0:
    quote = max(quote, math.ceil(base * bid * (1 + guard / 1e4)))
if side == "buy" and ask > 0:
    quote = min(quote, math.floor(base * ask * (1 - guard / 1e4)))
print(base, int(round(quote)))' "$feed" "$ticker" "$1" "$2" "$3" "$4" "$5" "$6" "$TOUCH_BPS" "$GUARD_BPS" 2>/dev/null
}

# Keep one maker running for as long as the service lives: a maker that ran a
# minute is relaunched after 8 s; one that exits sooner doubles the wait, up to
# five minutes, and a run that lasts resets it.
keep_running() { # logfile command...
  local log=$1 delay=8 started rc ran
  shift
  while true; do
    started=$SECONDS
    "$@" >> "$log" 2>&1
    rc=$?
    ran=$((SECONDS - started))
    if [ "$ran" -ge 60 ]; then delay=8; else delay=$((delay * 2)); [ "$delay" -gt 300 ] && delay=300; fi
    echo "[sc-fleet] $(date -u +%FT%TZ) exited rc=$rc after ${ran}s; relaunch in ${delay}s" >> "$log"
    sleep "$delay"
  done
}

launch() { # acct side baseId baseKey basePrec quoteId quoteKey quotePrec keyfile usd
  local acct=$1 side=$2 b=$3 bk=$4 bp=$5 q=$6 qk=$7 qp=$8 key=$9 usd=${10} amts bamt qamt fee
  amts=$(price_pair "$bk" "$bp" "$qk" "$qp" "$side" "$usd" "$b" "$q") || { echo "[sc-fleet] $(date -u +%FT%TZ) no price for $bk or $qk; retrying"; return 1; }
  read -r bamt qamt <<< "$amts"
  is_atoms "$bamt" && is_atoms "$qamt" || { echo "[sc-fleet] amounts '$bamt'/'$qamt' are not whole atoms; retrying"; return 1; }
  fee=$b; [ "$side" = buy ] && fee=$q
  echo "[sc-fleet] $(date -u +%FT%TZ) $acct $side level 0: $bamt base atoms for $qamt quote atoms, $LEVELS levels"
  "$BIN" -mode samechain -relay "$RELAY" -ocean "$OCEAN" -node-rpc "$SEQ_NODE_RPC" -account "$acct" \
    -base "$b" -quote "$q" -side "$side" -base-amount "$bamt" -quote-amount "$qamt" \
    -levels "$LEVELS" -level-bps "$LEVEL_BPS" -level-growth "$GROWTH" \
    -max-quote-age "$QUOTE_AGE" -guard-feed "$FEED" -guard-bps "$GUARD_BPS" \
    -guard-base-key "$bk" -guard-quote-key "$qk" -guard-base-prec "$bp" -guard-quote-prec "$qp" -expiry 1h -fee-asset "$fee" -confidential=false -msats-per-byte 300 \
    -maker-priv "$(cat "$key")"
}

run_side() { # acct side baseT baseId baseKey basePrec quoteT quoteId quoteKey quotePrec usd
  local acct=$1 side=$2 key=$KEYS/$1-$2.key
  [ -s "$key" ] || { head -c32 /dev/urandom | xxd -p -c64 > "$key"; chmod 600 "$key"; }
  keep_running "$LOGS/$acct-$side.log" launch "$acct" "$side" "$4" "$5" "$6" "$8" "$9" "${10}" "$key" "${11}" &
}

# Nothing starts until the feed has answered: an amount that came out empty makes
# the maker refuse its command line and be relaunched for ever.
first=$(head -n 1 <<< "$ASSETS" | awk '{print $2}')
until curl -sf -m 10 "$FEED" | python3 -c 'import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; v=v.get("price") if isinstance(v,dict) else v; sys.exit(0 if float(v)>0 else 1)' "$first" 2>/dev/null; do
  echo "price feed $FEED has not answered with a $first price; retrying in 5s" >&2
  sleep 5
done

mapfile -t A <<< "$ASSETS"
for ((i = 0; i < ${#A[@]}; i++)); do
  for ((j = i + 1; j < ${#A[@]}; j++)); do
    read -r bt bk b bp bu <<< "${A[i]}"
    read -r qt qk q qp qu <<< "${A[j]}"
    [ -n "$b" ] && [ -n "$q" ] || continue
    usd=$(python3 -c 'import sys; print(min(float(sys.argv[1]), float(sys.argv[2])))' "${bu:-$USD}" "${qu:-$USD}")
    run_side "$PREFIX-$bt-$qt" sell "$bt" "$b" "$bk" "$bp" "$qt" "$q" "$qk" "$qp" "$usd"
    run_side "$PREFIX-$bt-$qt" buy  "$bt" "$b" "$bk" "$bp" "$qt" "$q" "$qk" "$qp" "$usd"
    sleep 2   # stagger the launches under the relay's submit throttle
  done
done
wait
