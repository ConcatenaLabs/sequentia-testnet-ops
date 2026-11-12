"""The sub-asset wrapper starts its maker again as soon as the maker ends, instead of waiting
out the reprice interval (sequentia-testnet-ops #229).

Runs makers/subasset-requote.sh with a stub oracle and a stub maker that ends a second after
it starts, and the reprice interval at 600 s: the stub must have been started three times in
a few seconds. A maker that failed, or ended sooner than MIN_RUN_SECS, is started again only
after RETRY_SECS. Run with: python3 -I makers/subasset_requote_test.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
WRAPPER = HERE / os.environ.get("WRAPPER", "subasset-requote.sh")


def run(exit_code: int, wait_s: float, min_run: str = "0") -> list[str]:
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        oracle = d / "oracle.sh"
        oracle.write_text("#!/bin/sh\necho 12345\n")
        starts = d / "starts"
        maker = d / "maker.sh"
        maker.write_text(f'#!/bin/sh\necho "$*" >> {starts}\nsleep 1\nexit {exit_code}\n')
        for f in (oracle, maker):
            f.chmod(0o755)
        env = dict(os.environ, KEYDIR=str(d / "keys"), ORACLE=str(oracle),
                   REPRICE_SECS="600", RETRY_SECS="1", MIN_RUN_SECS=min_run)
        p = subprocess.Popen(["bash", str(WRAPPER), "TST", "100", "0.004", "sell", "--", str(maker), "-requote"],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            time.sleep(wait_s)
        finally:
            os.killpg(p.pid, 15)
            p.wait()
        mode = (d / "keys").stat().st_mode & 0o777
        assert mode == 0o700, f"the key directory it made has mode {oct(mode)}"
        return starts.read_text().splitlines() if starts.exists() else []


def main() -> int:
    got = run(0, 9)
    if len(got) < 3:
        print(f"FAIL: a maker that ended after a fill was started {len(got)} time(s) in 9 s; "
              "the wrapper waited out its reprice interval with the book empty")
        return 1
    if not all(line.endswith("-requote -quote-amount 12345") for line in got):
        print(f"FAIL: started with {got}")
        return 1
    got = run(3, 9)
    if not 2 <= len(got) <= 5:
        print(f"FAIL: a maker that ended in failure was started {len(got)} time(s) in 9 s with a 1 s retry pause")
        return 1
    got = run(0, 9, min_run="30")
    if not 2 <= len(got) <= 5:
        print(f"FAIL: a maker that ended 0 at once was started {len(got)} time(s) in 9 s; it must pause like a failure")
        return 1
    print("PASS: the maker is quoted again at once after it ends, and after a pause when it failed or ended at once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
