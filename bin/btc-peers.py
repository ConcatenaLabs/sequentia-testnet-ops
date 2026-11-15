#!/usr/bin/env python3
"""Write the box Bitcoin node's peer list, address and user agent only, to a
file Emissio reads.

Emissio's task for validating anchors with your own Bitcoin node looks for
the tester's Bitcoin node among this node's peers, announcing the account
code in its user agent. Emissio holds no Bitcoin node credential: this
script runs under its own user (btc-peers.service), reads the node's
configuration through a systemd credential, and writes only each peer's
address, user agent and direction, with the time it ran:

    {"updated": <unix seconds>, "peers": [{"addr": "a.b.c.d:port", "subver": "/Satoshi:28.1.0(...)/", "inbound": true}]}

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


def getpeerinfo(conf):
    host = conf.get("rpcconnect", "127.0.0.1")
    port = int(conf.get("rpcport", "48332"))
    login = "%s:%s" % (conf["rpcuser"], conf["rpcpassword"])
    req = urllib.request.Request("http://%s:%d/" % (host, port),
                                 data=json.dumps({"jsonrpc": "1.0", "id": "btc-peers", "method": "getpeerinfo", "params": []}).encode(),
                                 headers={"Authorization": "Basic " + base64.b64encode(login.encode()).decode(),
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        reply = json.loads(r.read())
    if reply.get("error"):
        raise RuntimeError(reply["error"])
    return reply["result"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--section", default="testnet4", help="the chain section of the configuration to read")
    a = ap.parse_args()
    try:
        peers = getpeerinfo(read_conf(a.conf, a.section))
    except KeyError as e:
        sys.exit("the configuration has no %s" % e)
    except Exception as e:
        # The error names the failure, never the login: urllib's messages
        # carry the URL (host and port) only.
        sys.exit("getpeerinfo failed: %s" % e)
    out = {"updated": int(time.time()),
           "peers": [{"addr": p.get("addr", ""), "subver": p.get("subver", ""), "inbound": bool(p.get("inbound"))} for p in peers]}
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
