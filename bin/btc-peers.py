#!/usr/bin/env python3
"""Write the box Bitcoin node's peer list to a file Emissio reads.

Emissio's task for validating anchors with your own Bitcoin node looks for
the tester's Bitcoin node among this node's peers, announcing the account
code in its user agent, synced, and connected for a while on one
connection. Emissio holds no Bitcoin node credential: this script runs under
its own user (btc-peers.service), reads the node's configuration through a
systemd credential, and writes the node's height and, for each peer, its
connection id, address, user agent, direction, services and when it
connected, with the heights of the headers and blocks the node knows the
peer has:

    {"updated": <unix seconds>, "height": <the node's height>,
     "peers": [{"id": 7, "addr": "a.b.c.d:port", "subver": "/Satoshi:28.1.0(...)/",
                "inbound": true, "services": ["NETWORK", "WITNESS"], "conntime": <unix seconds>,
                "synced_headers": 120000, "synced_blocks": 120000,
                "first_height": 119998, "best_headers": 120000, "best_blocks": 120000,
                "listed": 3}]}

Bitcoin Core learns a peer's height when the peer connects (it asks for
headers from just below its own tip) and when the peer announces a block;
a node that only follows never announces one, so its synced heights stay at
the connection's start. So the file follows each connection (id and
conntime) from one list to the next, as long as the list before is at most
five minutes old: "listed" is how many successive lists carry it,
"first_height" is the node's height in the first of them, and best_headers
and best_blocks are the highest synced heights seen on it.

It speaks JSON-RPC itself rather than running bitcoin-cli, so it needs no
binary from a directory its user cannot enter: the login, port and address
come from the configuration, the [testnet4] section over the top level.

usage: btc-peers.py --conf <bitcoin.conf> --out <file> [--section testnet4]
"""

import argparse
import base64
import json
import os
import sys
import tempfile
import time
import urllib.request


def read_conf(path, section="testnet4"):
    """The keys of a bitcoin.conf, a [section]'s values over the top level's."""
    top, sec, cur = {}, {}, None
    with open(path, encoding="utf8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("[") and line.endswith("]"):
                cur = line[1:-1]
                continue
            if "=" not in line:
                continue
            k, v = (x.strip() for x in line.split("=", 1))
            if cur is None:
                top[k] = v
            elif cur == section:
                sec[k] = v
    top.update(sec)
    return top


def rpc(conf, method):
    host = conf.get("rpcconnect", "127.0.0.1")
    port = int(conf.get("rpcport", "48332"))
    login = "%s:%s" % (conf["rpcuser"], conf["rpcpassword"])
    req = urllib.request.Request("http://%s:%d/" % (host, port),
                                 data=json.dumps({"jsonrpc": "1.0", "id": "btc-peers", "method": method, "params": []}).encode(),
                                 headers={"Authorization": "Basic " + base64.b64encode(login.encode()).decode(),
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        reply = json.loads(r.read())
    if reply.get("error"):
        raise RuntimeError(reply["error"])
    return reply["result"]


# A list older than this is not "the list before": a connection seen in it
# and again now may have dropped in between.
SUCCESSIVE = 300


def previous(path, now):
    """The connections of the list this run replaces, by (id, conntime)."""
    try:
        with open(path, encoding="utf8") as f:
            old = json.load(f)
        if not 0 < now - int(old["updated"]) <= SUCCESSIVE:
            return {}
        return {(int(p["id"]), int(p["conntime"])): p for p in old["peers"] if "listed" in p}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def follow(p, height, prev):
    """One peer's entry, carrying its connection on from the list before."""
    e = {"id": int(p.get("id", -1)), "addr": p.get("addr", ""), "subver": p.get("subver", ""),
         "inbound": bool(p.get("inbound")),
         "services": [str(n) for n in p.get("servicesnames", [])], "conntime": int(p.get("conntime", 0)),
         "synced_headers": int(p.get("synced_headers", -1)), "synced_blocks": int(p.get("synced_blocks", -1))}
    q = prev.get((e["id"], e["conntime"]))
    if q is None:
        e.update(first_height=height, best_headers=e["synced_headers"], best_blocks=e["synced_blocks"], listed=1)
    else:
        e.update(first_height=int(q["first_height"]),
                 best_headers=max(e["synced_headers"], int(q["best_headers"])),
                 best_blocks=max(e["synced_blocks"], int(q["best_blocks"])),
                 listed=int(q["listed"]) + 1)
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--section", default="testnet4", help="the chain section of the configuration to read")
    a = ap.parse_args()
    try:
        conf = read_conf(a.conf, a.section)
        peers = rpc(conf, "getpeerinfo")
        height = rpc(conf, "getblockcount")
    except KeyError as e:
        sys.exit("the configuration has no %s" % e)
    except Exception as e:
        # The error names the failure, never the login: urllib's messages
        # carry the URL (host and port) only.
        sys.exit("the node's RPC failed: %s" % e)
    now, height = int(time.time()), int(height)
    prev = previous(a.out, now)
    out = {"updated": now, "height": height, "peers": [follow(p, height, prev) for p in peers]}
    d = os.path.dirname(os.path.abspath(a.out))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".peers-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(out, f)
        os.chmod(tmp, 0o640)
        os.replace(tmp, a.out)
    except BaseException:
        os.unlink(tmp)
        raise
    print("%d peers, %d inbound" % (len(peers), sum(1 for p in out["peers"] if p["inbound"])))


if __name__ == "__main__":
    main()
