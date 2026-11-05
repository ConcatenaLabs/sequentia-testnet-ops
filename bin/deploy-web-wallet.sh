#!/usr/bin/env bash
# deploy-web-wallet.sh: the one way the web wallet goes live on the box. It moves the page, the
# services that run from the same checkout and the Caddyfile together, so the page never runs ahead
# of what answers it.
#
#   ssh seq 'bash -s' < bin/deploy-web-wallet.sh                       deploy origin/main
#   ssh seq 'COMMIT=<sha> bash -s' < bin/deploy-web-wallet.sh          deploy that commit
#   ssh seq 'DRY=1 bash -s' < bin/deploy-web-wallet.sh                 say what it would do; change nothing
#   ssh seq 'COMMIT=<sha> ALLOW_BACK=1 bash -s' < bin/deploy-web-wallet.sh   roll back to <sha>
#
# Run as root on the box (from a laptop's checkout of this repository, as above, or on the box from
# /root/sequentia/sequentia-testnet-ops/bin/).
#
# 1. The ops checkout ($OPS) moves to OPS_COMMIT (origin/main as fetched), and its Caddyfile is
#    applied with bin/apply-caddy.sh only when it differs from the installed one.
# 2. The web wallet checkout ($WALLET) moves to COMMIT (origin/main as fetched). It refuses modified
#    tracked files, and a commit that does not contain what the checkout runs now (ALLOW_BACK=1 for
#    a deliberate rollback).
# 3. The LSP ($UNIT) restarts only when the deploy changes a file it loads, or one is newer than
#    its process: tooling/lsp/ (its tests and notes aside), the page's modules it imports (followed
#    import by import), and the leaf library (leaves/pkg/). Every hosted wallet node running before is checked by pid after.
# 4. Through the public address: the page serves this checkout's index.html and every served file
#    the deploy changed, and the LSP answers.
# The commit it replaces is appended to $KEEP/history as the checkout moves, and the command that
# rolls back to it is printed then, so a step that stops later still leaves the way back.
#
# Safe to paste again: checkouts already there stay, an installed Caddyfile equal to the
# repository's is left, and the LSP restarts only for a reason in step 3. DRY=1 reads only: it
# fetches nothing (it asks the remote what origin/main is) and changes nothing on the box; its only
# write is a temporary directory it removes.
# Takes under two minutes. Ends "=== done ===" or "STOPPED in step ...".
set -Eeuo pipefail
export LC_ALL=C
trap 'printf "\nSTOPPED in step \"%s\": unexpected failure at line %s: %s\n" "${STEP:-start}" "$LINENO" "$BASH_COMMAND" >&2' ERR
: "${COMMIT:=}"                                     # empty: origin/main as fetched
: "${OPS_COMMIT:=}"                                 # empty: origin/main as fetched
: "${DRY:=0}"
: "${ALLOW_BACK:=0}"
: "${WALLET:=/root/sequentia/sequentia-web-wallet}"
: "${OPS:=/root/sequentia/sequentia-testnet-ops}"
: "${PROV:=/root/sequentia/lsp/prov}"
: "${UNIT:=lsp-b5b1.service}"
: "${NODE:=/root/sequentia/downloads/node22/bin/node}"
: "${LSP_LOCAL=http://127.0.0.1:9981/health}"       # empty: no local check
: "${SITE=https://sequentiatestnet.com}"            # empty: no public check
: "${GH_API:=https://api.github.com/repos/ConcatenaLabs/sequentia-web-wallet}"
: "${CADDY_LIVE:=/etc/caddy/Caddyfile}"
: "${APPLY_CADDY:=sh bin/apply-caddy.sh}"           # run from $OPS
: "${KEEP:=/root/deploy-web-wallet}"
: "${PROC:=/proc}"
: "${SYSTEMCTL:=systemctl}"
: "${LOCK:=/run/lock/deploy-web-wallet.lock}"
: "${REQUIRE_ROOT:=1}"
step() { STEP="$1"; printf '\n=== %s === %s\n' "$1" "$(date -u +%H:%M:%SZ)"; }
say()  { printf '  %s\n' "$*"; }
would() { printf '  DRY: would %s\n' "$*"; }
die()  { printf '\nSTOPPED in step "%s": %s\n' "${STEP:-start}" "$*" >&2; exit 1; }
g() { local dir=$1; shift; git -c safe.directory="$dir" -c http.version=HTTP/1.1 -C "$dir" "$@"; }
sc() { $SYSTEMCTL "$@"; }
dry() { [ "$DRY" = 1 ]; }
WORK=$(mktemp -d /tmp/deploy-web-wallet.XXXXXX); trap 'rm -rf "$WORK"' EXIT

[ "$REQUIRE_ROOT" != 1 ] || [ "$(id -u)" = 0 ] || die "run it as root"
if ! dry; then exec 9>"$LOCK"; flock -n 9 || { echo "already running"; exit 0; }; fi
command -v "$NODE" >/dev/null 2>&1 || NODE=node
[ -d "$WALLET/.git" ] || die "$WALLET is not a checkout"
[ -d "$OPS/.git" ] || die "$OPS is not a checkout"

# The commit `want` names in checkout $1 (empty: origin/main). A real run fetches first; a dry run
# asks the remote, so it fetches nothing. -> the full sha.
target() {
  local dir=$1 want=$2 sha
  if dry; then
    if [ -z "$want" ]; then
      sha=$(g "$dir" ls-remote origin refs/heads/main | cut -f1)
      [ -n "$sha" ] || die "the remote of $dir names no main"
      echo "$sha"; return
    fi
    g "$dir" rev-parse --verify --quiet "$want^{commit}" || echo "$want"; return
  fi
  g "$dir" fetch --quiet origin || die "fetch failed in $dir"
  g "$dir" rev-parse --verify --quiet "${want:-origin/main}^{commit}" || die "${want:-origin/main} is not in $dir's fetched history"
}
have() { g "$1" cat-file -e "$2^{commit}" 2>/dev/null; }

# Checks that checkout $1 may move to $2; -> 0 when it would move, 1 when it is there already.
may_move() {
  local dir=$1 to=$2 now
  [ -z "$(g "$dir" status --porcelain --untracked-files=no)" ] || die "$dir has modified tracked files"
  now=$(g "$dir" rev-parse HEAD)
  [ "$now" != "$to" ] || return 1
  if have "$dir" "$to"; then
    if ! g "$dir" merge-base --is-ancestor "$now" "$to"; then
      [ "$ALLOW_BACK" = 1 ] || die "${to:0:10} does not contain ${now:0:10}, which $dir runs now (ALLOW_BACK=1 to go back on purpose)"
      say "going back on purpose (ALLOW_BACK=1): ${to:0:10} does not contain ${now:0:10}"
    fi
  elif ! dry; then die "${to:0:10} is not in $dir's history"
  fi
  return 0
}

# The files the LSP loads at revision $1 of the wallet checkout: tooling/lsp/ and every relative
# import followed from there, one path a line. A revision not in the checkout reads HEAD.
lsp_files() {
  local rev=$1
  have "$WALLET" "$rev" || rev=HEAD
  "$NODE" - "$WALLET" "$rev" <<'JS'
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const [dir, rev] = process.argv.slice(2)
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=' + dir, '-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const all = new Set(git('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean))
// Tests and notes are not run by the LSP: a test reads the page itself, which the LSP never loads.
const runs = (f) => !/\.test\.m?js$|\.md$/.test(f)
const seen = new Set(), todo = [...all].filter((f) => f.startsWith('tooling/lsp/') && runs(f))
for (const f of todo) seen.add(f)
while (todo.length) {
  const f = todo.pop()
  if (!/\.(m?js)$/.test(f)) continue
  let src = ''; try { src = git('show', rev + ':' + f) } catch { continue }
  const re = /(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  for (let m; (m = re.exec(src));) {
    const to = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
    if (all.has(to) && runs(to) && !seen.has(to)) { seen.add(to); todo.push(to) }
  }
}
for (const f of all) if (f.startsWith('leaves/pkg/')) seen.add(f)
console.log([...seen].sort().join('\n'))
JS
}

# The files that differ between $1 and $2 in the wallet checkout, one a line; through GitHub when
# a dry run does not have $2 here.
changed() {
  if have "$WALLET" "$2"; then g "$WALLET" diff --name-only "$1" "$2"; return; fi
  python3 - "$GH_API/compare/$1...$2" <<'PY'
import json, sys, urllib.request
r = urllib.request.Request(sys.argv[1], headers={"Accept": "application/vnd.github+json", "User-Agent": "deploy-web-wallet"})
for f in json.load(urllib.request.urlopen(r, timeout=30)).get("files", []): print(f["filename"])
PY
}

# The hosted wallet nodes running now, by pid (lightningd under the provisioning directory).
hosted() {
  local p c
  for p in "$PROC"/[0-9]*; do
    p=${p##*/}
    [ "$(cat "$PROC/$p/comm" 2>/dev/null || true)" = lightningd ] || continue
    c=$({ tr '\0' ' ' < "$PROC/$p/cmdline"; } 2>/dev/null || true)
    case "$c" in *"--lightning-dir=$PROV/"*) echo "$p";; esac
  done | sort -n
}
# When the LSP's process started, in seconds since the epoch (0 when it runs none).
lsp_started() {
  local t; t=$(sc show -p ExecMainStartTimestamp --value "$UNIT" 2>/dev/null || true)
  [ -n "$t" ] && [ "$t" != n/a ] && date -u -d "$t" +%s 2>/dev/null || echo 0
}
# The newest of the files in $1 (one path a line, relative to the wallet checkout), on disk, and
# its name: "<epoch> <path>".
newest() {
  local f best=0 name=none t
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$WALLET/$f" ] || continue
    t=$(stat -c %Y "$WALLET/$f"); [ "$t" -gt "$best" ] && { best=$t; name=$f; }
  done < "$1"
  echo "$best $name"
}

step "now"
w_now=$(g "$WALLET" rev-parse HEAD); o_now=$(g "$OPS" rev-parse HEAD)
say "web wallet: ${w_now:0:10} $(g "$WALLET" log -1 --format=%s)"
say "ops:        ${o_now:0:10} $(g "$OPS" log -1 --format=%s)"
sc cat "$UNIT" >/dev/null 2>&1 || die "no unit $UNIT"
started=$(lsp_started)
say "$UNIT: pid $(sc show -p MainPID --value "$UNIT"), started $(date -u -d "@$started" +%FT%TZ)"
before=$(hosted); say "hosted wallet nodes running: $(wc -w <<<"$before")"
others=$(sc list-units --type=service --all --no-legend --plain 2>/dev/null | cut -d' ' -f1 | while read -r u; do
  [ "$u" = "$UNIT" ] && continue
  sc show -p ExecStart -p WorkingDirectory --value "$u" 2>/dev/null | grep -q "$WALLET" && echo "$u"; done | tr '\n' ' ' || true)
[ -z "${others// /}" ] || say "other units running from $WALLET (not restarted here): $others"

STEP="the Caddyfile"; step "$STEP"
o_to=$(target "$OPS" "$OPS_COMMIT")
if may_move "$OPS" "$o_to"; then
  if dry; then would "move $OPS to ${o_to:0:10}"
  else g "$OPS" checkout --quiet --detach "$o_to"; say "ops moved to $(g "$OPS" log -1 --format='%h %s')"
  fi
else say "ops at ${o_to:0:10} already"
fi
if have "$OPS" "$o_to"; then g "$OPS" show "$o_to:caddy/Caddyfile" > "$WORK/Caddyfile"; else cp "$OPS/caddy/Caddyfile" "$WORK/Caddyfile"; fi
if cmp -s "$WORK/Caddyfile" "$CADDY_LIVE"; then say "the installed Caddyfile is the repository's"
elif dry; then would "apply the Caddyfile with bin/apply-caddy.sh ($(diff "$CADDY_LIVE" "$WORK/Caddyfile" | grep -c '^[<>]' || true) line(s) differ)"
else (cd "$OPS" && $APPLY_CADDY) || die "apply-caddy.sh refused or failed; it says what it left in place"
fi

STEP="the web wallet checkout"; step "$STEP"
w_to=$(target "$WALLET" "$COMMIT")
moved=0
if may_move "$WALLET" "$w_to"; then
  changed "$w_now" "$w_to" > "$WORK/changed"
  say "${w_to:0:10} changes $(wc -l < "$WORK/changed") file(s)"
  if dry; then would "move $WALLET to ${w_to:0:10}, recording ${w_now:0:10} in $KEEP/history"
  else
    g "$WALLET" checkout --quiet --detach "$w_to"; moved=1; say "moved to $(g "$WALLET" log -1 --format='%h %s')"
    # Recorded at once, so a step that stops later still leaves the way back.
    [ -d "$KEEP" ] || install -d -m 700 "$KEEP"
    printf '%s %s -> %s\n' "$(date -u +%FT%TZ)" "$w_now" "$w_to" >> "$KEEP/history"
    say "replaced ${w_now:0:10}, recorded in $KEEP/history; to roll back:"
    say "  ssh seq 'COMMIT=$w_now ALLOW_BACK=1 bash -s' < bin/deploy-web-wallet.sh"
  fi
else : > "$WORK/changed"; say "at ${w_to:0:10} already"
fi

STEP="the LSP"; step "$STEP"
lsp_files "$w_to" > "$WORK/lsp"
grep -Fxf "$WORK/lsp" "$WORK/changed" > "$WORK/lsp-changed" || true
read -r latest latest_name <<<"$(newest "$WORK/lsp")"
why=""
[ -s "$WORK/lsp-changed" ] && why="the deploy changes $(wc -l < "$WORK/lsp-changed") file(s) it loads: $(head -5 "$WORK/lsp-changed" | tr '\n' ' ')"
[ -z "$why" ] && [ "$latest" -gt "$started" ] && why="it started before $latest_name was written"
if [ -z "$why" ]; then say "left running: it loads none of what changed, and started after every file it loads"
elif dry; then would "restart $UNIT: $why"
else
  say "restarting: $why"
  sc restart "$UNIT"
  for _ in $(seq 1 60); do sc is-active --quiet "$UNIT" && break; sleep 1; done
  sc is-active --quiet "$UNIT" || die "$UNIT did not come back (journalctl -u $UNIT)"
  if [ -n "$LSP_LOCAL" ]; then
    for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LSP_LOCAL" || true)" = 200 ] && break; sleep 1; done
  fi
  sleep 5
  say "restarted"
fi
after=$(hosted)
missing=$(comm -23 <(printf '%s\n' $before) <(printf '%s\n' $after) | tr '\n' ' ')
[ -z "${missing// /}" ] || die "hosted wallet nodes running before are gone: pids $missing"
say "every hosted wallet node running before still runs ($(wc -w <<<"$after") now)"
if [ -n "$LSP_LOCAL" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$LSP_LOCAL" || true)
  [ "$code" = 200 ] || die "the LSP does not answer on $LSP_LOCAL (HTTP ${code:-none})"
  say "the LSP answers on $LSP_LOCAL"
fi

if [ -n "$SITE" ]; then
  STEP="check through $SITE"; step "$STEP"
  # What the public page must serve: index.html and each served file the deploy changed. A dry run
  # checks the checkout as it runs now.
  { echo index.html; dry || grep -vE '^(tooling/|docs/|\.github/|[^/]*\.md$|.*\.test\.mjs$|LICENSE$)' "$WORK/changed" || true; } | sort -u > "$WORK/served"
  n=0
  while IFS= read -r f; do
    [ -f "$WALLET/$f" ] || continue
    want=$(sha256sum "$WALLET/$f" | cut -c1-64)
    got=$(curl -sf --max-time 60 -H 'Cache-Control: no-cache' "$SITE/wallet/$f" | sha256sum | cut -c1-64) || die "$SITE/wallet/$f could not be read"
    [ "$got" = "$want" ] || die "the public $f is not the checkout's (served ${got:0:12}, checkout ${want:0:12})"
    n=$((n + 1))
  done < "$WORK/served"
  say "the page serves the checkout's files ($n checked, index.html among them)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE/lsp/health" || true)
  [ "$code" = 200 ] || die "the LSP does not answer through $SITE/lsp/health (HTTP ${code:-none})"
  say "the LSP answers through $SITE/lsp/health"
fi

if dry; then printf '\n=== done === (DRY: nothing changed)\n'
else printf '\n=== done ===\n  The web wallet runs %s; the Caddyfile is ops %s.\n' "$(g "$WALLET" log -1 --format='%h %s')" "$(g "$OPS" rev-parse --short=10 HEAD)"
fi
