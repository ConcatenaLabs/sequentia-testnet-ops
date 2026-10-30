#!/usr/bin/env python3
# btc_desk_room.py: the BTC desk's Lightning room against its ladder, for the health pass.
#
# The leaf maker's BTC desk gives BTC from what its own Lightning node can send (less keep_sats)
# and buys BTC up to 90% of what the node can be paid; every pair quotes from the same balance.
# This reads the desk's unit, its configuration and its node's channels, and prints the ladder's
# need against the room each way. It exits 1 when either way is short of `margin` times the
# ladder (the owner script lq3_5_btc_desk.sh opens what is missing), 2 when it cannot read.
import argparse, glob, json, os, re, subprocess, sys


def unit_val(path, key):
    v = None
    for line in open(path):
        if line.startswith(key + "="):
            v = line.split("=", 1)[1].strip()
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--unit-dir", default="/etc/systemd/system")
    ap.add_argument("--unit", default="leaf-maker-btc.service")
    ap.add_argument("--lightning-cli", default="")
    ap.add_argument("--margin", type=float, default=1.0)
    a = ap.parse_args()
    try:
        ex = unit_val(os.path.join(a.unit_dir, a.unit), "ExecStart") or ""
        cfg = json.load(open(re.search(r"--config (\S+)", ex).group(1)))
        b = cfg["btc"]
        sock = b["rpc"]
        cli = a.lightning_cli
        if not cli:
            ldir = os.path.dirname(os.path.dirname(sock))
            for u in glob.glob(os.path.join(a.unit_dir, "*.service")):
                t = open(u).read()
                m = re.search(r"^ExecStart=(\S*lightningd)\b.*--lightning-dir=%s\b" % re.escape(ldir), t, re.M)
                if m:
                    cli = os.path.join(os.path.dirname(os.path.dirname(m.group(1))), "cli", "lightning-cli")
        ch = json.loads(subprocess.run([cli or "lightning-cli", "--rpc-file=" + sock, "listpeerchannels"],
                                       capture_output=True, text=True, timeout=60, check=True).stdout).get("channels", [])
    except Exception as e:  # noqa: BLE001
        print("BTC desk: cannot read its room: %s" % e)
        return 2
    need = 0
    for p in b.get("pairs", []):
        if p.get("give") != "BTC":
            continue
        lad = dict(cfg.get("ladder") or {}, **(p.get("ladder") or {}))
        first, levels, growth = int(lad.get("first") or 0), int(lad.get("levels", 8)), float(lad.get("growth", 1.25))
        need = max(need, int(sum(first * growth ** k for k in range(levels))))
    ms = lambda c, k: int(str(c.get(k, 0)).rstrip("msat") or 0) // 1000
    live = [c for c in ch if c.get("state") == "CHANNELD_NORMAL"]
    send = sum(ms(c, "spendable_msat") for c in live) - int(b.get("keep_sats", 100000))
    recv = sum(ms(c, "receivable_msat") for c in live) * 9 // 10
    short = send < need * a.margin or recv < need * a.margin
    f = lambda s: "%.4f" % (s / 1e8)
    print("BTC desk%s: its ladder needs %s BTC each way; it can send %s and be paid %s (90%% of its room)%s" % (
        " SHORT" if short else "", f(need), f(send), f(recv), ": paste lq3_5_btc_desk.sh" if short else ""))
    return 1 if short else 0


if __name__ == "__main__":
    sys.exit(main())
