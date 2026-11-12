#!/usr/bin/env python3
"""The node route's limits, in simulated time.

- A batch is admitted whole or not at all, so a client that asks again finds the tokens it
  waited for.
- At the limits the proxy ships with: a wallet restored from its phrase, reading its chain two
  calls a block from its oldest coin's block up, is never refused, for a history of weeks or of
  months, even with a source asking for the largest answers beside it; and that source gets no
  more than its byte budget of the node's answers.

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

# ---------------------------------------------------------------------------------------------
# Admission, at small limits: the leaf wallet reads the chain 64 block hashes a batch and asks
# again about every 2.2 s; at 20 calls a second from one source it must get a batch through
# about every 3.2 s, for as long as it asks.
# ---------------------------------------------------------------------------------------------
UNBOUNDED = 1e18
a = types.SimpleNamespace(source_per_second=20, source_burst=400, all_per_second=200, all_burst=2000,
                          scan_per_second=1, scan_burst=30, scan_all_per_second=4, scan_all_burst=60,
                          source_bytes_per_second=UNBOUNDED, source_bytes_burst=UNBOUNDED,
                          all_bytes_per_second=UNBOUNDED, all_bytes_burst=UNBOUNDED)
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
now[0] = 1000.0  # later than every time above: simulated time only moves forward
limits = proxy.Limits(a)
assert limits.take("s", False, 400) is None
assert limits.take("s", False, 64) is not None
now[0] += 3.2
assert limits.take("s", False, 64) is None, "the refusal spent the tokens gathered since"
# Calls one at a time are counted as before.
assert all(limits.take("t", False) is None for _ in range(400))
assert limits.take("t", False) is not None

# The byte budget: a call is admitted while it is not overdrawn, and an answer overdraws it.
b = types.SimpleNamespace(**dict(vars(a), source_per_second=1e6, source_burst=1e6, all_per_second=1e6, all_burst=1e6,
                                 source_bytes_per_second=1000, source_bytes_burst=5000))
now[0] = 2000.0
limits = proxy.Limits(b)
assert limits.take("u", False) is None
limits.answered("u", 12000)  # 7,000 bytes over
assert limits.take("u", False) is not None, "a call admitted while the byte budget is overdrawn"
now[0] += 6.9
assert limits.take("u", False) is not None, "admitted before the overdraft was repaid"
now[0] += 0.2
assert limits.take("u", False) is None, "refused once the overdraft was repaid"
assert limits.take("v", False) is None, "one source's answers count against another's budget"
print("ok: admission whole or not at all, and the byte budget overdrawn by one answer and repaid")

# ---------------------------------------------------------------------------------------------
# At the limits the proxy ships with.
# ---------------------------------------------------------------------------------------------
shipped = proxy.parser().parse_args(["--node-url", "http://127.0.0.1:1/", "--node-conf", "/dev/null"])


def block_hex(height):
    """A block's raw hex, by height, shaped as the testnet's are (2026-11: of about 24,000 block,
    header and transaction answers a long restore read, half under 1 kB, nine in ten under 41 kB,
    the largest 620 kB): four in five 1 kB, three in twenty 40 kB, one in twenty-five 100 kB, one
    in a hundred 620 kB."""
    r = (height * 2654435761) % 100
    return 1000 if r < 80 else 40000 if r < 95 else 100000 if r < 99 else 620000


def restore(limits, blocks, step, abuser=None):
    """A wallet reading `blocks` blocks as the leaf wallet does: a batch of 64 getblockhash, then
    a batch of 64 getblock, each followed by `step` seconds of its own work, and every tenth step
    a batch of 64 other reads (its coins' transactions and outputs, the node's view).
    -> (refusals, seconds). `abuser()` runs after each of the wallet's batches."""
    refused, h = 0, 0
    start = now[0]
    while h < blocks:
        n = min(64, blocks - h)
        for answer in (n * 70, sum(block_hex(x) for x in range(h, h + n))):
            while limits.take("restoring wallet", False, n) is not None:
                refused += 1
                now[0] += 0.25  # the wallet's first pause after a refusal
            limits.answered("restoring wallet", answer)
            now[0] += step
            if abuser:
                abuser()
        if (h // 64) % 10 == 0:
            while limits.take("restoring wallet", False, 64) is not None:
                refused += 1
                now[0] += 0.25
            limits.answered("restoring wallet", 64 * 2000)
        h += n
    return refused, now[0] - start


# The trade checks' wallet reads about 12,000 blocks from its oldest coin's base: on the box in
# about 90 s once nothing refused it, on a laptop in about 47 s. Read here at twice the laptop's
# pace (a batch of 64 every 0.075 s: 850 calls a second), and four times as far back (a wallet two months old).
for blocks in (12000, 48000):
    now[0] = 10000.0 * (1 + blocks // 12000)
    limits = proxy.Limits(shipped)
    refused, secs = restore(limits, blocks, 0.075)
    assert refused == 0, "a restore of %d blocks was refused %d times" % (blocks, refused)
    print("ok: a restore of %d blocks (%d calls) in %.0f s of simulated time, never refused" % (blocks, 2 * blocks, secs))

# Beside it, one source asking for the largest block, 64 at a time, as fast as it is let.
now[0] = 100000.0
limits = proxy.Limits(shipped)
abused = {"bytes": 0, "calls": 0}


def abuser():
    while limits.take("abuser", False, 64) is None:
        limits.answered("abuser", 64 * 620000)
        abused["bytes"] += 64 * 620000
        abused["calls"] += 64


refused, secs = restore(limits, 48000, 0.075, abuser)
assert refused == 0, "a restore was refused %d times beside a source asking for the largest blocks" % refused
rate = (abused["bytes"] - shipped.source_bytes_burst) / secs
assert rate <= shipped.source_bytes_per_second + 64 * 620000 / secs, "the abuser got %.1f MB/s" % (rate / 1e6)
print("ok: beside a source asking for the largest blocks, a 48000-block restore was never refused; that source had "
      "%.1f MB/s after its burst of %.0f MB (%d calls in %.0f s); at 60 calls a second it could have had %.1f MB/s" % (
          rate / 1e6, shipped.source_bytes_burst / 1e6, abused["calls"], secs, 60 * 620000 / 1e6))
