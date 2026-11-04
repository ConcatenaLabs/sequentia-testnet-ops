#!/usr/bin/env python3
"""What the bots that stand for our own capital hold, against the mainnet plan.

Read-only. Values every holding at the box's price feed (USD, the reference unit; tSEQ at its mock
price). Prints one block per holder and a verdict line each:

  - our makers: what each quotes it holds (`/v1/quotes`, the largest `max_give` of each asset it
    gives: a leaf maker quotes only what it holds), against `--maker-plan` dollars across them all;
  - our LSP: its Lightning nodes' channels to every peer that is not one of the market's nodes
    (users' wallets, the arks' Lightning gateways), on its side, plus each node's confirmed on-chain
    float, against `--lsp-plan` dollars. A channel to a market node (`--market-node`, a Lightning
    directory) stands for another maker's node peered with ours and is counted apart.

    our-capital.py                       the box's makers, nodes and plan
    our-capital.py --json out.json       the same, and the figures as JSON

sequentia-testnet-ops README, "The testnet's numbers", says which bot stands for whom and why.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

SEQ = "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40"
# asset id -> (ticker, precision, the feed's key)
ASSETS = {
    SEQ: ("tSEQ", 8, "SEQ"),
    "2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de": ("USDX", 8, "USDX"),
    "e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13": ("EURX", 8, "EURX"),
    "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1": ("GOLD", 8, "GOLD"),
    "57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48": ("SILVR", 8, "SILVR"),
    "4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f": ("OILX", 8, "OILX"),
    "9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa": ("USDC.e", 6, "USDC"),
    "d1bb6f4d0d12dde93405c23da8da38c6d00270930d75b7cdcb91ad8f0646efef": ("EURC.e", 6, "EURC"),
    "BTC": ("BTC", 8, "tBTC"),
}


def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def usd(prices, asset, atoms):
    """Dollars of `atoms` of `asset` at the feed, or None when the feed has no price for it."""
    t = ASSETS.get(asset)
    if not t or t[2] not in prices:
        return None
    p = prices[t[2]]
    p = p.get("price") if isinstance(p, dict) else p
    return atoms / 10 ** t[1] * float(p)


def maker_holdings(port):
    q = get("http://127.0.0.1:%d/v1/quotes" % port, timeout=60)
    held = {}
    for x in q.get("quotes") or []:
        held[x["give_asset"]] = max(held.get(x["give_asset"], 0), int(x.get("max_give") or 0))
    return held


def lightning(cli, d, net, *args):
    r = subprocess.run([cli, "--lightning-dir=" + d, "--network=" + net, *args],
                       capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError("%s %s: %s" % (d, args[0], (r.stderr or r.stdout).strip()[:200]))
    return json.loads(r.stdout or "{}")


def node_net(d):
    for net in ("sequentia-testnet", "testnet4"):
        if os.path.exists(os.path.join(d, net, "lightning-rpc")):
            return net
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feed", default="http://127.0.0.1:8088/prices")
    ap.add_argument("--maker", action="append", default=None, metavar="NAME:PORT",
                    help="a maker that stands for us (default: leaf-maker-btc:9978)")
    ap.add_argument("--maker-plan", type=float, default=275000.0)
    ap.add_argument("--lsp-node", action="append", default=None, metavar="DIR",
                    help="a Lightning directory of our LSP (default: ln-asset and btc-maker)")
    ap.add_argument("--market-node", action="append", default=None, metavar="DIR",
                    help="a Lightning directory of the market's (default: ln-asset-b and btc-taker)")
    ap.add_argument("--lsp-plan", type=float, default=100000.0)
    ap.add_argument("--cli", default="/root/sequentia/seqln/cli/lightning-cli")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    makers = a.maker or ["leaf-maker-btc:9978"]
    lsp_nodes = a.lsp_node or ["/root/sequentia/lsp/ln-asset", "/root/sequentia/lsp/btc-maker"]
    market_nodes = a.market_node or ["/var/lib/volume-takers/ln/ln-asset-b", "/var/lib/volume-takers/ln/btc-taker"]

    prices = get(a.feed)
    out = {"makers": {}, "lsp": {}, "plan": {"makers": a.maker_plan, "lsp": a.lsp_plan}}
    print("prices: tSEQ $%.4f, BTC $%.0f (the feed at %s)" % (
        float(prices["SEQ"]["price"]), float(prices["tBTC"]["price"]), a.feed))

    total = 0.0
    for m in makers:
        name, port = m.rsplit(":", 1)
        try:
            held = maker_holdings(int(port))
        except Exception as e:  # noqa: BLE001 -- reported, and the verdict says it could not read
            print("%s: does not answer on :%s (%s)" % (name, port, e))
            out["makers"][name] = None
            total = None
            continue
        rows = {}
        for asset, atoms in sorted(held.items(), key=lambda kv: -(usd(prices, kv[0], kv[1]) or 0)):
            v = usd(prices, asset, atoms)
            t = ASSETS.get(asset, (asset[:8], 8, None))
            rows[t[0]] = {"atoms": atoms, "usd": v}
            print("  %-15s %-7s %18s  %s" % (name, t[0], "{:,.2f}".format(atoms / 10 ** t[1]),
                                            "${:,.0f}".format(v) if v is not None else "unpriced"))
            if total is not None and v is not None:
                total += v
        out["makers"][name] = rows
    out["makers_usd"] = total
    if total is None:
        print("our makers: could not read them all")
    else:
        print("our makers hold ${:,.0f}, against a plan of ${:,.0f}: {}".format(
            total, a.maker_plan, verdict(total, a.maker_plan)))

    market_ids = {}
    for d in market_nodes:
        net = node_net(d)
        if net:
            try:
                market_ids[lightning(a.cli, d, net, "getinfo")["id"]] = os.path.basename(d.rstrip("/"))
            except Exception as e:  # noqa: BLE001
                print("market node %s: %s" % (d, e))
    lsp_total, market_total = 0.0, 0.0
    for d in lsp_nodes:
        net = node_net(d)
        if not net:
            print("LSP node %s: no RPC socket" % d)
            continue
        ours = market = onchain = 0.0
        for c in lightning(a.cli, d, net, "listpeerchannels").get("channels", []):
            if c.get("state") != "CHANNELD_NORMAL":
                continue
            asset = "BTC" if net == "testnet4" else c.get("channel_asset", "?")
            v = usd(prices, asset, int(c.get("to_us_msat", 0)) // 1000) or 0.0
            if c["peer_id"] in market_ids:
                market += v
            else:
                ours += v
        for o in lightning(a.cli, d, net, "listfunds").get("outputs", []):
            if o.get("status") != "confirmed":
                continue
            asset = "BTC" if net == "testnet4" else (o.get("asset") or SEQ)
            onchain += usd(prices, asset, int(o.get("amount_msat", 0)) // 1000) or 0.0
        name = os.path.basename(d.rstrip("/"))
        out["lsp"][name] = {"channels_usd": ours, "onchain_usd": onchain, "market_channels_usd": market}
        print("  LSP {:11} channels to wallets and arks ${:,.0f}, on-chain float ${:,.0f}; channels to the market's nodes ${:,.0f}".format(
            name, ours, onchain, market))
        lsp_total += ours + onchain
        market_total += market
    out["lsp_usd"] = lsp_total
    print("our LSP holds ${:,.0f}, against a plan of ${:,.0f}: {}".format(lsp_total, a.lsp_plan, verdict(lsp_total, a.lsp_plan)))
    print("the market's channels with our LSP's nodes hold ${:,.0f} on our nodes' side (not ours)".format(market_total))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=1)
    return 0


def verdict(have, plan):
    r = have / plan if plan else 0
    if r > 1.25:
        return "above the plan by ${:,.0f}".format(have - plan)
    if r < 0.75:
        return "below the plan by ${:,.0f}".format(plan - have)
    return "at the plan"


if __name__ == "__main__":
    sys.exit(main())
