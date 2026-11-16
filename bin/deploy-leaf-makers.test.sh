#!/usr/bin/env bash
# deploy-leaf-makers.test.sh: bin/deploy-leaf-makers.sh rehearsed in a container, as the box runs it:
# as root, with the makers' users (leafmaker, leafmakerbtc) owning their checkouts, cloned from an
# origin of commits made here, and git run as those users. A stand-in `systemctl` (SYSTEMCTL) runs
# each unit's stand-in maker with runuser as its user; the stand-in answers /health as the maker does,
# its sync and upkeep ending passes or not as the commit it runs says. Four runs:
#   1. a commit every maker keeps itself on: all three move, one at a time, and pass;
#   2. pasted again: nothing moves or restarts, every maker is checked;
#   3. a commit on which the BTC maker ends no sync pass: it is put back by itself, restarted on the
#      commit it ran, and nothing after it moves;
#   4. a commit on which only the agents' maker ends no upkeep pass: the checkout it shares goes back,
#      and both makers that run from it restart on it; the BTC maker stays on the new commit.
# Needs docker; uses the node:22-bookworm image.  bin/deploy-leaf-makers.test.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec docker run --rm -i --name "deploy-leaf-makers-test-$$" -v "$here/deploy-leaf-makers.sh:/deploy.sh:ro" node:22-bookworm bash -s <<'IN'
set -euo pipefail
fail() { echo "FAIL: $*"; tail -n 5 /run/fake/*.log 2>/dev/null; ps -eo pid,user,args | grep -v ' ps ' | tail -n 12; exit 1; }
useradd -m leafmaker; useradd -m leafmakerbtc
mkdir -p /run/lock /run/fake /etc/fake-units /etc/leaf-maker /etc/leaf-maker-btc
git config --global user.email t@example.org; git config --global user.name t; git config --global init.defaultBranch main
# The origin: OLD (what runs), GOOD, BAD_BTC (the BTC maker's sync never ends a pass), BAD_AGENTS
# (the agents' maker's upkeep never ends one), each with the maker's markers and its leaves/pkg.
LIB=1111111111111111111111111111111111111111
mkdir /src && cd /src && git init -q
commit() { # $1 name, $2 behaviour json
  mkdir -p tooling/lsp leaves/pkg
  echo "$LIB" > leaves/pkg/BUILT_FROM
  printf '%s\n' "$2" > tooling/lsp/stand-in.json
  cat > tooling/lsp/leaf-maker.mjs <<'MAKER'
// stand-in maker: export function workingSizes export function roomNow export function syncStanding
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'))
const how = JSON.parse(readFileSync(new URL('./stand-in.json', import.meta.url), 'utf8'))
if (process.argv.includes('--size')) {
  console.log(JSON.stringify({ store: { bytes: 362000000, live_coins: 640 }, took_ms: 900, steps: { refresh: { items: 640,
    refused_participations: { refused: 2089, void: 6264, expired: 43, coins_named: 127089 },
    before_items_ms: { refused_each_slice: 1, refused_each_slice_by_an_older_library: 2400, refused_read_once: 150 } } } }))
  process.exit(0)
}
const t0 = Date.now(), at = (s) => s != null && !(how.never || []).includes(cfg.listen) && Date.now() - t0 >= s * 1000
const upkeepNever = (how.upkeep_never || []).includes(cfg.listen)
console.log(new Date().toISOString() + ' working coins of at most: X 1000, Y 1000')
createServer((req, res) => {
  if (req.url === '/v1/quotes') return res.end(JSON.stringify({ quotes: [{ give_asset: 'aa', want_asset: 'bb', min_give: '10000' }] }))
  if (req.url === '/v1/firm') return res.end(JSON.stringify({ swap: 'ss' }))
  if (req.url === '/v1/release') return res.end('{}')
  const sync = at(how.sync_after) ? 1 : 0, upkeep = sync && !upkeepNever && at(how.upkeep_after) ? 1 : 0
  res.end(JSON.stringify({ ok: true, version: how.name, sync: { passes: sync }, upkeep: { passes: upkeep } }))
}).listen(Number(cfg.listen.split(':')[1]), '127.0.0.1')
MAKER
  git add -A; git commit -qm "$1"; git rev-parse HEAD
}
OLD=$(commit old '{"name":"old","sync_after":1,"upkeep_after":2}')
GOOD=$(commit good '{"name":"good","sync_after":2,"upkeep_after":4}')
git checkout -q "$OLD"; git checkout -q -b bad1
BAD_BTC=$(commit bad-btc '{"name":"bad-btc","sync_after":2,"upkeep_after":4,"never":["127.0.0.1:9978"]}')
git checkout -q main; git checkout -q -b bad2
BAD_AGENTS=$(commit bad-agents '{"name":"bad-agents","sync_after":2,"upkeep_after":4,"upkeep_never":["127.0.0.1:9977"]}')
git clone -q --bare /src /srv/origin.git; chmod -R a+rX /srv/origin.git
# On the box the origin is GitHub; here it is a directory of root's, which the makers' users may read.
git config --system --add safe.directory /srv/origin.git
for spec in /opt/leaf-maker-btc:leafmakerbtc /opt/leaf-maker:leafmaker; do
  d=${spec%%:*}; u=${spec##*:}; mkdir -p "$d"; chown "$u" "$d"
  runuser -u "$u" -- git clone -q /srv/origin.git "$d/sequentia-web-wallet"
  runuser -u "$u" -- git -C "$d/sequentia-web-wallet" checkout -q --detach "$OLD"
done
# The units: unit|checkout|user|listen|config.
cat > /etc/fake-units/list <<UNITS
leaf-maker-btc.service|/opt/leaf-maker-btc/sequentia-web-wallet|leafmakerbtc|127.0.0.1:9978|/etc/leaf-maker-btc/maker.json
leaf-maker.service|/opt/leaf-maker/sequentia-web-wallet|leafmaker|127.0.0.1:9979|/etc/leaf-maker/maker.json
leaf-maker-agents.service|/opt/leaf-maker/sequentia-web-wallet|leafmaker|127.0.0.1:9977|/etc/leaf-maker/agents.json
seqob-volume-wallet@9601.service|/opt/leaf-maker/sequentia-web-wallet|leafmaker|127.0.0.1:9601|/etc/leaf-maker/volume.json
UNITS
while IFS='|' read -r u d user listen cfg; do echo "{\"listen\":\"$listen\"}" > "$cfg"; chmod a+r "$cfg"; done < /etc/fake-units/list
cat > /usr/local/bin/fake-systemctl <<'SC'
#!/bin/bash
# A stand-in for systemctl: each unit of /etc/fake-units/list runs node on its checkout's maker, as its user.
row() { grep "^$1|" /etc/fake-units/list; }
pidf() { echo "/run/fake/$1.pid"; }
active() { [ -f "$(pidf "$1")" ] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null; }
case "$1" in
  list-units) cut -d'|' -f1 /etc/fake-units/list | sed 's/$/ loaded active running stand-in/' ;;
  show) u=${!#}; IFS='|' read -r _ d _ _ cfg <<<"$(row "$u")"
    case "$3" in WorkingDirectory) echo "$d" ;; ExecStart) echo "{ path=$(command -v node) ; argv[]=$(command -v node) tooling/lsp/leaf-maker.mjs --config $cfg ; }" ;; esac ;;
  is-active) active "${!#}" ;;
  restart) u=$2; IFS='|' read -r _ d user _ cfg <<<"$(row "$u")"
    # The unit's processes are one session (setsid): stopped together, as systemd stops a unit's cgroup.
    if active "$u"; then p=$(cat "$(pidf "$u")"); kill -- -"$p"; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; fi
    cd "$d"; setsid runuser -u "$user" -- node tooling/lsp/leaf-maker.mjs --config "$cfg" >>"/run/fake/$u.log" 2>&1 8>&- 9>&- &
    echo $! > "$(pidf "$u")"
    sleep 0.5 ;;
  *) echo "fake-systemctl: $*" >&2; exit 1 ;;
esac
SC
chmod +x /usr/local/bin/fake-systemctl
# A stand-in for journalctl -u UNIT: what the unit's stand-in printed.
printf '#!/bin/bash\ncat "/run/fake/$2.log" 2>/dev/null\n' > /usr/local/bin/fake-journalctl; chmod +x /usr/local/bin/fake-journalctl
while IFS='|' read -r u _; do fake-systemctl restart "$u"; done < /etc/fake-units/list
sleep 2
head_of() { runuser -u "$2" -- git -C "$1" rev-parse HEAD; }
version() { curl -sf "http://$1/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'; }
run() { env SYSTEMCTL=fake-systemctl JOURNALCTL=fake-journalctl FLOOR="$OLD" LIBRARY="$LIB" SYNC_WAIT=8 UPKEEP_WAIT=12 POLL=1 COMMIT="$1" bash /deploy.sh > "/tmp/run-$2.log" 2>&1; }
BTC=/opt/leaf-maker-btc/sequentia-web-wallet MAIN=/opt/leaf-maker/sequentia-web-wallet

echo "--- 1. a good commit"
run "$GOOD" 1 || { cat /tmp/run-1.log; fail "run 1 stopped"; }
grep -q '=== done ===' /tmp/run-1.log || fail "run 1 did not end"
[ "$(head_of $BTC leafmakerbtc)" = "$GOOD" ] && [ "$(head_of $MAIN leafmaker)" = "$GOOD" ] || fail "run 1: checkouts not on GOOD"
for a in 9978 9979 9977 9601; do [ "$(version 127.0.0.1:$a)" = good ] || fail "run 1: :$a does not run GOOD"; done
grep -q 'refresh: 640 items, 8396 refused/void/expired participations' /tmp/run-1.log || fail "run 1: no sizing"
[ "$(grep -c 'answers quotes; working coins of at most' /tmp/run-1.log)" = 3 ] || { grep -E "upkeep pass|quotes|working|STOPPED" /tmp/run-1.log; fail "run 1: quotes and working coins checked"; }
[ "$(grep -c 'firm offer [123]: HTTP 200' /tmp/run-1.log)" = 3 ] || fail "run 1: firm offers timed"
[ "$(grep -c 'first upkeep pass ended' /tmp/run-1.log)" = 3 ] || fail "run 1: three makers watched"
# One at a time: each maker's restart comes after the one before it passed.
awk '/restarted on/ {print $1 " " $2}' /tmp/run-1.log
python3 - /tmp/run-1.log <<'PY' || fail "run 1: not one at a time"
import sys
l = open(sys.argv[1]).read().split('\n')
order = [x for x in l if 'restarted on' in x or 'first upkeep pass ended' in x]
seq = ['restarted' if 'restarted on' in x else 'passed' for x in order]
assert seq == ['restarted', 'passed'] * 3, seq
PY
echo "ok 1"

echo "--- 2. pasted again"
run "$GOOD" 2 || { cat /tmp/run-2.log; fail "run 2 stopped"; }
grep -q 'restarted on' /tmp/run-2.log && fail "run 2 restarted a maker"
[ "$(grep -c "not restarted" /tmp/run-2.log)" = 3 ] || { cat /tmp/run-2.log; fail "run 2: three makers left as they were"; }
echo "ok 2"

echo "--- 3. the BTC maker ends no sync pass"
# From GOOD back to BAD_BTC's base is a step back: start again from OLD for this run.
for spec in $BTC:leafmakerbtc $MAIN:leafmaker; do runuser -u "${spec##*:}" -- git -C "${spec%%:*}" checkout -q --detach "$OLD"; done
while IFS='|' read -r u _; do fake-systemctl restart "$u"; done < /etc/fake-units/list; sleep 2
if run "$BAD_BTC" 3; then cat /tmp/run-3.log; fail "run 3 should stop"; fi
cat /tmp/run-3.log | sed -n '/roll back/,$p'
grep -q 'leaf-maker-btc.service ended no sync pass within 8 s' /tmp/run-3.log || fail "run 3: the miss is not named"
grep -q 'rolled back' /tmp/run-3.log || fail "run 3: not rolled back"
[ "$(head_of $BTC leafmakerbtc)" = "$OLD" ] || fail "run 3: the BTC checkout is not back on OLD"
[ "$(version 127.0.0.1:9978)" = old ] || fail "run 3: the BTC maker does not run OLD again"
[ "$(head_of $MAIN leafmaker)" = "$OLD" ] && [ "$(version 127.0.0.1:9979)" = old ] || fail "run 3: the next maker moved"
grep -q "back to $OLD" /root/deploy-leaf-makers/history || fail "run 3: no history line"
echo "ok 3"

echo "--- 4. only the agents' maker ends no upkeep pass"
if run "$BAD_AGENTS" 4; then cat /tmp/run-4.log; fail "run 4 should stop"; fi
cat /tmp/run-4.log | sed -n '/roll back/,$p'
grep -q 'leaf-maker-agents.service ended no upkeep pass within 12 s' /tmp/run-4.log || fail "run 4: the miss is not named"
[ "$(head_of $BTC leafmakerbtc)" = "$BAD_AGENTS" ] && [ "$(version 127.0.0.1:9978)" = bad-agents ] || fail "run 4: the BTC maker should stay on the new commit"
[ "$(head_of $MAIN leafmaker)" = "$OLD" ] || fail "run 4: the shared checkout is not back on OLD"
for a in 9979 9977; do [ "$(version 127.0.0.1:$a)" = old ] || fail "run 4: :$a does not run OLD again"; done
[ "$(version 127.0.0.1:9601)" = old ] || fail "run 4: the volume wallet moved"
echo "ok 4"
echo "PASS"
IN
