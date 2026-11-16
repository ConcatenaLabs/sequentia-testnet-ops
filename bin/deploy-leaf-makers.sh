#!/usr/bin/env bash
# deploy-leaf-makers.sh: the one way the leaf makers move to a web wallet commit. One maker at a
# time: it moves that maker's checkout, restarts that maker alone and reads its /health until the
# maker has ended a sync pass and an upkeep pass and says it is ok; a maker that misses either in
# its time is put back, by the script, on the commit it ran and restarted again, and the script
# stops there, before the next maker. Run as root on the box:
#
#   ssh seq 'COMMIT=<web wallet commit> LIBRARY=<arca commit of its leaves/pkg> bash -s' < bin/deploy-leaf-makers.sh
#   ssh seq 'DRY=1 COMMIT=<…> LIBRARY=<…> bash -s' < bin/deploy-leaf-makers.sh      # the checks only
#
# The wallets it touches, by restarting the units that run them (it moves no coin itself): the
# makers' own wallets leaf-maker-btc-usdx (leaf-maker-btc.service), leaf-maker-usdx-eurx
# (leaf-maker.service) and leaf-maker-agents (leaf-maker-agents.service), and the volume wallets whose
# units run from a maker checkout (seqob-volume-wallet@*), restarted once every maker passed.
#
# Before a checkout moves: COMMIT must contain what the checkout runs now (ALLOW_BACK=1 for a
# deliberate rollback) and web FLOOR; its leaves/pkg must be built from LIBRARY; its maker must keep
# working coins, size quotes on a pass's room and stop quoting when its sync ends no pass
# (syncStanding); the tracked files must be unmodified; and no unit may run from a maker checkout
# but the makers named in MAKERS and the volume wallets (OTHER_UNITS). After a checkout moves and
# before its maker restarts, the new library sizes that maker's store (`--size`, from a private
# copy; nothing is written to the store): what a pass in slices will cost there. A sizing that
# fails or answers no sizing stops that maker and puts its checkout back (SIZE=0 skips it).
#
# The order: the BTC maker (its own checkout), then the leaf maker, then the agents' maker (both run
# from /opt/leaf-maker). Each must, from its restart, end its first sync pass within SYNC_WAIT
# seconds (300) and its first upkeep pass within UPKEEP_WAIT (900), with /health ok. When the
# agents' maker misses, the checkout it shares goes back and the leaf maker restarts on it too.
# Every move is written to /root/deploy-leaf-makers/history. Safe to paste again: a checkout at
# COMMIT is left, and its makers are restarted only when it moved (FORCE_RESTART=1 restarts them),
# but checked all the same. 10 to 40 minutes.
set -Eeuo pipefail
trap 'printf "\nSTOPPED: unexpected failure at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
: "${COMMIT:?name the web wallet commit: COMMIT=<40-character id>}"
: "${LIBRARY:?name the arca commit its leaves/pkg was built from: LIBRARY=<40-character id>}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "COMMIT is not a full commit id: $COMMIT"; exit 1; }
[[ "$LIBRARY" =~ ^[0-9a-f]{40}$ ]] || { echo "LIBRARY is not a full commit id: $LIBRARY"; exit 1; }
: "${FLOOR:=7c91c5971f1d2d2a2ce540a92596d555f103a9f9}"   # web main with BX2's record fixes, which the volume wallets need
: "${SYNC_WAIT:=300}"       # seconds from a maker's restart to the end of its first sync pass
: "${UPKEEP_WAIT:=900}"     # seconds from its restart to the end of its first upkeep pass
: "${POLL:=5}"              # seconds between two readings of /health
: "${SIZE:=1}"              # 0: the new library does not size the stores first (else a sizing that fails stops that maker)
: "${OTHER_UNITS:=seqob-volume-wallet@*.service}"   # the only other units that may run from a maker checkout
# unit|checkout|its user|its address, in the order they move.
: "${MAKERS:=leaf-maker-btc.service|/opt/leaf-maker-btc/sequentia-web-wallet|leafmakerbtc|127.0.0.1:9978 leaf-maker.service|/opt/leaf-maker/sequentia-web-wallet|leafmaker|127.0.0.1:9979 leaf-maker-agents.service|/opt/leaf-maker/sequentia-web-wallet|leafmaker|127.0.0.1:9977}"
: "${STATE:=/root/deploy-leaf-makers}"
: "${LOCK:=/run/lock/deploy-leaf-makers.lock}"
: "${SYSTEMCTL:=systemctl}"
: "${JOURNALCTL:=journalctl}"
: "${HEALTH_LOCK:=/run/lock/seqob-liquidity-health.lock}"   # the makers' health run's: held while a maker restarts
: "${FIRM_AT:=127.0.0.1:9979}"   # the maker whose firm offers are timed at the end
exec 9>"$LOCK"; flock -n 9 || { echo "already running"; exit 0; }
step() { STEP="$1"; printf '\n=== %s === %s\n' "$1" "$(date -u +%H:%M:%SZ)"; }
say()  { printf '  %s\n' "$*"; }
die()  { printf '\nSTOPPED in step "%s": %s\n' "${STEP:-start}" "$*" >&2; exit 1; }
# git in a checkout, as `user`, told the checkout is safe.
g() { local dir=$1 user=$2; shift 2
  runuser -u "$user" -- git -c safe.directory="$dir" -c http.version=HTTP/1.1 -C "$dir" "$@"; }
# The checkouts, once each, in the makers' order.
checkouts() { local seen="" m dir; for m in $MAKERS; do IFS='|' read -r _ dir _ _ <<<"$m"; case " $seen " in *" $dir "*) ;; *) seen="$seen $dir"; echo "$dir";; esac; done; }
# The units of a checkout among the makers, and every other unit running from it.
units_of() { local dir=$1 u; for u in $($SYSTEMCTL list-units --type=service --no-legend --plain | awk '{print $1}'); do
  [ "$($SYSTEMCTL show -p WorkingDirectory --value "$u" 2>/dev/null)" = "$dir" ] && echo "$u"; done; return 0; }
restart() { local u=$1
  # No refill of the makers' health run moves coins while a maker restarts: its lock, for this step.
  exec 8>>"$HEALTH_LOCK"; flock -w 900 8 || die "the makers' health run held $HEALTH_LOCK for 15 minutes"
  $SYSTEMCTL restart "$u"
  exec 8>&-
  for _ in $(seq 30); do $SYSTEMCTL is-active --quiet "$u" && return 0; sleep 1; done
  die "$u did not come back after its restart"; }
# /health of the maker at `addr` as "ok sync-passes upkeep-passes why", or "none".
health() { local h
  h=$(curl -sf --max-time 10 "http://$1/health" 2>/dev/null) || { echo none; return; }
  python3 -I -c 'import json,sys; h=json.loads(sys.argv[1]); print("%s %s %s %s" % (str(h.get("ok")).lower(), (h.get("sync") or {}).get("passes", 0), (h.get("upkeep") or {}).get("passes", 0), (h.get("why") or "-").replace(" ", "_")))' "$h" 2>/dev/null || echo none; }
# Waits for the maker of `unit` at `addr` to end a sync pass within SYNC_WAIT and an upkeep pass
# within UPKEEP_WAIT of `since`, and to say ok. -> nothing, or the reason it missed (on stdout).
watch() { local unit=$1 addr=$2 since=$3 now ok sp up why synced=""
  while :; do
    now=$(date +%s)
    $SYSTEMCTL is-active --quiet "$unit" || { echo "$unit stopped running"; return; }
    read -r ok sp up why <<<"$(health "$addr")"
    if [ "$ok" != none ] && [ "${sp:-0}" -ge 1 ] && [ -z "$synced" ]; then synced=$((now - since)); say "$unit: first sync pass ended within ${synced} s" >&2; fi
    if [ -n "$synced" ] && [ "${up:-0}" -ge 1 ]; then
      if [ "$ok" = true ]; then
        say "$unit: first upkeep pass ended within $((now - since)) s; /health ok" >&2
        # What the makers' deploy always checked: quotes answered, a working-coin size logged, and
        # a library that cuts a refresh into pieces.
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$addr/v1/quotes" || true)
        [ "$code" = 200 ] || { echo "$unit does not answer its quotes (HTTP ${code:-none})"; return; }
        j=$($JOURNALCTL -u "$unit" --since "@$since" --no-pager -o cat 2>/dev/null || true)
        grep -q 'does not cut a refresh into pieces' <<<"$j" && { echo "$unit's library does not cut a refresh into pieces"; return; }
        l=$(grep -E 'working coins of at most' <<<"$j" | tail -n 1 | cut -c1-200 || true)
        [ -n "$l" ] || { echo "$unit logged no working-coin size since its restart"; return; }
        say "$unit: answers quotes; ${l#* }" >&2
        return
      fi
      echo "$unit's /health is not ok: ${why//_/ }"; return
    fi
    [ -z "$synced" ] && [ $((now - since)) -gt "$SYNC_WAIT" ] && { echo "$unit ended no sync pass within $SYNC_WAIT s (/health: ${ok:-none}, ${why//_/ })"; return; }
    [ $((now - since)) -gt "$UPKEEP_WAIT" ] && { echo "$unit ended no upkeep pass within $UPKEEP_WAIT s (/health: ${ok:-none})"; return; }
    sleep "$POLL"
  done; }
# Puts `dir` back on `prev` and restarts `units` (the ones this script restarted from it), then stops.
roll_back() { local dir=$1 user=$2 prev=$3 why=$4 u; shift 4
  step "roll back $dir"
  say "$why"
  g "$dir" "$user" checkout --quiet --detach "$prev"
  printf '%s %s back to %s: %s\n' "$(date -u +%FT%TZ)" "$dir" "$prev" "$why" >> "$STATE/history"
  for u in "$@"; do restart "$u"; say "$u restarted on $(g "$dir" "$user" log -1 --format='%h %s')"; done
  die "rolled back: $why. $dir runs ${prev:0:9} again; nothing after it moved"; }

STEP="check before changing anything"; step "$STEP"
for dir in $(checkouts); do
  user=$(for m in $MAKERS; do IFS='|' read -r _ d u _ <<<"$m"; [ "$d" = "$dir" ] && { echo "$u"; break; }; done)
  [ -d "$dir/.git" ] || die "$dir is not a checkout"
  id "$user" >/dev/null 2>&1 || die "no user $user"
  g "$dir" "$user" fetch --quiet origin || die "fetch failed in $dir"
  g "$dir" "$user" cat-file -e "$COMMIT^{commit}" 2>/dev/null || die "$COMMIT is not in $dir's fetched history"
  [ -z "$(g "$dir" "$user" status --porcelain --untracked-files=no)" ] || die "$dir has modified tracked files"
  if [ "${ALLOW_BACK:-0}" != 1 ] && ! g "$dir" "$user" merge-base --is-ancestor HEAD "$COMMIT"; then
    die "$COMMIT does not contain what $dir runs now ($(g "$dir" "$user" log -1 --format='%h %s')): deploy a commit that does, or ALLOW_BACK=1"
  fi
  built=$(g "$dir" "$user" show "$COMMIT:leaves/pkg/BUILT_FROM" 2>/dev/null | tr -d '[:space:]' || true)
  [ "$built" = "$LIBRARY" ] || die "$COMMIT's leaves/pkg is built from ${built:-nothing}, not $LIBRARY"
  g "$dir" "$user" cat-file -e "$FLOOR^{commit}" 2>/dev/null || die "$FLOOR is not in $dir's fetched history"
  g "$dir" "$user" merge-base --is-ancestor "$FLOOR" "$COMMIT" || die "$COMMIT does not contain web $FLOOR: deploy a commit that does"
  maker=$(g "$dir" "$user" show "$COMMIT:tooling/lsp/leaf-maker.mjs")
  grep -q 'export function workingSizes' <<<"$maker" || die "$COMMIT's maker keeps no working coins (web wallet #643)"
  grep -q 'export function roomNow' <<<"$maker" || die "$COMMIT's maker sizes quotes on its coins, not a pass's room"
  grep -q 'export function syncStanding' <<<"$maker" || die "$COMMIT's maker quotes on whatever its sync does: it does not stop when no pass ends"
  # Every unit that runs from the checkout restarts on the new commit: only the makers named and the
  # volume wallets may, anything else is refused before anything moves.
  for u in $(units_of "$dir"); do
    named=0; for m in $MAKERS; do IFS='|' read -r mu _ _ _ <<<"$m"; [ "$mu" = "$u" ] && named=1; done
    # shellcheck disable=SC2053
    [ "$named" = 1 ] || [[ "$u" == $OTHER_UNITS ]] || die "$u runs from $dir and is neither a maker named in MAKERS nor a unit of $OTHER_UNITS: it would restart on the new commit; stop it, move it, or name it"
  done
  say "$dir: at $(g "$dir" "$user" log -1 --format='%h' HEAD), can move to ${COMMIT:0:9} (leaf library arca ${LIBRARY:0:9})"
done
for m in $MAKERS; do IFS='|' read -r unit dir _ addr <<<"$m"
  $SYSTEMCTL is-active --quiet "$unit" || die "$unit is not running: start it, or name the makers in MAKERS"
  say "$unit: active, /health $(health "$addr" | awk '{print "ok=" $1}')"
done
if [ "${DRY:-0}" = 1 ]; then printf '\n=== dry run: nothing changed ===\n'; exit 0; fi
[ -d "$STATE" ] || install -d -m 700 "$STATE"

declare -A PREV=() MOVED=() RESTARTED=()
for m in $MAKERS; do
  IFS='|' read -r unit dir user addr <<<"$m"
  STEP="$unit"; step "$STEP"
  if [ -z "${PREV[$dir]:-}" ]; then
    PREV[$dir]=$(g "$dir" "$user" rev-parse HEAD)
    if [ "${PREV[$dir]}" = "$COMMIT" ]; then MOVED[$dir]=0; say "$dir is already at ${COMMIT:0:9}"
    else
      g "$dir" "$user" checkout --quiet --detach "$COMMIT"; MOVED[$dir]=1
      printf '%s %s from %s to %s\n' "$(date -u +%FT%TZ)" "$dir" "${PREV[$dir]}" "$COMMIT" >> "$STATE/history"
      say "$dir moved from ${PREV[$dir]:0:9} to $(g "$dir" "$user" log -1 --format='%h %s')"
    fi
    [ "$(tr -d '[:space:]' < "$dir/leaves/pkg/BUILT_FROM")" = "$LIBRARY" ] || die "$dir/leaves/pkg is not built from $LIBRARY"
  fi
  if [ "${MOVED[$dir]}" != 1 ] && [ "${FORCE_RESTART:-0}" != 1 ]; then
    say "$unit: its checkout did not move, not restarted"
    read -r ok _ _ why <<<"$(health "$addr")"
    [ "$ok" = true ] || die "$unit's /health is not ok: ${why//_/ }"
    say "$unit: /health ok"; continue
  fi
  # The store as the new library sees it, from a private copy (the maker's own config and node). A
  # sizing that fails, or answers no sizing, stops this maker: its checkout goes back (SIZE=0 skips it).
  if [ "$SIZE" = 1 ]; then
    exe=$($SYSTEMCTL show -p ExecStart --value "$unit" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
    cfg=$($SYSTEMCTL show -p ExecStart --value "$unit" | sed -n 's/.*--config \([^ ;]*\).*/\1/p')
    serr="" sized="" summary="" errf=$(mktemp)
    if [ -z "$exe" ] || [ -z "$cfg" ]; then serr="no node or no --config in its ExecStart, so its store cannot be sized"
    elif ! sized=$(cd "$dir" && timeout 900 runuser -u "$user" -- "$exe" tooling/lsp/leaf-maker.mjs --config "$cfg" --size 2>"$errf"); then
      serr="its store's sizing failed: $(tail -c 300 "$errf" | tr '\n' ' ')"
    elif ! summary=$(python3 -I -c '
import json, sys
v = json.loads(sys.argv[1])
r = v["steps"]["refresh"]; b = r["before_items_ms"]; p = r["refused_participations"]
print("  store %d MB, %d live coins; refresh: %d items, %d refused/void/expired participations naming %d coins" % (v["store"]["bytes"] // 1000000, v["store"]["live_coins"], r["items"], p["refused"] + p["void"] + p["expired"], p["coins_named"]))
print("  before refresh'"'"'s items, each slice: %d ms (an older library: %d ms); once a change: %d ms; sized in %d ms" % (b["refused_each_slice"], b["refused_each_slice_by_an_older_library"], b["refused_read_once"], v["took_ms"]))
' "$sized" 2>/dev/null); then serr="its store's sizing answered no sizing: $(printf '%s' "$sized" | tail -c 200 | tr '\n' ' ')"
    fi
    rm -f "$errf"
    if [ -n "$serr" ]; then
      # shellcheck disable=SC2086
      roll_back "$dir" "$user" "${PREV[$dir]}" "$unit: $serr" ${RESTARTED[$dir]:-}
    fi
    printf '%s\n' "$summary"
  fi
  since=$(date +%s)
  restart "$unit"; RESTARTED[$dir]="${RESTARTED[$dir]:-} $unit"
  say "$unit restarted on ${COMMIT:0:9}; watching its /health (sync pass within $SYNC_WAIT s, upkeep pass within $UPKEEP_WAIT s)"
  missed=$(watch "$unit" "$addr" "$since")
  if [ -n "$missed" ]; then
    # shellcheck disable=SC2086
    roll_back "$dir" "$user" "${PREV[$dir]}" "$missed" ${RESTARTED[$dir]}
  fi
done

STEP="the other units that run from a maker checkout"; step "$STEP"
for dir in $(checkouts); do
  [ "${MOVED[$dir]:-0}" = 1 ] || [ "${FORCE_RESTART:-0}" = 1 ] || continue
  for u in $(units_of "$dir"); do
    case " ${RESTARTED[$dir]:-} " in *" $u "*) continue;; esac
    # shellcheck disable=SC2053
    [[ "$u" == $OTHER_UNITS ]] || die "$u runs from $dir and is not a unit of $OTHER_UNITS: not restarted"
    restart "$u"; say "$u restarted"
  done
done

STEP="time the leaf maker's firm offers"; step "$STEP"
# Three firm offers of the smallest size the leaf maker quotes, each released at once: nothing is
# traded. The time is what a taker waits for a price.
q=$(curl -sf --max-time 10 "http://$FIRM_AT/v1/quotes" || true)
pair=$(python3 -I -c 'import json,sys; q=[x for x in json.loads(sys.argv[1])["quotes"] if x["give_asset"]!="BTC" and x["want_asset"]!="BTC"][0]; print(json.dumps({"give_asset":q["give_asset"],"want_asset":q["want_asset"],"give":q["min_give"]}))' "$q" 2>/dev/null) || pair=""
if [ -z "$pair" ]; then say "the leaf maker on $FIRM_AT quotes no in-tree pair now: not timed"; else
  f=$(mktemp)
  for k in 1 2 3; do
    out=$(curl -s -o "$f" -w '%{http_code} %{time_total}' --max-time 30 -H 'content-type: application/json' -d "$pair" "http://$FIRM_AT/v1/firm" || true)
    swap=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("swap",""))' "$f" 2>/dev/null || true)
    [ -n "$swap" ] && curl -s -o /dev/null --max-time 10 -H 'content-type: application/json' -d "{\"swap\":\"$swap\"}" "http://$FIRM_AT/v1/release" || true
    say "firm offer $k: HTTP ${out%% *} in ${out#* } s"
    sleep 3
  done
  rm -f "$f"
fi
STEP="the makers' forfeit pass"; step "$STEP"
# The pass runs every 30 s ahead of each maker's queue; a refusal or an error is logged "forfeits:".
for m in $MAKERS; do IFS='|' read -r unit _ _ _ <<<"$m"
  errs=$($JOURNALCTL -u "$unit" --since "-2 min" --no-pager -o cat 2>/dev/null | grep -c ' forfeits: ' || true)
  say "$unit: ${errs:-0} forfeit refusal(s) or error(s) in the last 2 minutes"
done

printf '\n=== done ===\n  Every leaf maker runs %s (leaf library arca %s), each with a sync pass and an upkeep pass ended and /health ok.\n' "${COMMIT:0:9}" "${LIBRARY:0:9}"
