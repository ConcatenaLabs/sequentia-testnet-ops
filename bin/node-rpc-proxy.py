#!/usr/bin/env python3
"""A node's JSON-RPC for browser wallets: read-only, a method allowlist, a rate limit.

Caddy serves it at /node-rpc on the site. A browser wallet that follows the
chain itself (the leaf wallet of the web wallet and the extension) points its
node URL here and holds no node credential: this process adds the node's own,
read from the node's configuration through a systemd credential, and forwards
only the calls below, each with the arguments a wallet sends. Everything else
is refused before the node sees it: every wallet call, every call that changes
the node, named arguments, a path under the node's /wallet/.

A batch (a JSON list of calls) is taken when every call in it is one of those
below other than sendrawtransaction and scantxoutset, at most MAX_BATCH of them:
each counts against the caller's budget as a call on its own, and the batch goes
to the node as one request. The wallet asks for the reads one check makes of all
its coins together (where each of its rounds and boards is, each block's header,
each board's output), so a batch saves a round trip per call and costs the node
the same calls. A batch with any other call in it is refused whole.

The only call that writes is sendrawtransaction. scantxoutset reads the whole
UTXO set, and the wallet makes one for each window of its on-chain scripts and
each output it looks for when the chain has moved since its last command (a
few, after a new block): it has a budget of its own, far tighter than the rest,
and the scans of every source wait in turn, one at a time, as the node runs
them.

    node-rpc-proxy.py --listen 127.0.0.1:18940 --node-url http://127.0.0.1:18300/ \
        --node-conf /path/to/elements.conf

The node's configuration is read for rpcuser and rpcpassword (the last of
each, in any section). Requests are counted against the address in
X-Forwarded-For, the address Caddy appends, since only Caddy reaches this
loopback port; an IPv6 address counts as its /48.
"""

import argparse
import base64
import http.client
import http.server
import ipaddress
import json
import re
import sys
import threading
import time
import urllib.parse

MAX_BODY = 1 << 20  # a sendrawtransaction of a 400 kWU transaction is under this in hex
HEX = re.compile(r"^[0-9a-fA-F]*$")
HASH = re.compile(r"^[0-9a-fA-F]{64}$")


def is_hex(v, most=MAX_BODY):
    return isinstance(v, str) and len(v) % 2 == 0 and len(v) <= most and HEX.match(v) is not None


def is_hash(v):
    return isinstance(v, str) and HASH.match(v) is not None


def is_uint(v, most=1 << 32):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= most


def is_flag(v):
    return isinstance(v, bool) or (is_uint(v) and v in (0, 1))


def is_address(v):
    # One address as a person typed or pasted it: bech32, blech32 or base58.
    return isinstance(v, str) and re.match(r"^[0-9A-Za-z]{14,120}$", v) is not None


def descriptors(v):
    # Single scripts only, as the wallet asks: raw(<hex>) or addr(<address>).
    # A ranged descriptor (an xpub with a range) would have the node derive
    # and look for up to a million scripts.
    if not isinstance(v, list) or not 1 <= len(v) <= 256:
        return False
    for d in v:
        if not isinstance(d, str) or len(d) > 20100:
            return False
        if d.startswith("raw(") and d.endswith(")") and is_hex(d[4:-1], 20000):
            continue
        if d.startswith("addr(") and d.endswith(")") and re.match(r"^[0-9A-Za-z]{14,120}$", d[5:-1]):
            continue
        return False
    return True


def shape(*checks, least=None):
    """Positional arguments: each a check, the first `least` required."""
    least = len(checks) if least is None else least

    def ok(params):
        if not least <= len(params) <= len(checks):
            return False
        return all(c(p) for c, p in zip(checks, params))
    return ok


# Exactly what the leaf wallet calls (arca: bark/src/arca/chain.rs and
# sequentia-ext/src/rpc.rs), with the arguments it sends.
ALLOWED = {
    "getblockchaininfo": shape(),
    "getblockhash": shape(lambda v: is_uint(v, 1 << 31)),
    "getblockheader": shape(is_hash, is_flag, least=1),
    "getblock": shape(is_hash, lambda v: v in (0, False), least=2),  # the raw block only
    "getrawtransaction": shape(is_hash, is_flag, is_hash, least=1),
    "gettxout": shape(is_hash, is_uint, is_flag, least=2),
    "getrawmempool": shape(lambda v: v in (0, False), least=0),  # txids only
    "getmempoolentry": shape(is_hash),
    "getmempoolinfo": shape(),
    "scantxoutset": shape(lambda v: v == "start", descriptors),
    "decodescript": shape(lambda v: is_hex(v, 20000)),
    "validateaddress": shape(is_address),  # an address the person gave: a payment, an offboard, a claim
    "getsupervisedassets": shape(),  # assets whose issuer can freeze holdings
    "isassetfrozen": shape(is_hash, lambda v: is_hex(v, 20000)),  # a supervised asset and one script
    "getanchorstatus": shape(),
    "getfeeexchangerates": shape(),
    "dumpassetlabels": shape(),  # the node's rates are keyed by label
    "sendrawtransaction": shape(is_hex, lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0, least=1),
}
HEAVY = {"scantxoutset"}
# Calls a batch may not carry: the one that writes, and the heavy one, which
# waits its turn on its own.
NOT_IN_BATCH = {"sendrawtransaction"} | HEAVY
MAX_BATCH = 64


def checked(req):
    """One call of a request: (method, params, id), or (status, code, message, id) refusing it."""
    if not isinstance(req, dict):
        return (400, -32600, "a call is a JSON object", None)
    rid = req.get("id")
    method, params = req.get("method"), req.get("params", [])
    if params is None:
        params = []
    if not isinstance(method, str) or method not in ALLOWED:
        return (403, -32601, "method not allowed here: %s" % str(method)[:64], rid)
    if not isinstance(params, list):
        return (403, -32602, "%s: positional arguments only" % method, rid)
    if not ALLOWED[method](params):
        return (403, -32602, "%s: arguments not allowed here" % method, rid)
    return (method, params, rid)


class Bucket:
    """A token bucket: `rate` a second, at most `burst` at once."""

    def __init__(self, rate, burst):
        self.rate, self.burst, self.tokens, self.at = rate, burst, float(burst), time.monotonic()

    def take(self):
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class Limits:
    def __init__(self, a):
        self.a = a
        self.lock = threading.Lock()
        self.sources = {}  # source -> (calls, scans, last seen)
        self.all_calls = Bucket(a.all_per_second, a.all_burst)
        self.all_scans = Bucket(a.scan_all_per_second, a.scan_all_burst)
        self.scanning = threading.Lock()

    def take(self, source, heavy):
        with self.lock:
            now = time.monotonic()
            if len(self.sources) > 100000:  # forget sources idle for ten minutes
                self.sources = {k: v for k, v in self.sources.items() if now - v[2] < 600}
            calls, scans, _ = self.sources.get(source) or (
                Bucket(self.a.source_per_second, self.a.source_burst), Bucket(self.a.scan_per_second, self.a.scan_burst), now)
            self.sources[source] = (calls, scans, now)
            if not calls.take() or not self.all_calls.take():
                return "too many calls from one source or in all; slow down"
            if heavy and (not scans.take() or not self.all_scans.take()):
                return "scantxoutset reads the whole UTXO set: %d in a row, then %g a second from one source; try again later" % (
                    self.a.scan_burst, self.a.scan_per_second)
        return None


def source_of(handler):
    peer = handler.client_address[0]
    fwd = handler.headers.get_all("X-Forwarded-For") or []
    names = [n.strip() for h in fwd for n in h.split(",") if n.strip()]
    addr = names[-1] if names and peer in ("127.0.0.1", "::1") else peer
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return addr
    if ip.version == 6:
        if ip.ipv4_mapped:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(str(ip) + "/48", strict=False))
    return str(ip)


def read_conf(path):
    user = password = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("rpcuser="):
                user = line.split("=", 1)[1].strip()
            elif line.startswith("rpcpassword="):
                password = line.split("=", 1)[1].strip()
    if not user or not password:
        sys.exit("node-rpc-proxy: %s names no rpcuser and rpcpassword" % path)
    return base64.b64encode(("%s:%s" % (user, password)).encode()).decode()


class Counts:
    def __init__(self):
        self.lock = threading.Lock()
        self.c = {}

    def add(self, k):
        with self.lock:
            self.c[k] = self.c.get(k, 0) + 1

    def take(self):
        with self.lock:
            c, self.c = self.c, {}
        return c


def make_handler(a, auth, limits, counts, upstream_slots):
    node = urllib.parse.urlsplit(a.node_url)

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 120  # an idle kept-alive connection is closed after two minutes
        disable_nagle_algorithm = True  # headers and body go out in two writes
        server_version = "node-rpc-proxy"
        sys_version = ""

        def log_message(self, *args):
            pass  # counts are logged every ten minutes instead

        def answer(self, status, body, close=False):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)

        def refuse(self, status, code, message, rid=None, close=False):
            counts.add("refused %d" % status)
            self.answer(status, {"result": None, "error": {"code": code, "message": message}, "id": rid}, close)

        def other(self):
            # A body is never left unread on a connection kept open: it is
            # read whole when it is small and the connection closed when not.
            n = self.headers.get("Content-Length")
            if n and n.isdigit() and int(n) <= MAX_BODY:
                self.rfile.read(int(n))
                self.refuse(405, -32600, "only POST of a JSON-RPC call or batch")
            else:
                self.refuse(405, -32600, "only POST of a JSON-RPC call or batch", close=True)

        do_GET = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = other

        def do_HEAD(self):
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            if self.headers.get("Transfer-Encoding"):
                return self.refuse(411, -32600, "a body needs a Content-Length", close=True)
            n = self.headers.get("Content-Length", "")
            if not n.isdigit():
                return self.refuse(411, -32600, "a body needs a Content-Length", close=True)
            if int(n) > MAX_BODY:
                return self.refuse(413, -32600, "the body is over %d bytes" % MAX_BODY, close=True)
            body = self.rfile.read(int(n))
            if urllib.parse.urlsplit(self.path).path not in ("", "/"):
                return self.refuse(404, -32601, "no such path: calls go to the root, never to a wallet")
            try:
                req = json.loads(body)
            except ValueError:
                return self.refuse(400, -32700, "the body is not JSON")
            if isinstance(req, list):
                return self.batch(req)
            c = checked(req)
            if len(c) == 4:
                return self.refuse(*c)
            method, params, rid = c
            why = limits.take(source_of(self), method in HEAVY)
            if why:
                return self.refuse(429, -32000, why, rid)
            if method in HEAVY and not limits.scanning.acquire(timeout=a.scan_wait):
                return self.refuse(503, -32000, "the scans before this one took over %d s; try again" % a.scan_wait, rid)
            if not upstream_slots.acquire(blocking=False):
                if method in HEAVY:
                    limits.scanning.release()
                return self.refuse(503, -32000, "the node is busy; try again", rid)
            try:
                out = json.dumps({"jsonrpc": "1.0", "id": rid, "method": method, "params": params}).encode()
                c = http.client.HTTPConnection(node.hostname, node.port or 80,
                                               timeout=a.scan_timeout if method in HEAVY else a.timeout)
                try:
                    c.request("POST", "/", out, {"Authorization": "Basic " + auth, "Content-Type": "application/json"})
                    r = c.getresponse()
                    data = r.read(64 << 20)
                    status = r.status
                finally:
                    c.close()
            except (OSError, http.client.HTTPException) as e:
                counts.add("node unreachable")
                return self.refuse(502, -32000, "the node did not answer: %s" % type(e).__name__, rid)
            finally:
                upstream_slots.release()
                if method in HEAVY:
                    limits.scanning.release()
            if status == 401:  # never pass on the node's own credential refusal
                counts.add("node refused the credential")
                return self.refuse(502, -32000, "the node refused this proxy's credential", rid)
            counts.add(method)
            self.answer(status if status in (200, 400, 404, 500) else 502, data)

        def batch(self, reqs):
            if not 1 <= len(reqs) <= MAX_BATCH:
                return self.refuse(400, -32600, "a batch carries 1 to %d calls" % MAX_BATCH)
            calls = []
            for r in reqs:
                c = checked(r)
                if len(c) == 4:
                    return self.refuse(c[0], c[1], "in a batch: " + c[2], c[3])
                if c[0] in NOT_IN_BATCH:
                    return self.refuse(403, -32601, "in a batch: %s is taken one call at a time" % c[0], c[2])
                calls.append(c)
            source = source_of(self)
            for _ in calls:
                why = limits.take(source, False)
                if why:
                    return self.refuse(429, -32000, why)
            if not upstream_slots.acquire(blocking=False):
                return self.refuse(503, -32000, "the node is busy; try again")
            try:
                out = json.dumps([{"jsonrpc": "1.0", "id": rid, "method": m, "params": p} for m, p, rid in calls]).encode()
                c = http.client.HTTPConnection(node.hostname, node.port or 80, timeout=a.timeout)
                try:
                    c.request("POST", "/", out, {"Authorization": "Basic " + auth, "Content-Type": "application/json"})
                    r = c.getresponse()
                    data = r.read(64 << 20)
                    status = r.status
                finally:
                    c.close()
            except (OSError, http.client.HTTPException) as e:
                counts.add("node unreachable")
                return self.refuse(502, -32000, "the node did not answer: %s" % type(e).__name__)
            finally:
                upstream_slots.release()
            if status == 401:
                counts.add("node refused the credential")
                return self.refuse(502, -32000, "the node refused this proxy's credential")
            counts.add("batch")
            for m, _, _ in calls:
                counts.add(m)
            self.answer(status if status in (200, 400, 404, 500) else 502, data)

    return Handler


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--listen", default="127.0.0.1:18940")
    p.add_argument("--node-url", required=True)
    p.add_argument("--node-conf", required=True)
    p.add_argument("--source-per-second", type=float, default=20)
    p.add_argument("--source-burst", type=float, default=400)
    p.add_argument("--all-per-second", type=float, default=200)
    p.add_argument("--all-burst", type=float, default=2000)
    p.add_argument("--scan-per-second", type=float, default=1)
    p.add_argument("--scan-burst", type=float, default=30)
    p.add_argument("--scan-all-per-second", type=float, default=4)
    p.add_argument("--scan-all-burst", type=float, default=60)
    p.add_argument("--scan-wait", type=float, default=60, help="seconds a scan waits for the one before it")
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--scan-timeout", type=float, default=180)
    p.add_argument("--upstream", type=int, default=16, help="calls to the node at once")
    a = p.parse_args()
    auth = read_conf(a.node_conf)
    host, port = a.listen.rsplit(":", 1)
    counts = Counts()
    srv = http.server.ThreadingHTTPServer((host.strip("[]"), int(port)),
                                          make_handler(a, auth, Limits(a), counts, threading.BoundedSemaphore(a.upstream)))
    srv.daemon_threads = True

    def report():
        while True:
            time.sleep(600)
            c = counts.take()
            if c:
                print("node-rpc-proxy: last 10 min: " + ", ".join("%s %d" % kv for kv in sorted(c.items())), flush=True)
    threading.Thread(target=report, daemon=True).start()
    print("node-rpc-proxy: listening on %s, calls to %s, %d methods allowed" % (a.listen, a.node_url, len(ALLOWED)), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
