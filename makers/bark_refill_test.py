#!/usr/bin/env python3
"""bark-refill's guards, against a regtest Bitcoin Core and a stand-in for the target's Bark.

The refill pays a Bitcoin ark wallet from a service wallet when the wallet says it holds too
little. A wallet that has stopped following the chain says it holds nothing, and the refill used
to pay it again on every pass (sequentia-testnet-ops#212). This drives the refill through:

  1. a target that holds nothing and follows the chain: paid;
  2. the same target, reading 0 while that payment sits confirmed at its address: refused,
     CANNOT SYNC, nothing paid;
  3. a target whose Bark logs a sync error: refused, nothing paid;
  4. a target that follows the chain but is still short: paid again up to its daily cap, then
     DAILY CAP and nothing more;
  5. a target that holds enough: nothing paid.

Boarding is out of this test (`--min-board-sats` above anything paid). The stand-in `arca` answers `bitcoin balance`, `bitcoin onchain balance` and `bitcoin onchain
address` from a state file; its on-chain balance is either the target wallet's real one in the
node ("real") or a stuck 0 ("zero"). Run with BITCOIND (and BITCOIN_CLI) naming Bitcoin Core, or
with them on PATH; without one the test says so and exits 0.

    BITCOIND=~/bitcoin-28.0/bin/bitcoind python3 -I makers/bark_refill_test.py
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BITCOIND = os.environ.get("BITCOIND") or shutil.which("bitcoind")
CLI = os.environ.get("BITCOIN_CLI") or (os.path.join(os.path.dirname(BITCOIND), "bitcoin-cli") if BITCOIND else None)

STUB = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
st = json.load(open(os.environ["STUB_STATE"]))
args = sys.argv[sys.argv.index("bitcoin") + 1:]
args = [a for a in args if a != "--quiet"]
if st.get("stderr"):
    sys.stderr.write(st["stderr"] + "\n")
cli = st["cli"].split() + ["-rpcwallet=target"]
def real():
    b = json.loads(subprocess.run(cli + ["getbalances"], capture_output=True, text=True, check=True).stdout)["mine"]
    return round((b["trusted"] + b["untrusted_pending"] + b["immature"]) * 1e8), round(b["trusted"] * 1e8)
if args == ["balance"]:
    print(json.dumps({"spendable_sat": st.get("ark", 0), "pending_board_sat": 0}))
elif args == ["onchain", "balance"]:
    total, conf = real() if st["onchain"] == "real" else (0, 0)
    print(json.dumps({"total_sat": total, "confirmed_sat": conf}))
elif args == ["onchain", "address"]:
    print(json.dumps({"address": st["address"]}))
elif args and args[0] == "board":
    sys.stderr.write("boarding is not part of this test\n"); sys.exit(1)
else:
    sys.stderr.write("stub: unknown %r\n" % args); sys.exit(2)
'''


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def main():
    if not BITCOIND or not CLI or not os.path.exists(CLI):
        print("skipped: no bitcoind (set BITCOIND)"); return 0
    work = tempfile.mkdtemp(prefix="bark-refill-test-")
    port, rpcport = free_port(), free_port()
    cli = "%s -regtest -datadir=%s -rpcport=%d" % (CLI, work, rpcport)
    proc = subprocess.Popen([BITCOIND, "-regtest", "-datadir=" + work, "-port=%d" % port, "-rpcport=%d" % rpcport,
                             "-listen=0", "-fallbackfee=0.0002", "-txindex=0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = []
    try:
        def c(*a):
            r = subprocess.run(cli.split() + list(a), capture_output=True, text=True)
            if r.returncode:
                raise RuntimeError(r.stderr.strip())
            return r.stdout.strip()
        for _ in range(100):
            try:
                c("getblockcount"); break
            except RuntimeError:
                time.sleep(0.2)
        c("createwallet", "service"); c("createwallet", "target")
        c("-rpcwallet=service", "generatetoaddress", "110", c("-rpcwallet=service", "getnewaddress"))
        stub = os.path.join(work, "arca"); open(stub, "w").write(STUB); os.chmod(stub, 0o755)
        state = os.path.join(work, "state.json")
        addr = c("-rpcwallet=target", "getnewaddress")
        def st(**kw):
            d = {"cli": cli, "address": addr, "ark": 0, "onchain": "real", "stderr": ""}
            d.update(kw); json.dump(d, open(state, "w"))
        def refill(target=1000000, max_sats=400000, day=None):
            args = [sys.executable, "-I", os.path.join(HERE, "maker_funds.py"), "bark-refill", "--name", "test side",
                    "--arca", stub, "--datadir", work, "--bark", "/bin/false", "--target-sats", str(target),
                    "--max-sats", str(max_sats), "--min-board-sats", "100000000", "--btc-wallet", "service", "--btc-cli", cli, "--fee-floor", "2"]
            if day is not None:
                args += ["--max-sats-day", str(day)]
            r = subprocess.run(args, capture_output=True, text=True, env=dict(os.environ, STUB_STATE=state, MAKERS_FEE_API=""))
            out = (r.stdout + r.stderr).strip()
            print("    " + out.replace("\n", "\n    "))
            return out
        def sent_total():
            return round(float(c("-rpcwallet=target", "getreceivedbyaddress", addr, "0")) * 1e8)
        def check(name, ok):
            print(("  ok    " if ok else "  FAIL  ") + name)
            if not ok:
                fails.append(name)
        def mine(n=3):
            c("-rpcwallet=service", "generatetoaddress", str(n), c("-rpcwallet=service", "getnewaddress"))

        print("1. a target that follows the chain and holds nothing")
        st(); out = refill()
        check("it is paid max_sats", sent_total() == 400000 and "400000 sats from service" in out)
        mine(3)

        print("2. the same target reading 0 while that payment sits confirmed at its address")
        st(onchain="zero"); out = refill()
        check("CANNOT SYNC, nothing paid", "CANNOT SYNC" in out and "400000 sats in 1 coin" in out and sent_total() == 400000)
        mine(1); out = refill()
        check("and again on the next pass, nothing paid", "CANNOT SYNC" in out and sent_total() == 400000)

        print("3. a target whose Bark logs a sync error")
        st(stderr="WARN Onchain sync error: introduced chain cannot connect with the original chain, try include height 158338")
        out = refill()
        check("CANNOT SYNC, nothing paid", "CANNOT SYNC" in out and "sync error" in out and sent_total() == 400000)

        print("4. a target that follows the chain and is still short: paid up to its daily cap")
        st(); out = refill(target=2000000, day=1000000)
        check("paid 400000 more", sent_total() == 800000)
        mine(3); out = refill(target=2000000, day=1000000)
        check("paid only the 200000 left of its 1000000 a day", sent_total() == 1000000 and "200000 sats from service" in out)
        mine(3)
        # the target spends what it was paid (as boarding would), so it holds little again
        c("-rpcwallet=target", "-named", "sendtoaddress", "address=" + c("-rpcwallet=service", "getnewaddress"),
          "amount=0.0095", "fee_rate=2")
        mine(3); out = refill(target=2000000, day=1000000)
        check("DAILY CAP, nothing paid", "DAILY CAP" in out and sent_total() == 1000000)

        print("5. a target that holds enough")
        st(ark=900000); out = refill(day=5000000)
        check("enough, nothing paid", out.endswith("enough") and sent_total() == 1000000)
    finally:
        subprocess.run(cli.split() + ["stop"], capture_output=True)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)
    print("%d check(s) failed" % len(fails) if fails else "all checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
