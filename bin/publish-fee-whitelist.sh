#!/usr/bin/env bash
# Publish the network's price server's fee whitelist at
# http://sequentiatestnet.com/feewhitelist, the address every testnet node is
# connected to by default. Run on the box, from a laptop:
#
#   git -C <ops checkout> fetch -q origin && git -C <ops checkout> show origin/main:bin/publish-fee-whitelist.sh | ssh seq 'bash -s'
#
#   TRIAL=1  runs the price server once, dry, into a temporary file, checks what
#            it would publish, and changes nothing.
#   BACK=1   undoes what this script did: removes the unit drop-in, the
#            published file and its directory and the price server's own
#            checkout, and restarts the price server as it ran before. The route
#            stays in the Caddyfile and answers 404 until it is reverted there.
#
# What it does:
#   1. moves a detached checkout of the node repository, /root/seq-price-server-src,
#      to origin/master, which must carry --publish-file and contain the code the
#      price server runs now (no rollback without ALLOW_BACK=1);
#   2. moves this repository's checkout on the box to origin/main (fast-forward
#      only) and installs systemd/seq-price-server.service.d/publish-file.conf,
#      so the price server runs from that checkout and writes the file;
#   3. installs the Caddyfile with bin/apply-caddy.sh, after checking that the
#      only difference from the installed one is the /feewhitelist route;
#   4. checks the result from outside: a published list, fresh, the same assets
#      the public nodes accept, and nothing of the price server's UI exposed.
# It can be pasted twice: every step checks before it changes anything.
set -Eeuo pipefail
exec 9> /run/lock/publish-fee-whitelist.lock
flock -n 9 || { echo "already running"; exit 0; }
STEP=start
trap 'echo "FAILED at step: $STEP" >&2' ERR
step() { STEP="$1"; echo "=== $1 ==="; }

NODE_CLONE=/root/sequentia/Sequentia
SRC=/root/seq-price-server-src
OPS=/root/sequentia/sequentia-testnet-ops
CONFIG=/root/price-demo/config.json
UNIT=seq-price-server.service
DROPIN_DIR=/etc/systemd/system/seq-price-server.service.d
DROPIN=$DROPIN_DIR/publish-file.conf
PUBDIR=/srv/feewhitelist
PUBFILE=$PUBDIR/feewhitelist.json
URL=http://sequentiatestnet.com/feewhitelist

# Checks a published list on stdin: the price server's shape, at least one
# asset, every key a 64-hex id and every rate an integer in (0, 1e18], fresh.
check_list() {
  python3 -I -c '
import json, sys, time
d = json.load(sys.stdin)
r = d.get("rates"); u = d.get("updated")
assert isinstance(r, dict) and r, "no rates"
assert isinstance(u, (int, float)), "no updated time"
for k, v in r.items():
    assert len(k) == 64 and all(c in "0123456789abcdef" for c in k), "bad id " + k[:20]
    assert isinstance(v, int) and 0 < v <= 10**18, "bad rate for " + k[:16]
age = time.time() - u
assert age < 600, "published %d s ago" % age
print("a published list of %d assets, %d s old" % (len(r), age))
'
}

# The assets the public nodes accept now, as hex ids (read with the price
# server's own node credentials, which are never printed).
node_assets() {
  python3 -I - "$CONFIG" <<'PY'
import base64, json, sys, urllib.request
n = json.load(open(sys.argv[1]))["node_rpcs"][0]
def rpc(m, p=[]):
    req = urllib.request.Request("http://%s:%d/" % (n["host"], n["port"]),
                                 data=json.dumps({"method": m, "params": p, "id": 1}).encode())
    req.add_header("Authorization", "Basic " + base64.b64encode(("%s:%s" % (n["user"], n["password"])).encode()).decode())
    return json.load(urllib.request.urlopen(req, timeout=15))["result"]
print(" ".join(sorted(k for k, v in rpc("getfeeassetinfo").items() if v["accepted"])))
PY
}

if [ "${BACK:-0}" = 1 ]; then
  step "back: the unit drop-in"
  if [ -f "$DROPIN" ]; then
    grep -q -- '--publish-file /srv/feewhitelist/feewhitelist.json' "$DROPIN" || { echo "$DROPIN is not this script's; leaving it" >&2; exit 1; }
    rm -f "$DROPIN"
    systemctl daemon-reload
    systemctl restart "$UNIT"
  fi
  step "back: the published file"
  rm -f "$PUBFILE" "$PUBFILE.tmp"
  [ -d "$PUBDIR" ] && rmdir "$PUBDIR"
  step "back: the price server's checkout"
  if [ -d "$SRC" ]; then git -C "$NODE_CLONE" worktree remove --force "$SRC"; fi
  step "back: check"
  sleep 5
  systemctl is-active --quiet "$UNIT"
  procs=$(ps -o args= -C python3)
  grep -q -- "$NODE_CLONE/contrib/price-server/price_server.py --config $CONFIG" <<< "$procs"
  echo "the price server runs as before, from $NODE_CLONE; $URL now answers 404"
  exit 0
fi

step "check the box"
systemctl is-active --quiet "$UNIT"
[ -r "$CONFIG" ]
command -v caddy >/dev/null

step "the price server's code: origin/master"
git -C "$NODE_CLONE" fetch -q origin master
COMMIT=$(git -C "$NODE_CLONE" rev-parse origin/master)
code=$(git -C "$NODE_CLONE" show "$COMMIT:contrib/price-server/price_server.py")
grep -q -- '--publish-file' <<< "$code" \
  || { echo "origin/master ($COMMIT) does not carry --publish-file yet" >&2; false; }
if [ -d "$SRC" ]; then LIVE=$(git -C "$SRC" rev-parse HEAD); else LIVE=$(git -C "$NODE_CLONE" rev-parse HEAD); fi
if ! git -C "$NODE_CLONE" merge-base --is-ancestor "$LIVE" "$COMMIT" && [ "${ALLOW_BACK:-0}" != 1 ]; then
  echo "origin/master ($COMMIT) does not contain the code the price server runs now ($LIVE); ALLOW_BACK=1 to go back" >&2
  false
fi
echo "deploying $COMMIT (running now: $LIVE)"

if [ "${TRIAL:-0}" = 1 ]; then
  step "trial: one dry poll into a temporary file"
  T=$(mktemp -d)
  git -C "$NODE_CLONE" show "$COMMIT:contrib/price-server/price_server.py" > "$T/price_server.py"
  python3 -I "$T/price_server.py" --config "$CONFIG" --once --dry-run --publish-file "$T/feewhitelist.json" > /dev/null
  check_list < "$T/feewhitelist.json"
  ours=$(python3 -I -c 'import json,sys; print(" ".join(sorted(json.load(open(sys.argv[1]))["rates"])))' "$T/feewhitelist.json")
  live=$(node_assets)
  [ "$ours" = "$live" ] && echo "the same assets as the public nodes accept now" \
    || { echo "differs from the public nodes' list:"; echo " file:  $ours"; echo " nodes: $live"; }
  rm -rf "$T"
  echo "trial done; nothing changed"
  exit 0
fi

step "the price server's checkout at $SRC"
if [ -d "$SRC" ]; then
  git -C "$SRC" checkout -q --detach "$COMMIT"
else
  git -C "$NODE_CLONE" worktree add -q --detach "$SRC" "$COMMIT"
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ]

step "this repository's checkout: origin/main, fast-forward only"
git -C "$OPS" fetch -q origin main
OPS_COMMIT=$(git -C "$OPS" rev-parse origin/main)
git -C "$OPS" merge-base --is-ancestor HEAD "$OPS_COMMIT" \
  || { echo "origin/main does not contain the box's checkout ($(git -C "$OPS" rev-parse HEAD))" >&2; false; }
newcaddy=$(git -C "$OPS" show "$OPS_COMMIT:caddy/Caddyfile")
grep -q 'handle /feewhitelist' <<< "$newcaddy" \
  || { echo "origin/main's Caddyfile has no /feewhitelist route yet" >&2; false; }
# Nothing but this route may change in the installed Caddyfile here: any other
# difference is somebody's change waiting to be applied on its own.
old_lines=$(grep -v '^[[:space:]]*#' /etc/caddy/Caddyfile || true)
new_lines=$(grep -v '^[[:space:]]*#' <<< "$newcaddy" || true)
changed=$(diff <(printf '%s\n' "$old_lines") <(printf '%s\n' "$new_lines") || true)
other=$(grep '^[<>]' <<< "$changed" \
        | grep -v -E '^> 	(handle /feewhitelist \{|	root \* /srv/feewhitelist|	rewrite \* /feewhitelist.json|	header Cache-Control no-cache|	file_server|\})$' || true)
if [ -n "$other" ]; then
  echo "the Caddyfile on origin/main differs from the installed one in more than the /feewhitelist route:" >&2
  echo "$other" >&2
  false
fi
git -C "$OPS" checkout -q --detach "$OPS_COMMIT"

step "the published file's directory"
[ -d "$PUBDIR" ] || install -d -m 755 "$PUBDIR"

step "the unit drop-in, and a restart of the price server"
if ! cmp -s "$OPS/systemd/seq-price-server.service.d/publish-file.conf" "$DROPIN"; then
  install -m 644 "$OPS/systemd/seq-price-server.service.d/publish-file.conf" "$DROPIN"
  systemctl daemon-reload
  systemctl restart "$UNIT"
fi
systemctl is-active --quiet "$UNIT"

step "wait for the first published list"
for _ in $(seq 1 60); do [ -s "$PUBFILE" ] && break; sleep 2; done
check_list < "$PUBFILE"

step "the Caddy route"
"$OPS/bin/apply-caddy.sh"

step "check from outside"
body=$(curl -fsS --max-time 15 "$URL")
check_list <<< "$body"
ours=$(python3 -I -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin)["rates"])))' <<< "$body")
live=$(node_assets)
[ "$ours" = "$live" ] || { echo "published: $ours"; echo "nodes:     $live"; echo "the published list is not the public nodes' list" >&2; false; }
admin=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/admin")
[ "$admin" != 200 ] || { echo "$URL/admin answers 200" >&2; false; }
echo "done: $URL publishes the network's price server's list, the same assets the public nodes accept"
