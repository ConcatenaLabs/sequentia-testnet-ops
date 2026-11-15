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
#   ssh seq 'STAGE=before bash -s'  < bin/fee-whitelist-cutover.sh   # fleet running, before the stop
#   ssh seq 'STAGE=stopped bash -s' < bin/fee-whitelist-cutover.sh   # every node stopped, new binaries in place
#   ssh seq 'STAGE=started bash -s' < bin/fee-whitelist-cutover.sh   # after the fleet has started again
#
#   TRIAL=1  checks everything and runs the new price server once into a
#            temporary file; changes nothing. Any time.
#   BACK=1   with the fleet stopped: undoes exactly what STAGE=stopped changed
#            (the configuration lines it added, the keys it removed, its drop-ins,
#            the second operator's price-server files) and restarts the price
#            servers as they ran before. It first checks that the code each
#            price server will then run accepts the configuration it puts back
#            (a node login); if not, because the release moved that code on, it
#            changes nothing and prints the one command that moves it back.
#
# Its first line is the count of public nodes it found. STAGE=before and TRIAL=1
# also match every node the network's price server writes to today (the RPC
# ports in its node_rpcs) to a public node's data directory, and the second
# operator's node_rpc to its node, and refuse on any that matches none: a node
# left out would keep a list nothing updates any more.
#
# Nothing in between leaves a public node with an empty or a one-asset list:
# the nodes are stopped while their configuration changes; STAGE=stopped
# returns only when both price servers serve a list of at least two assets, so
# each node takes it in its first second; and STAGE=started checks every node.
# It changes no firewall rule. Each stage can be pasted twice.
set -Eeuo pipefail
exec 9> /run/lock/fee-whitelist-cutover.lock
flock -n 9 || { echo "already running"; exit 0; }
STEP=start
trap 'echo "FAILED at step: $STEP" >&2' ERR
step() { STEP="$1"; echo "=== $1 ==="; }

NODE_CLONE=${NODE_CLONE:-/root/sequentia/Sequentia}
SRC=${SRC:-/root/seq-price-server-src}
OPS=${OPS:-/root/sequentia/sequentia-testnet-ops}
STATE=${STATE:-/var/lib/fee-whitelist-cutover}
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

public_datadirs() {
  local d
  for d in "$COMMITTEE_ROOT"/node0*/ "$COMMITTEE_ROOT"/dexnode/; do [ -f "$d/elements.conf" ] && echo "${d%/}"; done
  for d in "$EXPLORER" "$POOLBOARD"; do [ -f "$d/elements.conf" ] && echo "$d"; done
}

# Checks a published list on stdin: the price server's shape, at least two
# assets (never one asset alone), every key a 64-hex id, every rate an integer
# in (0, 1e18], made within the last ten minutes, and nothing else in it.
check_list() {
  python3 -I -c '
import json, sys, time
d = json.load(sys.stdin)
r = d.get("rates"); u = d.get("updated")
assert set(d) == {"updated", "rates"}, "the list carries more than the rates and their time: %s" % sorted(d)
assert isinstance(r, dict) and len(r) >= 2, "fewer than two assets"
assert isinstance(u, (int, float)), "no updated time"
for k, v in r.items():
    assert len(k) == 64 and all(c in "0123456789abcdef" for c in k), "bad id " + k[:20]
    assert isinstance(v, int) and 0 < v <= 10**18, "bad rate for " + k[:16]
age = time.time() - u
assert -600 < age < 600, "made %d s ago" % age
print(" ".join(sorted(r)))
'
}

# Removes the keys a price server refuses from a JSON config, in place, keeping
# its owner and mode, and saves what it removed (once) to $2. Prints what it did.
strip_config() {
  python3 -I - "$1" "$2" $REMOVED_KEYS <<'PY'
import json, os, sys
path, saved, keys = sys.argv[1], sys.argv[2], sys.argv[3:]
st = os.stat(path)
cfg = json.load(open(path))
gone = {k: cfg.pop(k) for k in keys if k in cfg}
if not gone:
    print("%s holds none of %s" % (path, " ".join(keys))); sys.exit(0)
if not os.path.exists(saved):
    # The file as it was, byte for byte, so the way back can restore it exactly.
    fd = os.open(saved + ".orig", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f: f.write(open(path, "rb").read())
    fd = os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(gone, f)
tmp = path + ".cutover-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, st.st_mode & 0o777)
with os.fdopen(fd, "w") as f: json.dump(cfg, f, indent=2); f.write("\n")
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, path)
print("%s: removed %s (kept in %s)" % (path, " ".join(sorted(gone)), saved))
PY
}

# The way back for strip_config: puts the saved keys back into the config as it
# is now, without touching anything else in it. When nothing else in it changed
# since, that is the file as it was, and its original bytes are written back.
unstrip_config() {
  [ -f "$2" ] || { echo "$1: nothing of it was removed"; return 0; }
  python3 -I - "$1" "$2" <<'PY'
import json, os, sys
path, saved = sys.argv[1], sys.argv[2]
st = os.stat(path)
cfg = json.load(open(path)); back = json.load(open(saved))
cfg.update(back)
orig = open(saved + ".orig", "rb").read() if os.path.exists(saved + ".orig") else None
same = orig is not None and json.loads(orig) == cfg
tmp = path + ".cutover-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, st.st_mode & 0o777)
with os.fdopen(fd, "wb") as f:
    f.write(orig if same else (json.dumps(cfg, indent=2) + "\n").encode())
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, path)
print("%s: put back %s%s" % (path, " ".join(sorted(back)), " (the file as it was, byte for byte)" if same else ""))
PY
  rm -f "$2" "$2.orig"
}

# Adds "feepriceserver=<url>" under a marker line at the top of the
# configuration (its default section, before any [section]), keeping owner and
# mode.
conf_connect() {
  local conf=$1 url=$2
  if grep -qxF "$MARK" "$conf"; then
    grep -qxF "feepriceserver=$url" "$conf" || { echo "$conf carries the marker with another address" >&2; return 1; }
    echo "$conf: already connected to $url"; return 0
  fi
  if grep -qE '^(no)?feepriceserver=' "$conf"; then
    echo "$conf already sets feepriceserver by hand; leaving it" >&2; return 1
  fi
  local tmp=$conf.cutover-tmp
  { printf '%s\n%s\n' "$MARK" "feepriceserver=$url"; cat "$conf"; } > "$tmp"
  chown --reference="$conf" "$tmp"; chmod --reference="$conf" "$tmp"
  mv -f "$tmp" "$conf"
  echo "$conf: connected to $url"
}

conf_disconnect() {
  local conf=$1
  grep -qxF "$MARK" "$conf" || { echo "$conf: nothing of this script's"; return 0; }
  local tmp=$conf.cutover-tmp
  awk -v m="$MARK" 'skip{skip=0; if ($0 ~ /^feepriceserver=/) next} $0==m{skip=1; next} {print}' "$conf" > "$tmp"
  chown --reference="$conf" "$tmp"; chmod --reference="$conf" "$tmp"
  mv -f "$tmp" "$conf"
  echo "$conf: line removed"
}

fleet_running() {
  local procs d
  procs=$(ps -C sequentiad -o args= || true)
  for d in $(public_datadirs); do grep -qF -- "-datadir=$d" <<< "$procs" && echo "$d"; done
  systemctl is-active --quiet "$B_NODE_UNIT" && echo "$B_NODE_UNIT" || true
}

wait_served() {
  local url=$1 body
  for _ in $(seq 1 90); do
    body=$(curl -fsS --max-time 10 "$url" 2>/dev/null) && check_list <<< "$body" >/dev/null 2>&1 && { check_list <<< "$body"; return 0; }
    sleep 2
  done
  echo "$url serves no valid list of two or more assets after 180 s" >&2
  return 1
}

# The RPC port a node's configuration sets (the last rpcport= line, in any
# section); empty when it sets none.
conf_rpcport() { awk -F= '/^[[:space:]]*rpcport[[:space:]]*=/ {gsub(/[[:space:]]/, "", $2); p=$2} END {print p}' "$1"; }

# Every node a price server's configuration writes to today, matched to the
# data directories this script connects ("<port> <datadir>" per line on stdin).
# Prints each match; fails on a node it writes to that matches none, and on one
# not on this machine. Never prints a login.
match_written_nodes() { # <price-server config> <label>
  python3 -I -c '
import json, sys, urllib.parse
cfg = json.load(open(sys.argv[1])); label = sys.argv[2]
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
        print("  %s writes to the node on RPC port %s, which is none of the nodes this script connects" % (label, port)); bad += 1
    else:
        print("  %s writes to port %s: %s" % (label, port, " ".join(dirs[port])))
print("  %s writes to %d node(s); %d match none" % (label, len(entries), bad))
sys.exit(1 if bad else 0)
' "$1" "$2"
}

# The price server's code a unit runs once this script's drop-in is gone: the
# last ExecStart= of the unit and its other drop-ins, without publish.conf.
unit_code_without_ours() {
  local all
  all=$(systemctl cat "$1" 2>/dev/null) || return 1
  python3 -I -c '
import shlex, sys
cur, exe = "", None
for line in sys.argv[1].split("\n"):
    if line.startswith("# /"): cur = line[2:].strip(); continue
    if cur.endswith("/publish.conf"): continue
    if line.startswith("ExecStart="):
        exe = line[len("ExecStart="):].strip() or None
code = [a for a in shlex.split(exe or "") if a.endswith("price_server.py")]
if not code: sys.exit(1)
print(code[0])
' "$all"
}

# Whether price-server code accepts a configuration (the file as it is, with
# the keys this script removed put back): the code's own check, run on it.
# Prints the code's refusal, never the configuration.
code_accepts() { # <price_server.py> <config> [<removed keys json>]
  # -B: loading the code leaves no bytecode cache beside it.
  python3 -I -B -c '
import importlib.util, json, os, sys
code, path = sys.argv[1], sys.argv[2]
saved = sys.argv[3] if len(sys.argv) > 3 else ""
cfg = json.load(open(path))
if saved and os.path.exists(saved): cfg.update(json.load(open(saved)))
spec = importlib.util.spec_from_file_location("price_server_under_check", code)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
check = getattr(m, "check_config", None)
if check is None: sys.exit(0)
try:
    check(cfg)
except Exception as e:
    print(str(e).split("\n")[0][:300]); sys.exit(1)
' "$@"
}

# Its own directory, created once; an existing one is never changed.
[ -d "$STATE" ] || install -d -m 700 "$STATE"
[ "$(stat -c %a "$STATE")" = 700 ]
echo "$(public_datadirs | wc -l) public nodes ($(fleet_running | grep -vcxF "$B_NODE_UNIT" || true) running), and the second operator's node"

# What the way back needs, taken once before the cutover changes anything: the
# checkout the network's price server's code runs from and its commit, and the
# directory the second operator's price server's code is in.
record_before() {
  local code clone
  if [ ! -s "$STATE/node-clone.before" ] && code=$(unit_code_without_ours "$PS_UNIT") \
     && code_accepts "$code" "$PS_CONFIG" > /dev/null \
     && clone=$(git -C "$(dirname "$code")" rev-parse --show-toplevel 2>/dev/null); then
    echo "$clone $(git -C "$clone" rev-parse HEAD)" > "$STATE/node-clone.before"
  fi
  if [ ! -s "$STATE/second-price-server-dir.before" ] && [ ! -f "$B_PS_DROPIN_DIR/publish.conf" ]; then
    readlink -f "$B_PS_DIR" > "$STATE/second-price-server-dir.before"
    # A bundle's link, as it is written (a bundle compares the text).
    [ -L "$(dirname "$B_PS_DIR")" ] && readlink "$(dirname "$B_PS_DIR")" > "$STATE/second-bundle-link.before"
  fi
  return 0
}

# The way back to the release a bundle link pointed at before (prints nothing
# when the link is not a symbolic link or has not moved).
b_link_back() {
  local bl was
  bl=$(dirname "$B_PS_DIR")
  [ -L "$bl" ] && [ -s "$STATE/second-bundle-link.before" ] || return 0
  was=$(cat "$STATE/second-bundle-link.before")
  [ "$(readlink "$bl")" != "$was" ] || return 0
  echo "  the bundle moved $bl to $(readlink "$bl"); point it back first (its node then runs the release it ran before, from its next start):"
  echo "    ln -sfn $was $bl"
}

if [ "${BACK:-0}" = 1 ]; then
  step "back: the fleet must be stopped"
  running=$(fleet_running)
  [ -z "$running" ] || { echo "still running: $running" >&2; false; }

  step "back: the code each price server will run accepts what is put back"
  # Checked before anything changes. A release moves the code under a price
  # server (the node checkout the network's runs from; the second operator's
  # bundle link), and code that refuses a node login would not start again.
  refuse=""
  code=$(unit_code_without_ours "$PS_UNIT") || { echo "cannot read the code $PS_UNIT runs" >&2; false; }
  if ! why=$(code_accepts "$code" "$PS_CONFIG" "$STATE/network-price-server.removed.json"); then
    echo "  the network's price server would run $code, which refuses its configuration with the node logins put back: $why"
    clone=$(git -C "$(dirname "$code")" rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$clone" ] && [ -s "$STATE/node-clone.before" ] && [ "$(cut -d' ' -f1 "$STATE/node-clone.before")" = "$clone" ]; then
      was=$(cut -d' ' -f2 "$STATE/node-clone.before")
      echo "  $clone is at $(git -C "$clone" rev-parse HEAD); it was at $was before the cutover. Move it back first:"
      echo "    git -C $clone checkout -q --detach $was"
    else
      echo "  move $code back to the code it ran before the cutover first"
    fi
    refuse=1
  fi
  if [ -d "$STATE/second-price-server-code" ]; then
    # The kept code goes back where it came from, never over another release's.
    bcode=$STATE/second-price-server-code/price_server.py
    moved=$(b_link_back)
    [ -z "$moved" ] || { echo "  the second operator's price-server code kept here came from a release its bundle has moved off"; echo "$moved"; refuse=1; }
  else
    bcode=$B_PS_DIR/price_server.py
  fi
  if ! why=$(code_accepts "$bcode" "$B_PS_CONFIG" "$STATE/second-price-server.removed.json"); then
    echo "  the second operator's price server would run $bcode, which refuses its configuration with the node login put back: $why"
    moved=$(b_link_back)
    if [ -n "$moved" ]; then echo "$moved"; else echo "  move $bcode back to the code it ran before the cutover first"; fi
    refuse=1
  fi
  [ -z "$refuse" ] || { echo "back refused; nothing was changed. Do the steps above, then BACK=1 again." >&2; false; }
  echo "  both accept it"
  step "back: the nodes' configuration lines"
  for d in $(public_datadirs); do conf_disconnect "$d/elements.conf"; done
  conf_disconnect "$B_NODE_CONF"
  step "back: the network's price server"
  rm -f "$PS_DROPIN_DIR/publish.conf"
  # Directories it created, and what is in them of its own; nothing else.
  [ -f "$STATE/created-ps-dropin-dir" ] && { rmdir "$PS_DROPIN_DIR"; rm -f "$STATE/created-ps-dropin-dir"; }
  [ -f "$STATE/created-pubdir" ] && { rm -f "$PUBFILE" "$PUBFILE.tmp"; rmdir "$PUBDIR"; rm -f "$STATE/created-pubdir"; }
  unstrip_config "$PS_CONFIG" "$STATE/network-price-server.removed.json"
  step "back: the second operator's price server"
  rm -f "$B_PS_DROPIN_DIR/publish.conf"
  [ -f "$STATE/created-b-dropin-dir" ] && { rmdir "$B_PS_DROPIN_DIR"; rm -f "$STATE/created-b-dropin-dir"; }
  unstrip_config "$B_PS_CONFIG" "$STATE/second-price-server.removed.json"
  if [ -d "$STATE/second-price-server-code" ]; then
    cp -p "$STATE/second-price-server-code/"* "$B_PS_DIR/"
    rm -rf "${STATE:?}/second-price-server-code"
  fi
  systemctl daemon-reload
  systemctl restart "$PS_UNIT" "$B_PS_UNIT"
  sleep 5
  systemctl is-active --quiet "$PS_UNIT"; systemctl is-active --quiet "$B_PS_UNIT"
  rm -f "$STATE/node-clone.before" "$STATE/second-price-server-dir.before" "$STATE/second-bundle-link.before"
  echo "back done: both price servers run as before; start the fleet with the binaries it ran before"
  exit 0
fi

step "check the box"
command -v curl >/dev/null; command -v python3 >/dev/null
[ -r "$PS_CONFIG" ] && [ -r "$B_PS_CONFIG" ] && [ -w "$B_NODE_CONF" ]
for d in $(public_datadirs); do [ -w "$d/elements.conf" ]; done

# The nodes the price servers write to today, against the nodes this script
# connects.
check_written_nodes() {
  local d p pairs="" b_port
  for d in $(public_datadirs); do p=$(conf_rpcport "$d/elements.conf"); pairs+="${p:-none} $d"$'\n'; done
  match_written_nodes "$PS_CONFIG" "the network's price server" <<< "$pairs" \
    || { echo "a node the network's price server writes to would lose its list: add it to this script's nodes, or take it out of node_rpcs" >&2; return 1; }
  b_port=$(conf_rpcport "$B_NODE_CONF")
  match_written_nodes "$B_PS_CONFIG" "the second operator's price server" <<< "${b_port:-none} $B_NODE_CONF" \
    || { echo "the second operator's price server writes to a node this script does not connect" >&2; return 1; }
}

STAGE=${STAGE:-}
[ "${TRIAL:-0}" = 1 ] && STAGE=trial
case "$STAGE" in
before|trial)
  step "the nodes the price servers write to today, against the nodes this script connects"
  check_written_nodes
  step "the assets the public nodes accept now (node000, by its own cookie)"
  live=$("$CLI" -datadir="$COMMITTEE_ROOT/node000" getfeeassetinfo | python3 -I -c 'import json,sys; print(" ".join(sorted(k for k,v in json.load(sys.stdin).items() if v["accepted"])))')
  echo "$(wc -w <<< "$live") assets"
  [ "$STAGE" = before ] && { printf '%s\n' "$live" > "$STATE/assets.before"; echo "kept in $STATE/assets.before"; }
  [ "$STAGE" = before ] && record_before
  step "the price server's code: origin/master"
  git -C "$NODE_CLONE" fetch -q origin master
  COMMIT=$(git -C "$NODE_CLONE" rev-parse origin/master)
  code=$(git -C "$NODE_CLONE" show "$COMMIT:contrib/price-server/price_server.py")
  grep -q '"/feewhitelist"' <<< "$code" || { echo "origin/master ($COMMIT) does not publish at /feewhitelist yet" >&2; false; }
  if [ "$STAGE" = trial ]; then
    step "trial: one round of the new code with the node logins removed, into a temporary file"
    T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
    printf '%s\n' "$code" > "$T/price_server.py"
    install -m 600 "$PS_CONFIG" "$T/config.json"
    strip_config "$T/config.json" "$T/removed.json" >/dev/null
    python3 -I "$T/price_server.py" --config "$T/config.json" --once --publish-file "$T/list.json" > "$T/out.log" 2>&1 \
      || { tail -5 "$T/out.log"; false; }
    if [ -s "$T/list.json" ]; then
      ours=$(check_list < "$T/list.json")
      [ "$ours" = "$live" ] && echo "the same $(wc -w <<< "$ours") assets as the public nodes accept now" \
        || { echo "differs from the public nodes' list:"; echo " new:   $ours"; echo " nodes: $live"; }
    else
      echo "its first round published nothing (it waits a round for max_change_factor's baselines); STAGE=stopped waits for it"
    fi
    for d in $(public_datadirs); do grep -qE '^(no)?feepriceserver=' "$d/elements.conf" && echo "  $d sets feepriceserver by hand: STAGE=stopped will refuse"; done
    ss -ltn | grep -q ":$B_PS_PORT " && { echo "port $B_PS_PORT is taken: set B_PS_PORT" >&2; false; }
    echo "trial done; nothing changed"
  fi
  exit 0
  ;;
stopped)
  step "every public node and the second operator's node is stopped"
  running=$(fleet_running)
  [ -z "$running" ] || { echo "still running: $running" >&2; false; }
  record_before

  step "the network's price server: code at origin/master, in its own checkout"
  git -C "$NODE_CLONE" fetch -q origin master
  COMMIT=$(git -C "$NODE_CLONE" rev-parse origin/master)
  if [ -d "$SRC" ]; then LIVE=$(git -C "$SRC" rev-parse HEAD); else LIVE=$(git -C "$NODE_CLONE" rev-parse HEAD); fi
  if ! git -C "$NODE_CLONE" merge-base --is-ancestor "$LIVE" "$COMMIT" && [ "${ALLOW_BACK:-0}" != 1 ]; then
    echo "origin/master ($COMMIT) does not contain the code the price server runs now ($LIVE); ALLOW_BACK=1 to go back" >&2; false
  fi
  if [ -d "$SRC" ]; then git -C "$SRC" checkout -q --detach "$COMMIT"; else git -C "$NODE_CLONE" worktree add -q --detach "$SRC" "$COMMIT"; fi
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ]

  step "the network's price server: no node logins, publishing to $PUBFILE"
  strip_config "$PS_CONFIG" "$STATE/network-price-server.removed.json"
  [ -d "$PUBDIR" ] || { install -d -m 755 "$PUBDIR"; touch "$STATE/created-pubdir"; }
  [ -d "$PS_DROPIN_DIR" ] || { install -d -m 755 "$PS_DROPIN_DIR"; touch "$STATE/created-ps-dropin-dir"; }
  printf '[Service]\n# fee-whitelist-cutover: publish the list; write to no node.\nExecStart=\nExecStart=/usr/bin/python3 %s --config %s --publish-file %s\n' \
    "$SRC/contrib/price-server/price_server.py" "$PS_CONFIG" "$PUBFILE" > "$STATE/publish.conf.new"
  install -m 644 "$STATE/publish.conf.new" "$PS_DROPIN_DIR/publish.conf"

  step "the second operator's price server: the same code, no node login, publishing at $B_URL"
  if ! cmp -s "$SRC/contrib/price-server/price_server.py" "$B_PS_DIR/price_server.py"; then
    if [ ! -d "$STATE/second-price-server-code" ]; then
      install -d -m 700 "$STATE/second-price-server-code"
      cp -p "$B_PS_DIR/"* "$STATE/second-price-server-code/"
    fi
    for f in price_server.py config.example.json README.md ORACLE-AND-REFERENCE-DESIGN.md; do
      install -m "$(stat -c %a "$B_PS_DIR/$f" 2>/dev/null || echo 644)" "$SRC/contrib/price-server/$f" "$B_PS_DIR/$f"
    done
  fi
  strip_config "$B_PS_CONFIG" "$STATE/second-price-server.removed.json"
  # Before its drop-in exists the second operator's price server serves no
  # port, so anything on this one is something else's.
  if [ ! -f "$B_PS_DROPIN_DIR/publish.conf" ] && ss -ltn | grep -q ":$B_PS_PORT "; then
    echo "port $B_PS_PORT is taken by something else: set B_PS_PORT" >&2; false
  fi
  [ -d "$B_PS_DROPIN_DIR" ] || { install -d -m 755 "$B_PS_DROPIN_DIR"; touch "$STATE/created-b-dropin-dir"; }
  printf '[Service]\n# fee-whitelist-cutover: publish the list on loopback; write to no node.\nExecStart=\nExecStart=/usr/bin/python3 -I %s/price_server.py --config %s --ui-port %s --ui-host 127.0.0.1\n' \
    "$B_PS_DIR" "$B_PS_CONFIG" "$B_PS_PORT" > "$STATE/b-publish.conf.new"
  install -m 644 "$STATE/b-publish.conf.new" "$B_PS_DROPIN_DIR/publish.conf"

  step "restart both price servers, always (new code, new settings)"
  systemctl daemon-reload
  systemctl restart "$PS_UNIT" "$B_PS_UNIT"
  sleep 3
  systemctl is-active --quiet "$PS_UNIT"; systemctl is-active --quiet "$B_PS_UNIT"

  step "the network's list: written, and served at $NETWORK_URL"
  for _ in $(seq 1 90); do [ -s "$PUBFILE" ] && break; sleep 2; done
  ours=$(check_list < "$PUBFILE")
  echo "$(wc -w <<< "$ours") assets in $PUBFILE"
  if [ -f "$STATE/assets.before" ]; then
    [ "$ours" = "$(cat "$STATE/assets.before")" ] && echo "the same assets the public nodes accepted before the stop" \
      || { echo "note: differs from the public nodes' list before the stop:"; echo " now:    $ours"; echo " before: $(cat "$STATE/assets.before")"; }
  fi
  if ! curl -fsS --max-time 10 "$NETWORK_URL" >/dev/null 2>&1; then
    step "the Caddy route: this repository's origin/main, fast-forward only, nothing else changing"
    git -C "$OPS" fetch -q origin main
    OPS_COMMIT=$(git -C "$OPS" rev-parse origin/main)
    git -C "$OPS" merge-base --is-ancestor HEAD "$OPS_COMMIT" \
      || { echo "origin/main does not contain the box's checkout ($(git -C "$OPS" rev-parse HEAD))" >&2; false; }
    newcaddy=$(git -C "$OPS" show "$OPS_COMMIT:caddy/Caddyfile")
    grep -q 'handle /feewhitelist' <<< "$newcaddy" || { echo "origin/main's Caddyfile has no /feewhitelist route" >&2; false; }
    old_lines=$(grep -v '^[[:space:]]*#' /etc/caddy/Caddyfile || true)
    new_lines=$(grep -v '^[[:space:]]*#' <<< "$newcaddy" || true)
    changed=$(diff <(printf '%s\n' "$old_lines") <(printf '%s\n' "$new_lines") || true)
    other=$(grep '^[<>]' <<< "$changed" \
            | grep -v -E '^> 	(handle /feewhitelist \{|	root \* /srv/feewhitelist|	rewrite \* /feewhitelist.json|	header Cache-Control no-cache|	file_server|\})$' || true)
    [ -z "$other" ] || { echo "the Caddyfile on origin/main differs from the installed one in more than the /feewhitelist route:" >&2; echo "$other" >&2; false; }
    git -C "$OPS" checkout -q --detach "$OPS_COMMIT"
    "$OPS/bin/apply-caddy.sh"
  fi
  wait_served "$NETWORK_URL" > /dev/null
  admin=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$NETWORK_URL/admin")
  [ "$admin" != 200 ] || { echo "$NETWORK_URL/admin answers 200" >&2; false; }

  step "the second operator's list, served at $B_URL"
  b=$(wait_served "$B_URL"); echo "$(wc -w <<< "$b") assets"

  step "every node's configuration: connected to its price server"
  for d in $(public_datadirs); do conf_connect "$d/elements.conf" "$NETWORK_URL"; done
  conf_connect "$B_NODE_CONF" "$B_URL"
  echo "done: start the fleet (and $B_NODE_UNIT), then run STAGE=started"
  ;;
started)
  step "every node connected, with a list of two or more assets"
  bad=0
  check_node() { # name, cli command..., expected url
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
  for d in $(public_datadirs); do check_node "$(basename "$d")" "$NETWORK_URL" "$CLI" -datadir="$d" || bad=$((bad+1)); done
  check_node "second operator" "$B_URL" runuser -u "$B_USER" -- "$B_CLI" -conf="$B_NODE_CONF" -datadir="$B_DATADIR" || bad=$((bad+1))
  [ "$bad" = 0 ] || { echo "$bad node(s) without their list" >&2; false; }
  echo "done: every node reads its price server's list; no price server writes to a node"
  ;;
*)
  echo "set STAGE=before, STAGE=stopped or STAGE=started (or TRIAL=1, BACK=1)" >&2; exit 2;;
esac
