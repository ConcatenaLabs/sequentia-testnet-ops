#!/usr/bin/env bash
# deploy-web-wallet.test.sh: bin/deploy-web-wallet.sh rehearsed in a container, with the box's own
# Node (22.11.0, the official build at a pinned SHA-256), which loads node:sqlite only with
# --experimental-sqlite. The web wallet and ops checkouts are cloned from origins of commits made
# here; a stand-in `systemctl` (SYSTEMCTL) loads the LSP's unit file only on daemon-reload, as
# systemd does, and runs its ExecStart. The stand-in LSP answers /health with its version, its node
# options and whether it loaded node:sqlite; the new commit's loads it, as the name store does.
# Runs:
#   0. DRY=1 towards the new commit and the unit with the flag: says it would install the unit and
#      that its node loads node:sqlite; changes nothing.
#   1. the new commit and the unit with the flag: the unit is installed (daemon-reload), the wallet
#      moves, the LSP restarts with --experimental-sqlite and loads node:sqlite;
#   2. pasted again: nothing installed, moved or restarted;
#   3. the rollback line it printed (COMMIT=<old> ALLOW_BACK=1): the old code runs under the
#      flagged unit and answers;
#   4. an ops commit whose unit drops the flag: refused before the wallet moves, the unit file put
#      back as it was, the LSP still running the code and unit it ran;
#   5. DRY=1 towards that commit: says it would refuse, and why.
# Needs docker and curl; uses the node:22-bookworm image. NODE_TARBALL=<file> uses a tarball already
# fetched (checked against the same SHA-256).  bin/deploy-web-wallet.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
V=v22.11.0
SHA=83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72   # node-v22.11.0-linux-x64.tar.xz, nodejs.org SHASUMS256.txt
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tarball=${NODE_TARBALL:-}
if [ -z "$tarball" ]; then
  tarball=$tmp/node-$V-linux-x64.tar.xz
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz" -o "$tarball"
fi
echo "$SHA  $tarball" | sha256sum -c --quiet - || { echo "FAIL: $tarball is not node $V as published"; exit 1; }
mkdir "$tmp/node"; tar -xJf "$tarball" -C "$tmp/node" --strip-components=1
docker run --rm -i --name "deploy-web-wallet-test-$$" -v "$here/deploy-web-wallet.sh:/deploy.sh:ro" -v "$tmp/node:/opt/node2211:ro" node:22-bookworm bash -s <<'IN'
set -euo pipefail
N=/opt/node2211/bin/node
UNITF=/etc/systemd/system/lsp-b5b1.service
fail() { echo "FAIL: $*"; tail -n 20 /run/fake/lsp.log 2>/dev/null; exit 1; }
"$N" --version | grep -qx v22.11.0 || fail "not node 22.11.0"
mkdir -p /run/lock /run/fake /etc/caddy /etc/systemd/system /root/sequentia
git config --global user.email t@example.org; git config --global user.name t; git config --global init.defaultBranch main

# The web wallet: OLD (an LSP without the name store) and NEW (one that loads node:sqlite).
mkdir /src-web && cd /src-web && git init -q
lsp() { # $1 version, $2 whether it loads the name store
  mkdir -p tooling/lsp
  local imp='' use='false'
  if [ -n "${2:-}" ]; then imp="import { sqlite } from './lnaddr-store.mjs'"; use='sqlite'; fi
  cat > tooling/lsp/lsp-server.mjs <<JS
import { createServer } from 'node:http'
$imp
const loaded = $use
createServer((q, r) => r.end(JSON.stringify({ ok: true, version: '$1', execArgv: process.execArgv, sqlite: loaded }))).listen(9981, '127.0.0.1')
JS
  if [ -n "${2:-}" ]; then
    cat > tooling/lsp/lnaddr-store.mjs <<'JS'
import { createRequire } from 'node:module'
let ok = false; try { createRequire(import.meta.url)('node:sqlite'); ok = true } catch {}
export const sqlite = ok
JS
  fi
  echo "<html>$1</html>" > index.html
  git add -A; git commit -qm "$1"; git rev-parse HEAD
}
OLD=$(lsp old); NEW=$(lsp new store)
git clone -q --bare /src-web /srv/web.git
git clone -q /srv/web.git /root/sequentia/sequentia-web-wallet
git -C /root/sequentia/sequentia-web-wallet checkout -q --detach "$OLD"

# Ops: the unit as the box has it (no flag), with the flag, then a mistaken edit dropping it.
mkdir /src-ops && cd /src-ops && git init -q
unit() { # $1 node options
  mkdir -p systemd caddy; echo ':80 { respond "x" }' > caddy/Caddyfile
  printf '[Unit]\nDescription=stand-in LSP\n[Service]\nExecStart=%s%s /root/sequentia/sequentia-web-wallet/tooling/lsp/lsp-server.mjs\nRestart=always\n' "$N" "${1:+ $1}" > systemd/lsp-b5b1.service
  git add -A; git commit -qm "unit ${1:-plain}"; git rev-parse HEAD
}
OPS_OLD=$(unit ""); OPS_FLAG=$(unit --experimental-sqlite); OPS_BAD=$(unit "")
git clone -q --bare /src-ops /srv/ops.git
git clone -q /srv/ops.git /root/sequentia/sequentia-testnet-ops
git -C /root/sequentia/sequentia-testnet-ops checkout -q --detach "$OPS_OLD"
cp /root/sequentia/sequentia-testnet-ops/caddy/Caddyfile /etc/caddy/Caddyfile
cp /root/sequentia/sequentia-testnet-ops/systemd/lsp-b5b1.service "$UNITF"

cat > /usr/local/bin/fake-systemctl <<'SC'
#!/bin/bash
# A stand-in for systemctl and the one unit: the unit file is read on daemon-reload only, and a
# restart runs the ExecStart read then.
L=/run/fake/loaded.service
argv() { grep -E '^ExecStart=' "$L" | tail -n 1 | cut -d= -f2-; }
active() { [ -f /run/fake/pid ] && kill -0 "$(cat /run/fake/pid)" 2>/dev/null; }
echo "$*" >> /run/fake/calls
case "$1" in
  daemon-reload) cp /etc/systemd/system/lsp-b5b1.service "$L" ;;
  cat) cat "$L" ;;
  list-units) echo "lsp-b5b1.service loaded active running stand-in" ;;
  is-active) active ;;
  show) case "$3" in
      ExecStart) a=$(argv); echo "{ path=${a%% *} ; argv[]=$a ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }" ;;
      ExecMainStartTimestamp) cat /run/fake/started 2>/dev/null || echo n/a ;;
      MainPID) cat /run/fake/pid 2>/dev/null || echo 0 ;;
      FragmentPath) echo /etc/systemd/system/lsp-b5b1.service ;;
      *) echo ;;
    esac ;;
  restart) if active; then p=$(cat /run/fake/pid); kill -- -"$p" 2>/dev/null || kill "$p"; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; fi
    # shellcheck disable=SC2046
    setsid $(argv) >> /run/fake/lsp.log 2>&1 8>&- 9>&- & echo $! > /run/fake/pid
    date -u '+%a %Y-%m-%d %H:%M:%S UTC' > /run/fake/started
    echo restart >> /run/fake/restarts; sleep 1 ;;
  *) echo "fake-systemctl: $*" >&2; exit 1 ;;
esac
SC
chmod +x /usr/local/bin/fake-systemctl
fake-systemctl daemon-reload; fake-systemctl restart lsp-b5b1.service; : > /run/fake/restarts
sleep 1
health() { curl -sf http://127.0.0.1:9981/health; }
field() { health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j[process.argv[1]]))})' "$1"; }
wallet_head() { git -C /root/sequentia/sequentia-web-wallet rev-parse HEAD; }
restarts() { wc -l < /run/fake/restarts; }
reloads() { grep -c '^daemon-reload' /run/fake/calls; }
run() { # $1 log name, then VAR=value...
  local log=/tmp/run-$1.log; shift
  env "$@" SYSTEMCTL=fake-systemctl NODE=node SITE= LSP_LOCAL=http://127.0.0.1:9981/health APPLY_CADDY=false bash /deploy.sh > "$log" 2>&1
}
[ "$(field version)" = '"old"' ] || fail "the stand-in LSP did not start"

echo "--- 0. DRY=1: the unit with the flag, the new commit"
sum0=$(sha256sum "$UNITF"); r0=$(reloads)
run 0 DRY=1 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-0.log; fail "run 0 stopped"; }
grep -q 'DRY: would install systemd/lsp-b5b1.service' /tmp/run-0.log || { cat /tmp/run-0.log; fail "run 0: no word of the unit"; }
grep -q 'loads node:sqlite with its own options: /opt/node2211/bin/node --experimental-sqlite' /tmp/run-0.log || { cat /tmp/run-0.log; fail "run 0: the repository's unit not checked"; }
[ "$(sha256sum "$UNITF")" = "$sum0" ] && [ "$(reloads)" = "$r0" ] && [ "$(wallet_head)" = "$OLD" ] || fail "run 0 changed something"

echo "--- 1. the unit with the flag, the new commit"
run 1 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-1.log; fail "run 1 stopped"; }
grep -q '=== done ===' /tmp/run-1.log || fail "run 1 did not end"
grep -q 'installed systemd/lsp-b5b1.service over /etc/systemd/system/lsp-b5b1.service and reloaded systemd' /tmp/run-1.log || fail "run 1: unit not installed"
grep -q 'restarting: its unit was installed in this deploy' /tmp/run-1.log || fail "run 1: no restart for the unit"
[ "$(wallet_head)" = "$NEW" ] || fail "run 1: wallet not on NEW"
[ "$(field version)" = '"new"' ] && [ "$(field sqlite)" = true ] && [ "$(field execArgv)" = '["--experimental-sqlite"]' ] || fail "run 1: the LSP is not the new code with node:sqlite: $(health)"
cmp -s "$UNITF" /root/sequentia/sequentia-testnet-ops/systemd/lsp-b5b1.service || fail "run 1: installed unit is not the repository's"
back=$(sed -n "s/.*ssh seq '\(COMMIT=[0-9a-f]* ALLOW_BACK=1\) bash -s'.*/\1/p" /tmp/run-1.log)
[ "$back" = "COMMIT=$OLD ALLOW_BACK=1" ] || fail "run 1: rollback line not printed: '$back'"

echo "--- 2. pasted again"
n=$(restarts); r=$(reloads)
run 2 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-2.log; fail "run 2 stopped"; }
grep -q 'the installed unit (/etc/systemd/system/lsp-b5b1.service) is the repository' /tmp/run-2.log || fail "run 2: unit not seen as installed"
[ "$(restarts)" = "$n" ] && [ "$(reloads)" = "$r" ] || { cat /tmp/run-2.log; fail "run 2 restarted or reloaded"; }

echo "--- 3. the rollback line"
# shellcheck disable=SC2086
run 3 $back OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-3.log; fail "run 3 stopped"; }
grep -q '=== done ===' /tmp/run-3.log || fail "run 3 did not end"
[ "$(wallet_head)" = "$OLD" ] || fail "run 3: wallet not back on OLD"
[ "$(field version)" = '"old"' ] && [ "$(field execArgv)" = '["--experimental-sqlite"]' ] || fail "run 3: the old code does not run under the flagged unit: $(health)"

echo "--- 4. a unit without the flag: refused before the wallet moves"
pid=$(cat /run/fake/pid); sum=$(sha256sum "$UNITF"); n=$(restarts)
if run 4 COMMIT="$NEW" OPS_COMMIT="$OPS_BAD"; then cat /tmp/run-4.log; fail "run 4 was not refused"; fi
grep -q 'STOPPED in step "the LSP unit": the unit.s node cannot load node:sqlite with its own options (/opt/node2211/bin/node): Error \[ERR_UNKNOWN_BUILTIN_MODULE\]: No such built-in module: node:sqlite' /tmp/run-4.log || { cat /tmp/run-4.log; fail "run 4: not refused for node:sqlite"; }
grep -q 'put /etc/systemd/system/lsp-b5b1.service back as it was' /tmp/run-4.log || fail "run 4: the unit file was not put back"
[ "$(sha256sum "$UNITF")" = "$sum" ] || fail "run 4: the unit file differs from before"
grep -q -- '--experimental-sqlite' /run/fake/loaded.service || fail "run 4: systemd was left with the unit without the flag"
[ "$(wallet_head)" = "$OLD" ] || fail "run 4: the wallet moved"
[ "$(cat /run/fake/pid)" = "$pid" ] && [ "$(restarts)" = "$n" ] && [ "$(field version)" = '"old"' ] || fail "run 4: the LSP was touched"

echo "--- 5. DRY=1 towards that unit: says it would refuse"
r=$(reloads)
if run 5 DRY=1 COMMIT="$NEW" OPS_COMMIT="$OPS_BAD"; then cat /tmp/run-5.log; fail "run 5 did not refuse"; fi
grep -q 'cannot load node:sqlite' /tmp/run-5.log || { cat /tmp/run-5.log; fail "run 5: no reason"; }
[ "$(reloads)" = "$r" ] && [ "$(sha256sum "$UNITF")" = "$sum" ] || fail "run 5 changed something"
grep -hE 'installed systemd|loads node:sqlite|restarting|STOPPED|put /etc' /tmp/run-1.log /tmp/run-3.log /tmp/run-4.log | sed 's/^/  /'
echo "PASS: deploy-web-wallet.sh, 6 runs"
IN
