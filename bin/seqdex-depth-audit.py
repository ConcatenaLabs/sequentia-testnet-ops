#!/usr/bin/env python3
"""seqdex-depth-audit: how deep every SeqDEX market is, rail by rail, and whether its best
level can be taken right now.

A market here is a direction of trade between two assets: the taker gives one and gets the
other. Ten assets give 45 pairs and 90 directed markets. For each, and for each rail (each
book or maker a wallet reaches), the audit counts the offers that serve it, the price levels
they make, and their depth in the price server's reference unit, and checks the best level:

  cov      covenant orders on the on-chain book (/seqob): the coin is unspent at the tip
  rest     orders resting as leaves in an operator's tree (/seqob): the operator calls the
           order active
  int      interactive same-chain offers (/seqob), transparent
  xbtc     cross-chain BTC offers (/seqob)
  pln      the Lightning book (/seqob-pln)
  conf     the confidential book (/seqob-conf); no BTC pairs, by consensus
  leaf     the leaf maker's quotes (/leafmaker)
  leafbtc  the BTC leaf maker's quotes (/leafmaker-btc)

A market is CROSSED when its combined book, the one every wallet shows (the on-chain book's
covenant, resting, interactive and cross-chain offers, both orientations of the pair taken
together), has a best bid at or above its best ask: a taker could buy and sell back at a
profit. For every pair the audit prints its best bid and ask, and for a crossed one the two
offers that cross, their rails, their distance from the feed and their age.

The check on an interactive, cross-chain or Lightning offer is a lift the relay must refuse:
the relay's courier is asked to lift one atom more than the offer has left. The relay
answers "maker is not connected" when nobody can fill the offer, and "take_amount exceeds
active_amount" when its maker is there; either way no session opens, nobody is asked to
sign, and the maker is not disturbed. A leaf maker's check is its quote.

Usage:
  seqdex-depth-audit.py [--base https://sequentiatestnet.com] [--json OUT] [--no-probe]
                        [--rails cov,rest,...] [--quiet] [--crossed-only]
--crossed-only reads the on-chain book and the feed only, prints the crossed-market section
with every pair's best bid and ask, and exits 1 when any market is crossed.
The base serves every mount; each mount can be pointed elsewhere (--seqob URL, --pln URL,
--conf URL, --leaf URL, --leafbtc URL, --prices URL, --esplora URL), e.g. at the box's
loopback ports. Exit status: 0 when every required rail of every market passes and no market
is crossed, 1 when any falls short or is crossed, 2 when the audit itself could not run (a
feed or book unreachable).
"""
import argparse, base64, json, os, socket, ssl, struct, sys, time, urllib.parse, urllib.request
from decimal import Decimal

# The assets that trade freely. Restricted (OpenAMP) and sale tokens are not here: their
# transfers are governed by their issuers. `feed` is the key the price server uses.
ASSETS = [
    # ticker,   asset id (display order),                                              precision, feed
    ("BTC",    "BTC",                                                                   8, "tBTC"),
    ("tSEQ",   "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40", 8, "SEQ"),
    ("USDX",   "2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de", 8, "USDX"),
    ("EURX",   "e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13", 8, "EURX"),
    ("GOLD",   "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1", 8, "GOLD"),
    ("SILVR",  "57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48", 8, "SILVR"),
    ("OILX",   "4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f", 8, "OILX"),
    ("USDC.e", "9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa", 6, "USDC"),
    ("EURC.e", "d1bb6f4d0d12dde93405c23da8da38c6d00270930d75b7cdcb91ad8f0646efef", 6, "EURC"),
]
BY_ID = {a[1]: a for a in ASSETS}
TICK = {a[1]: a[0] for a in ASSETS}

RAILS = ["cov", "rest", "int", "xbtc", "pln", "conf", "leaf", "leafbtc"]
# The levels a rail must show per directed market, where it serves that market.
TARGET = {"cov": 20, "rest": 8, "int": 8, "xbtc": 8, "pln": 8, "conf": 8, "leaf": 8, "leafbtc": 8}


# The supervised assets: their issuer can freeze a holder, so they are never confidential, and the
# Arca operator carries no Lightning leg in them.
SUPERVISED = {"9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa",
              "d1bb6f4d0d12dde93405c23da8da38c6d00270930d75b7cdcb91ad8f0646efef"}


def serves(rail, give, get):
    """Whether a rail can serve a market at all. BTC lives on the parent chain, so no covenant,
    resting, interactive same-chain, confidential or in-tree order holds it; the BTC rails carry
    only BTC pairs. A supervised asset is never confidential, and has no Lightning leg at the
    operator, so no resting order and no BTC leaf trade."""
    btc = "BTC" in (give, get)
    sup = bool(SUPERVISED & {give, get})
    if rail in ("cov", "int", "leaf"):
        return not btc
    if rail == "rest":
        return not btc and not sup
    if rail == "conf":
        return not btc and not sup
    if rail == "xbtc":
        return btc
    if rail == "leafbtc":
        return btc and not sup
    return True  # pln: the Lightning book carries asset pairs and BTC pairs


def required(rail, give, get):
    """The rails a default-mode surface uses for a market, which must pass: covenant, interactive
    and in-tree for asset pairs (and resting where the asset can rest in the tree), the Lightning
    book and the BTC leaf maker for BTC pairs. The cross-chain and confidential books are the
    developer composers' and are reported, not required."""
    if not serves(rail, give, get):
        return False
    btc = "BTC" in (give, get)
    if rail in ("cov", "int", "leaf", "rest"):
        return True
    if rail in ("pln", "leafbtc"):
        return btc and not (SUPERVISED & {give, get})
    return False


# ---------------------------------------------------------------- http

def http_json(url, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json",
                                                          "User-Agent": "seqdex-depth-audit"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def try_json(url, body=None, timeout=30):
    try:
        return http_json(url, body, timeout), None
    except Exception as e:  # noqa: BLE001 - every failure is reported, not raised
        return None, f"{type(e).__name__}: {str(e)[:160]}"


# ---------------------------------------------------------------- websocket (RFC 6455, text only)

class WS:
    """The least WebSocket client the relay's courier needs: text frames out, masked; text frames
    in. One connection per relay, the probes sent one after another on it."""

    def __init__(self, url, timeout=20):
        u = urllib.parse.urlparse(url)
        port = u.port or (443 if u.scheme == "wss" else 80)
        raw = socket.create_connection((u.hostname, port), timeout=timeout)
        if u.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname)
        self.s = raw
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        host = u.hostname + ("" if u.port in (None, 80, 443) else f":{u.port}")
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                        f"Sec-WebSocket-Version: 13\r\nUser-Agent: seqdex-depth-audit\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.s.recv(4096)
            if not c:
                raise ConnectionError("closed during the handshake")
            head += c
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status + " ":
            raise ConnectionError("handshake refused: " + status)
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise ConnectionError("relay closed the connection")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        p = json.dumps(obj).encode()
        hdr = bytes([0x81])
        n = len(p)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(p)))

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            p = self._read(n)
            if mask:
                p = bytes(b ^ mask[i % 4] for i, b in enumerate(p))
            op = b0 & 0x0F
            if op == 0x8:
                raise ConnectionError("relay closed the connection")
            if op == 0x9:  # ping: answer, keep reading
                self.s.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if op in (0x1, 0x2):
                try:
                    return json.loads(p.decode())
                except ValueError:
                    continue

    def close(self):
        try:
            self.s.sendall(bytes([0x88, 0x80]) + os.urandom(4))
            self.s.close()
        except OSError:
            pass


def ws_url(mount):
    return mount.replace("https://", "wss://").replace("http://", "ws://") + "/v1/ws"


def probe_lift(ws, offer, status):
    """Ask the relay to lift one atom more than the offer has left. Returns (liftable, words)."""
    active = int(status.get("active_amount") or offer.get("base_amount") or 0)
    ws.send({"start_lift": {"offer_id": offer["offer_id"], "maker_pubkey": offer["maker_pubkey"],
                            "take_amount": str(active + 1), "taker_fee_asset": "",
                            "taker_session_pubkey": base64.b64encode(b"\x02" + os.urandom(32)).decode()}})
    deadline = time.time() + 20
    while time.time() < deadline:
        m = ws.recv()
        if m.get("lift_accepted") or m.get("liftAccepted"):
            # Should not happen (the amount is over); say so rather than claim liftable.
            return None, "the relay opened a lift for more than the offer holds"
        err = m.get("error")
        if err:
            msg = str(err.get("message") or err)
            if "exceeds active_amount" in msg:
                return True, "maker connected"
            return False, msg[:120]
    return None, "no answer from the relay"


# ---------------------------------------------------------------- prices and units

def load_prices(url):
    j = http_json(url)
    out = {}
    for t, _id, _p, key in ASSETS:
        v = j.get(key)
        v = v.get("price") if isinstance(v, dict) else v
        try:
            out[_id] = float(v) if v is not None and float(v) > 0 else None
        except (TypeError, ValueError):
            out[_id] = None
    return out


def units(asset, atoms):
    return Decimal(int(atoms)) / (Decimal(10) ** BY_ID[asset][2])


def level_key(price):
    """Two offers at prices within one part in 10^6 of each other are one level."""
    if price <= 0:
        return 0.0
    return float(f"{price:.6g}")


# ---------------------------------------------------------------- the books

def offer_rail(o, mount_rail):
    if mount_rail != "seqob":
        return mount_rail
    if o.get("resting_leaf"):
        return "rest"
    if o.get("covenant") or o.get("simplicity_covenant") or any(
            k.endswith("covenant") and isinstance(v, dict) for k, v in o.items()):
        return "cov"
    if o.get("cross_chain"):
        return "xbtc"
    if o.get("lightning"):
        return "pln"  # a submarine offer on the on-chain book; counted with the Lightning rail
    if o.get("confidential") or (o.get("pair") or {}).get("confidential"):
        return "conf"
    return "int"


def read_book(mount, mount_rail, problems):
    """Every offer of every market of a relay, with its status, as (rail, offer, status, mount)."""
    j, err = try_json(mount + "/v1/markets")
    if err:
        problems.append(f"{mount}: markets unreachable ({err})")
        return []
    out = []
    for m in j.get("markets") or []:
        p = m["pair"]
        q = f"{mount}/v1/market/{p['base_asset']}/{p['quote_asset']}/orderbook"
        if p.get("confidential"):
            q += "?confidential=1"
        b, err = try_json(q)
        if err:
            problems.append(f"{q}: {err}")
            continue
        offers, st = b.get("offers") or [], b.get("statuses") or []
        for i, o in enumerate(offers):
            s = st[i] if i < len(st) else {}
            out.append((offer_rail(o, mount_rail), o, s, mount))
    return out


def norm_asset(a):
    return "BTC" if a in ("BTC", "", None) else a


def offer_entry(rail, o, s, mount):
    """What a taker sees in one offer: it gives `want_asset` and gets `offer_asset`."""
    give, get = norm_asset(o.get("want_asset")), norm_asset(o.get("offer_asset"))
    if give not in BY_ID or get not in BY_ID or give == get:
        return None
    offer_amt, want_amt = int(o.get("offer_amount") or 0), int(o.get("want_amount") or 0)
    if offer_amt <= 0 or want_amt <= 0:
        return None
    # What is left of the offer in the asset the maker gives. The status's active_amount is in
    # base atoms; the maker gives the base when it sells, the quote when it buys.
    base_amt = int(o.get("base_amount") or offer_amt)
    active = int(s.get("active_amount") or base_amt) if s else base_amt
    if str(s.get("status", "")).endswith(("FILLED", "CANCELLED", "EXPIRED")):
        active = 0
    sells_base = str(o.get("trade_dir")) in ("TRADE_DIR_SELL", "1")
    left = active if sells_base else (offer_amt * active) // max(base_amt, 1)
    left = min(left, offer_amt)
    price = float(units(give, want_amt) / units(get, offer_amt))  # give-units per get-unit
    return {"rail": rail, "give": give, "get": get, "price": price, "left": left,
            "offer": o, "status": s, "mount": mount}


def read_leaf(url, rail, problems):
    j, err = try_json(url + "/v1/quotes")
    if err:
        problems.append(f"{url}: quotes unreachable ({err})")
        return []
    out = []
    for q in j.get("quotes") or []:
        giv, want = norm_asset(q.get("give_asset")), norm_asset(q.get("want_asset"))
        if giv not in BY_ID or want not in BY_ID:
            continue
        num, den = int(q.get("rate_num") or 0), int(q.get("rate_den") or 0)
        mx, mn = int(q.get("max_give") or 0), int(q.get("min_give") or 0)
        if num <= 0 or den <= 0 or mx <= 0:
            continue
        # The maker gives `give_asset` and wants rate_num/rate_den atoms of want per atom given.
        price = float((Decimal(num) / Decimal(den)) * (Decimal(10) ** BY_ID[giv][2]) / (Decimal(10) ** BY_ID[want][2]))
        out.append({"rail": rail, "give": want, "get": giv, "price": price, "left": mx,
                    "quote": q, "liftable": mx >= mn, "words": "quoted" if mx >= mn else "max below min"})
    return out


# ---------------------------------------------------------------- liftability

def check_cov(e, esplora):
    o = e["offer"]
    t = None
    for k, v in o.items():
        if k.endswith("covenant") and isinstance(v, dict):
            t = v
    if not t:
        return None, "no covenant terms"
    if e["left"] <= 0:
        return False, "the relay lists it at 0"
    j, err = try_json(f"{esplora}/tx/{t['covenant_txid']}/outspend/{int(t.get('covenant_vout') or 0)}")
    if err:
        return None, "explorer: " + err
    return (not j.get("spent")), ("coin unspent" if not j.get("spent") else "coin spent")


def check_rest(e):
    """The operator's own word on the order (`/v1/order_state`): resting, at the coin the offer
    names, with fills left."""
    r = e["offer"]["resting_leaf"]
    j, err = try_json(r["operator_url"].rstrip("/") + "/v1/order_state", {"orders": [r["order_id"]]})
    if err:
        return None, "operator: " + err
    st = next((x for x in (j.get("orders") or []) if str(x.get("order", "")).lower() == r["order_id"].lower()), None)
    if not st:
        return False, "operator: order not published"
    # The operator's states: `resting` is live and fillable; `exhausted`, `filling`, `filled`,
    # `cancelled`, `landed`, `pending` and `unknown` are not.
    if st.get("state") != "resting":
        return False, f"operator: {st.get('state')}"
    if r.get("coin") and st.get("coin") and st["coin"].lower() != r["coin"].lower():
        return False, "operator: the order moved to another coin"
    if int(st.get("fills_left") or 1) <= 0:
        return False, "operator: no fills left"
    return True, "operator: resting"


# ---------------------------------------------------------------- crossed markets

COMBINED = ("cov", "rest", "int", "xbtc")   # the rails of the book every wallet shows


def crossed_markets(entries, prices, now=None):
    """Every pair's combined best bid and ask, and whether they cross.

    A pair X/Y (X before Y in ASSETS) has asks where a taker gives Y and gets X (price in Y per
    X) and bids where a taker gives X and gets Y (price p in X per Y, a bid of 1/p Y per X). It
    is crossed when the best bid is at or above the best ask."""
    now = now or time.time()
    best = {}
    for e in entries:
        if e["rail"] not in COMBINED or e["left"] <= 0:
            continue
        k = (e["give"], e["get"])
        if k not in best or e["price"] < best[k]["price"]:
            best[k] = e

    def describe(e, px, fair):
        o = e["offer"]
        age = now - int(o.get("created_at_unix") or now)
        d = {"rail": e["rail"], "price": px, "maker": str(o.get("maker_pubkey", ""))[:12],
             "offer_id": o.get("offer_id"), "age_s": int(age)}
        if fair:
            d["off_feed_pct"] = round((px / fair - 1) * 100, 3)
        return d

    out = []
    ids = [a[1] for a in ASSETS]
    for i, x in enumerate(ids):
        for y in ids[i + 1:]:
            a, b = best.get((y, x)), best.get((x, y))
            if not a and not b:
                continue
            fair = (prices.get(x) / prices.get(y)) if prices.get(x) and prices.get(y) else None
            ask = a["price"] if a else None
            bid = (1 / b["price"]) if b else None
            row = {"pair": f"{TICK[x]}/{TICK[y]}", "bid": bid, "ask": ask, "feed": fair,
                   "crossed": bool(ask and bid and bid >= ask)}
            if row["crossed"]:
                row["bid_offer"], row["ask_offer"] = describe(b, bid, fair), describe(a, ask, fair)
            out.append(row)
    return out


def render_crossed(rows):
    lines = ["crossed markets (the combined book: " + ", ".join(COMBINED) + "; bid >= ask is crossed):"]
    for r in rows:
        f = lambda v: f"{v:.6g}" if v else "-"
        line = f"  {r['pair']:<14} bid {f(r['bid']):>12}  ask {f(r['ask']):>12}  feed {f(r['feed']):>12}"
        if r["crossed"]:
            def side(d):
                off = f" {d['off_feed_pct']:+.2f}% off the feed" if "off_feed_pct" in d else ""
                return f"{d['rail']} {d['maker']} {d['age_s'] // 60} min old{off}"
            line += f"  CROSSED: bid {side(r['bid_offer'])} | ask {side(r['ask_offer'])}"
        lines.append(line)
    n = sum(1 for r in rows if r["crossed"])
    lines.append(f"crossed: {n} of {len(rows)} pairs")
    return "\n".join(lines)


# ---------------------------------------------------------------- the audit

def audit(args):
    problems = []
    prices = load_prices(args.prices)
    rails = set(args.rails.split(",")) if args.rails else set(RAILS)
    entries = []
    stale = []
    if rails & {"cov", "rest", "int", "xbtc"}:
        for (rail, o, s, mount) in read_book(args.seqob, "seqob", problems):
            if rail == "int":
                age = time.time() - int(o.get("created_at_unix") or time.time())
                if age > args.stale_minutes * 60:
                    stale.append((o.get("maker_pubkey") or "?", int(age // 60)))
            e = offer_entry(rail, o, s, mount)
            if e and rail in rails and rail != "pln" and rail != "conf":
                entries.append(e)
    if "pln" in rails:
        for (rail, o, s, mount) in read_book(args.pln, "pln", problems):
            e = offer_entry("pln", o, s, mount)
            if e:
                entries.append(e)
    if "conf" in rails:
        for (rail, o, s, mount) in read_book(args.conf, "conf", problems):
            e = offer_entry("conf", o, s, mount)
            if e:
                entries.append(e)
    if "leaf" in rails:
        entries += read_leaf(args.leaf, "leaf", problems)
    if "leafbtc" in rails:
        entries += read_leaf(args.leafbtc, "leafbtc", problems)

    # group: (give, get, rail) -> entries
    groups = {}
    for e in entries:
        groups.setdefault((e["give"], e["get"], e["rail"]), []).append(e)

    # liftability of each group's best level (lowest price the taker pays per unit got)
    sockets = {}
    for key, es in groups.items():
        es.sort(key=lambda e: e["price"])
        live = [e for e in es if e["left"] > 0]
        best = live[0] if live else None
        ok, words = (False, "nothing left to take") if not best else (None, "")
        if best is not None:
            rail = key[2]
            if rail in ("leaf", "leafbtc"):
                ok, words = best["liftable"], best["words"]
            elif rail == "cov":
                ok, words = check_cov(best, args.esplora)
            elif rail == "rest":
                ok, words = check_rest(best)
            elif args.no_probe:
                ok, words = None, "not probed"
            else:
                m = best["mount"]
                try:
                    if m not in sockets:
                        sockets[m] = WS(ws_url(m))
                    ok, words = probe_lift(sockets[m], best["offer"], best["status"])
                except Exception as ex:  # noqa: BLE001
                    sockets.pop(m, None)
                    ok, words = None, f"probe failed: {type(ex).__name__}: {str(ex)[:80]}"
        for e in es:
            e["_best"] = e is best
        groups[key] = {"entries": es, "best_ok": ok, "best_words": words, "best": best}
    for w in sockets.values():
        w.close()

    rows = []
    ids = [a[1] for a in ASSETS]
    for give in ids:
        for get in ids:
            if give == get:
                continue
            row = {"give": TICK[give], "get": TICK[get], "rails": {}, "verdict": "ok", "short": []}
            for rail in RAILS:
                if rail not in rails or not serves(rail, give, get):
                    continue
                g = groups.get((give, get, rail))
                if not g:
                    cell = {"offers": 0, "levels": 0, "depth": 0.0, "best": None, "liftable": None, "words": "empty"}
                else:
                    live = [e for e in g["entries"] if e["left"] > 0]
                    px = prices.get(get)
                    depth = sum(float(units(get, e["left"])) for e in live) * (px or 0)
                    cell = {"offers": len(live), "levels": len({level_key(e["price"]) for e in live}),
                            "depth": round(depth, 2),
                            "best": (g["best"]["price"] if g["best"] else None),
                            "liftable": g["best_ok"], "words": g["best_words"]}
                need = TARGET[rail]
                cell["target"] = need
                cell["pass"] = bool(cell["levels"] >= need and cell["liftable"] is True)
                row["rails"][rail] = cell
                cell["required"] = rail in args.required and required(rail, give, get)
                if cell["required"] and not cell["pass"]:
                    row["short"].append(rail)
            waiting = sorted({TICK[a] for a in (give, get)} & args.awaiting)
            if waiting:
                row["verdict"] = "awaiting backed supply"
                row["waiting"] = waiting
                row["short"] = []
            elif row["short"]:
                row["verdict"] = "SHORT"
            elif not any(c.get("required") for c in row["rails"].values()):
                row["verdict"] = "no default route"
            rows.append(row)
    return {"at": int(time.time()), "prices": {TICK[k]: v for k, v in prices.items()},
            "rails": sorted(rails, key=RAILS.index), "required": sorted(args.required, key=RAILS.index),
            "markets": rows, "crossed": crossed_markets(entries, prices), "problems": problems,
            "stale_interactive": stale_report(stale, args.stale_minutes)}


def stale_report(stale, minutes):
    """Interactive offers listed longer than the fleet ever keeps one (it re-quotes every ten
    minutes): an earlier run's offers no one co-signs, which a taker meets as 'maker did not
    answer'."""
    by = {}
    for pub, age in stale:
        n, oldest = by.get(pub, (0, 0))
        by[pub] = (n + 1, max(oldest, age))
    return {"minutes": minutes, "count": len(stale),
            "makers": [{"maker": k, "offers": n, "oldest_minutes": a} for k, (n, a) in sorted(by.items(), key=lambda x: -x[1][0])]}


def audit_crossed(args):
    """The crossed-market section alone: the on-chain book and the feed, no probes."""
    problems = []
    prices = load_prices(args.prices)
    entries = [e for e in (offer_entry(r, o, s, m) for (r, o, s, m) in read_book(args.seqob, "seqob", problems)) if e]
    if problems and not entries:
        raise RuntimeError("; ".join(problems))
    return {"at": int(time.time()), "prices": {TICK[k]: v for k, v in prices.items()},
            "crossed": crossed_markets(entries, prices), "problems": problems}


def money(x):
    if x >= 1e6:
        return f"{x/1e6:.1f}M"
    if x >= 1e3:
        return f"{x/1e3:.1f}k"
    return f"{x:.0f}"


def render(rep, quiet=False):
    rails = rep["rails"]
    lines = []
    hdr = f"{'market (taker gives > gets)':<22}" + "".join(f"{r:>17}" for r in rails) + "  verdict"
    lines.append("cell = levels/target  depth in the reference unit  best level: + liftable, x not, ? unknown, . none;  ~ reported, not required;  - the rail cannot carry the market")
    lines.append(hdr)
    lines.append("-" * len(hdr))
    nshort = 0
    for row in rep["markets"]:
        if row["short"]:
            nshort += 1
        if quiet and not row["short"]:
            continue
        cells = []
        for r in rails:
            c = row["rails"].get(r)
            if c is None:
                cells.append(f"{'-':>17}")
                continue
            opt = " " if c.get("required") else "~"
            mark = {True: "+", False: "x", None: "?"}[c["liftable"]] if c["offers"] else "."
            cells.append(f"{c['levels']:>3}/{c['target']:<2} {money(c['depth']):>7} {mark:>1}{opt} ")
        v = "SHORT: " + ",".join(row["short"]) if row["short"] else row["verdict"]
        lines.append(f"{row['give'] + ' > ' + row['get']:<22}" + "".join(cells) + "  " + v)
    lines.append("")
    noroute = [r["give"] + " > " + r["get"] for r in rep["markets"] if r["verdict"] == "no default route"]
    waiting = [r for r in rep["markets"] if r["verdict"] == "awaiting backed supply"]
    tot = len(rep["markets"]) - len(noroute) - len(waiting)
    if waiting:
        lines.append(f"awaiting backed supply ({', '.join(sorted({t for r in waiting for t in r['waiting']}))}: bridged and "
                     f"fully backed, so a maker holds them only once a deposit has minted them): {len(waiting)} markets, not counted")
    if noroute:
        lines.append(f"no one-step default-mode route (the supervised assets carry no Lightning leg): {', '.join(noroute)}")
    lines.append(f"verdict: {tot - nshort} of {tot} directed markets have every required rail "
                 f"({','.join(rep['required'])}) at its levels with a liftable best level; {nshort} short.")
    # per rail: of the markets that require it, how many pass
    for r in rails:
        req = [row["rails"][r] for row in rep["markets"]
               if r in row["rails"] and row["rails"][r].get("required") and row["verdict"] != "awaiting backed supply"]
        if req:
            lines.append(f"  {r:<8} passes {sum(1 for c in req if c['pass']):>2} of {len(req):>2} markets that require it")
    # the reasons best levels were not liftable, counted
    why = {}
    for row in rep["markets"]:
        for r, c in row["rails"].items():
            if c["offers"] and c["liftable"] is not True:
                why.setdefault((r, c["words"]), 0)
                why[(r, c["words"])] += 1
    for (r, w), n in sorted(why.items(), key=lambda x: -x[1]):
        lines.append(f"  best level not liftable: {r}: {w} ({n} markets)")
    st = rep.get("stale_interactive") or {}
    lines.append("")
    lines.append(f"dead interactive offers listed: {st.get('count', 0)} older than {st.get('minutes')} min (the fleet re-quotes every 10)")
    for m in (st.get("makers") or [])[:10]:
        lines.append(f"  maker {m['maker'][:16]}…: {m['offers']} offers, the oldest {m['oldest_minutes']} min")
    lines.append("")
    lines.append(render_crossed(rep.get("crossed") or []))
    for p in rep["problems"]:
        lines.append(f"  problem: {p}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("SEQDEX_AUDIT_BASE", "https://sequentiatestnet.com"))
    for k in ("seqob", "pln", "conf", "leaf", "leafbtc", "prices", "esplora"):
        ap.add_argument("--" + k)
    ap.add_argument("--rails", help="comma-separated subset of " + ",".join(RAILS))
    ap.add_argument("--required", default="cov,rest,int,pln,leaf,leafbtc",
                    help="the rails a market may be required to pass on; each market requires those of them a default-mode surface uses for it (see required())")
    ap.add_argument("--assets", help="a JSON file of [ticker, asset id, precision, feed key] rows in place of the "
                    "testnet's assets (a regtest rehearsal's own)")
    ap.add_argument("--awaiting", default="",
                    help="comma-separated tickers whose markets are reported but not counted, as awaiting backed supply")
    ap.add_argument("--no-probe", action="store_true", help="skip the courier probe of interactive, cross-chain and Lightning offers")
    ap.add_argument("--json", help="write the full report as JSON here")
    ap.add_argument("--quiet", action="store_true", help="print only the markets that fall short, and the verdict")
    ap.add_argument("--stale-minutes", type=int, default=30,
                    help="an interactive offer listed longer than this is reported as dead (the fleet re-quotes every ten minutes)")
    ap.add_argument("--crossed-only", action="store_true", help="only the crossed-market section: the on-chain book and the feed, no probes")
    args = ap.parse_args()
    b = args.base.rstrip("/")
    args.seqob = (args.seqob or b + "/seqob").rstrip("/")
    args.pln = (args.pln or b + "/seqob-pln").rstrip("/")
    args.conf = (args.conf or b + "/seqob-conf").rstrip("/")
    args.leaf = (args.leaf or b + "/leafmaker").rstrip("/")
    args.leafbtc = (args.leafbtc or b + "/leafmaker-btc").rstrip("/")
    args.prices = args.prices or b + "/prices"
    args.esplora = (args.esplora or b + "/api").rstrip("/")
    args.required = set(x for x in args.required.split(",") if x)
    if args.assets:
        with open(args.assets) as f:
            rows = [tuple(r) for r in json.load(f)]
        ASSETS[:] = rows
        BY_ID.clear(); BY_ID.update({a[1]: a for a in rows})
        TICK.clear(); TICK.update({a[1]: a[0] for a in rows})
    args.awaiting = set(x for x in args.awaiting.split(",") if x)
    try:
        rep = audit_crossed(args) if args.crossed_only else audit(args)
    except Exception as e:  # noqa: BLE001
        print(f"audit could not run: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    print(time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(rep["at"])) + "  seqdex depth audit")
    if args.crossed_only:
        print(render_crossed(rep["crossed"]))
        for p in rep["problems"]:
            print(f"  problem: {p}")
    else:
        print(render(rep, args.quiet))
    if args.json:
        tmp = args.json + ".tmp"
        with open(tmp, "w") as f:
            json.dump(rep, f, indent=1, default=str)
        os.replace(tmp, args.json)
    crossed = any(r["crossed"] for r in rep["crossed"])
    dead = (rep.get("stale_interactive") or {}).get("count", 0)
    return 1 if crossed or dead or any(r["short"] for r in rep.get("markets", [])) else 0


if __name__ == "__main__":
    sys.exit(main())
