#!/usr/bin/env python3
# pln_size.py: the base atoms of a pure-Lightning maker's first level, sized to the depth target
# and capped by what the Lightning channels can carry, so no rung is quoted that a taker could not
# fill. Run by makers/pureln-fleet.sh at each launch of a maker.
#
#   pln_size.py SIDE BASE_ID BASE_PRICE QUOTE_ID|BTC TARGET_USD FALLBACK_ATOMS
#
# SIDE sell: the maker gives the base over the asset node and receives the quote; buy: the other
# way. A ladder of LEVELS levels grows 1.5 times a level, up to 5 times the first (the fleet's
# shape), so it holds SUM times its first level; every one of the SHARE ladders that give the same
# asset from the same node draws on one pool of channel room, so a ladder gets SUM x SHARE of it.
# The room is what the node can send of what it gives and receive of what it gets, from its
# CHANNELD_NORMAL channels (`listpeerchannels`; an asset channel names `channel_asset`, a bitcoin
# channel none). Prints the first level's base atoms; FALLBACK_ATOMS when the node cannot be read.
import json, os, subprocess, sys

LNCLI = os.environ.get("PLN_LNCLI", "/root/sequentia/seqln/cli/lightning-cli")
ASOCK = os.environ.get("PLN_ASOCK", "/root/sequentia/lsp/ln-asset/sequentia-testnet/lightning-rpc")
BSOCK = os.environ.get("PLN_BSOCK", "/root/sequentia/lsp/btc-maker/testnet4/lightning-rpc")
LEVELS, SHARE = 8, int(os.environ.get("PLN_SHARE", "6"))
SUM = sum(min(5, 1.5 ** k) for k in range(LEVELS))


def room(sock, asset):
    """(spendable, receivable) atoms of `asset` ("BTC": the bitcoin node's own channels)."""
    out = subprocess.run([LNCLI, "--rpc-file=" + sock, "listpeerchannels"], capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200])
    s = r = 0
    for c in json.loads(out.stdout).get("channels", []):
        if c.get("state") != "CHANNELD_NORMAL":
            continue
        a = c.get("channel_asset") or "BTC"
        if asset != "BTC" and a != asset:
            continue
        if asset == "BTC" and a != "BTC":
            continue
        ms = lambda k: int(str(c.get(k, 0)).rstrip("msat") or 0)
        s += ms("spendable_msat") // 1000
        r += ms("receivable_msat") // 1000
    return s, r


def main():
    side, base, bprice, quote, target, fallback = sys.argv[1:7]
    bprice, target = float(bprice), float(target)
    qprice = float(os.environ.get("PLN_QUOTE_PRICE", "0"))
    try:
        bs, br = room(ASOCK, base)
        qs, qr = room(BSOCK if quote == "BTC" else ASOCK, quote)
    except Exception as e:  # noqa: BLE001
        print(fallback); print("pln_size: no channel room read (%s): the fixed size" % e, file=sys.stderr); return
    # atoms are 1e-8 of a unit for every asset these makers quote
    usd = lambda atoms, p: atoms / 1e8 * p
    if side == "sell":
        room_usd = min(usd(bs, bprice), usd(qr, qprice))
    else:
        room_usd = min(usd(qs, qprice), usd(br, bprice))
    l1 = min(target, room_usd / SHARE / SUM)
    atoms = int(l1 / bprice * 1e8)
    print(max(atoms, 0))
    print("pln_size: %s %s..: target $%.0f, room $%.0f, first level $%.0f" % (side, base[:8], target, room_usd, l1), file=sys.stderr)


if __name__ == "__main__":
    main()
