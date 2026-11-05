#!/usr/bin/env python3
"""fee-proxy.test.py: the fee proxy against a stand-in node and a stand-in mempool.space.

    python3 -I bitcoin-ark/fee-proxy.test.py [path/to/fee-proxy.py]

It starts the proxy (by default the one beside this file) in front of a stand-in
Bitcoin Core and a stand-in fee API, both on loopback, and asks it for
`estimatesmartfee` at the three targets captaind reads (1, 3 and 6 blocks,
economical). For each case it checks the proxy's answers and then what captaind
does with them (server/src/fee_estimator.rs at Bark 0.7.1: each rate clamped to
`max_fee_rate`, an offboard quoted at the 3-block rate, refused under the 6-block
rate), so a case fails when an offboard at the quoted rate would be refused.

The first case is what testnet4 showed: five 85-vbyte transactions paying
0.005 BTC each (588,235 sat/vB) in a mempool of a few kilobytes, Core estimating
5.88235294 BTC/kvB for six blocks and nothing for one or three, and mempool.space
projecting a next block of 5,396 vbytes with those five at the top of its range.
"""
import http.server, json, os, socket, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "fee-proxy.py")
MAX_FEE_RATE = 100  # sat/vB, captaind.toml [fee_estimator] max_fee_rate

SPAM = {"vsize": 85, "fees": {"base": 0.005, "ancestor": 0.005}, "ancestorsize": 85}
SMALL = {"vsize": 99, "fees": {"base": 0.00000149, "ancestor": 0.00000149}, "ancestorsize": 99}
TESTNET4 = {
    "estimates": {1: None, 3: None, 6: 5.88235294},
    "mempool": [SPAM] * 5 + [SMALL] * 21,
    "recommended": {"fastestFee": 1, "halfHourFee": 1, "hourFee": 1, "economyFee": 1, "minimumFee": 1},
    "blocks": [{"blockVSize": 5395.5, "nTx": 26, "medianFee": 0,
                "feeRange": [1.50, 1.503, 1.506, 1.508, 1.515, 588235.29, 588235.29]}],
}
STATE = {}


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Node(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def answer(self, q):
        m, p = q.get("method"), q.get("params") or []
        if m == "estimatesmartfee":
            fr = STATE["estimates"].get(int(p[0]) if p else 2)
            res = {"feerate": fr, "blocks": int(p[0])} if fr else {"errors": ["Insufficient data or no feerate found"], "blocks": int(p[0])}
            return {"result": res, "error": None, "id": q.get("id")}
        if m == "getrawmempool":
            return {"result": {"%064x" % i: e for i, e in enumerate(STATE["mempool"])}, "error": None, "id": q.get("id")}
        return {"result": None, "error": {"code": -32601, "message": "Method not found"}, "id": q.get("id")}

    def do_POST(self):
        q = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        out = json.dumps([self.answer(x) for x in q] if isinstance(q, list) else self.answer(q)).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        out = json.dumps(STATE["recommended"] if self.path.endswith("/recommended") else STATE["blocks"]).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)


def serve(handler):
    port = free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


def ask(port, target):
    import urllib.request
    body = json.dumps({"jsonrpc": "1.0", "id": "t", "method": "estimatesmartfee", "params": [target, "ECONOMICAL"]}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/" % port, data=body, method="POST",
                                 headers={"Authorization": "Basic dDp0", "Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=10).read())["result"]
    return r.get("feerate")


def main():
    node, api = serve(Node), serve(Api)
    STATE.update(TESTNET4)
    work = tempfile.mkdtemp(prefix="fee-proxy-test-")
    cookie = os.path.join(work, "cookie"); open(cookie, "w").write("t:t")
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-I", PROXY, "--listen", "127.0.0.1:%d" % port, "--upstream", "127.0.0.1:%d" % node,
                             "--cookie", cookie, "--floor", "30", "--cap", "500", "--api", "http://127.0.0.1:%d" % api, "--refresh", "0.5"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    failed = []
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close(); break
            except OSError:
                time.sleep(0.1)

        def case(name, want, **state):
            STATE.clear(); STATE.update(TESTNET4); STATE.update(state)
            time.sleep(1.5)  # two refreshes
            got = {t: ask(port, t) for t in (1, 3, 6)}
            sat = {t: (v or 0) * 1e5 for t, v in got.items()}
            clamped = {t: min(v, MAX_FEE_RATE) for t, v in sat.items()}
            quote = clamped[3]
            offboard = "accepted" if quote >= clamped[6] else "refused: fee rate too low (quote %g, minimum %g)" % (quote, clamped[6])
            ok = all(abs(v - want) < 1e-6 for v in sat.values()) and offboard == "accepted"
            print("%s %s: proxy answers 1/3/6 = %s sat/vB; captaind's offboard at its quote %s"
                  % ("ok  " if ok else "FAIL", name, "/".join("%g" % sat[t] for t in (1, 3, 6)), offboard))
            if not ok:
                failed.append(name)

        case("testnet4's spam (Core: 588,235 sat/vB at 6 blocks, none at 1 or 3; mempool 5 kvB)", 30)
        full = [{"blockVSize": 998000, "nTx": 3000, "medianFee": 45.2, "feeRange": [40, 42, 44, 45.2, 50, 80, 588235.29]}]
        case("a full public next block, median 45.2", 45.2, blocks=full, recommended=dict(TESTNET4["recommended"], fastestFee=44))
        case("a full node mempool, its next block's last rate 60", 61, mempool=[{"vsize": 1000, "fees": {"base": 0.0006, "ancestor": 0.0006}, "ancestorsize": 1000}] * 1000)
        case("a full public next block at 700, capped", 500, blocks=[dict(full[0], medianFee=700, feeRange=[700] * 7)])
    finally:
        proc.terminate(); out = proc.communicate(timeout=10)[0]
        os.remove(cookie); os.rmdir(work)
    print("proxy log:\n  " + "\n  ".join(out.strip().splitlines()))
    if failed:
        sys.exit("%d case(s) failed" % len(failed))
    print("all cases passed")


if __name__ == "__main__":
    main()
