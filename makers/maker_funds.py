#!/usr/bin/env python3
# maker_funds.py: the SeqDEX makers' funding helper. The scripts that set the makers up carry a copy, and
# makers/liquidity-health.sh runs this one. Node credentials come from each node's own elements.conf;
# nothing here prints a key or a password. Funding comes from treasury2026 and maker-bridged only.
import base64, json, os, re, subprocess, sys, time, urllib.request

TESTNET_DIR = os.environ.get("TESTNET_DIR", "/root/seq-testnet")
# The wallets the makers are funded from: the live treasury, and the dexnode wallet the bridges
# mint USDC.e and EURC.e into for the makers. Every other wallet is refused by name.
ALLOWED_SOURCES = {"treasury2026", "maker-bridged"}
REFUSED = re.compile(r"(reserve|sbtc|compages|faucet|founder|pool|escrow|bond|beacon|drip|oracle)", re.I)
# A node reports every asset in units of 1e-8 whatever its display precision (0.2 is 20 USDC.e of
# precision 6): node amounts and atoms convert by 1e8, display units by 10**precision.
NODE_ATOMS = 10 ** 8


def die(msg):
    print("STOPPED: " + msg)
    sys.exit(1)


def conf(node):
    txt = open(os.path.join(TESTNET_DIR, node, "elements.conf")).read()
    def get(k):
        m = re.findall(r"^\s*%s\s*=\s*(.*)$" % k, txt, re.M)
        return m[-1].strip() if m else None
    port = get("rpcport")
    if not port:
        die("no rpcport in %s's elements.conf" % node)
    return port, get("rpcuser") or "", get("rpcpassword") or ""


def rpc(node, method, params=None, wallet=None, timeout=120):
    port, user, pw = conf(node)
    url = "http://127.0.0.1:%s/%s" % (port, ("wallet/" + wallet) if wallet else "")
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "1.0", "id": "lq1", "method": method, "params": params or []}).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Basic " + base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        r = json.loads(e.read() or b"{}")
    if r.get("error"):
        raise RuntimeError("%s: %s" % (method, r["error"].get("message")))
    return r["result"]


def http_json(url, timeout=20):
    return json.loads(urllib.request.urlopen(url, timeout=timeout).read())


def assets_of(path):
    """TICKER FEED_KEY ASSET_ID PRECISION lines."""
    out = []
    for line in open(path):
        p = line.split()
        if len(p) >= 4 and not line.startswith("#"):
            out.append({"t": p[0], "feed": p[1], "id": p[2], "prec": int(p[3])})
    return out


def price(feed, key):
    v = feed.get(key)
    v = v.get("price") if isinstance(v, dict) else v
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


# ---- bech32 / blech32: an Ocean confidential address's explicit form, when the node cannot say
CS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values, gen):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= gen[i]
    return chk


def _hrpx(h):
    return [ord(c) >> 5 for c in h] + [0] + [ord(c) & 31 for c in h]


def _conv(data, f, t, pad):
    acc = bits = 0
    out = []
    for v in data:
        acc = (acc << f) | v
        bits += f
        while bits >= t:
            bits -= t
            out.append((acc >> bits) & ((1 << t) - 1))
    if pad and bits:
        out.append((acc << (t - bits)) & ((1 << t) - 1))
    return out


def explicit_of(addr, hrp):
    a = addr.lower()
    words = [CS.index(c) for c in a[a.rindex("1") + 1:]]
    if len(words) < 80:  # plain bech32: re-prefix
        prog = _conv(words[1:-6], 5, 8, False)
    else:                # blech32: drop the 33-byte blinding key
        prog = _conv(words[1:-12], 5, 8, False)[33:]
    ver = words[0]
    data = [ver] + _conv(prog, 8, 5, True)
    G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    const = 1 if ver == 0 else 0x2bc830a3
    chk = _polymod(_hrpx(hrp) + data + [0] * 6, G) ^ const
    return hrp + "1" + "".join(CS[d] for d in data + [(chk >> (5 * (5 - i))) & 31 for i in range(6)])


def explicit_address(node, addr, hrp):
    try:
        v = rpc(node, "validateaddress", [addr])
        if v.get("isvalid"):
            return v.get("unconfidential") or addr
    except RuntimeError:
        pass
    e = explicit_of(addr, hrp)
    v = rpc(node, "validateaddress", [e])
    if not v.get("isvalid"):
        die("the node takes neither %s nor its explicit form %s" % (addr, e))
    return e


# ---- Ocean, through seqob-octl
def octl(octl_bin, ocean, *args):
    r = subprocess.run([octl_bin, "-ocean", ocean] + list(args), capture_output=True, text=True, timeout=60)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def ocean_balance(octl_bin, ocean, acct):
    rc, out = octl(octl_bin, ocean, "-account", acct, "-action", "balance")
    b = {}
    for m in re.finditer(r"balance\[\S+\] ([0-9a-f]{64}) confirmed=(\d+) unconfirmed=(\d+) locked=(\d+) total=(\d+)", out):
        b[m.group(1)] = {"confirmed": int(m.group(2)), "unconfirmed": int(m.group(3)), "locked": int(m.group(4)), "total": int(m.group(5))}
    return b


def ocean_has(octl_bin, ocean, acct):
    """Whether Ocean holds account `acct` now (a read of its balance answers)."""
    rc, _ = octl(octl_bin, ocean, "-account", acct, "-action", "balance")
    return rc == 0


def cmd_accounts(a):
    """Create (once) each pair's account and derive its funding addresses: `coins` for the base
    and `coins` for the quote, so each side is funded in one coin a ladder level. Each account is
    read back from Ocean: one kept here that Ocean no longer holds is made again, with new
    addresses, and none is written here before Ocean is seen to hold it."""
    assets = assets_of(a.assets)
    out = json.load(open(a.out)) if os.path.exists(a.out) else {}
    for i in range(len(assets)):
        for j in range(i + 1, len(assets)):
            acct = "%s-%s-%s" % (a.prefix, assets[i]["t"], assets[j]["t"])
            have = out.get(acct, {})
            if len(have.get("base_addresses", [])) >= a.coins and len(have.get("quote_addresses", [])) >= a.coins:
                if ocean_has(a.octl, a.ocean, acct):
                    print("  %s: kept (%d addresses)" % (acct, a.coins * 2)); continue
                print("  %s: kept here, but Ocean no longer holds it: made again" % acct)
                out.pop(acct, None)
            addrs = []
            for attempt in range(3):
                ok = False
                for _ in range(30):
                    rc, txt = octl(a.octl, a.ocean, "-account", acct, "-action", "create")
                    if rc == 0 or "already exist" in txt:
                        ok = True; break
                    time.sleep(2)
                if not ok:
                    die("Ocean at %s made no account %s: %s" % (a.ocean, acct, txt.strip()[-200:]))
                rc, txt = octl(a.octl, a.ocean, "-account", acct, "-action", "address", "-n", str(2 * a.coins))
                addrs = re.findall(r"address\[\S+\] (\S+)", txt)
                if len(addrs) >= 2 * a.coins and ocean_has(a.octl, a.ocean, acct):
                    break
                print("  %s: Ocean did not keep it (%s); again" % (acct, txt.strip()[-120:]))
                addrs = []
                time.sleep(3)
            if len(addrs) < 2 * a.coins:
                die("Ocean derived %d addresses for %s, not %d, or did not keep the account: %s" % (len(addrs), acct, 2 * a.coins, txt.strip()[-200:]))
            ex = [explicit_address(a.node, x, a.hrp) for x in addrs]
            out[acct] = {"base": assets[i]["t"], "quote": assets[j]["t"],
                         "base_addresses": ex[:a.coins], "quote_addresses": ex[a.coins:2 * a.coins]}
            print("  %s: %d funding addresses derived (%s …)" % (acct, 2 * a.coins, ex[0]))
            json.dump(out, open(a.out + ".tmp", "w"), indent=1)
            os.replace(a.out + ".tmp", a.out)
    gone = [x for x in out if not ocean_has(a.octl, a.ocean, x)]
    if gone:
        die("Ocean does not hold %s after they were made: paste again" % ", ".join(gone))
    print("  every account read back from Ocean (%d)" % len(out))
    json.dump(out, open(a.out + ".tmp", "w"), indent=1)
    os.replace(a.out + ".tmp", a.out)


def sources_of(spec):
    """"wallet@node,…" -> [(wallet, node)], each wallet an allowed source, loaded on its node."""
    out = []
    for part in spec.split(","):
        wallet, _, node = part.partition("@")
        if wallet not in ALLOWED_SOURCES or REFUSED.search(wallet):
            die("%s is not a source this script sends from: only %s fund the makers" % (wallet, " and ".join(sorted(ALLOWED_SOURCES))))
        if wallet not in rpc(node, "listwallets"):
            die("%s is not loaded on %s" % (wallet, node))
        out.append((wallet, node))
    return out


# ---- minting into the treasury
# The faucet assets whose supply the testnet's treasury may grow. tSEQ (the Sequence token) has a
# fixed supply, and USDC.e and EURC.e are minted only by their bridge against deposits: neither is
# ever minted here, whatever a caller asks.
MINTABLE = {"USDX", "EURX", "GOLD", "SILVR", "OILX"}
NEVER_MINTED = re.compile(r"^(t?SEQ|USDC.*|EURC.*)$", re.I)
# The issuance records (the entropy `reissueasset` needs) and the reissuance tokens live in wallet
# `recovered` on node000; what it mints is delivered to `treasury2026` on the same node, which
# every maker is funded from. Nothing else mints and nothing else receives.
MINT_WALLET, TREASURY = "recovered", "treasury2026"
MINT_NODE = os.environ.get("MINT_NODE", "node000")
MINT_LOG = os.environ.get("MINT_LOG", "/root/lq1/mints.jsonl")


def mintable(ticker):
    return ticker in MINTABLE and not NEVER_MINTED.match(ticker)


def trusted(node, wallet, aid, key=None):
    b = rpc(node, "getbalances", [], wallet)["mine"]["trusted"]
    return float(b.get(key or aid, b.get(aid, 0)))


def mint_into_treasury(ticker, aid, units, wait_minutes=20):
    """Mint `units` (the node's whole units) of `ticker` with its reissuance token in `recovered`
    and deliver them to treasury2026; wait until the delivery is in a block, so the treasury can
    spend it. Returns the two txids. Refuses tSEQ and the bridged assets."""
    if not mintable(ticker):
        die("%s is never minted here (only %s are)" % (ticker, ", ".join(sorted(MINTABLE))))
    units = float("%.8f" % units)
    if units <= 0:
        die("a mint of %s %s" % (units, ticker))
    wallets = rpc(MINT_NODE, "listwallets")
    for w in (MINT_WALLET, TREASURY):
        if w not in wallets:
            die("%s is not loaded on %s: nothing can be minted" % (w, MINT_NODE))
    recs = [i for i in rpc(MINT_NODE, "listissuances", [aid], MINT_WALLET) if not i.get("isreissuance")]
    if not recs:
        die("%s holds no issuance record of %s" % (MINT_WALLET, ticker))
    token = recs[0]["token"]
    if trusted(MINT_NODE, MINT_WALLET, token) <= 0:
        die("%s holds no confirmed reissuance token of %s (%s...): move it there once (treasury_mint.sh)" % (MINT_WALLET, ticker, token[:12]))
    # The issuance's fee in the asset itself once the mint wallet holds some of it (each mint
    # keeps a little back for that); an issuance creates no output its own fee could come out
    # of, so a first mint pays it in tSEQ and says so.
    lab = labels(MINT_NODE)
    tseq = lab.get("bitcoin") or lab.get("tSEQ")
    keep = min(0.05, units / 100)
    held = trusted(MINT_NODE, MINT_WALLET, aid)
    if held >= units:
        # a mint whose delivery did not go out (a run stopped between the two): deliver it now
        reissue, fee_name = None, None
        print("  %s already holds %s %s: delivering it, nothing minted" % (MINT_WALLET, held, ticker))
    else:
        fee = aid if held > 0.01 else tseq
        if not fee:
            die("%s holds no %s to pay the issuance's fee in, and the node names no tSEQ" % (MINT_WALLET, ticker))
        reissue = rpc(MINT_NODE, "reissueasset", [aid, units, fee], MINT_WALLET)["txid"]
        fee_name = ticker if fee == aid else "tSEQ"
    to = rpc(MINT_NODE, "getnewaddress", ["", "bech32"], TREASURY)
    # The delivery's fee comes out of what is delivered, in the asset itself.
    st = rpc(MINT_NODE, "sendtoaddress", {"address": to, "amount": float("%.8f" % (units - keep)), "assetlabel": aid,
                                          "subtractfeefromamount": True}, MINT_WALLET)
    rec = {"t": int(time.time()), "asset": ticker, "units": units, "delivered": round(units - keep, 8), "reissue": reissue,
           "delivery": st, "fee_asset": fee_name}
    try:
        with open(MINT_LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass
    if reissue:
        print("  minted %s %s in %s (%s, its fee in %s)" % (units, ticker, MINT_WALLET, reissue, fee_name))
    print("  delivered %s %s to %s: %s" % (rec["delivered"], ticker, TREASURY, st))
    t0 = time.time()
    while rpc(MINT_NODE, "gettransaction", [st], TREASURY).get("confirmations", 0) < 1:
        if time.time() - t0 > wait_minutes * 60:
            die("the delivery of %s %s is not in a block after %d minutes: %s" % (units, ticker, wait_minutes, st))
        time.sleep(5)
    print("  the delivery of %s is in a block" % ticker)
    return reissue, st


def cmd_mint(a):
    """Mint X of asset A into treasury2026: the one mint route every script uses."""
    x = {y["t"]: y for y in assets_of(a.assets)}.get(a.asset)
    if not mintable(a.asset):
        die("%s is never minted here (only %s are)" % (a.asset, ", ".join(sorted(MINTABLE))))
    if not x:
        die("%s is not in %s" % (a.asset, a.assets))
    mint_into_treasury(a.asset, x["id"], a.units, a.minutes)


def cmd_floors(a):
    """Keep treasury2026 at its floor of each mintable asset: once it holds less than `below` of
    the floor, mint it back up to the floor and `over` more. Floors are in the reference unit (USD
    on the testnet), `TICKER USD` a line."""
    assets = {x["t"]: x for x in assets_of(a.assets)}
    feed = http_json(a.prices)
    id2label = {v: k for k, v in labels(MINT_NODE).items()}
    for line in open(a.floors):
        p = line.split()
        if len(p) < 2 or line.startswith("#"):
            continue
        t, usd = p[0], float(p[1])
        x = assets.get(t)
        if not x or not mintable(t):
            print("  %s: never minted here, no floor kept" % t); continue
        px = price(feed, x["feed"])
        if not px:
            print("  %s: no price in the feed, its floor not checked" % t); continue
        floor_units = usd / px
        have = trusted(MINT_NODE, TREASURY, x["id"], id2label.get(x["id"]))
        if have >= floor_units * a.below:
            print("  %s: the treasury holds %.8f, floor %.8f, enough" % (t, have, floor_units)); continue
        units = floor_units * (1 + a.over) - have
        print("  %s: the treasury holds %.8f, under %d%% of its floor %.8f: minting %.8f" % (t, have, round(a.below * 100), floor_units, units))
        if not a.dry_run:
            mint_into_treasury(t, x["id"], units, a.minutes)


def labels(node):
    try:
        return rpc(node, "dumpassetlabels")
    except RuntimeError:
        return {}


def cmd_fund(a):
    """Top each destination up to its target in each asset it needs, from the first allowed
    source wallet that holds enough, the fee paid in the asset sent. A destination names its
    addresses per asset (one coin each) or one address. All the top-ups of one asset from one
    source go out in one sendmany, so a few hundred coins need a few transactions, not a chain
    of unconfirmed sends. Writes the txids."""
    sources = sources_of(a.sources)
    assets = {x["t"]: x for x in assets_of(a.assets)}
    feed = http_json(a.prices)
    lab = {}
    for _, node in sources:
        lab.update(labels(node))
    id2label = {v: k for k, v in lab.items()}
    def held_by(wallet, node, aid):
        b = rpc(node, "getbalances", [], wallet)["mine"]
        key = id2label.get(aid, aid)
        return int(round(float(b["trusted"].get(key, b["trusted"].get(aid, 0))) * NODE_ATOMS))
    avail = {}
    def available(src, aid):
        k = (src, aid)
        if k not in avail:
            avail[k] = held_by(src[0], src[1], aid)
        return avail[k]
    plan = json.load(open(a.plan))
    # What the sources sent that is not in a block yet, by address and asset: a consumer paid at an
    # address counts it as held, so a pass run before the last one's payment confirms pays nothing
    # twice (a scan of the chain's unspent outputs does not see the mempool).
    in_flight = {}
    for w0, n0 in sources:
        try:
            for tx in rpc(n0, "listtransactions", ["*", 500], w0):
                if tx.get("category") == "send" and tx.get("confirmations", 1) == 0 and tx.get("address"):
                    k = (tx["address"], tx.get("asset"))
                    in_flight[k] = in_flight.get(k, 0) + int(round(abs(float(tx["amount"])) * NODE_ATOMS))
        except RuntimeError:
            pass
    def flying(address, aid):
        return in_flight.get((address, aid), 0)
    for dest in plan:
        if dest["kind"] == "arca" and "*" in dest["need"]:
            # every asset the operator serves, from the moment it serves it: the target "*"
            # stands for each one this file knows and the plan names no target of its own
            served = {x.get("asset") for x in http_json(dest["info"]).get("assets", [])}
            every = dest["need"].pop("*")
            for t, x in assets.items():
                if x["id"] in served:
                    dest["need"].setdefault(t, every)
    batches = {}   # (wallet, node, ticker) -> {address: atoms}
    short = []
    for dest in plan:
        for t, usd in dest["need"].items():
            x = assets.get(t)
            if not x:
                continue
            px = price(feed, x["feed"])
            if not px:
                print("  %s %s: no price in the feed, not funded" % (dest["name"], t)); continue
            target = int(usd / px * 10 ** x["prec"])
            if dest["kind"] == "arca":
                # an Arca operator's pool: what a round can pay now (its info's `fundable`, what
                # its wallet can spend less what it owes), and what waits at its address
                # (coins at its address count until the operator's wallet takes them as final;
                # an older coin there is in `fundable` already)
                waits = arca_waits(dest["info"])
                if waits:
                    # finality waits on the Bitcoin anchor: a pause, not a fault; what is paid
                    # now would only wait with the rest, and the final coins carry the rounds
                    print("  %s %s: PAUSED, the operator's finality waits on %s; not paid" % (dest["name"], t, waits))
                    continue
                fundable = arca_fundable(dest["info"], x["id"])
                young = onchain_at(dest["node"], dest["address"], x["id"], newer_than=dest.get("pending_blocks", 60))
                old = onchain_at(dest["node"], dest["address"], x["id"]) - young
                if fundable < old:
                    # coins paid an hour ago and more are still not the operator's to spend: its
                    # finality has stalled, and paying again would only add to what waits
                    print("  %s %s: OPERATOR FINALITY STALLED: %s atoms at its address are an hour old or more, and it can fund %s; not paid" % (
                        dest["name"], t, old, fundable))
                    short.append([dest["name"], t]); continue
                held = fundable + young + flying(dest["address"], x["id"])
            elif dest["kind"] == "ocean":
                held = ocean_balance(a.octl, a.ocean, dest["name"]).get(x["id"], {}).get("total", 0)
            elif dest["kind"] == "leaf":
                # what the maker holds in leaves (read by the script), and what waits on the chain
                # at its address to be boarded
                held = int(dest.get("held", {}).get(t, 0)) + onchain_at(dest["node"], dest["address"], x["id"]) + flying(dest["address"], x["id"])
            else:
                b = rpc(dest["node"], "getbalances", [], dest["name"])["mine"]
                key = id2label.get(x["id"], x["id"])
                held = int(round((float(b["trusted"].get(key, 0)) + float(b["untrusted_pending"].get(key, 0))) * NODE_ATOMS))
            if held >= target * dest.get("floor", a.floor):
                print("  %s %s: holds %s of %s atoms, enough" % (dest["name"], t, held, target)); continue
            want = target - held
            src = next((s0 for s0 in sources if available(s0, x["id"]) >= want), None)
            tre = next((s0 for s0 in sources if s0[0] == TREASURY), None)
            if not src and tre and a.mint and mintable(t):
                # The treasury is short of an asset it can mint: mint what this destination
                # needs and `mint_over` of the reference unit more, so the next ones need none.
                have = available(tre, x["id"])
                units = (want - have) / NODE_ATOMS + a.mint_over_usd / px * 10 ** x["prec"] / NODE_ATOMS
                print("  %s %s: %s holds %s atoms of the %s needed: minting" % (dest["name"], t, TREASURY, have, want))
                mint_into_treasury(t, x["id"], units, a.mint_minutes)
                avail[tre, x["id"]] = held_by(tre[0], tre[1], x["id"]) - sum(v for (w0, n0, t0), o in batches.items() if (w0, n0, t0) == (tre[0], tre[1], t) for v in o.values())
                src = tre if available(tre, x["id"]) >= want else None
            if not src:
                best = max(sources, key=lambda s0: available(s0, x["id"]))
                # what a short source can send is what it holds less what it keeps for the send's
                # own fee, paid in the asset sent (a bridged wallet holds nothing else to pay with)
                held_src = available(best, x["id"])
                have = held_src - max(a.keep_atoms, held_src // 50, 10 ** max(0, x["prec"] - 2))
                if t in a.partial and have > 0:
                    src, want = best, min(want, have)
                else:
                    print("  %s %s: AWAITING SUPPLY, %s atoms needed, the sources hold %s" % (dest["name"], t, want, available(best, x["id"])))
                    short.append([dest["name"], t]); continue
            avail[src, x["id"]] -= want
            if dest["kind"] == "wallet" and not dest.get("address"):
                # a node wallet is paid at an address of its own, drawn once a run
                dest["address"] = rpc(dest["node"], "getnewaddress", ["", "bech32"], dest["name"])
            addrs = (dest.get("addresses") or {}).get(t) or [dest["address"]]
            per = want // len(addrs)
            if per <= 0:
                addrs, per = addrs[:1], want
            batch = batches.setdefault((src[0], src[1], t), {})
            for k, ad in enumerate(addrs):
                batch[ad] = batch.get(ad, 0) + (per if k < len(addrs) - 1 else want - per * (len(addrs) - 1))
            print("  %s %s: holds %s, %s atoms to come from %s in %d coins" % (dest["name"], t, held, want, src[0], len(addrs)))
    sent = []
    for (wallet, node, t), outs in sorted(batches.items()):
        x = assets[t]
        label = id2label.get(x["id"], x["id"])
        total = sum(outs.values())
        if a.dry_run:
            print("  would send %s atoms of %s from %s in one transaction of %d outputs" % (total, t, wallet, len(outs))); continue
        args = {"dummy": "", "amounts": {ad: float("%.8f" % (v / NODE_ATOMS)) for ad, v in outs.items()},
                "output_assets": {ad: label for ad in outs}, "fee_asset": label}
        fee_t = t
        txid = None
        for attempt in range(6):
            try:
                txid = rpc(node, "sendmany", args, wallet)
                break
            except RuntimeError as e:
                if re.search(r"insufficient funds", str(e), re.I) and t in a.partial and attempt < 3:
                    # a bridged source sends what it has: shrink every output by a quarter and try again
                    outs = {ad: v * 3 // 4 for ad, v in outs.items() if v * 3 // 4 > 0}
                    total = sum(outs.values())
                    args["amounts"] = {ad: float("%.8f" % (v / NODE_ATOMS)) for ad, v in outs.items()}
                    args["output_assets"] = {ad: label for ad in outs}
                    print("  %s from %s: insufficient funds; trying %s atoms" % (t, wallet, total)); continue
                if "not accepted" in str(e) and fee_t == t:
                    # The node takes no fee in the asset sent: pay the fee in an asset it does take
                    # that the source holds, and say which.
                    other = fee_asset_for(node, wallet, exclude=x["id"])
                    if not other:
                        die("sendmany of %s %s from %s: the node takes no fee in %s, and %s holds no asset it does take" % (total, t, wallet, t, wallet))
                    args["fee_asset"], fee_t = other[0], other[1]
                    print("  the node takes no fee in %s: this send pays its fee in %s" % (t, fee_t)); continue
                if attempt == 5 or not re.search(r"chain|mempool|missingorspent|unconf", str(e), re.I):
                    # one asset's send failing stops nothing else: it is reported and skipped
                    print("  NOT SENT: %s atoms of %s from %s: %s%s" % (total, t, wallet, str(e)[:160],
                          " (awaiting backed supply)" if t in a.partial else ""))
                    short.append([wallet, t]); txid = None; break
                print("  send retry (%s)" % str(e)[:80]); time.sleep(30)
        if not txid:
            continue
        sent.append({"asset": t, "atoms": total, "outputs": len(outs), "txid": txid, "source": wallet, "node": node, "fee_asset": fee_t})
        print("  sent %s atoms of %s from %s in %d coins, fee in %s: %s" % (total, t, wallet, len(outs), fee_t, txid))
    json.dump({"sent": sent, "short": short}, open(a.out, "w"), indent=1)
    print("  %d transactions; %d account sides awaiting supply" % (len(sent), len(short)))


def fee_asset_for(node, wallet, exclude=None):
    """(label or id, name) of an asset the node takes fees in that the wallet holds most of, by
    value at the node's own rate; None when there is none."""
    rates = rpc(node, "getfeeexchangerates")
    lab = labels(node)
    id2label = {v: k for k, v in lab.items()}
    held = rpc(node, "getbalances", [], wallet)["mine"]["trusted"]
    best = None
    for aid, rate in rates.items():
        if aid == exclude or not rate:
            continue
        key = id2label.get(aid, aid)
        v = float(held.get(key, held.get(aid, 0))) * float(rate)
        if v > 0 and (best is None or v > best[0]):
            best = (v, key)
    return (best[1], best[1]) if best else None


def arca_waits(info_url):
    """What the operator's finality waits on when it is the Bitcoin anchor (its /v1/chain), in
    words; None when it waits on nothing of the kind, or the operator does not say."""
    try:
        c = http_json(info_url.rsplit("/info", 1)[0] + "/chain")
    except Exception:  # noqa: BLE001
        return None
    if c.get("waiting_on") in ("anchor", "anchor_status"):
        return "the Bitcoin anchor (at Bitcoin height %s for %d min, %s rounds waiting)" % (
            c.get("anchor_height"), int(c.get("anchor_unchanged_seconds", 0)) // 60, c.get("rounds_waiting_count"))
    return None


def arca_fundable(info_url, aid):
    for x in http_json(info_url).get("assets", []):
        if x.get("asset") == aid:
            return int(x.get("fundable") or 0)
    die("the operator at %s does not serve %s" % (info_url, aid))


def cmd_plan_targets(a):
    """Funding plans from the targets file (makers/liquidity-targets.json): one plan a consumer,
    each asset its target in the reference unit; `floor` (a share of the target) is when it is
    refilled, and a refill brings it back to the target."""
    cfg = json.load(open(a.targets))
    only = set(x for x in a.only.split(",") if x)
    for f in os.listdir(a.out_dir):
        if f.startswith("target-") and f.endswith(".json"):
            os.remove(os.path.join(a.out_dir, f))
    for name, c in cfg.get("consumers", {}).items():
        if only and name not in only:
            continue
        dest = {k: v for k, v in c.items() if k not in ("comment", "need")}
        dest.setdefault("floor", cfg.get("floor", 0.5))
        dest["name"] = c.get("wallet", name) if c["kind"] == "wallet" else name
        dest["need"] = c["need"]
        addr_file = c.get("address_file")
        if addr_file:
            try:
                dest["address"] = open(addr_file).read().strip()
            except OSError:
                print("  %s: no address at %s yet, not planned" % (name, addr_file)); continue
        out = os.path.join(a.out_dir, "target-%s.json" % name)
        json.dump([dest], open(out, "w"), indent=1)
        print("  %s: %s, floor %s" % (name, " ".join("%s $%s" % kv for kv in c["need"].items()), c.get("floor", cfg.get("floor", 0.5))))


def onchain_at(node, address, aid, newer_than=None):
    r = rpc(node, "scantxoutset", ["start", ["addr(%s)" % address]], timeout=300)
    tip = r.get("height", 0)
    return sum(int(round(float(u["amount"]) * NODE_ATOMS)) for u in r.get("unspents", [])
               if u.get("asset") == aid and (newer_than is None or tip - u.get("height", 0) < newer_than))


def cmd_leafcfg(a):
    """A leaf maker's configuration: the existing one (its wallet, phrase, store, operator,
    listen) with every pair of the assets, priced from the feed, quoted on a ladder whose first
    level is `first_usd` of the asset given (`first_usd_small` for the small-supply assets), and
    per-asset coin sizes. --btc puts the pairs against BTC on the maker's BTC desk instead."""
    cfg = json.load(open(a.config))
    feed = http_json(a.prices)
    assets = assets_of(a.assets)
    small = set(x for x in a.small.split(",") if x)
    pa = {x["id"]: {"ticker": x["feed"], "precision": x["prec"]} for x in assets}
    def atoms(x, usd):
        px = price(feed, x["feed"])
        return str(max(1, int(usd / px * 10 ** x["prec"]))) if px else None
    def first_of(x):
        return atoms(x, a.first_usd_small if x["t"] in small else a.first_usd)
    ladder = {"levels": a.levels, "step_bps": a.step_bps, "growth": a.growth}
    pairs = []
    if a.btc:
        pa["BTC"] = {"ticker": "tBTC", "precision": 8}
        btcp = price(feed, "tBTC")
        for x in assets:
            if x["t"] in small or not first_of(x):
                continue
            pairs.append({"give": "BTC", "want": x["id"], "price": True, "min_give": "10000",
                          "ladder": dict(ladder, first=str(int(a.btc_first_sats)))})
            pairs.append({"give": x["id"], "want": "BTC", "price": True, "min_give": atoms(x, 2) or "1",
                          "ladder": dict(ladder, first=atoms(x, a.btc_asset_first_usd))})
        cfg["pairs"] = []
        cfg.setdefault("btc", {})["pairs"] = pairs
    else:
        for x in assets:
            for y in assets:
                if x is y or not first_of(x) or not price(feed, y["feed"]):
                    continue
                pairs.append({"give": x["id"], "want": y["id"], "price": True,
                              "min_give": atoms(x, 0.05 if x["t"] in small else 1),
                              "ladder": dict(ladder, first=first_of(x))})
        cfg["pairs"] = pairs
        if a.rest_relay:
            # orders resting in the tree, a ladder a directed pair (not the supervised assets,
            # which do not rest), listed on the on-chain book's relay
            cfg["rest"] = {"relay": a.rest_relay, "days": 7, "reprice_bps": 300, "refill_pct": 25, "interval_seconds": 60,
                           "max_new_per_pass": 6,
                           "pairs": [{"give": x["id"], "want": y["id"], "price": True,
                                      "ladder": {"levels": a.levels, "step_bps": a.step_bps, "growth": a.rest_growth, "first": atoms(x, a.rest_first_usd)}}
                                     for x in assets for y in assets
                                     if x is not y and x["t"] not in small and y["t"] not in small and first_of(x) and price(feed, y["feed"])]}
    cfg["prices"] = {"url": a.feed_url, "spread_bps": a.spread_bps, "assets": pa}
    cfg["coin_size"] = {x["id"]: atoms(x, a.coin_usd_small if x["t"] in small else a.coin_usd) for x in assets if price(feed, x["feed"])}
    cfg["board_keep"] = {x["id"]: atoms(x, 0.05 if x["t"] in small else 2) for x in assets if price(feed, x["feed"])}
    cfg["fee_margin"] = {x["id"]: atoms(x, 0.02 if x["t"] in small else 0.2) for x in assets if price(feed, x["feed"])}
    json.dump(cfg, open(a.out, "w"), indent=2)
    print("  %d pairs%s, ladder of %d levels from $%s (small-supply assets $%s), %s bps a level%s" % (
        len(pairs), " on the BTC desk" if a.btc else "", a.levels, a.first_usd, a.first_usd_small, a.step_bps,
        ("; %d pairs resting %d orders each in the tree, from $%s" % (len(cfg["rest"]["pairs"]), a.levels, a.rest_first_usd)) if cfg.get("rest") else ""))


def cmd_plan_leaf(a):
    """A leaf maker's funding plan: `usd` of each asset it gives (`usd_small` for the
    small-supply ones), counting what it holds in leaves and what waits at its address."""
    held = json.load(open(a.held)) if a.held else {}
    small = set(x for x in a.small.split(",") if x)
    plan = [{"name": a.name, "kind": "leaf", "node": a.node, "address": a.address, "held": held,
             "need": {x["t"]: (a.usd_small if x["t"] in small else a.usd) for x in assets_of(a.assets) if x["t"] not in a.skip.split(",")}}]
    json.dump(plan, open(a.out, "w"), indent=1)


def cmd_quotes(a):
    """Wait until a leaf maker quotes every pair it is configured for at `min` levels; print one
    line a pair."""
    cfg = json.load(open(a.config))
    want = [(p["give"], p["want"]) for p in (cfg.get("pairs") or []) + ((cfg.get("btc") or {}).get("pairs") or [])]
    names = {x["id"]: x["t"] for x in assets_of(a.assets)}; names["BTC"] = "BTC"
    t0 = time.time()
    while True:
        try:
            q = http_json(a.url + "/v1/quotes", timeout=60).get("quotes") or []
        except Exception:  # noqa: BLE001
            q = []
        n = {}
        for x in q:
            n[(x["give_asset"], x["want_asset"])] = n.get((x["give_asset"], x["want_asset"]), 0) + 1
        full = sum(1 for k in want if n.get(k, 0) >= a.min)
        if full == len(want) or time.time() - t0 > a.minutes * 60:
            break
        time.sleep(30)
    by = {}
    for g, w in want:
        by.setdefault(names.get(g, g[:8]), []).append("%s:%d" % (names.get(w, w[:8]), n.get((g, w), 0)))
    for g, v in sorted(by.items()):
        print("  gives %s: %s" % (g, " ".join(v)))
    print("  %d of %d pairs quoted at %d levels or more" % (full, len(want), a.min))


def cmd_plan_covseed(a):
    """The covenant seeder's funding plan, read from the seeder itself: each asset it sells
    needs its ladder (the sum of its LEVELS, in the reference unit) once for every other asset
    it is paired with, times `margin`, and the Sequence token for the fundings' fees besides."""
    src = open(a.seeder).read()
    # the levels before COVSEED_SCALE (BASE_LEVELS), times the scale the seeder runs at
    named = "const BASE_LEVELS" if "const BASE_LEVELS" in src else "const LEVELS"
    body = src[src.index(named):]
    body = body[:body.index("};")]
    m = re.search(r"COVSEED_SCALE \|\| (\d+(?:\.\d+)?)", src)
    scale = float(os.environ.get("COVSEED_SCALE") or (m.group(1) if m else 1)) if named == "const BASE_LEVELS" else 1.0
    small = re.search(r"const SMALL = Array.from\(\{ length: (\d+) \}, \(_, k\) => \+\(([\d.]+) \* Math.pow\(([\d.]+), k\)\)", src)
    sums = {}
    for m in re.finditer(r'"?([A-Za-z.]+)"?\s*:\s*\[([\d.,\s]+)\]', body):
        sums[m.group(1)] = sum(float(x) for x in m.group(2).split(",") if x.strip()) * scale
    if small:
        n, v0, g = int(small.group(1)), float(small.group(2)), float(small.group(3))
        for k in re.findall(r'"([A-Za-z.]+)"\s*:\s*SMALL', src):
            sums[k] = sum(v0 * g ** i for i in range(n))
    tick = {"SEQ": "tSEQ"}
    assets = [x["t"] for x in assets_of(a.assets)]
    need = {}
    for sym, total in sums.items():
        t = tick.get(sym, sym)
        if t in assets:
            need[t] = round(total * (len(assets) - 1) * a.margin, 2)
    need["tSEQ"] = need.get("tSEQ", 0) + a.fee_usd
    plan = [{"name": a.wallet, "kind": "wallet", "node": a.node, "address": a.address, "need": need}]
    json.dump(plan, open(a.out, "w"), indent=1)
    print("  %s needs, in the reference unit: %s" % (a.wallet, ", ".join("%s %s" % (k, v) for k, v in sorted(need.items()))))


def cmd_plan_sc(a):
    """The interactive fleet's funding plan: each pair's account, 1.5 times its ladder of each side.
    A pair's level 0 is the smaller of its two assets' level-0 sizes (the fleet's fifth column,
    else `usd` / 26, the sum of ten levels growing 1.2)."""
    accts = json.load(open(a.accounts))
    lvl0 = {}
    for line in open(a.assets):
        p = line.split()
        if len(p) >= 4 and not line.startswith("#"):
            lvl0[p[0]] = float(p[4]) if len(p) >= 5 else a.usd / 26 / 1.5
    ladder = sum(1.2 ** k for k in range(10))
    plan = []
    for k, v in sorted(accts.items()):
        usd = 1.5 * ladder * min(lvl0.get(v["base"], 100), lvl0.get(v["quote"], 100))
        plan.append({"name": k, "kind": "ocean", "need": {v["base"]: usd, v["quote"]: usd},
                     "addresses": {v["base"]: v["base_addresses"], v["quote"]: v["quote_addresses"]}})
    json.dump(plan, open(a.out, "w"), indent=1)
    print("  %d accounts, %s of each side" % (len(plan), a.usd))


def cmd_waitconf(a):
    sent = json.load(open(a.sent))["sent"]
    txids = sorted({s["txid"] for s in sent})
    t0 = time.time()
    while True:
        left = []
        for t in txids:
            s0 = next(x for x in sent if x["txid"] == t)
            try:
                c = rpc(s0["node"], "gettransaction", [t], s0["source"]).get("confirmations", 0)
            except RuntimeError:
                c = 0
            if c < 1:
                left.append(t)
        if not left:
            print("  every send (%d) has a confirmation" % len(txids)); return
        if time.time() - t0 > a.minutes * 60:
            die("%d sends still unconfirmed after %d min: %s" % (len(left), a.minutes, " ".join(x[:12] for x in left[:5])))
        time.sleep(20)


def cmd_oceancheck(a):
    """Every account's Ocean view: what it holds, confirmed, of each asset the plan funded."""
    plan = json.load(open(a.plan))
    assets = {x["t"]: x for x in assets_of(a.assets)}
    bad = 0
    t0 = time.time()
    while True:
        bad, lines = 0, []
        for dest in plan:
            if dest["kind"] != "ocean":
                continue
            b = ocean_balance(a.octl, a.ocean, dest["name"])
            parts = []
            for t in dest["need"]:
                x = assets.get(t)
                if not x:
                    continue
                v = b.get(x["id"], {})
                parts.append("%s %s/%s" % (t, v.get("confirmed", 0), v.get("total", 0)))
                if v.get("confirmed", 0) <= 0 and t not in a.awaiting:
                    bad += 1
            lines.append("  %s: %s (confirmed/total atoms)" % (dest["name"], ", ".join(parts)))
        if not bad or time.time() - t0 > a.minutes * 60:
            break
        time.sleep(20)
    print("\n".join(lines))
    if bad:
        die("%d account sides show nothing confirmed in Ocean" % bad)


def cmd_books(a):
    """Wait until every pair's book on the relay shows at least `min` offers each way."""
    assets = assets_of(a.assets)
    t0 = time.time()
    while True:
        rows, short = [], 0
        for i in range(len(assets)):
            for j in range(i + 1, len(assets)):
                b, q = assets[i], assets[j]
                if b["t"] in a.awaiting or q["t"] in a.awaiting:
                    continue
                try:
                    book = http_json("%s/v1/market/%s/%s/orderbook" % (a.relay, b["id"], q["id"]))
                except Exception as e:  # noqa: BLE001
                    book = {"offers": []}
                o = [x for x in book.get("offers") or [] if not any(k.endswith("covenant") or k == "resting_leaf" for k in x)]
                s = sum(1 for x in o if x.get("trade_dir") == "TRADE_DIR_SELL")
                bu = sum(1 for x in o if x.get("trade_dir") == "TRADE_DIR_BUY")
                rows.append("  %s/%s: %d asks, %d bids (interactive)" % (b["t"], q["t"], s, bu))
                if s < a.min or bu < a.min:
                    short += 1
        if not short or time.time() - t0 > a.minutes * 60:
            break
        time.sleep(20)
    print("\n".join(rows))
    print("  %d of %d pairs short of %d offers a side" % (short, len(rows), a.min))
    if short and a.strict:
        die("%d pairs short" % short)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("accounts"); c.add_argument("--octl"); c.add_argument("--ocean"); c.add_argument("--assets"); c.add_argument("--prefix"); c.add_argument("--coins", type=int, default=10)
    c.add_argument("--node"); c.add_argument("--hrp", default="tb"); c.add_argument("--out")
    c = sp.add_parser("fund"); c.add_argument("--sources"); c.add_argument("--assets"); c.add_argument("--prices")
    c.add_argument("--partial", default="USDC.e,EURC.e"); c.add_argument("--keep-atoms", type=int, default=0)
    c.add_argument("--plan"); c.add_argument("--octl"); c.add_argument("--ocean"); c.add_argument("--floor", type=float, default=0.5); c.add_argument("--coins", type=int, default=4)
    c.add_argument("--out"); c.add_argument("--dry-run", action="store_true")
    c.add_argument("--mint", action="store_true", help="mint into treasury2026 what it is short of a mintable asset")
    c.add_argument("--mint-over-usd", type=float, default=1000000); c.add_argument("--mint-minutes", type=int, default=20)
    c = sp.add_parser("mint"); c.add_argument("--asset", required=True); c.add_argument("--units", type=float, required=True)
    c.add_argument("--assets", required=True); c.add_argument("--minutes", type=int, default=20)
    c = sp.add_parser("floors"); c.add_argument("--floors", required=True); c.add_argument("--assets", required=True); c.add_argument("--prices", required=True)
    c.add_argument("--below", type=float, default=0.5); c.add_argument("--over", type=float, default=0.5); c.add_argument("--minutes", type=int, default=20)
    c.add_argument("--dry-run", action="store_true")
    c = sp.add_parser("plan-targets"); c.add_argument("--targets", required=True); c.add_argument("--out-dir", required=True); c.add_argument("--only", default="")
    c = sp.add_parser("plan-sc"); c.add_argument("--accounts"); c.add_argument("--assets"); c.add_argument("--usd", type=float, default=390000); c.add_argument("--coins", type=int, default=4); c.add_argument("--out")
    c = sp.add_parser("leafcfg"); c.add_argument("--config"); c.add_argument("--assets"); c.add_argument("--prices"); c.add_argument("--feed-url")
    c.add_argument("--out"); c.add_argument("--btc", action="store_true"); c.add_argument("--small", default="USDC.e,EURC.e")
    c.add_argument("--levels", type=int, default=8); c.add_argument("--step-bps", type=int, default=25); c.add_argument("--growth", type=float, default=1.4)
    c.add_argument("--first-usd", type=float, default=12000); c.add_argument("--first-usd-small", type=float, default=0.25)
    c.add_argument("--coin-usd", type=float, default=25000); c.add_argument("--coin-usd-small", type=float, default=2)
    c.add_argument("--spread-bps", type=int, default=30); c.add_argument("--btc-first-sats", type=int, default=15000000)
    c.add_argument("--btc-asset-first-usd", type=float, default=12000)
    c.add_argument("--rest-relay", default=""); c.add_argument("--rest-first-usd", type=float, default=5000); c.add_argument("--rest-growth", type=float, default=1.3)
    c = sp.add_parser("plan-leaf"); c.add_argument("--name"); c.add_argument("--node"); c.add_argument("--address"); c.add_argument("--assets")
    c.add_argument("--held"); c.add_argument("--usd", type=float, default=1000000); c.add_argument("--usd-small", type=float, default=10)
    c.add_argument("--small", default="USDC.e,EURC.e"); c.add_argument("--skip", default=""); c.add_argument("--out")
    c = sp.add_parser("quotes"); c.add_argument("--url"); c.add_argument("--config"); c.add_argument("--assets"); c.add_argument("--min", type=int, default=8); c.add_argument("--minutes", type=int, default=20)
    c = sp.add_parser("plan-covseed"); c.add_argument("--seeder"); c.add_argument("--assets"); c.add_argument("--wallet"); c.add_argument("--node")
    c.add_argument("--address"); c.add_argument("--margin", type=float, default=1.25); c.add_argument("--fee-usd", type=float, default=2000); c.add_argument("--out")
    c = sp.add_parser("waitconf"); c.add_argument("--sent"); c.add_argument("--minutes", type=int, default=20)
    c = sp.add_parser("oceancheck"); c.add_argument("--octl"); c.add_argument("--ocean"); c.add_argument("--plan"); c.add_argument("--assets"); c.add_argument("--minutes", type=int, default=5)
    c.add_argument("--awaiting", default="")
    c = sp.add_parser("books"); c.add_argument("--relay"); c.add_argument("--assets"); c.add_argument("--min", type=int, default=8); c.add_argument("--minutes", type=int, default=10)
    c.add_argument("--awaiting", default=""); c.add_argument("--strict", action="store_true")
    a = ap.parse_args()
    for k in ("awaiting", "partial"):
        if hasattr(a, k):
            setattr(a, k, set(x for x in getattr(a, k).split(",") if x))
    {"mint": cmd_mint, "floors": cmd_floors, "plan-targets": cmd_plan_targets, "accounts": cmd_accounts, "plan-sc": cmd_plan_sc, "plan-covseed": cmd_plan_covseed,
     "leafcfg": cmd_leafcfg, "plan-leaf": cmd_plan_leaf, "quotes": cmd_quotes, "fund": cmd_fund, "waitconf": cmd_waitconf, "oceancheck": cmd_oceancheck,
     "books": cmd_books}[a.cmd](a)


if __name__ == "__main__":
    main()
