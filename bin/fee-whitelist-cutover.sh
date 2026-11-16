#!/usr/bin/env bash
# The fee whitelist's part of a node release's cutover: the public nodes read
# their price servers' lists, and no price server writes to a node.
#
# A node's fee whitelist is dynamic when the node is connected to a price
# server and reads the list it publishes; a price server never writes to a node.
# This moves the box to that: the network's price server publishes its list at
# http://sequentiatestnet.com/feewhitelist and the second operator's at a
# loopback address, neither holds a node's login, and every public node (the
# committee, the dexnode, the explorer node, the pool-board node) and the second
# operator's node is connected to its price server by its configuration file.
#
# Run from a laptop, in three stages around the release cutover, which stops the
# whole fleet, swaps the binary and starts it again (the node repository's
# CLAUDE.md, "Upgrading the committee"):
#
#   ssh seq 'STAGE=before bash -s'  < bin/fee-whitelist-cutover.sh   # fleet running, before anything moves
#   ssh seq 'STAGE=stopped bash -s' < bin/fee-whitelist-cutover.sh   # every node stopped, new binaries in place
#   ssh seq 'STAGE=started bash -s' < bin/fee-whitelist-cutover.sh   # after the fleet has started again
#
#   TRIAL=1  checks everything and runs the new price server once into a
#            temporary file; changes no node, price server or Caddy file. Any time.
#   BACK=1   with the fleet stopped: undoes what STAGE=stopped changed (the
#            configuration lines it added, the keys it removed, its drop-ins, the
#            published file, the second operator's price-server files, the Caddy
#            route and the checkout it was applied from) and restarts the price
#            servers as they ran before. It first checks that the code each
#            price server will then run accepts the configuration it puts back
#            (a node login); if not, because the release moved that code on, it
#            changes nothing and prints the command that moves it back.
#
# STAGE=before records, before anything moves, what the way back needs: the
# public nodes running now (the fleet the later stages act on), the commit the
# network's price server runs, and the release the second operator's bundle
# link names. It runs before the second operator's bundle moves to the release,
# and refuses once it has (that price server's code then refuses its node
# login, so the link names a release that is not the one to go back to).
#
# STAGE=before and TRIAL=1 also match every node the network's price server
# writes to today (the RPC ports in its node_rpcs) to a running public node,
# and the second operator's node_rpc to its node, and refuse on any that matches
# none or more than one: a node left out would keep a list nothing updates any
# more. A node's RPC port is read as the node reads it (its chain's section
# first, the first value of a key, comments, included files, its command line,
# its chain's default) and checked against the ports its process listens on.
#
# STAGE=before also records every public node directory on disk, running or
# not, with its RPC port. STAGE=stopped, before it changes anything, and
# STAGE=started, before it reports success, hold the fleet as it is now against
# that record (and STAGE=stopped against the nodes a release switch under way
# will start): a node added, removed, started since or moved to another port is
# refused by name, with what to do, since a node this script does not connect
# keeps a list nothing updates.
#
# It changes only what it wrote. A price server's drop-in it did not write is
# refused, never replaced; a published list that was there before is kept and
# put back by BACK=1; Caddy's files go back through temporaries and renames,
# and a restore stays pending until Caddy has reloaded. BACK=1 refuses where
# no cutover was recorded.
#
# Nothing in between leaves a public node with an empty or a one-asset list:
# the nodes are stopped while their configuration changes; STAGE=stopped
# returns only when both price servers serve a list of at least two assets, so
# each node takes it in its first second; and STAGE=started checks every node.
# It changes no firewall rule. Each stage can be pasted twice, and a run that
# was cut short is taken up by the next paste of the same stage or by BACK=1.
# Wherever it stops, it prints the state of the box, the command to go forward
# and the command to go back. On any host but the testnet box it stops before
# it opens or creates anything.
set -Eeuo pipefail
# The testnet box, checked before anything is opened or created.
BOX_HOST=sequentia
[ "$(cat /proc/sys/kernel/hostname)" = "$BOX_HOST" ] \
  || { echo "this host is $(cat /proc/sys/kernel/hostname), not the testnet box ($BOX_HOST): nothing was opened or changed" >&2; exit 1; }
exec 9> /run/lock/fee-whitelist-cutover.lock
# A run killed outright can leave a child (a sleep) holding the lock for a few seconds.
flock -w 20 9 || { echo "another run of this script holds its lock; this paste did nothing. Paste it again once that run has ended." >&2; exit 75; }

NODE_CLONE=${NODE_CLONE:-/root/sequentia/Sequentia}
SRC=${SRC:-/root/seq-price-server-src}
OPS=${OPS:-/root/sequentia/sequentia-testnet-ops}
STATE=${STATE:-/var/lib/fee-whitelist-cutover}
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
CADDY_ENV_CONF=${CADDY_ENV_CONF:-/etc/systemd/system/caddy.service.d/env.conf}
# The network's price server.
PS_UNIT=seq-price-server.service
PS_CONFIG=${PS_CONFIG:-/root/price-demo/config.json}
PS_DROPIN_DIR=${PS_DROPIN_DIR:-/etc/systemd/system/seq-price-server.service.d}
PUBDIR=${PUBDIR:-/srv/feewhitelist}
PUBFILE=$PUBDIR/feewhitelist.json
NETWORK_URL=${NETWORK_URL:-http://sequentiatestnet.com/feewhitelist}
# The second operator's price server and node.
B_USER=${B_USER:-arca-b}
B_PS_UNIT=arca-b-priceserver.service
B_PS_DIR=${B_PS_DIR:-/opt/arca-b/sequentia/price-server}
B_LINK=$(dirname "$B_PS_DIR")
B_PS_CONFIG=${B_PS_CONFIG:-/var/lib/arca-b/price-server.json}
B_PS_DROPIN_DIR=${B_PS_DROPIN_DIR:-/etc/systemd/system/arca-b-priceserver.service.d}
B_PS_PORT=${B_PS_PORT:-18690}
B_URL=http://127.0.0.1:$B_PS_PORT/feewhitelist
B_NODE_CONF=${B_NODE_CONF:-/etc/arca-b/sequentia.conf}
B_NODE_UNIT=arca-b-sequentiad.service
# The public nodes: data directory, the configuration file in it, and the CLI.
COMMITTEE_ROOT=${COMMITTEE_ROOT:-/root/seq-testnet}
EXPLORER=${EXPLORER:-/root/sequentia/explorer-node}
POOLBOARD=${POOLBOARD:-/root/sequentia/pool-board-node}
CLI=${CLI:-/root/Sequentia/src/sequentia-cli}
B_CLI=${B_CLI:-/opt/arca-b/sequentia/bin/sequentia-cli}
B_DATADIR=${B_DATADIR:-/var/lib/arca-b/sequentia}
MARK="# fee-whitelist-cutover: connected to its price server"
REMOVED_KEYS="node_rpc node_rpcs clear_whitelist_on_shutdown"
FLEET=$STATE/fleet.before
# Every public node directory on disk at STAGE=before, and the second
# operator's node: 'port datadir running|stopped conf|command-line'.
DISK=$STATE/nodes.before
# The node release's switch records the nodes it stops and starts in
# <its state>/fleet.txt (name|kind|unit|datadir|binary) and its progress in
# <its state>/phase; SWITCH_STATE names it, else the one under way here.
SWITCH_GLOB=${SWITCH_GLOB:-/root/sequentia/node-cutover-v*}
# A Caddy restore under way: present from before its first file changes until
# Caddy has reloaded.
CADDY_PENDING=$STATE/caddy-restore.pending
PUB_KEPT=$STATE/feewhitelist.json.before
DROPIN_MARK="# fee-whitelist-cutover:"

MODE=${STAGE:-}
[ "${TRIAL:-0}" = 1 ] && MODE=trial
[ "${BACK:-0}" = 1 ] && MODE=back
case "$MODE" in before|trial|stopped|started|back) ;; *)
  echo "set STAGE=before, STAGE=stopped or STAGE=started (or TRIAL=1, BACK=1)" >&2; exit 2;; esac

# Everything this script does in Python, in one program: `py <subcommand> <args>`.
read -r -d '' PYTOOL <<'PY' || true
import json, os, re, subprocess, sys, time, urllib.parse

def write_private(path, data):
    # The new content goes to a temporary created mode 600 before anything is
    # written to it (it can hold a node's login), takes the file's owner and
    # mode, and replaces the file in one rename; on any failure it is removed.
    st = os.stat(path)
    tmp = path + ".cutover-tmp"
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o7777)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
        raise

def check_list(text):
    d = json.loads(text)
    r = d.get("rates"); u = d.get("updated")
    assert set(d) == {"updated", "rates"}, "the list carries more than the rates and their time: %s" % sorted(d)
    assert isinstance(r, dict) and len(r) >= 2, "fewer than two assets"
    assert isinstance(u, (int, float)), "no updated time"
    for k, v in r.items():
        assert len(k) == 64 and all(c in "0123456789abcdef" for c in k), "bad id " + k[:20]
        assert isinstance(v, int) and 0 < v <= 10**18, "bad rate for " + k[:16]
    age = time.time() - u
    assert -600 < age < 600, "made %d s ago" % age
    return " ".join(sorted(r))

# A node's configuration, read as the node reads it (src/util/system.cpp
# GetConfigOptions and ReadConfigFiles, src/util/settings.cpp GetSetting,
# src/chainparamsbase.cpp CreateBaseChainParams).
DEFAULT_CHAIN = "test"   # CBaseChainParams::DEFAULT
RPC_PORTS = {"main": 8332, "sequentia": 7332, "test": 18776, "signet": 38332, "regtest": 18443,
             "liquidv1": 7041, "liquidv1test": 7040, "liquidtestnet": 7039}
CUSTOM_RPC_PORT = 7040

def conf_options(path):
    # (section, key, value) per assignment in file order: '#' starts a comment
    # anywhere on a line, a [section] line prefixes the keys after it, and a
    # key's section is what precedes the first '.' of the prefixed name.
    out, prefix = [], ""
    with open(path, "rb") as f:
        for raw in f.read().decode("utf-8", "replace").split("\n"):
            s = raw.split("#", 1)[0].strip(" \t\r\n")
            if not s: continue
            if s[0] == "[" and s[-1] == "]":
                prefix = s[1:-1] + "."; continue
            if "=" not in s: continue
            k, v = s.split("=", 1)
            name = prefix + k.strip(" \t\r\n")
            sec, key = name.split(".", 1) if "." in name else ("", name)
            out.append((sec, key, v.strip(" \t\r\n")))
    return out

def truthy(v):
    v = v.strip().lower()
    if v in ("", "true", "yes"): return True
    try: return int(v) != 0
    except ValueError: return False

def cmdline(args):
    out = []
    for a in args:
        if not a.startswith("-"): continue
        a = a.lstrip("-")
        k, v = a.split("=", 1) if "=" in a else (a, "")
        out.append((k, v))
    return out

def effective_rpcport(conf, datadir, args):
    cl = cmdline(args)
    def last_cl(key):
        vals = [v for k, v in cl if k == key]
        return vals[-1] if vals else None
    opts = conf_options(conf) if os.path.exists(conf) else []
    chain = None
    for flag, name in (("regtest", "regtest"), ("signet", "signet"), ("testnet", "test")):
        v = last_cl(flag)
        if v is None:
            vals = [v for s, k, v in opts if s == "" and k == flag]
            v = vals[-1] if vals else None          # the chain flags: the last value
        if v is not None and truthy(v): chain = name; break
    if chain is None:
        v = last_cl("chain")
        if v is None:
            vals = [v for s, k, v in opts if s == "" and k == "chain"]
            v = vals[0] if vals else None           # -chain from the file: the first value
        chain = v or DEFAULT_CHAIN
    if not any(k == "noincludeconf" for k, _ in cl):
        incs = [v for s, k, v in opts if s == chain and k == "includeconf"] + \
               [v for s, k, v in opts if s == "" and k == "includeconf"]
        for inc in incs:
            opts = opts + conf_options(inc if os.path.isabs(inc) else os.path.join(datadir, inc))
    v = last_cl("rpcport")
    if v is not None: return chain, int(v), "command line"
    vals = [v for s, k, v in opts if s == chain and k == "rpcport"]
    if vals: return chain, int(vals[0]), "[%s] section" % chain
    # rpcport is network-only: the default section counts only on the default chain.
    if chain == DEFAULT_CHAIN:
        vals = [v for s, k, v in opts if s == "" and k == "rpcport"]
        if vals: return chain, int(vals[0]), "default section"
    return chain, RPC_PORTS.get(chain, CUSTOM_RPC_PORT), "the chain's default"

def processes():
    r = subprocess.run(["ps", "-C", "sequentiad", "-o", "pid=,args="], capture_output=True, text=True)
    out = {}
    for line in r.stdout.splitlines():
        parts = line.split()
        if parts: out[int(parts[0])] = parts[1:]
    return out

def listeners():
    r = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True)
    out = {}
    for line in r.stdout.splitlines():
        f = line.split()
        if len(f) < 4: continue
        m = re.search(r":(\d+)$", f[3])
        if not m: continue
        for pid in re.findall(r"pid=(\d+)", line):
            out.setdefault(int(pid), set()).add(int(m.group(1)))
    return out

def pid_of(datadir, procs):
    want = "-datadir=" + datadir.rstrip("/")
    for pid, args in procs.items():
        if any(a.rstrip("/") == want for a in args): return pid
    return None

def running(argv):
    # running <datadir>...: those a sequentiad runs on.
    procs = processes()
    for d in argv:
        if pid_of(d, procs) is not None: print(d)

def fleet(argv):
    # fleet <conf or -> <datadir> ...: 'port datadir running|stopped' per node.
    # Refuses on a running node not listening on the port its configuration
    # gives, and on two running nodes on one port.
    procs, lis, bad, seen = processes(), listeners(), 0, {}
    for conf, d in zip(argv[0::2], argv[1::2]):
        pid = pid_of(d, procs)
        args = procs.get(pid, [])
        c = [a.split("=", 1)[1] for a in args if a.startswith("-conf=")]
        conf = c[-1] if c else (conf if conf != "-" else os.path.join(d, "elements.conf"))
        if not os.path.isabs(conf): conf = os.path.join(d, conf)
        try:
            chain, port, src = effective_rpcport(conf, d, args)
        except (OSError, ValueError) as e:
            print("  %s: cannot read its RPC port: %s" % (d, e), file=sys.stderr); bad += 1; continue
        if pid is not None:
            ports = lis.get(pid, set())
            if port not in ports:
                print("  %s: its configuration gives RPC port %d (%s), but its process %d listens on %s" %
                      (d, port, src, pid, " ".join(map(str, sorted(ports))) or "nothing"), file=sys.stderr); bad += 1; continue
            if port in seen:
                print("  %s and %s both on RPC port %d" % (seen[port], d, port), file=sys.stderr); bad += 1; continue
            seen[port] = d
        print("%d %s %s %s" % (port, d, "running" if pid is not None else "stopped",
                               "command-line" if src == "command line" else "conf"))
    sys.exit(1 if bad else 0)

def reconcile(argv):
    # reconcile <record> <stopped|started> <switch fleet record or -> <the second
    # operator's datadir, which no release switch starts>, the fleet
    # now on stdin ('port datadir running|stopped conf|command-line', as fleet
    # prints it): one line per node added, removed, started since or moved to
    # another port; fails if there is any.
    rec_path, stage, sw_path, own = argv
    def table(text):
        t = {}
        for line in text.split("\n"):
            f = line.split()
            if len(f) >= 3: t[f[1]] = (int(f[0]), f[2], f[3] if len(f) > 3 else "conf")
        return t
    rec, now = table(open(rec_path).read()), table(sys.stdin.read())
    since = os.stat(rec_path).st_mtime
    bad = []
    for d in sorted(set(now) - set(rec)):
        bad.append("%s: a node directory that was not on disk at STAGE=before (%s now)" % (d, now[d][1]))
    for d in sorted(set(rec) - set(now)):
        if rec[d][1] == "running":
            bad.append("%s: ran at STAGE=before, and is gone from disk" % d)
    for d in sorted(set(rec) & set(now)):
        (rp, rs, rsrc), (np_, ns, nsrc) = rec[d], now[d]
        # A port given on the command line is not in the configuration: with the
        # node stopped, only a port read from the configuration both times compares.
        if rs == "running" and np_ != rp and (stage == "started" or (rsrc == "conf" and nsrc == "conf")):
            bad.append("%s: its RPC port is %d now, %d at STAGE=before" % (d, np_, rp))
        if stage == "started" and rs == "stopped" and ns == "running":
            bad.append("%s: runs now, and was not running at STAGE=before: its configuration is not connected" % d)
        if stage == "started" and rs == "running" and ns == "stopped":
            bad.append("%s: ran at STAGE=before, and is not running" % d)
    if stage == "stopped":
        recrun = {d for d in rec if rec[d][1] == "running"}
        if sw_path != "-":
            sw = set()
            for line in open(sw_path).read().split("\n"):
                f = line.split("|")
                if len(f) >= 4 and f[3].rstrip("/") in set(rec) | set(now): sw.add(f[3].rstrip("/"))
            for d in sorted(sw - recrun):
                bad.append("%s: the release switch (%s) starts it, and it was not running at STAGE=before" % (d, sw_path))
            for d in sorted((recrun - sw - {own}) & set(now)):
                bad.append("%s: ran at STAGE=before, and the release switch (%s) does not start it" % (d, sw_path))
        else:
            # No switch record: a directory stopped at STAGE=before whose log
            # moved since has run since, and may run again.
            for d in sorted(set(rec) & set(now)):
                if rec[d][1] != "stopped": continue
                for root, dirs, files in os.walk(d):
                    if root[len(d):].count(os.sep) >= 2: dirs[:] = []
                    if "debug.log" in files and os.stat(os.path.join(root, "debug.log")).st_mtime > since:
                        bad.append("%s: not running at STAGE=before, and has run since (%s)" % (d, os.path.join(root, "debug.log"))); break
    for b in bad: print("  " + b)
    sys.exit(1 if bad else 0)

def match(argv):
    # match <price-server config> <label>, 'port datadir' per running node on
    # stdin: each node the price server writes to; fails on one that matches no
    # node or more than one, and on one not on this machine. Prints no login.
    cfg = json.load(open(argv[0])); label = argv[1]
    dirs = {}
    for line in sys.stdin.read().split("\n"):
        if line.strip():
            port, d = line.split(" ", 1); dirs.setdefault(port, []).append(d)
    entries = list(cfg.get("node_rpcs") or [])
    if cfg.get("node_rpc"): entries.append(cfg["node_rpc"])
    bad = 0
    for e in entries:
        if isinstance(e, str):
            u = urllib.parse.urlsplit(e if "//" in e else "http://" + e); host, port = u.hostname, u.port
        else:
            host, port = e.get("host", "127.0.0.1"), e.get("port")
        port = str(port)
        if host not in ("127.0.0.1", "localhost", "::1"):
            print("  %s writes to a node at %s:%s, not on this machine" % (label, host, port)); bad += 1
        elif port not in dirs:
            print("  %s writes to the node on RPC port %s, which is none of the running nodes this script connects" % (label, port)); bad += 1
        elif len(dirs[port]) > 1:
            print("  %s writes to RPC port %s, which more than one node claims: %s" % (label, port, " ".join(dirs[port]))); bad += 1
        else:
            print("  %s writes to port %s: %s" % (label, port, dirs[port][0]))
    print("  %s writes to %d node(s); %d match none or more than one" % (label, len(entries), bad))
    sys.exit(1 if bad else 0)

def connect(argv):
    conf, url, mark = argv
    data = open(conf, "rb").read()
    bare = [l.rstrip(b"\r\n") for l in data.splitlines(keepends=True)]
    m, want = mark.encode(), ("feepriceserver=" + url).encode()
    if m in bare:
        i = bare.index(m)
        if i + 1 >= len(bare) or bare[i + 1] != want:
            print("%s carries the marker with another address" % conf, file=sys.stderr); sys.exit(1)
        print("%s: already connected to %s" % (conf, url)); return
    for l in bare:
        s = l.decode("utf-8", "replace").split("#", 1)[0].strip()
        if re.match(r"^([^=\s]+\.)?(no)?feepriceserver\s*=", s):
            print("%s already sets feepriceserver by hand; leaving it" % conf, file=sys.stderr); sys.exit(1)
    # Two lines before every other: the default section, which this option reads.
    write_private(conf, m + b"\n" + want + b"\n" + data)
    print("%s: connected to %s" % (conf, url))

def disconnect(argv):
    conf, mark = argv
    lines = open(conf, "rb").read().splitlines(keepends=True)
    m = mark.encode()
    if m not in [l.rstrip(b"\r\n") for l in lines]:
        print("%s: nothing of this script's" % conf); return
    # Exactly the two lines connect added; every other byte stays as it is (an
    # unterminated last line, CRLF line ends).
    out, skip = [], False
    for l in lines:
        s = l.rstrip(b"\r\n")
        if skip:
            skip = False
            if s.startswith(b"feepriceserver="): continue
        if s == m: skip = True; continue
        out.append(l)
    write_private(conf, b"".join(out))
    print("%s: line removed" % conf)

def save_private(p, b):
    tmp = p + ".tmp"
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f: f.write(b); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, p)

def strip(argv):
    path, saved, keys = argv[0], argv[1], argv[2:]
    raw = open(path, "rb").read()
    cfg = json.loads(raw)
    gone = {k: cfg.pop(k) for k in keys if k in cfg}
    if not gone:
        print("%s holds none of %s" % (path, " ".join(keys))); return
    if not os.path.exists(saved):
        # The file as it was, byte for byte, then the keys: the way back
        # restores it exactly. The keys' file is written last, so it exists
        # only once both are complete.
        save_private(saved + ".orig", raw)
        save_private(saved, json.dumps(gone).encode())
    write_private(path, (json.dumps(cfg, indent=2) + "\n").encode())
    print("%s: removed %s (kept in %s)" % (path, " ".join(sorted(gone)), saved))

def unstrip(argv):
    path, saved = argv
    cfg = json.load(open(path)); back = json.load(open(saved))
    cfg.update(back)
    orig = open(saved + ".orig", "rb").read() if os.path.exists(saved + ".orig") else None
    same = orig is not None and json.loads(orig) == cfg
    write_private(path, orig if same else (json.dumps(cfg, indent=2) + "\n").encode())
    print("%s: put back %s%s" % (path, " ".join(sorted(back)), " (the file as it was, byte for byte)" if same else ""))

def unit_code(argv):
    # The price-server code a unit runs once this script's drop-in is gone (on
    # stdin, systemctl cat): the last ExecStart= outside publish.conf.
    import shlex
    cur, exe = "", None
    for line in sys.stdin.read().split("\n"):
        if line.startswith("# /"): cur = line[2:].strip(); continue
        if cur.endswith("/publish.conf"): continue
        if line.startswith("ExecStart="): exe = line[len("ExecStart="):].strip() or None
    code = [a for a in shlex.split(exe or "") if a.endswith("price_server.py")]
    if not code: sys.exit(1)
    print(code[0])

def accepts(argv):
    # Whether price-server code accepts a configuration (the file as it is,
    # with the keys this script removed put back): the code's own check, run
    # on it. Prints the code's refusal, never the configuration.
    import importlib.util
    code, path = argv[0], argv[1]
    saved = argv[2] if len(argv) > 2 else ""
    cfg = json.load(open(path))
    if saved and os.path.exists(saved): cfg.update(json.load(open(saved)))
    spec = importlib.util.spec_from_file_location("price_server_under_check", code)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    check = getattr(mod, "check_config", None)
    if check is None: return
    try: check(cfg)
    except Exception as e:
        print(str(e).split("\n")[0][:300]); sys.exit(1)

def served(argv):
    # The list a URL serves itself: a 200, never a redirect followed.
    import urllib.request
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try:
        r = urllib.request.build_opener(NoRedirect).open(argv[0], timeout=10)
        if r.status != 200: raise ValueError("HTTP %d" % r.status)
        print(check_list(r.read().decode()))
    except Exception as e:
        print("%s: %s" % (argv[0], str(e)[:200]), file=sys.stderr); sys.exit(1)

def check_list_cmd(argv):
    try: print(check_list(sys.stdin.read()))
    except Exception as e: print(str(e), file=sys.stderr); sys.exit(1)

{"check-list": check_list_cmd, "running": running, "fleet": fleet, "reconcile": reconcile, "match": match, "connect": connect,
 "disconnect": disconnect, "strip": strip, "unstrip": unstrip, "unit-code": unit_code,
 "accepts": accepts, "served": served}[sys.argv[1]](sys.argv[2:])
PY
# -B: loading code leaves no bytecode cache beside it.
py() { python3 -I -B -c "$PYTOOL" "$@"; }

# --- The fleet. ---
datadirs_on_disk() {
  local d
  for d in "$COMMITTEE_ROOT"/node0*/ "$COMMITTEE_ROOT"/dexnode/; do [ -f "$d/elements.conf" ] && echo "${d%/}"; done
  for d in "$EXPLORER" "$POOLBOARD"; do [ -f "$d/elements.conf" ] && echo "$d"; done
  return 0
}
# The public nodes this cutover acts on: the ones running at STAGE=before.
fleet_dirs() { if [ -s "$FLEET" ]; then cut -d' ' -f2- "$FLEET"; else datadirs_on_disk; fi; }
all_dirs() { { fleet_dirs; datadirs_on_disk; } | sort -u; }
fleet_running() {
  # shellcheck disable=SC2046
  py running $(all_dirs)
  if systemctl is-active --quiet "$B_NODE_UNIT"; then echo "$B_NODE_UNIT"; fi
}

# --- Where the run stands, and what it prints wherever it stops. ---
# The message goes to the stderr the run started with (fd 8): a signal caught
# while a function runs under a redirection (py ... > /dev/null) runs its trap
# under that redirection too, and the message would be lost.
exec 8>&2
STEP=start
paste_cmd() { echo "ssh seq '$1 bash -s' < bin/fee-whitelist-cutover.sh"; }
yn() { if "$@" > /dev/null 2>&1; then echo yes; else echo no; fi; }

# Temporaries this script makes: removed on every exit, and at the start of the
# stages that change anything (a run killed outright leaves them behind).
T=""
remove_temporaries() {
  local f
  for f in $(all_dirs | sed 's|$|/elements.conf|') "$B_NODE_CONF" "$PS_CONFIG" "$B_PS_CONFIG"; do
    rm -f "$f.cutover-tmp"
  done
  rm -f "$STATE"/*.tmp "$STATE"/*.new 2>/dev/null || true
  rm -rf "$STATE/second-price-server-code.new"
  # put_back's temporaries (a run killed between its copy and its rename).
  for f in "$CADDYFILE" "$CADDY_ENV_CONF" "$PUBFILE"; do
    find "$(dirname "$f")" -maxdepth 1 -name ".$(basename "$f").cutover-back.*" -type f -delete 2>/dev/null || true
  done
  [ -z "$T" ] || rm -rf "$T"
}

state_report() {
  local n=0 c=0 d r
  for d in $(fleet_dirs); do n=$((n+1)); grep -qxF "$MARK" "$d/elements.conf" 2>/dev/null && c=$((c+1)); done
  r=$(fleet_running 2>/dev/null | grep -c . )
  echo "The box now:"
  echo "  nodes running: $r (the fleet is $n public nodes and the second operator's)"
  echo "  node configurations connected to a price server: $c of $n public; the second operator's: $(yn grep -qxF "$MARK" "$B_NODE_CONF")"
  echo "  the network's price server: $(systemctl is-active "$PS_UNIT" 2>/dev/null); this script's drop-in: $(yn test -f "$PS_DROPIN_DIR/publish.conf"); node logins taken out of its configuration: $(yn test -f "$STATE/network-price-server.removed.json")"
  echo "  the second operator's price server: $(systemctl is-active "$B_PS_UNIT" 2>/dev/null); this script's drop-in: $(yn test -f "$B_PS_DROPIN_DIR/publish.conf"); node login taken out: $(yn test -f "$STATE/second-price-server.removed.json")"
  echo "  the second operator's bundle: $B_LINK -> $(readlink "$B_LINK" 2>/dev/null || echo '?') (before the cutover: $(cat "$STATE/second-bundle-link.before" 2>/dev/null || echo 'not recorded'))"
  echo "  the /feewhitelist route in $CADDYFILE: $(yn grep -q 'handle /feewhitelist' "$CADDYFILE")"
}

advice() {
  case "$MODE" in
  trial|before)
    echo "Nothing to undo: this stage changes no node, price server or Caddy file (only its own records in $STATE)."
    echo "Forward: fix the cause above, then paste the same again: $(paste_cmd "$(if [ "$MODE" = trial ]; then echo TRIAL=1; else echo STAGE=before; fi)")";;
  stopped)
    echo "Forward: fix the cause above, then paste the same again; it takes up from where this run stopped:"
    echo "    $(paste_cmd STAGE=stopped)"
    echo "Back, with every node stopped, in this order:"
    echo "    $(switch_back_paste CUT_PAUSE_STOPPED=1)   (the release's binaries and clones back; starts nothing)"
    echo "    $(paste_cmd BACK=1)   (it says first if a command is needed before it; then paste it again)"
    echo "    $(switch_back_paste)   (starts every node as it was started, reloads the wallets)"
    echo "    ssh seq systemctl start $B_NODE_UNIT";;
  started)
    echo "The fleet runs."
    echo "Forward: fix the cause above (the node named), then paste the same again: $(paste_cmd STAGE=started)"
    echo "Back, in this order:"
    echo "    $(switch_back_paste CUT_PAUSE_STOPPED=1)   (stops every node; the release's binaries and clones back)"
    echo "    ssh seq systemctl stop $B_NODE_UNIT"
    echo "    $(paste_cmd BACK=1)   (it says first if a command is needed before it; then paste it again)"
    echo "    $(switch_back_paste)   (starts every node as it was started, reloads the wallets)"
    echo "    ssh seq systemctl start $B_NODE_UNIT";;
  back)
    echo "Forward (finish the way back): fix the cause above, then paste the same again; it takes up from where this run stopped:"
    echo "    $(paste_cmd BACK=1)"
    echo "Or go forward again instead: $(paste_cmd STAGE=stopped)";;
  esac
}

stopped_here() { # <how>
  trap - ERR INT TERM HUP
  set +e
  {
    echo ""
    echo "STOPPED ($1) in $MODE at step: $STEP"
    state_report
    advice
  } >&8
  echo "$MODE stopped at: $STEP" > "$STATE/last-run" 2>/dev/null
}
on_err() {
  local rc=$?
  # A failure inside $(...) is reported once, by the shell that runs the script.
  [ "$BASHPID" = "$$" ] || exit "$rc"
  stopped_here "a command failed at line $1"
  exit "$rc"
}
die() { echo "$*" >&8; stopped_here "refused"; exit 1; }
trap 'on_err $LINENO' ERR
trap 'stopped_here "interrupted"; exit 130' INT TERM HUP
trap 'remove_temporaries' EXIT
step() { STEP="$1"; echo "=== $1 ==="; echo "$MODE running: $STEP" > "$STATE/last-run"; }
finish() { echo "$MODE done" > "$STATE/last-run"; }

wait_served() {
  local url=$1
  # Run in $(...), this loop outlives a run killed outright and would hold the
  # lock for up to 180 s: it stops as soon as the shell running the script is gone.
  for _ in $(seq 1 90); do py served "$url" 2>/dev/null && return 0; kill -0 "$$" 2>/dev/null || exit 1; sleep 2; done
  echo "$url serves no valid list of two or more assets after 180 s:" >&2
  py served "$url" >&2 || true
  return 1
}

sha_of() { if [ -f "$1" ]; then sha256sum < "$1" | cut -d' ' -f1; else echo absent; fi; }
rev_sha() { git -C "$OPS" cat-file -e "$1" 2>/dev/null || return 1; git -C "$OPS" show "$1" | sha256sum | cut -d' ' -f1; }

# Whether a TCP port is listened on. The list is read whole before it is
# searched: grep -q on a pipe ends the reader early, and under pipefail its
# SIGPIPE would make a taken port read as free.
port_taken() { local l; l=$(ss -ltnH); grep -qE ":$1\$" <<< "$(awk '{print $4}' <<< "$l")"; }

# Whether STAGE=stopped has changed anything yet.
changed_by_stopped() {
  [ -f "$STATE/network-price-server.removed.json" ] || [ -f "$STATE/second-price-server.removed.json" ] \
    || [ -f "$PS_DROPIN_DIR/publish.conf" ] || [ -f "$B_PS_DROPIN_DIR/publish.conf" ] \
    || [ -d "$STATE/second-price-server-code" ] || [ -s "$STATE/ops.before" ]
}

# A run killed between removing a drop-in and reloading systemd leaves the
# manager listing a file that is gone, and systemctl cat then fails: reload
# once (it reads the unit files as they are on disk; it restarts nothing) and
# read again.
code_of_unit() {
  local all
  all=$(systemctl cat "$1" 2>/dev/null) || { systemctl daemon-reload; all=$(systemctl cat "$1" 2>/dev/null); } || return 1
  py unit-code <<< "$all"
}

# --- The fleet now, against the record STAGE=before made. ---
# 'port datadir running|stopped conf|command-line' per public node directory on
# disk, and the second operator's node.
fleet_now() {
  local d args=()
  for d in $(datadirs_on_disk); do args+=(- "$d"); done
  py fleet "${args[@]}" "$B_NODE_CONF" "$B_DATADIR"
}
# The state directory of the node release's switch under way, if any.
switch_state() {
  local f ph found=()
  if [ -n "${SWITCH_STATE:-}" ]; then echo "$SWITCH_STATE"; return 0; fi
  for f in $SWITCH_GLOB; do
    [ -s "$f/phase" ] && [ -s "$f/fleet.txt" ] || continue
    ph=$(cat "$f/phase")
    case $ph in captured|stopping|stopped|swapped|started|back-*) [ "$ph" = back-done ] || found+=("$f");; esac
  done
  [ "${#found[@]}" -le 1 ] || { echo "more than one node release's switch is under way (${found[*]}): set SWITCH_STATE to this release's" >&8; return 1; }
  [ "${#found[@]}" = 0 ] || echo "${found[0]}"
}
# The paste of that switch's way back (its owner script is named after its version).
switch_back_paste() {
  local s v
  s=$(switch_state 2>/dev/null || true)
  # None under way (a switch that has finished): the newest one on the box.
  # shellcheck disable=SC2086
  [ -n "$s" ] || s=$(ls -dt $SWITCH_GLOB 2>/dev/null | head -n 1 || true)
  v=${s##*/node-cutover-v}
  if [ -n "$s" ] && [ "$v" != "$s" ]; then
    echo "ssh seq 'BACK=1${1:+ $1} bash -s' < ~/Documents/arca/owner/node_cutover_${v}_2_switch.sh"
  else
    echo "the node release's switch with BACK=1${1:+ $1}"
  fi
}
# Refuses, naming each node, when the fleet now is not the one STAGE=before
# recorded: a node this script does not connect keeps a list nothing updates.
reconcile() { # <stopped|started>
  local now sw=- out
  [ -s "$DISK" ] || die "STAGE=before has not recorded the node directories on disk: with the fleet running on the binaries it ran, paste $(paste_cmd STAGE=before)"
  # Just started, a node may not listen yet: STAGE=started reads again for 90 s.
  for _ in $(seq 1 45); do now=$(fleet_now 2>/dev/null) && break; [ "$1" = started ] || break; sleep 2; done
  now=$(fleet_now) || die "a node's RPC port cannot be read, is not what its configuration says, or two nodes claim one"
  if [ "$1" = stopped ]; then
    sw=$(switch_state) || die "see above"
    if [ -n "$sw" ]; then sw=$sw/fleet.txt
    else sw=-; echo "  no node release's switch is under way here: the directories stopped at STAGE=before are checked for a run since"; fi
  fi
  if out=$(py reconcile "$DISK" "$1" "$sw" "$B_DATADIR" <<< "$now"); then
    echo "  the fleet is the one STAGE=before recorded: $(grep -c ' running ' "$DISK") nodes$([ "$sw" = - ] || echo ", the ones the release switch starts")"
    return 0
  fi
  { echo "The fleet is not the one STAGE=before recorded:"; echo "$out"; } >&8
  if [ "$1" = stopped ]; then
    die "$(if changed_by_stopped; then echo "This stage has changed things already."; else echo "This stage has changed nothing."; fi) To record the fleet that is to run: go back by the way printed below (it starts every node the release switch recorded, on the binaries they ran), stop or start each node named above as it is to be, paste $(paste_cmd STAGE=before), and take the day up again from the second operator's script."
  else
    die "A node that ran at STAGE=before and is not running now: start it (as it was started), then paste $(paste_cmd STAGE=started) again. A node that runs and was not running then has no price server's list: if it is not to run, stop it and paste the same again; to connect it, record it: go back by the way printed below, then paste $(paste_cmd STAGE=before) with it running, and take the day up again from the second operator's script."
  fi
}

# --- Files this script writes beside others'. ---
# A price server's drop-in of this script's name is this script's only if it
# carries its mark; anything else there is someone else's, refused and kept.
dropin_ours() { [ -f "$1" ] && grep -q "^$DROPIN_MARK" "$1"; }
foreign_dropins() {
  local f
  for f in "$PS_DROPIN_DIR/publish.conf" "$B_PS_DROPIN_DIR/publish.conf"; do
    if [ -e "$f" ] && ! dropin_ours "$f"; then echo "$f"; fi
  done
  return 0
}
# A file put back through a private temporary beside it and a rename: at any
# moment the path holds the old bytes or the new, never a part.
put_back() { # <saved copy> <path>
  local tmp
  tmp=$(mktemp "$(dirname "$2")/.$(basename "$2").cutover-back.XXXXXX")
  cp -p "$1" "$tmp"
  mv -f "$tmp" "$2"
}

# BACK=1 undoes a cutover this script recorded, and nothing else: with no
# record of STAGE=before it changes nothing (and creates nothing).
if [ "$MODE" = back ] && [ ! -s "$FLEET" ]; then
  if [ "$(cat "$STATE/last-run" 2>/dev/null)" = "back done" ]; then
    echo "back done: an earlier BACK=1 finished, and nothing of the cutover is left to undo"; exit 0
  fi
  echo "no cutover is recorded on this box (STAGE=before has not run, or its record is gone): BACK=1 changed nothing" >&2
  exit 1
fi

# Its own directory, created once; an existing one is never changed.
[ -d "$STATE" ] || install -d -m 700 "$STATE"
[ "$(stat -c %a "$STATE")" = 700 ] || { echo "$STATE is not mode 700; refusing to keep records there" >&2; exit 1; }
if [ -s "$STATE/last-run" ] && ! grep -q ' done$' "$STATE/last-run"; then
  echo "note: the last run did not finish ($(cat "$STATE/last-run")); this run takes it up."
fi
case "$MODE" in stopped|back) remove_temporaries ;; esac
echo "$(datadirs_on_disk | wc -l) public nodes on disk ($(fleet_running | grep -vcxF "$B_NODE_UNIT" || true) running)$( [ -s "$FLEET" ] && echo "; the fleet recorded at STAGE=before: $(wc -l < "$FLEET")"), and the second operator's node"

if [ "$MODE" = back ]; then
  step "back: the fleet must be stopped, if STAGE=stopped changed anything"
  # A node's configuration changes only with the node stopped. With nothing of
  # STAGE=stopped's to undo (it never ran, or was refused before it changed
  # anything), only the records go, and the fleet may run.
  marked=""
  for d in $(all_dirs) "$(dirname "$B_NODE_CONF")"; do
    f=$d/elements.conf; [ "$d" = "$(dirname "$B_NODE_CONF")" ] && f=$B_NODE_CONF
    if grep -qxF "$MARK" "$f" 2>/dev/null; then marked=1; fi
  done
  if changed_by_stopped || [ -n "$marked" ] || [ -f "$CADDY_PENDING" ]; then
    running=$(fleet_running)
    [ -z "$running" ] || die "still running: $(tr '\n' ' ' <<< "$running")"
  else
    echo "  STAGE=stopped changed nothing: the fleet may run"
  fi

  step "back: what each part goes back to, checked before anything changes"
  refuse=""
  # The network's price server: a release moves the node checkout it runs
  # from, and code that refuses a node login would not start again.
  code=$(code_of_unit "$PS_UNIT") || die "cannot read the code $PS_UNIT runs"
  if ! why=$(py accepts "$code" "$PS_CONFIG" "$STATE/network-price-server.removed.json"); then
    echo "  the network's price server would run $code, which refuses its configuration with the node logins put back: $why"
    clone=$(git -C "$(dirname "$code")" rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$clone" ] && [ -s "$STATE/node-clone.before" ] && [ "$(cut -d' ' -f1 "$STATE/node-clone.before")" = "$clone" ]; then
      was=$(cut -d' ' -f2 "$STATE/node-clone.before")
      echo "  $clone is at $(git -C "$clone" rev-parse HEAD); it was at $was before the cutover. Move it back first:"
      echo "    git -C $clone checkout -q --detach $was"
    else
      echo "  no commit was recorded for $code before the cutover (STAGE=before did not run): move it back by hand to the code it ran before"
    fi
    refuse=1
  fi
  # The second operator's price server runs the files behind its bundle link.
  # The files this script replaced go back to the directory they came from, by
  # that directory's own path, never through the link.
  link_now=$(readlink "$B_LINK" 2>/dev/null || true)
  link_was=$(cat "$STATE/second-bundle-link.before" 2>/dev/null || true)
  real_now=$(readlink -f "$B_PS_DIR")
  kept_from=$(cat "$STATE/second-price-server-code.from" 2>/dev/null || true)
  if [ -n "$kept_from" ] && [ "$kept_from" = "$real_now" ] && [ -d "$STATE/second-price-server-code" ]; then
    bcode=$STATE/second-price-server-code/price_server.py
  else
    bcode=$B_PS_DIR/price_server.py
  fi
  if ! why=$(py accepts "$bcode" "$B_PS_CONFIG" "$STATE/second-price-server.removed.json"); then
    echo "  the second operator's price server would run $bcode ($B_LINK -> $link_now), which refuses its configuration with the node login put back: $why"
    if [ -n "$link_was" ] && [ "$link_was" != "$link_now" ]; then
      echo "  its bundle link named $link_was before the cutover. Point it back first (its node then runs that release from its next start):"
      echo "    ln -sfn $link_was $B_LINK"
    elif [ -n "$link_was" ]; then
      echo "  its bundle link names $link_was, as it did before the cutover, and that code refuses the login: put that release's own price server back in $real_now by hand"
    else
      echo "  no bundle link was recorded before the cutover (STAGE=before did not run), so there is no earlier release to name: point $B_LINK at the release it ran before by hand"
    fi
    refuse=1
  fi
  # Caddy and the operations checkout: put back only when nothing else changed
  # them since this script did; otherwise left as they are, and said so.
  # Caddy and the operations checkout, judged by what they hold now against
  # the copies taken before the first change and against what the recorded
  # commit installs: what is as this script left it goes back; anything else
  # is left and said. A run killed anywhere in the route's step leaves no
  # record that this depends on.
  caddy_back=""; env_back=""; ops_back=""; caddy_left=""; env_left=""
  inst=$(cat "$STATE/ops.installed" 2>/dev/null || true)
  if [ -f "$STATE/Caddyfile.before" ]; then
    new=$(rev_sha "$inst:caddy/Caddyfile") || new=none
    if [ "$(sha_of "$CADDYFILE")" = "$(sha_of "$STATE/Caddyfile.before")" ]; then :
    elif [ "$(sha_of "$CADDYFILE")" = "$new" ]; then caddy_back=1
    else caddy_left=1; echo "  $CADDYFILE changed since this script installed it: left as it is (its /feewhitelist route will serve nothing)"; fi
    new=$(rev_sha "$inst:caddy/caddy.service.d/env.conf") || new=none
    if [ -f "$STATE/caddy-env.conf.before" ]; then
      if [ "$(sha_of "$CADDY_ENV_CONF")" = "$(sha_of "$STATE/caddy-env.conf.before")" ]; then :
      elif [ "$(sha_of "$CADDY_ENV_CONF")" = "$new" ]; then env_back=1
      else env_left=1; echo "  $CADDY_ENV_CONF changed since this script installed it: left as it is"; fi
    elif [ -f "$CADDY_ENV_CONF" ]; then
      if [ "$(sha_of "$CADDY_ENV_CONF")" = "$new" ]; then env_back=1
      else env_left=1; echo "  $CADDY_ENV_CONF appeared since, and is not this script's: left as it is"; fi
    fi
  fi
  if [ -s "$STATE/ops.before" ]; then
    head_now=$(git -C "$OPS" rev-parse HEAD)
    if [ "$head_now" = "$(cut -d' ' -f1 "$STATE/ops.before")" ]; then :
    elif [ "$head_now" = "$inst" ]; then ops_back=1
    else echo "  $OPS moved since this script checked it out: left at $(git -C "$OPS" rev-parse --short HEAD)"; fi
  fi
  [ -z "$refuse" ] || die "back refused; nothing was changed. Do the steps above, then BACK=1 again."
  echo "  both price servers accept what is put back"

  step "back: the nodes' configuration lines"
  for d in $(all_dirs); do py disconnect "$d/elements.conf" "$MARK"; done
  py disconnect "$B_NODE_CONF" "$MARK"

  step "back: the network's price server's configuration and drop-in"
  # Only a drop-in this script wrote (it carries its mark) is removed.
  if dropin_ours "$PS_DROPIN_DIR/publish.conf"; then rm -f "$PS_DROPIN_DIR/publish.conf"
  elif [ -e "$PS_DROPIN_DIR/publish.conf" ]; then echo "  left $PS_DROPIN_DIR/publish.conf: this script did not write it"; fi
  if [ -f "$STATE/created-ps-dropin-dir" ]; then
    rmdir "$PS_DROPIN_DIR" 2>/dev/null || echo "  left $PS_DROPIN_DIR: it holds files this script did not put there"
    rm -f "$STATE/created-ps-dropin-dir"
  fi
  if [ -f "$STATE/network-price-server.removed.json" ]; then
    py unstrip "$PS_CONFIG" "$STATE/network-price-server.removed.json"
    rm -f "$STATE/network-price-server.removed.json" "$STATE/network-price-server.removed.json.orig"
  fi

  step "back: the second operator's price server's configuration, drop-in and code"
  if dropin_ours "$B_PS_DROPIN_DIR/publish.conf"; then rm -f "$B_PS_DROPIN_DIR/publish.conf"
  elif [ -e "$B_PS_DROPIN_DIR/publish.conf" ]; then echo "  left $B_PS_DROPIN_DIR/publish.conf: this script did not write it"; fi
  if [ -f "$STATE/created-b-dropin-dir" ]; then
    rmdir "$B_PS_DROPIN_DIR" 2>/dev/null || echo "  left $B_PS_DROPIN_DIR: it holds files this script did not put there"
    rm -f "$STATE/created-b-dropin-dir"
  fi
  if [ -f "$STATE/second-price-server.removed.json" ]; then
    py unstrip "$B_PS_CONFIG" "$STATE/second-price-server.removed.json"
    rm -f "$STATE/second-price-server.removed.json" "$STATE/second-price-server.removed.json.orig"
  fi
  if [ -n "$kept_from" ] && [ -d "$STATE/second-price-server-code" ]; then
    if [ -d "$kept_from" ]; then
      cp -p "$STATE/second-price-server-code/"* "$kept_from/"
      echo "  $kept_from: its own price-server files put back"
    else
      echo "  $kept_from is gone; the price-server files kept from it are put nowhere else"
    fi
  fi
  rm -rf "$STATE/second-price-server-code"; rm -f "$STATE/second-price-server-code.from"

  step "back: restart both price servers as they ran before"
  systemctl daemon-reload
  systemctl restart "$PS_UNIT" "$B_PS_UNIT"
  sleep 5
  systemctl is-active --quiet "$PS_UNIT" || die "$PS_UNIT is not active after its restart (journalctl -u $PS_UNIT)"
  systemctl is-active --quiet "$B_PS_UNIT" || die "$B_PS_UNIT is not active after its restart (journalctl -u $B_PS_UNIT)"

  step "back: the published file"
  # After the restart: until then the new price server writes it again.
  if [ -f "$PUB_KEPT" ]; then
    # The list that was there before the cutover: its bytes, owner and mode.
    put_back "$PUB_KEPT" "$PUBFILE"; rm -f "$PUB_KEPT"
    echo "  $PUBFILE: the file that was there before the cutover, put back"
  elif [ -f "$STATE/created-pubdir" ]; then
    rm -f "$PUBFILE" "$PUBFILE.tmp"
    rmdir "$PUBDIR" 2>/dev/null || echo "  left $PUBDIR: it holds files this script did not put there"
  elif [ -f "$STATE/created-pubfile" ]; then
    rm -f "$PUBFILE" "$PUBFILE.tmp"
  fi
  rm -f "$STATE/created-pubdir" "$STATE/created-pubfile"

  step "back: the Caddy route and the checkout it came from"
  if [ -n "$caddy_back$env_back" ] || [ -f "$CADDY_PENDING" ]; then
    # Pending from before the first file changes until Caddy has reloaded: a
    # run stopped in between reloads on the next paste, whatever the files
    # hold by then. Each file goes back through a temporary and a rename.
    [ -f "$CADDY_PENDING" ] || { date -u +%FT%TZ > "$CADDY_PENDING.new"; mv -f "$CADDY_PENDING.new" "$CADDY_PENDING"; }
    if [ -n "$caddy_back" ]; then put_back "$STATE/Caddyfile.before" "$CADDYFILE"; echo "  $CADDYFILE: as it was before the cutover"; fi
    if [ -n "$env_back" ]; then
      if [ -f "$STATE/caddy-env.conf.before" ]; then put_back "$STATE/caddy-env.conf.before" "$CADDY_ENV_CONF"; else rm -f "$CADDY_ENV_CONF"; fi
      echo "  $CADDY_ENV_CONF: as it was before the cutover"
    fi
    systemctl daemon-reload
    systemctl reload caddy
    rm -f "$CADDY_PENDING"
    echo "  caddy reloaded"
  fi
  # A file someone else changed since keeps the copy taken before the
  # cutover, under a name of its own; the others' copies are done with.
  if [ -n "$caddy_left" ] && [ -f "$STATE/Caddyfile.before" ]; then
    mv -f "$STATE/Caddyfile.before" "$STATE/Caddyfile.before-cutover"; echo "  the Caddyfile from before the cutover is kept in $STATE/Caddyfile.before-cutover"
  fi
  if [ -n "$env_left" ] && [ -f "$STATE/caddy-env.conf.before" ]; then
    mv -f "$STATE/caddy-env.conf.before" "$STATE/caddy-env.conf.before-cutover"; echo "  $CADDY_ENV_CONF from before the cutover is kept in $STATE/caddy-env.conf.before-cutover"
  fi
  rm -f "$STATE/Caddyfile.before" "$STATE/caddy-env.conf.before" "$STATE/caddy-env.conf.absent"
  if [ -n "$ops_back" ]; then
    read -r ops_sha ops_branch < "$STATE/ops.before"
    if [ "$ops_branch" != "-" ]; then git -C "$OPS" checkout -q "$ops_branch"; else git -C "$OPS" checkout -q --detach "$ops_sha"; fi
    echo "  $OPS: back at $(git -C "$OPS" rev-parse --short HEAD)"
  fi
  rm -f "$STATE/ops.before" "$STATE/ops.installed"

  rm -f "$STATE/node-clone.before" "$STATE/second-bundle-link.before" "$STATE/assets.before"
  # The record of the cutover goes last: until it is gone, BACK=1 runs again.
  finish
  rm -f "$DISK" "$FLEET"
  echo "back done: both price servers run as before; start the fleet with the binaries it ran before ($(switch_back_paste)), and $B_NODE_UNIT"
  exit 0
fi

step "check the box"
command -v curl >/dev/null; command -v python3 >/dev/null; command -v ss >/dev/null
[ -r "$PS_CONFIG" ] && [ -r "$B_PS_CONFIG" ] && [ -w "$B_NODE_CONF" ]
for d in $(fleet_dirs); do [ -w "$d/elements.conf" ]; done

case "$MODE" in
before|trial)
  step "the public nodes, and the RPC port each listens on"
  args=(); for d in $(datadirs_on_disk); do args+=(- "$d"); done
  pub=$(py fleet "${args[@]}") || die "a node's RPC port is not what its configuration says, or two nodes claim one"
  sec=$(py fleet "$B_NODE_CONF" "$B_DATADIR") || die "the second operator's node's RPC port is not what its configuration says"
  awk '$3 == "stopped" {print "  " $2 ": not running; this cutover leaves it alone"}' <<< "$pub"
  nrun=$(awk '$3 == "running"' <<< "$pub" | grep -c . || true)
  [ "$nrun" -gt 0 ] || die "no public node is running: STAGE=before and TRIAL=1 run with the fleet up"
  echo "  $nrun running public nodes"
  foreign=$(foreign_dropins)
  [ -z "$foreign" ] || die "a price server's drop-in this script did not write is where it writes its own: $(tr '\n' ' ' <<< "$foreign")-- move it aside (or fold it into the unit) and paste this again; this script neither replaces nor deletes it"
  if [ -e "$PUBFILE" ]; then echo "  $PUBFILE exists already: STAGE=stopped keeps it, and BACK=1 puts it back"; fi

  step "the nodes the price servers write to today, against the nodes this script connects"
  py match "$PS_CONFIG" "the network's price server" <<< "$(awk '$3 == "running" {print $1, $2}' <<< "$pub")" \
    || die "a node the network's price server writes to would lose its list: start it, add it to this script's nodes, or take it out of node_rpcs"
  py match "$B_PS_CONFIG" "the second operator's price server" <<< "$(awk '$3 == "running" {print $1, $2}' <<< "$sec")" \
    || die "the second operator's price server writes to a node this script does not connect (or its node is not running)"

  step "the assets the public nodes accept now (node000, by its own cookie)"
  live=$("$CLI" -datadir="$COMMITTEE_ROOT/node000" getfeeassetinfo | python3 -I -c 'import json,sys; print(" ".join(sorted(k for k,v in json.load(sys.stdin).items() if v["accepted"])))')
  echo "$(wc -w <<< "$live") assets"

  step "the code each price server runs now, and the release the second operator's bundle names"
  code=$(code_of_unit "$PS_UNIT") || die "cannot read the code $PS_UNIT runs"
  why=$(py accepts "$code" "$PS_CONFIG") || die "the network's price server's code ($code) refuses its own configuration now: $why"
  clone=$(git -C "$(dirname "$code")" rev-parse --show-toplevel 2>/dev/null) || die "$code is not in a git checkout"
  [ -L "$B_LINK" ] || die "$B_LINK is not a link; this script handles a bundle whose release is a link"
  if why=$(py accepts "$B_PS_DIR/price_server.py" "$B_PS_CONFIG"); then
    echo "  $B_LINK -> $(readlink "$B_LINK"): its price server takes its node login, as before the cutover"
  elif [ -s "$STATE/second-bundle-link.before" ]; then
    echo "  $B_LINK -> $(readlink "$B_LINK"), the release's; before the cutover it named $(cat "$STATE/second-bundle-link.before") (recorded)"
  elif [ "$MODE" = before ]; then
    die "the second operator's price server ($B_LINK -> $(readlink "$B_LINK")) refuses its node login ($why): its bundle has moved to the release already, so the link no longer names the release to go back to. STAGE=before runs before the second operator's bundle moves. Point the link back to the release it ran (ln -sfn <that release> $B_LINK), then paste STAGE=before again"
  else
    echo "  note: $B_LINK -> $(readlink "$B_LINK") refuses its node login ($why): STAGE=before would refuse until the link names the release it ran before"
  fi

  if [ "$MODE" = before ]; then
    step "record what the way back needs"
    if ! changed_by_stopped; then
      # Nothing has changed yet: the records are what runs now (an attempt
      # given up earlier leaves none behind that would mislead this one).
      awk '$3 == "running" {print $1, $2}' <<< "$pub" > "$FLEET.new"; mv -f "$FLEET.new" "$FLEET"
      # Every directory on disk, running or not, and the second operator's
      # node: what the later stages hold the fleet against.
      printf '%s\n%s\n' "$pub" "$sec" > "$DISK.new"; mv -f "$DISK.new" "$DISK"
      printf '%s\n' "$live" > "$STATE/assets.before"
      echo "$clone $(git -C "$clone" rev-parse HEAD)" > "$STATE/node-clone.before"
    else
      echo "  STAGE=stopped has changed things since the first STAGE=before: its records are kept"
    fi
    # The bundle link: recorded while it names the release from before the
    # cutover, never once it has moved off the recorded one.
    link_now=$(readlink "$B_LINK")
    if [ ! -s "$STATE/second-bundle-link.before" ]; then echo "$link_now" > "$STATE/second-bundle-link.before"
    elif [ "$(cat "$STATE/second-bundle-link.before")" != "$link_now" ]; then echo "  the bundle link moved since it was recorded: the record is kept"; fi
    echo "  the fleet: $(wc -l < "$FLEET") public nodes; the network's price server's checkout: $(cat "$STATE/node-clone.before"); the second operator's bundle: $B_LINK -> $(cat "$STATE/second-bundle-link.before")"
  fi

  step "the price server's code: origin/master"
  git -C "$NODE_CLONE" fetch -q origin master
  COMMIT=$(git -C "$NODE_CLONE" rev-parse origin/master)
  code=$(git -C "$NODE_CLONE" show "$COMMIT:contrib/price-server/price_server.py")
  grep -q '"/feewhitelist"' <<< "$code" || die "origin/master ($COMMIT) does not publish at /feewhitelist yet"
  if [ "$MODE" = trial ]; then
    step "trial: one round of the new code with the node logins removed, into a temporary file"
    find /tmp -maxdepth 1 -name 'fee-whitelist-cutover-trial.*' -type d -exec rm -rf {} + 2>/dev/null || true
    T=$(mktemp -d /tmp/fee-whitelist-cutover-trial.XXXXXX)
    printf '%s\n' "$code" > "$T/price_server.py"
    install -m 600 "$PS_CONFIG" "$T/config.json"
    # shellcheck disable=SC2086
    py strip "$T/config.json" "$T/removed.json" $REMOVED_KEYS >/dev/null
    python3 -I -B "$T/price_server.py" --config "$T/config.json" --once --publish-file "$T/list.json" > "$T/out.log" 2>&1 \
      || { tail -5 "$T/out.log"; die "one round of the new code failed"; }
    if [ -s "$T/list.json" ]; then
      ours=$(py check-list < "$T/list.json")
      if [ "$ours" = "$live" ]; then echo "the same $(wc -w <<< "$ours") assets as the public nodes accept now"
      else echo "differs from the public nodes' list:"; echo " new:   $ours"; echo " nodes: $live"; fi
    else
      echo "its first round published nothing (it waits a round for max_change_factor's baselines); STAGE=stopped waits for it"
    fi
    for d in $(datadirs_on_disk); do grep -qE '^(no)?feepriceserver=' "$d/elements.conf" && echo "  $d sets feepriceserver by hand: STAGE=stopped will refuse"; done
    if [ ! -f "$B_PS_DROPIN_DIR/publish.conf" ] && port_taken "$B_PS_PORT"; then die "port $B_PS_PORT is taken: set B_PS_PORT"; fi
    if py served "$NETWORK_URL" > /dev/null 2>&1; then echo "$NETWORK_URL serves a list already"
    else echo "$NETWORK_URL serves no list yet: STAGE=stopped installs the Caddy route"; fi
    echo "trial done; nothing changed"
  else
    echo "before done: the second operator's bundle may move to the release now; then stop the fleet and run STAGE=stopped"
  fi
  finish
  exit 0
  ;;
stopped)
  step "every public node and the second operator's node is stopped"
  [ -s "$FLEET" ] && [ -s "$STATE/node-clone.before" ] && [ -s "$STATE/second-bundle-link.before" ] \
    || die "STAGE=before has not recorded the fleet and what the way back needs: start the fleet on the binaries it ran, run STAGE=before, then stop it again"
  running=$(fleet_running)
  [ -z "$running" ] || die "still running: $(tr '\n' ' ' <<< "$running")"

  step "the fleet that will start, against the one STAGE=before recorded"
  reconcile stopped
  foreign=$(foreign_dropins)
  [ -z "$foreign" ] || die "a price server's drop-in this script did not write is where it writes its own: $(tr '\n' ' ' <<< "$foreign")-- move it aside (or fold it into the unit) and paste this again; this script neither replaces nor deletes it"
  # Before its drop-in exists the second operator's price server serves no
  # port, so anything on this one is something else's. Checked before anything changes.
  if [ ! -f "$B_PS_DROPIN_DIR/publish.conf" ] && port_taken "$B_PS_PORT"; then
    die "port $B_PS_PORT is taken by something else: free it or set B_PS_PORT"
  fi
  real_now=$(readlink -f "$B_PS_DIR")
  kept_from=$(cat "$STATE/second-price-server-code.from" 2>/dev/null || true)
  [ -z "$kept_from" ] || [ "$kept_from" = "$real_now" ] \
    || die "this script replaced the price-server files in $kept_from, and the second operator's bundle now names $real_now: run BACK=1 first, so those files go back where they came from"

  step "the network's price server: code at origin/master, in its own checkout"
  git -C "$NODE_CLONE" fetch -q origin master
  COMMIT=$(git -C "$NODE_CLONE" rev-parse origin/master)
  if [ -d "$SRC" ]; then LIVE=$(git -C "$SRC" rev-parse HEAD); else LIVE=$(git -C "$NODE_CLONE" rev-parse HEAD); fi
  if ! git -C "$NODE_CLONE" merge-base --is-ancestor "$LIVE" "$COMMIT" && [ "${ALLOW_BACK:-0}" != 1 ]; then
    die "origin/master ($COMMIT) does not contain the code the price server runs now ($LIVE); ALLOW_BACK=1 to go back"
  fi
  if [ -d "$SRC" ]; then git -C "$SRC" checkout -q --detach "$COMMIT"; else git -C "$NODE_CLONE" worktree add -q --detach "$SRC" "$COMMIT"; fi
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ]

  step "the network's price server: no node logins, publishing to $PUBFILE"
  # shellcheck disable=SC2086
  py strip "$PS_CONFIG" "$STATE/network-price-server.removed.json" $REMOVED_KEYS
  [ -d "$PUBDIR" ] || { install -d -m 755 "$PUBDIR"; touch "$STATE/created-pubdir"; }
  if [ -e "$PUBFILE" ] && [ ! -f "$STATE/created-pubdir" ] && [ ! -f "$STATE/created-pubfile" ] && [ ! -f "$PUB_KEPT" ]; then
    # A list published before the cutover: kept once, with its owner and mode,
    # before this script's writer starts; BACK=1 puts it back.
    cp -p "$PUBFILE" "$PUB_KEPT.new"; mv -f "$PUB_KEPT.new" "$PUB_KEPT"
    echo "  $PUBFILE was there before the cutover: kept in $PUB_KEPT"
  fi
  [ -e "$PUBFILE" ] || [ -f "$STATE/created-pubdir" ] || [ -f "$PUB_KEPT" ] || touch "$STATE/created-pubfile"
  [ -d "$PS_DROPIN_DIR" ] || { install -d -m 755 "$PS_DROPIN_DIR"; touch "$STATE/created-ps-dropin-dir"; }
  printf '[Service]\n# fee-whitelist-cutover: publish the list; write to no node.\nExecStart=\nExecStart=/usr/bin/python3 %s --config %s --publish-file %s\n' \
    "$SRC/contrib/price-server/price_server.py" "$PS_CONFIG" "$PUBFILE" > "$STATE/publish.conf.new"
  install -m 644 "$STATE/publish.conf.new" "$PS_DROPIN_DIR/publish.conf"

  step "the second operator's price server: the same code, no node login, publishing at $B_URL"
  if ! cmp -s "$SRC/contrib/price-server/price_server.py" "$real_now/price_server.py"; then
    # Its own files kept once, with the directory they came from; the files
    # are replaced in that directory, by its own path.
    if [ ! -d "$STATE/second-price-server-code" ]; then
      install -d -m 700 "$STATE/second-price-server-code.new"
      cp -p "$real_now/"* "$STATE/second-price-server-code.new/"
      echo "$real_now" > "$STATE/second-price-server-code.from"
      mv "$STATE/second-price-server-code.new" "$STATE/second-price-server-code"
    fi
    for f in price_server.py config.example.json README.md ORACLE-AND-REFERENCE-DESIGN.md; do
      install -m "$(stat -c %a "$real_now/$f" 2>/dev/null || echo 644)" "$SRC/contrib/price-server/$f" "$real_now/$f"
    done
  fi
  # shellcheck disable=SC2086
  py strip "$B_PS_CONFIG" "$STATE/second-price-server.removed.json" $REMOVED_KEYS
  [ -d "$B_PS_DROPIN_DIR" ] || { install -d -m 755 "$B_PS_DROPIN_DIR"; touch "$STATE/created-b-dropin-dir"; }
  printf '[Service]\n# fee-whitelist-cutover: publish the list on loopback; write to no node.\nExecStart=\nExecStart=/usr/bin/python3 -I %s/price_server.py --config %s --ui-port %s --ui-host 127.0.0.1\n' \
    "$B_PS_DIR" "$B_PS_CONFIG" "$B_PS_PORT" > "$STATE/b-publish.conf.new"
  install -m 644 "$STATE/b-publish.conf.new" "$B_PS_DROPIN_DIR/publish.conf"

  step "restart both price servers, always (new code, new settings)"
  systemctl daemon-reload
  systemctl restart "$PS_UNIT" "$B_PS_UNIT"
  sleep 3
  systemctl is-active --quiet "$PS_UNIT" || die "$PS_UNIT is not active after its restart (journalctl -u $PS_UNIT)"
  systemctl is-active --quiet "$B_PS_UNIT" || die "$B_PS_UNIT is not active after its restart (journalctl -u $B_PS_UNIT)"

  step "the network's list: written, and served at $NETWORK_URL"
  for _ in $(seq 1 90); do [ -s "$PUBFILE" ] && break; sleep 2; done
  ours=$(py check-list < "$PUBFILE") || die "$PUBFILE holds no valid list of two or more assets"
  echo "$(wc -w <<< "$ours") assets in $PUBFILE"
  if [ -f "$STATE/assets.before" ]; then
    if [ "$ours" = "$(cat "$STATE/assets.before")" ]; then echo "the same assets the public nodes accepted before the stop"
    else echo "note: differs from the public nodes' list before the stop:"; echo " now:    $ours"; echo " before: $(cat "$STATE/assets.before")"; fi
  fi
  # Whether the route is there is decided by the list the address serves
  # itself: a redirect (what the site answers a path it has no route for) is no route.
  if ! py served "$NETWORK_URL" > /dev/null 2>&1; then
    step "the Caddy route: this repository's origin/main, fast-forward only, nothing else changing"
    git -C "$OPS" fetch -q origin main
    OPS_COMMIT=$(git -C "$OPS" rev-parse origin/main)
    git -C "$OPS" merge-base --is-ancestor HEAD "$OPS_COMMIT" \
      || die "origin/main does not contain the box's operations checkout ($(git -C "$OPS" rev-parse HEAD))"
    newcaddy=$(git -C "$OPS" show "$OPS_COMMIT:caddy/Caddyfile")
    grep -q 'handle /feewhitelist' <<< "$newcaddy" || die "origin/main's Caddyfile has no /feewhitelist route"
    old_lines=$(grep -v '^[[:space:]]*#' "$CADDYFILE" || true)
    new_lines=$(grep -v '^[[:space:]]*#' <<< "$newcaddy" || true)
    changed=$(diff <(printf '%s\n' "$old_lines") <(printf '%s\n' "$new_lines") || true)
    other=$(grep '^[<>]' <<< "$changed" \
            | grep -v -E '^> 	(handle /feewhitelist \{|	root \* /srv/feewhitelist|	rewrite \* /feewhitelist.json|	header Cache-Control no-cache|	file_server|\})$' || true)
    [ -z "$other" ] || die "the Caddyfile on origin/main differs from the installed one in more than the /feewhitelist route: $other"
    # What the way back puts back, recorded once, before the first change.
    if [ ! -s "$STATE/ops.before" ]; then
      branch=$(git -C "$OPS" symbolic-ref -q --short HEAD || echo -)
      cp -p "$CADDYFILE" "$STATE/Caddyfile.before"
      if [ -f "$CADDY_ENV_CONF" ]; then cp -p "$CADDY_ENV_CONF" "$STATE/caddy-env.conf.before"; else touch "$STATE/caddy-env.conf.absent"; fi
      echo "$(git -C "$OPS" rev-parse HEAD) $branch" > "$STATE/ops.before.new"; mv -f "$STATE/ops.before.new" "$STATE/ops.before"
    fi
    echo "$OPS_COMMIT" > "$STATE/ops.installed"
    git -C "$OPS" checkout -q --detach "$OPS_COMMIT"
    "$OPS/bin/apply-caddy.sh" || die "$OPS/bin/apply-caddy.sh failed (above)"
  fi
  wait_served "$NETWORK_URL" > /dev/null || die "$NETWORK_URL serves no list"
  admin=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$NETWORK_URL/admin" || true)
  [ "$admin" != 200 ] || die "$NETWORK_URL/admin answers 200"

  step "the second operator's list, served at $B_URL"
  b=$(wait_served "$B_URL") || die "$B_URL serves no list"
  echo "$(wc -w <<< "$b") assets"

  step "every node's configuration: connected to its price server"
  for d in $(fleet_dirs); do py connect "$d/elements.conf" "$NETWORK_URL" "$MARK" || die "$d/elements.conf: see above"; done
  py connect "$B_NODE_CONF" "$B_URL" "$MARK" || die "$B_NODE_CONF: see above"
  finish
  echo "done: start the fleet (and $B_NODE_UNIT), then run STAGE=started"
  ;;
started)
  step "the fleet running, against the one STAGE=before recorded"
  reconcile started

  step "every node connected, with a list of two or more assets"
  bad=0
  check_node() { # name, expected url, cli command...
    local name=$1 url=$2; shift 2
    local s
    for _ in $(seq 1 45); do
      s=$("$@" getfeepriceserver 2>/dev/null) && python3 -I -c '
import json, sys
s = json.loads(sys.argv[1])
assert s["connected"] and s["url"] == sys.argv[2] and s.get("has_list") and s["assets"] >= 2
assert s["decided_by"] == "configuration file"
' "$s" "$url" 2>/dev/null && { printf '  %-18s connected, %s assets\n' "$name" "$(python3 -I -c 'import json,sys;print(json.loads(sys.argv[1])["assets"])' "$s")"; return 0; }
      sleep 2
    done
    printf '  %-18s NOT CONNECTED with a list: %s\n' "$name" "${s:-no answer}"; return 1
  }
  for d in $(fleet_dirs); do check_node "$(basename "$d")" "$NETWORK_URL" "$CLI" -datadir="$d" || bad=$((bad+1)); done
  check_node "second operator" "$B_URL" runuser -u "$B_USER" -- "$B_CLI" -conf="$B_NODE_CONF" -datadir="$B_DATADIR" || bad=$((bad+1))
  [ "$bad" = 0 ] || die "$bad node(s) without their list"
  step "the fleet still the one STAGE=before recorded"
  reconcile started
  finish
  echo "done: every node reads its price server's list; no price server writes to a node"
  ;;
esac
