#!/usr/bin/env bash
# The mixed same-chain GOLD/EURX makers: GOLD over Lightning against EURX
# on-chain. Run by seqob-mixed-gold-eurx-buyer-side.service (the maker sells
# GOLD, `sell`) and seqob-mixed-gold-eurx-seller-side.service (the maker buys
# GOLD, `buy`). Their price was written into the units once, by hand, and sat
# 3.8% under the market four days later. Each launch now prices the offer from
# the feed, 20 bps off it on the maker's side; the maker retires the offer at
# expiry (an hour) and is relaunched at the price of that moment.
set -u
ROLE=${1:?usage: mixed-maker.sh sell|buy}

BIN=/root/sequentia/seqdex/bin/seqob-maker
FEED=http://127.0.0.1:8080/prices
ASOCK=/root/sequentia/lsp/ln-asset/sequentia-testnet/lightning-rpc
GOLD=3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1
EURX=e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13

# The node RPC URL carries a password, so it lives on the box only.
ENV_FILE=/etc/sequentia/seqob-makers.env
SEQ_NODE_RPC=$(sed -n 's/^SEQ_NODE_RPC=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
[ -n "$SEQ_NODE_RPC" ] || { echo "SEQ_NODE_RPC is not set in $ENV_FILE" >&2; exit 1; }

case $ROLE in
  sell) MODE=subasset;      RELAY=http://127.0.0.1:9966; KEY=/etc/sequentia/maker-keys/mixed-buy.key;  BASE=100000 ;;
  buy)  MODE=subasset-sell; RELAY=http://127.0.0.1:9971; KEY=/etc/sequentia/maker-keys/mixed-sell.key; BASE=50000 ;;
  *) echo "role must be sell or buy, not $ROLE" >&2; exit 2 ;;
esac

# EURX atoms for BASE GOLD atoms at the feed's price, 20 bps above it when the
# maker sells and below when it buys; nothing when the feed has no price.
quote() {
  curl -sf -m 10 "$FEED" | python3 -c "
import json, sys
d = json.load(sys.stdin)
g, e = float(d['GOLD']['price']), float(d['EURX']['price'])
assert g > 0 and e > 0
print(int($BASE * g / e * (1.002 if '$ROLE' == 'sell' else 0.998)))" 2>/dev/null
}

# A maker that ran for a minute is relaunched after 8s; one that exits sooner
# doubles the wait, up to 5 minutes, and a run that lasts resets it.
delay=8
while true; do
  started=$SECONDS
  Q=$(quote)
  if [[ $Q =~ ^[1-9][0-9]*$ ]]; then
    echo "[mixed] $(date -u +%FT%TZ) $ROLE $BASE GOLD atoms for $Q EURX atoms"
    "$BIN" -mode $MODE -base $GOLD -quote-asset $EURX -base-amount $BASE -quote-amount "$Q" \
      -maker-priv "$(cat "$KEY")" -xseq-rpc "$SEQ_NODE_RPC" -xseq-wallet xmm \
      -asset-ln-socket $ASOCK -relay $RELAY -expiry 1h -requote -logtostderr
    echo "[mixed] $(date -u +%FT%TZ) exited rc=$?"
  else
    echo "[mixed] $(date -u +%FT%TZ) the feed gave no GOLD/EURX price; retrying"
  fi
  if [ $((SECONDS - started)) -ge 60 ]; then delay=8; else delay=$((delay * 2)); [ $delay -gt 300 ] && delay=300; fi
  sleep $delay
done
