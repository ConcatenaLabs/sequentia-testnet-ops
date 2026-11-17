#!/usr/bin/env bash
# deploy-web-wallet.test.sh: bin/deploy-web-wallet.sh rehearsed in a container, with the box's own
# Node (22.11.0, the official build at a pinned SHA-256), which loads node:sqlite only with
# --experimental-sqlite, and the web wallet's real payment name service: the one deployed before
# the names' SQLite store (OLD_WEB) and the one with it (NEW_WEB), their files taken from the web
# wallet's repository. The checkouts are cloned from origins of commits made here, each commit a
# stand-in LSP that serves those names; a stand-in `systemctl` (SYSTEMCTL) loads the LSP's unit
# only on daemon-reload, as systemd does, and runs its ExecStart with its EnvironmentFile.
# Runs:
#   0. DRY=1 towards the new commit and origin/main's unit, which adds the flag and which the box's
#      ops checkout has not fetched: says it would install that unit and that its node loads
#      node:sqlite; changes nothing and fetches nothing into the checkout.
#   1. the new commit and the unit with the flag: the unit is installed, the wallet moves, the LSP
#      restarts with --experimental-sqlite and imports the names the old service held. Then names in
#      use, a released name and a moved-away name are made on it.
#   2. pasted again: nothing installed, moved or restarted;
#   3. the rollback line it printed, while the names file cannot be written: the LSP is stopped,
#      the export fails, the LSP runs again and the wallet does not move;
#   4. the rollback line: the LSP is stopped, its names exported, the old code started on them.
#      There every name keeps its key: the released and moved-away names are refused to another
#      key and give a payer no code, and a removed name is not handed back to its owner. Then the
#      old service makes a name, ends one and moves one, and two names change hands there: C
#      releases X and F takes it; D moves from Y to Y2 and G takes Y.
#   5. forward again: the new service takes back what the old one did; X is F's and Y is G's, their
#      payers get F's and G's codes, C holds no name (declined) and D holds Y2 only;
#   6. an ops commit whose unit drops the flag: refused before the wallet moves (a rollback here),
#      the unit file put back, the LSP and the names untouched;
#   7. DRY=1 towards that commit: says it would refuse, and why.
# No line of any run prints the LSP's environment file's other values.
# Needs docker, curl and git; uses the node:22-bookworm image. NODE_TARBALL=<file> uses a tarball
# already fetched (checked against the same SHA-256); WEB_REPO=<a local clone> reads the web
# wallet's files from it instead of GitHub.  bin/deploy-web-wallet.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
V=v22.11.0
SHA=83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72   # node-v22.11.0-linux-x64.tar.xz, nodejs.org SHASUMS256.txt
: "${WEB_REPO:=https://github.com/ConcatenaLabs/sequentia-web-wallet.git}"
: "${OLD_WEB:=aee65e858a14e58a6d95fb3be11056f027b3429d}"   # the name service before the SQLite store
: "${NEW_WEB:=0c1fa380fe3e937a8604541c20aac500fa6d703c}"   # the name service with it
# What the name service loads (tooling/lsp/lnaddr.mjs and its imports).
FILES="bolt11.js btc.js lnaddr.js name-stock.js pay-code.js receive-index.js word-name.js tooling/lsp/lnaddr.mjs tooling/lsp/lnaddr-store.mjs"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tarball=${NODE_TARBALL:-}
if [ -z "$tarball" ]; then
  tarball=$tmp/node-$V-linux-x64.tar.xz
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz" -o "$tarball"
fi
echo "$SHA  $tarball" | sha256sum -c --quiet - || { echo "FAIL: $tarball is not node $V as published"; exit 1; }
mkdir "$tmp/node"; tar -xJf "$tarball" -C "$tmp/node" --strip-components=1
src=$WEB_REPO
if [ ! -d "$src" ]; then
  src=$tmp/web; git init -q "$src"; git -C "$src" remote add origin "$WEB_REPO"
  git -C "$src" fetch -q --depth 1 --filter=blob:none origin "$OLD_WEB" "$NEW_WEB"
fi
for side in old new; do
  sha=$OLD_WEB; [ "$side" = new ] && sha=$NEW_WEB
  for f in $FILES; do
    git -C "$src" cat-file -e "$sha:$f" 2>/dev/null || continue
    mkdir -p "$tmp/trees/$side/$(dirname "$f")"; git -C "$src" show "$sha:$f" > "$tmp/trees/$side/$f"
  done
done
[ ! -e "$tmp/trees/old/tooling/lsp/lnaddr-store.mjs" ] && [ -e "$tmp/trees/new/tooling/lsp/lnaddr-store.mjs" ] || { echo "FAIL: OLD_WEB must lack the names store and NEW_WEB carry it"; exit 1; }
docker run --rm -i --name "deploy-web-wallet-test-$$" -v "$here/deploy-web-wallet.sh:/deploy.sh:ro" -v "$tmp/node:/opt/node2211:ro" -v "$tmp/trees:/trees:ro" node:22-bookworm bash -s <<'IN'
set -euo pipefail
N=/opt/node2211/bin/node
UNITF=/etc/systemd/system/lsp-b5b1.service
STORE=/root/sequentia/lsp/prov/lnaddr-names.json
SECRET=never-print-this-value
fail() { echo "FAIL: $*"; tail -n 20 /run/fake/lsp.log 2>/dev/null; exit 1; }
"$N" --version | grep -qx v22.11.0 || fail "not node 22.11.0"
mkdir -p /run/lock /run/fake /etc/caddy /etc/systemd/system /etc/sequentia /root/sequentia/lsp/prov
git config --global user.email t@example.org; git config --global user.name t; git config --global init.defaultBranch main
printf 'PROV_DIR=/root/sequentia/lsp/prov\nLSP_TOKEN=%s\n' "$SECRET" > /etc/sequentia/lsp-b5b1.env; chmod 600 /etc/sequentia/lsp-b5b1.env

# The web wallet: OLD and NEW, each the real name service with a stand-in LSP serving it.
mkdir /src-web && cd /src-web && git init -q
web() { # $1 old|new
  git rm -r -q --ignore-unmatch . >/dev/null; cp -r "/trees/$1/." .
  cat > tooling/lsp/lsp-server.mjs <<JS
import { createServer } from 'node:http'
import { makeLnaddr } from './lnaddr.mjs'
const storePath = process.env.LNADDR_STORE || (process.env.PROV_DIR ? process.env.PROV_DIR + '/lnaddr-names.json' : '')
const svc = makeLnaddr({ domain: 'sequentiatestnet.com', base: 'http://127.0.0.1:9981', storePath, log: (...a) => console.log(...a), netBurst: 1e6, nameBurst: 1e6, newBurst: 1e6 })
createServer(async (q, r) => {
  const u = new URL(q.url, 'http://x')
  if (u.pathname === '/health') return r.end(JSON.stringify({ ok: true, version: '$1', execArgv: process.execArgv, store: svc.store ? svc.store.kind : 'json' }))
  if (!(await svc.handle(q, r, u))) { r.writeHead(404); r.end('{}') }
}).listen(9981, '127.0.0.1')
JS
  echo "<html>$1</html>" > index.html
  git add -A; git commit -qm "$1"; git rev-parse HEAD
}
OLD=$(web old); NEW=$(web new)
git clone -q --bare /src-web /srv/web.git
git clone -q /srv/web.git /root/sequentia/sequentia-web-wallet
git -C /root/sequentia/sequentia-web-wallet checkout -q --detach "$OLD"

# Ops: the unit as the box has it (no flag), with the flag, then a mistaken edit dropping it.
mkdir /src-ops && cd /src-ops && git init -q
unit() { # $1 node options
  mkdir -p systemd caddy; echo ':80 { respond "x" }' > caddy/Caddyfile
  printf '[Unit]\nDescription=stand-in LSP\n[Service]\nEnvironmentFile=/etc/sequentia/lsp-b5b1.env\nExecStart=%s%s /root/sequentia/sequentia-web-wallet/tooling/lsp/lsp-server.mjs\nRestart=always\n' "$N" "${1:+ $1}" > systemd/lsp-b5b1.service
  git add -A; git commit -qm "unit ${1:-plain}"; git rev-parse HEAD
}
OPS_OLD=$(unit "")
git clone -q --bare /src-ops /srv/ops.git
git clone -q /srv/ops.git /root/sequentia/sequentia-testnet-ops
git -C /root/sequentia/sequentia-testnet-ops checkout -q --detach "$OPS_OLD"
# Pushed after the box's clone, as on the box: origin/main moves to the unit with the flag, which the
# box's checkout has not fetched; the mistaken edit is on another branch.
OPS_FLAG=$(unit --experimental-sqlite); OPS_BAD=$(unit "")
git push -q /srv/ops.git "$OPS_FLAG:refs/heads/main" "$OPS_BAD:refs/heads/later"
cp /root/sequentia/sequentia-testnet-ops/caddy/Caddyfile /etc/caddy/Caddyfile
cp /root/sequentia/sequentia-testnet-ops/systemd/lsp-b5b1.service "$UNITF"

cat > /usr/local/bin/fake-systemctl <<'SC'
#!/bin/bash
# A stand-in for systemctl and the one unit: the unit file is read on daemon-reload only, and a
# start runs the ExecStart read then, with its EnvironmentFile.
L=/run/fake/loaded.service
argv() { grep -E '^ExecStart=' "$L" | tail -n 1 | cut -d= -f2-; }
envfile() { grep -E '^EnvironmentFile=' "$L" | tail -n 1 | cut -d= -f2-; }
active() { [ -f /run/fake/pid ] && kill -0 "$(cat /run/fake/pid)" 2>/dev/null; }
stop() { if active; then p=$(cat /run/fake/pid); kill -- -"$p" 2>/dev/null || kill "$p"; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; fi; rm -f /run/fake/pid; }
launch() {
  # shellcheck disable=SC2046
  ( set -a; e=$(envfile); [ -z "$e" ] || . "$e"; set +a; exec setsid $(argv) ) >> /run/fake/lsp.log 2>&1 8>&- 9>&- &
  echo $! > /run/fake/pid
  date -u '+%a %Y-%m-%d %H:%M:%S UTC' > /run/fake/started
  for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:9981/health && break; sleep 0.1; done
}
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
      EnvironmentFiles) e=$(envfile); [ -z "$e" ] || echo "$e (ignore_errors=no)" ;;
      *) echo ;;
    esac ;;
  stop) stop; echo stop >> /run/fake/restarts ;;
  start) active || { launch; echo start >> /run/fake/restarts; } ;;
  restart) stop; launch; echo restart >> /run/fake/restarts ;;
  *) echo "fake-systemctl: $*" >&2; exit 1 ;;
esac
SC
chmod +x /usr/local/bin/fake-systemctl

# Signed requests to the name service, by the real lnaddr.js of the new commit.
cat > /names.mjs <<'JS'
import { nameKey, signWith, signedDigest, signCode } from '/trees/new/lnaddr.js'
import { buildPayCode } from '/trees/new/pay-code.js'
const B = 'http://127.0.0.1:9981', D = 'sequentiatestnet.com'
const K = { a: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', b: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  c: 'legal winner thank year wave sausage worth useful legal winner thank yellow', d: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  e: 'scheme spot photo card baby mountain device kick cradle pact join borrow', x: 'hamster diagram private dutch cause delay private meat slide toddler razor book',
  f: 'fig fig fig fig fig fig fig fig fig fig fig fig', g: 'gas gas gas gas gas gas gas gas gas gas gas gas', h: 'hat hat hat hat hat hat hat hat hat hat hat hat' }
const [cmd, who, name] = process.argv.slice(2), k = K[who] && nameKey(K[who]), ts = Math.floor(Date.now() / 1000)
const post = (p, b) => fetch(`${B}/lnaddr/-/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status)
let out
if (cmd === 'reg') out = await post('register', { name, pubkey: k.pub, ts, sig: signWith(k.priv, signedDigest('register', D, name, k.pub, ts)) })
else if (cmd === 'rel') out = await post('release', { name, ts, sig: signWith(k.priv, signedDigest('release', D, name, ts)) })
else if (cmd === 'stock') { const c = signCode(k.priv, D, name, buildPayCode({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' })); out = await post('stock', { name, ts, add: [c], drop: [], sig: signWith(k.priv, signedDigest('stock', D, name, ts, c.id, '')) }) }
else if (cmd === 'mine') { const j = await fetch(`${B}/lnaddr/-/mine?pubkey=${k.pub}`).then((r) => r.json()); out = `${j.name}/${j.declined === true}` }
else if (cmd === 'pay') { const r = await fetch(`${B}/lnaddr/${who}`); const j = await r.json(); out = `${r.status}/${j.code ? 'code' : 'none'}/${Object.entries(K).find(([, p]) => j.pubkey && nameKey(p).pub === j.pubkey)?.[0] || '-'}` }
console.log(out)
JS
names() { node /names.mjs "$@"; }
want() { local got; got=$(names "${@:2}"); [ "$got" = "$1" ] || fail "names $*: got $got"; }

fake-systemctl daemon-reload; fake-systemctl start lsp-b5b1.service; : > /run/fake/restarts
health() { curl -sf http://127.0.0.1:9981/health; }
field() { health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j[process.argv[1]]))})' "$1"; }
wallet_head() { git -C /root/sequentia/sequentia-web-wallet rev-parse HEAD; }
restarts() { wc -l < /run/fake/restarts; }
reloads() { grep -c '^daemon-reload' /run/fake/calls; }
run() { # $1 log name, then VAR=value...
  local log=/tmp/run-$1.log; shift
  env "$@" SYSTEMCTL=fake-systemctl NODE=node SITE= LSP_LOCAL=http://127.0.0.1:9981/health APPLY_CADDY=false bash /deploy.sh > "$log" 2>&1
}
[ "$(field version)" = '"old"' ] || fail "the old LSP did not start"
# A name of before: E holds premname, with a code in stock.
want 200 reg e premname; want 200 stock e premname

echo "--- 0. DRY=1: origin/main's unit (with the flag, not fetched here), the new commit"
sum0=$(sha256sum "$UNITF"); r0=$(reloads)
! git -C /root/sequentia/sequentia-testnet-ops cat-file -e "$OPS_FLAG^{commit}" 2>/dev/null || fail "run 0: the box's ops checkout has the incoming commit already"
run 0 DRY=1 COMMIT="$NEW" || { cat /tmp/run-0.log; fail "run 0 stopped"; }
grep -q 'DRY: would install systemd/lsp-b5b1.service' /tmp/run-0.log || { cat /tmp/run-0.log; fail "run 0: no word of the unit"; }
grep -q 'loads node:sqlite with its own options: /opt/node2211/bin/node --experimental-sqlite' /tmp/run-0.log || { cat /tmp/run-0.log; fail "run 0: the repository's unit not checked"; }
[ "$(sha256sum "$UNITF")" = "$sum0" ] && [ "$(reloads)" = "$r0" ] && [ "$(wallet_head)" = "$OLD" ] || fail "run 0 changed something"
! git -C /root/sequentia/sequentia-testnet-ops cat-file -e "$OPS_FLAG^{commit}" 2>/dev/null || fail "run 0 fetched into the box's ops checkout"

echo "--- 1. the unit with the flag, the new commit"
run 1 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-1.log; fail "run 1 stopped"; }
grep -q '=== done ===' /tmp/run-1.log || fail "run 1 did not end"
grep -q 'installed systemd/lsp-b5b1.service over /etc/systemd/system/lsp-b5b1.service and reloaded systemd' /tmp/run-1.log || fail "run 1: unit not installed"
grep -q 'restarting: its unit was installed in this deploy' /tmp/run-1.log || fail "run 1: no restart for the unit"
[ "$(wallet_head)" = "$NEW" ] || fail "run 1: wallet not on NEW"
[ "$(field version)" = '"new"' ] && [ "$(field store)" = '"sqlite"' ] && [ "$(field execArgv)" = '["--experimental-sqlite"]' ] || fail "run 1: the LSP is not the new code on its SQLite store: $(health)"
grep -q 'imported 1 names from lnaddr-names.json' /run/fake/lsp.log || fail "run 1: the names of before were not imported"
want premname/false mine e
back=$(sed -n "s/.*ssh seq '\(COMMIT=[0-9a-f]* ALLOW_BACK=1\) bash -s'.*/\1/p" /tmp/run-1.log)
[ "$back" = "COMMIT=$OLD ALLOW_BACK=1" ] || fail "run 1: rollback line not printed: '$back'"
# On the new service: A holds livename (with a code in stock), B released gonename, C moved from
# oldname to newname (with a code in stock), D holds yname (with a code in stock).
want 200 reg a livename; want 200 stock a livename
want 200 reg d yname; want 200 stock d yname
want 200 reg b gonename; want 200 rel b gonename
want 200 reg c oldname; want 200 reg c newname; want 200 stock c newname
want 409 reg x gonename

echo "--- 2. pasted again"
n=$(restarts); r=$(reloads)
run 2 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-2.log; fail "run 2 stopped"; }
grep -q 'the installed unit (/etc/systemd/system/lsp-b5b1.service) is the repository' /tmp/run-2.log || fail "run 2: unit not seen as installed"
[ "$(restarts)" = "$n" ] && [ "$(reloads)" = "$r" ] || { cat /tmp/run-2.log; fail "run 2 restarted or reloaded"; }

echo "--- 3. the rollback line, while the names file cannot be written"
mv "$STORE" "$STORE.aside"; mkdir "$STORE"; touch "$STORE/in-the-way"
# shellcheck disable=SC2086
if run 3 $back OPS_COMMIT="$OPS_FLAG"; then cat /tmp/run-3.log; fail "run 3 was not refused"; fi
grep -q 'STOPPED in step "the web wallet checkout": the names could not be exported from /root/sequentia/lsp/prov/lnaddr-names.sqlite: ' /tmp/run-3.log || { cat /tmp/run-3.log; fail "run 3: not refused for the export"; }
grep -q 'The LSP runs again on' /tmp/run-3.log || fail "run 3: the LSP not said to run again"
[ "$(wallet_head)" = "$NEW" ] || fail "run 3: the wallet moved"
[ "$(field version)" = '"new"' ] || fail "run 3: the LSP does not run: $(health || true)"
tail -n 2 /run/fake/restarts | tr '\n' ' ' | grep -qx 'stop start ' || fail "run 3: the LSP was not stopped for the export and started again"
rm -r "$STORE"; mv "$STORE.aside" "$STORE"
fake-systemctl restart lsp-b5b1.service

echo "--- 4. the rollback line"
# shellcheck disable=SC2086
run 4 $back OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-4.log; fail "run 4 stopped"; }
grep -q '=== done ===' /tmp/run-4.log || fail "run 4 did not end"
grep -q 'exported the names with the LSP stopped: wrote 4 names in use and 2 released or moved-away names to /root/sequentia/lsp/prov/lnaddr-names.json' /tmp/run-4.log || { cat /tmp/run-4.log; fail "run 4: names not exported"; }
grep -q 'restarting: it was stopped to export its names' /tmp/run-4.log || fail "run 4: no restart after the export"
ls /root/deploy-web-wallet/lnaddr-names.*.json >/dev/null 2>&1 || fail "run 4: the names file it replaced was not kept"
[ "$(wallet_head)" = "$OLD" ] || fail "run 4: wallet not back on OLD"
[ "$(field version)" = '"old"' ] && [ "$(field store)" = '"json"' ] && [ "$(field execArgv)" = '["--experimental-sqlite"]' ] || fail "run 4: the old code does not run under the flagged unit: $(health)"
# On the old service: every name keeps its key.
want 409 reg x gonename; want 409 reg x oldname
want 200/none/- pay gonename; want 200/none/- pay oldname
want 200/code/a pay livename; want 200/code/c pay newname
want livename/false mine a; want newname/false mine c; want null/false mine b; want premname/false mine e; want yname/false mine d
# While rolled back: H takes a name, C releases newname, A moves to livename2; F takes newname, D
# moves to yname2 and G takes yname, F and G each with a code in stock.
want 200 reg h rollbackname; want 200 rel c newname; want 200 reg a livename2
want 200 reg f newname; want 200 stock f newname
want 200 reg d yname2; want 200 reg g yname; want 200 stock g yname

echo "--- 5. forward again"
run 5 COMMIT="$NEW" OPS_COMMIT="$OPS_FLAG" || { cat /tmp/run-5.log; fail "run 5 stopped"; }
grep -q '=== done ===' /tmp/run-5.log || fail "run 5 did not end"
! grep -q 'exported' /tmp/run-5.log || fail "run 5: exported on a move forward"
[ "$(field version)" = '"new"' ] && [ "$(field store)" = '"sqlite"' ] || fail "run 5: not the new code: $(health)"
want rollbackname/false mine h; want 409 reg x rollbackname
for n in livename gonename oldname; do want 404/none/- pay "$n"; want 409 reg x "$n"; done
# The names that changed hands while rolled back: their payers reach the keys that took them.
want 200/code/f pay newname; want 200/code/g pay yname
want newname/false mine f; want yname/false mine g
want 409 reg c newname; want 409 reg d yname; want 409 reg x newname; want 409 reg x yname
want null/true mine c; want yname2/false mine d; want livename2/false mine a; want null/true mine b; want premname/false mine e
grep -q 'took back from lnaddr-names.json, written by the code before this store: 3 names made, 1 released or moved away, 2 changed hands' /run/fake/lsp.log || fail "run 5: what the old service did was not taken back"
grep -q 'conflict: newname was .* and is .*in the file: now .*, and ended for' /run/fake/lsp.log && grep -q 'conflict: yname was ' /run/fake/lsp.log || fail "run 5: the names that changed hands were not logged"

echo "--- 6. a unit without the flag: refused before the wallet moves"
pid=$(cat /run/fake/pid); sum=$(sha256sum "$UNITF"); jsum=$(sha256sum "$STORE"); n=$(restarts)
if run 6 COMMIT="$OLD" ALLOW_BACK=1 OPS_COMMIT="$OPS_BAD"; then cat /tmp/run-6.log; fail "run 6 was not refused"; fi
grep -q 'STOPPED in step "the LSP unit": the unit.s node cannot load node:sqlite with its own options (/opt/node2211/bin/node): Error \[ERR_UNKNOWN_BUILTIN_MODULE\]: No such built-in module: node:sqlite' /tmp/run-6.log || { cat /tmp/run-6.log; fail "run 6: not refused for node:sqlite"; }
grep -q 'put /etc/systemd/system/lsp-b5b1.service back as it was' /tmp/run-6.log || fail "run 6: the unit file was not put back"
[ "$(sha256sum "$UNITF")" = "$sum" ] || fail "run 6: the unit file differs from before"
grep -q -- '--experimental-sqlite' /run/fake/loaded.service || fail "run 6: systemd was left with the unit without the flag"
[ "$(wallet_head)" = "$NEW" ] && [ "$(sha256sum "$STORE")" = "$jsum" ] || fail "run 6: the wallet or the names moved"
[ "$(cat /run/fake/pid)" = "$pid" ] && [ "$(restarts)" = "$n" ] && [ "$(field version)" = '"new"' ] || fail "run 6: the LSP was touched"

echo "--- 7. DRY=1 towards that unit: says it would refuse"
r=$(reloads)
if run 7 DRY=1 COMMIT="$OLD" ALLOW_BACK=1 OPS_COMMIT="$OPS_BAD"; then cat /tmp/run-7.log; fail "run 7 did not refuse"; fi
grep -q 'cannot load node:sqlite' /tmp/run-7.log || { cat /tmp/run-7.log; fail "run 7: no reason"; }
[ "$(reloads)" = "$r" ] && [ "$(sha256sum "$UNITF")" = "$sum" ] || fail "run 7 changed something"

! grep -l "$SECRET" /tmp/run-*.log || fail "a run printed a value of the LSP's environment file"
grep -hE 'installed systemd|loads node:sqlite|restarting|STOPPED|put /etc|exported|kept the names' /tmp/run-1.log /tmp/run-3.log /tmp/run-4.log /tmp/run-6.log | sed 's/^/  /'
grep -h 'imported\|took back\|conflict' /run/fake/lsp.log | sed 's/^/  LSP: /'
echo "PASS: deploy-web-wallet.sh, 8 runs"
IN
