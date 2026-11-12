#!/usr/bin/env python3
"""The node route's hold, over HTTP, with no node behind it: GET /hold?ms=N answers 204 after N
milliseconds (at most --hold-most-ms), a source holds at most --hold-per-source at once and all
sources --hold-all, anything else on /hold is refused, and the rest of the route is unchanged.

    python3 bin/node-rpc-proxy-hold-test.py
"""
import http.client
import http.server
import importlib.util
import os
import threading
import time

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("proxy", os.path.join(here, "node-rpc-proxy.py"))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

a = proxy.parser().parse_args(["--node-url", "http://127.0.0.1:9/", "--node-conf", "/dev/null",
                               "--hold-most-ms", "800", "--hold-per-source", "2", "--hold-all", "3"])
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), proxy.make_handler(
    a, "", proxy.Limits(a), proxy.Counts(), threading.BoundedSemaphore(a.upstream), proxy.Holds(a.hold_per_source, a.hold_all)))
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]


def get(path, source="198.51.100.1", method="GET", body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    t = time.monotonic()
    c.request(method, path, body, {"X-Forwarded-For": source})
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, data, time.monotonic() - t


s, d, t = get("/hold?ms=300")
assert s == 204 and d == b"" and 0.29 <= t < 0.6, (s, d, t)
s, d, t = get("/hold?ms=600000")
assert s == 204 and 0.79 <= t < 1.2, "a hold is kept open --hold-most-ms at most: %s %.2f" % (s, t)
for q in ("/hold", "/hold?ms=0", "/hold?ms=600001", "/hold?ms=abc", "/hold?ms=1&x=2", "/hold?ms=1&ms=2", "/hold?ms=%C2%B2"):
    s, d, t = get(q)
    assert s == 400 and t < 0.2, (q, s, d)
s, d, t = get("/hold?ms=10", method="POST", body=b"{}")
assert s == 404, "a POST to /hold is a call to a path, refused as before: %s" % s
s, d, t = get("/")
assert s == 405, "GET elsewhere is refused as before: %s" % s

# Two holds from one source at once; a third from it is refused at once, another source's is held.
out = {}


def hold(name, source):
    out[name] = get("/hold?ms=600", source)


ts = [threading.Thread(target=hold, args=(n, "203.0.113.1")) for n in ("a", "b")]
[t.start() for t in ts]
time.sleep(0.15)
s, d, t = get("/hold?ms=600", "203.0.113.1")
assert s == 429 and b"slow down" in d and t < 0.2, (s, d, t)
# All sources: the third hold in all is admitted, the fourth refused.
t3 = threading.Thread(target=hold, args=("c", "203.0.113.2"))
t3.start()
time.sleep(0.15)
s, d, t = get("/hold?ms=600", "203.0.113.3")
assert s == 429 and t < 0.2, (s, d, t)
[t.join() for t in ts + [t3]]
assert all(out[n][0] == 204 and out[n][2] >= 0.59 for n in "abc"), out
# Once they are answered, the source may hold again.
s, d, t = get("/hold?ms=50", "203.0.113.1")
assert s == 204, s
print("ok: holds kept for what they ask up to the bound, two per source and three in all, refused at once past either; "
      "anything else on /hold refused; the rest of the route as before")
