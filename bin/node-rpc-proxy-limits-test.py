#!/usr/bin/env python3
"""The node route's limits, in simulated time: a batch is admitted whole or not at all, so a
client that asks again finds the tokens it waited for. The leaf wallet reads the chain 64 block
hashes a batch and asks again about every 2.2 s; at 20 calls a second from one source it must get
a batch through about every 3.2 s, for as long as it asks.

    python3 bin/node-rpc-proxy-limits-test.py
"""
import importlib.util
import os
import types

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("proxy", os.path.join(here, "node-rpc-proxy.py"))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

now = [0.0]
proxy.time.monotonic = lambda: now[0]
a = types.SimpleNamespace(source_per_second=20, source_burst=400, all_per_second=200, all_burst=2000,
                          scan_per_second=1, scan_burst=30, scan_all_per_second=4, scan_all_burst=60)
limits = proxy.Limits(a)

through = []
while now[0] < 600:
    if limits.take("leaf wallet", False, 64) is None:
        through.append(now[0])
    now[0] += 2.2
late = [t for t in through if t > 60]
assert len(late) >= 160, "after the burst, %d batches of 64 in nine minutes; want one about every 3.2 s" % len(late)
assert max(b - a for a, b in zip(late, late[1:])) <= 4.5, "a gap of over 4.5 s between batches"

# A refused batch takes nothing: the tokens it found are still there for the next.
limits = proxy.Limits(a)
now[0] = 1000.0
assert limits.take("s", False, 400) is None
assert limits.take("s", False, 64) is not None
now[0] += 3.2
assert limits.take("s", False, 64) is None, "the refusal spent the tokens gathered since"
# Calls one at a time are counted as before.
assert all(limits.take("t", False) is None for _ in range(400))
assert limits.take("t", False) is not None
print("ok: %d batches of 64 through in ten minutes, %d after the first minute" % (len(through), len(late)))
