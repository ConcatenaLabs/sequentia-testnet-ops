#!/usr/bin/env bash
# fronting-read.sh: what the testnet Arca operator fronts, why, and what fronting the market needs
# once fronted capital comes back promptly. Read-only: SELECTs on the operator's database (read-only
# transaction) and GETs of its own /v1/info and /v1/chain. Changes nothing, writes no file.
#
#   bin/fronting-read.sh                                  (on the box, as root)
#   SINCE="2026-11-01 02:00Z" bin/fronting-read.sh
#
# SINCE: start of the window the refresh demand and return times are read over (default 72 hours ago).
# TRADES_SINCE: start of the window for in-Ark payments (default 7 days ago).
# PRICED_TARGET (USD, default 200000) and TSEQ_TARGET (tSEQ, default 5000000): the operator's
# fronting plan. Values in USD use the operator node's rates (the mock price feed), 1 rfa = 1e-8 USD.
# A minute or two. Safe to paste any number of times. Prints no password.
set -Eeuo pipefail
export LC_ALL=C
: "${SINCE:=$(date -u -d '-72 hours' '+%Y-%m-%d %H:%M:%SZ')}"
: "${TRADES_SINCE:=$(date -u -d '-7 days' '+%Y-%m-%d %H:%M:%SZ')}"
: "${PRICED_TARGET:=200000}"
: "${TSEQ_TARGET:=5000000}"
: "${TSEQ:=c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40}"
: "${LISTEN:=127.0.0.1:3535}"
: "${ARCA_USER:=arca}"
: "${DB:=host=/var/run/postgresql port=5432 user=arca dbname=arca}"
: "${PSQL:=/usr/lib/postgresql/16/bin/psql}"
: "${TICKERS_FROM:=/etc/leaf-maker/maker.json}"
: "${LOCK:=/run/lock/fronting-read.lock}"
step() { STEP="$*"; printf '\n=== %s === %s\n' "$*" "$(date -u +%H:%M:%SZ)"; }
die()  { printf '\nSTOPPED in step "%s": %s\n' "${STEP:-start}" "$*"; exit 1; }
trap 'printf "\nSTOPPED in step \"%s\": unexpected failure: %s\n" "${STEP:-start}" "$BASH_COMMAND"' ERR
exec 9> "$LOCK"; flock -n 9 || { echo "already running"; exit 0; }
q() {  # read-only SQL on stdin, as the operator's database user, the window bound as :since / :trades
  local sql; sql=$(cat)
  printf 'SET default_transaction_read_only = on; SET statement_timeout = 300000;\n\\set since %s\n\\set trades %s\n%s\n' \
    "'$SINCE'" "'$TRADES_SINCE'" "$sql" \
    | ( cd /tmp && runuser -u "$ARCA_USER" -- "$PSQL" "$DB" -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f - )
}

step "the operator's figures"
command -v "$PSQL" >/dev/null || die "no psql at $PSQL"
info=$(curl -fsS --max-time 120 "http://$LISTEN/v1/info") || die "/v1/info did not answer"
chain=$(curl -fsS --max-time 120 "http://$LISTEN/v1/chain") || die "/v1/chain did not answer"
tickers=$(python3 -I -c 'import json,sys
try: print(json.dumps({k: v.get("ticker") for k, v in json.load(open(sys.argv[1]))["prices"]["assets"].items()}))
except Exception: print("{}")' "$TICKERS_FROM")
printf '  window: refreshes since %s, in-Ark payments since %s\n' "$SINCE" "$TRADES_SINCE"

step "what is in flight now, and why"
causes=$(q <<'SQL'
WITH RECURSIVE given AS MATERIALIZED (
   SELECT pi.leaf_id, pi.asset, pi.value FROM participation_input pi
   JOIN participation p USING (participation_id) JOIN round r ON r.round_id = p.round_id
   WHERE pi.active AND p.state IN ('issued', 'released') AND r.state IN ('broadcast', 'final')),
 up (root, asset, leaf_id, depth) AS (
   SELECT leaf_id, asset, leaf_id, 0 FROM given
   UNION
   SELECT u.root, u.asset, p.parent, u.depth + 1 FROM up u
   JOIN transfer_output o ON o.leaf_id = u.leaf_id
   JOIN LATERAL (SELECT ti.leaf_id AS parent FROM transfer_input ti WHERE ti.transfer_id = o.transfer_id
                 UNION ALL SELECT f.order_leaf FROM order_fill f WHERE f.transfer_id = o.transfer_id) p ON true
   WHERE u.depth < 8),
 swept AS MATERIALIZED (
   SELECT DISTINCT b.round_id, b.vout FROM batch b JOIN watcher_tx w ON w.subject = b.token JOIN nursery_tx n USING (txid)
   WHERE w.kind = 'sweep' AND n.state = 'final'),
 back AS MATERIALIZED (
   SELECT rl.leaf_id FROM reclaimed_leaf rl JOIN nursery_tx n USING (txid) WHERE n.state <> 'lost'
   UNION
   SELECT nr.leaf_id FROM node_release nr JOIN watcher_tx w ON w.kind = 'reclaim' AND w.subject = nr.node_hash
   JOIN nursery_tx n ON n.txid = w.txid WHERE n.state <> 'lost'
   UNION
   SELECT bl.leaf_id FROM batch_leaf bl JOIN batch b ON b.round_id = bl.round_id AND b.vout = bl.vout
   JOIN watcher_tx w ON w.kind = 'forfeit' AND w.subject = bl.leaf_id JOIN nursery_tx n ON n.txid = w.txid
   WHERE b.collect_mtp IS NOT NULL AND n.state = 'final'),
 held AS MATERIALIZED (
   SELECT u.root, bl.leaf_id, bl.round_id, bl.vout FROM up u
   JOIN batch_leaf bl ON bl.leaf_id = u.leaf_id JOIN batch b ON b.round_id = bl.round_id AND b.vout = bl.vout
   JOIN round r ON r.round_id = b.round_id
   WHERE b.asset = u.asset AND r.state IN ('broadcast', 'final') AND b.kind = 'tree'
     AND NOT EXISTS (SELECT 1 FROM swept s WHERE s.round_id = bl.round_id AND s.vout = bl.vout)
     AND NOT EXISTS (SELECT 1 FROM back k WHERE k.leaf_id = bl.leaf_id)),
 bsz AS (SELECT bl.round_id, bl.vout, count(*) n, max(b.radix) radix FROM batch_leaf bl JOIN batch b USING (round_id, vout)
         WHERE (bl.round_id, bl.vout) IN (SELECT round_id, vout FROM held) GROUP BY 1, 2),
 pos AS (SELECT bl.leaf_id, bl.round_id, bl.vout, bl.idx, bl.owner_key, bl.participation_id, bl.value, s.n, ((s.n + s.radix - 1) / s.radix) k
         FROM batch_leaf bl JOIN bsz s USING (round_id, vout)),
 node AS (SELECT p.*, CASE WHEN p.idx < (p.n % p.k) * (p.n / p.k + 1) THEN p.idx / (p.n / p.k + 1)
                      ELSE (p.n % p.k) + (p.idx - (p.n % p.k) * (p.n / p.k + 1)) / (p.n / p.k) END node FROM pos p),
 opennode AS (SELECT DISTINCT n.round_id, n.vout, n.node FROM node n JOIN held h USING (leaf_id)),
 cls AS (SELECT m.*, l.state::text st,
   EXISTS (SELECT 1 FROM node_release nr WHERE nr.leaf_id = m.leaf_id AND NOT nr.retired) rel,
   EXISTS (SELECT 1 FROM transfer_input ti JOIN transfer t USING (transfer_id) WHERE ti.leaf_id = m.leaf_id AND t.state = 'signed')
     OR EXISTS (SELECT 1 FROM order_fill f WHERE f.order_leaf = m.leaf_id AND f.signature IS NOT NULL) xfer,
   EXISTS (SELECT 1 FROM delegation d WHERE d.leaf_id = m.leaf_id) deleg,
   EXISTS (SELECT 1 FROM back k WHERE k.leaf_id = m.leaf_id) bk,
   EXISTS (SELECT 1 FROM resting_order ro WHERE ro.current_leaf = m.leaf_id) resting,
   EXISTS (SELECT 1 FROM participation_output po WHERE po.participation_id = m.participation_id AND po.order_terms IS NOT NULL) ochange,
   (SELECT encode(substr(lm.mailbox_key, 1, 5), 'hex') FROM leaf_mailbox lm WHERE lm.owner_key = m.owner_key) mb,
   EXISTS (SELECT 1 FROM participation_input pi JOIN participation p USING (participation_id)
           WHERE pi.leaf_id = m.leaf_id AND ((pi.active AND p.state IN ('pending', 'issued'))
              OR (p.waiting LIKE 'This refresh waits%' AND p.created_at > now() - interval '1 hour'))) ropen
   FROM node m JOIN opennode o USING (round_id, vout, node) JOIN leaf l USING (leaf_id)),
 c2 AS (SELECT *, CASE WHEN bk OR rel THEN NULL WHEN xfer AND deleg THEN 'deleg' WHEN xfer THEN 'nodeleg'
           WHEN resting THEN 'resting' WHEN ropen THEN 'waiting'
           WHEN st = 'spent' THEN 'spent-norelease' WHEN ochange THEN 'idle-orderchange' ELSE 'idle' END c FROM cls),
 ns AS (SELECT c2.round_id, c2.vout, c2.node, bool_or(b.delegated_reclaim) dr, array_agg(DISTINCT c2.c) FILTER (WHERE c2.c IS NOT NULL) x,
          string_agg(DISTINCT c2.c || ':' || coalesce(c2.mb, '-'), ',') FILTER (WHERE c2.c LIKE 'idle%') who
        FROM c2 JOIN batch b USING (round_id, vout) GROUP BY 1, 2, 3),
 rootcls AS (SELECT g.asset, g.leaf_id, g.value, min(r.created_at) rc,
   CASE WHEN bool_or(NOT ns.dr AND 'nodeleg' = ANY(ns.x)) THEN 'A collection only (old batch, no RECLAIM-D; a coin paid on without a delegation)'
        WHEN bool_or('nodeleg' = ANY(ns.x)) THEN 'B a coin paid on without a delegation'
        WHEN bool_or('idle-orderchange' = ANY(ns.x)) THEN 'C idle: change of an order placement'
        WHEN bool_or('resting' = ANY(ns.x)) THEN 'D a resting order coin on its node'
        WHEN bool_or('idle' = ANY(ns.x)) THEN 'E idle: a holder who has not refreshed'
        WHEN bool_or('waiting' = ANY(ns.x)) THEN 'F a refresh waiting (cap/funds)'
        WHEN bool_or('spent-norelease' = ANY(ns.x)) THEN 'G refreshed, no release yet'
        WHEN bool_or('deleg' = ANY(ns.x)) THEN 'H delegated payment, coins not all refreshed'
        ELSE 'I nothing left (reclaim due)' END cls,
   min(ns.who) who
   FROM given g JOIN held h ON h.root = g.leaf_id JOIN node n ON n.leaf_id = h.leaf_id JOIN round r ON r.round_id = h.round_id
   JOIN ns ON ns.round_id = n.round_id AND ns.vout = n.vout AND ns.node = n.node GROUP BY 1, 2, 3)
SELECT 'C', encode(t.asset, 'hex'), t.cls, t.n, t.v, t.f, t.l FROM (SELECT asset, cls, count(*) n, sum(value) v,
  to_char(min(rc) AT TIME ZONE 'UTC', 'MM-DD') f, to_char(max(rc) AT TIME ZONE 'UTC', 'MM-DD') l FROM rootcls GROUP BY 1, 2) t ORDER BY 2, 5 DESC;
SQL
)

step "refresh demand, return times and in-Ark payments"
demand=$(q <<'SQL'
-- refreshes since :since, by asset and cause, with the return time of each given coin
WITH RECURSIVE p AS MATERIALIZED (
  SELECT p.participation_id, r.created_at t0,
    EXISTS (SELECT 1 FROM participation_output po WHERE po.participation_id = p.participation_id AND po.order_terms IS NOT NULL) ord,
    EXISTS (SELECT 1 FROM participation_output po WHERE po.participation_id = p.participation_id AND po.kind = 'offboard') off,
    EXISTS (SELECT 1 FROM participation_input pi JOIN leaf l USING (leaf_id) WHERE pi.participation_id = p.participation_id AND pi.active AND l.kind::text IN ('transfer','fill')) recv
  FROM participation p JOIN round r ON r.round_id = p.round_id
  WHERE p.state IN ('issued','released') AND r.state IN ('broadcast','final') AND r.created_at >= timestamptz :'since'),
 given AS MATERIALIZED (
  SELECT pi.leaf_id, pi.asset, pi.value, p.t0, l.kind::text lk,
    CASE WHEN p.off THEN 'offboard' WHEN p.ord THEN 'order placement' WHEN p.recv THEN 'received coins settled' ELSE 'coins of a round refreshed again' END cause
  FROM p JOIN participation_input pi USING (participation_id) JOIN leaf l ON l.leaf_id = pi.leaf_id WHERE pi.active),
 up (root, asset, leaf_id, depth) AS (
   SELECT leaf_id, asset, leaf_id, 0 FROM given
   UNION
   SELECT u.root, u.asset, q.parent, u.depth + 1 FROM up u
   JOIN transfer_output o ON o.leaf_id = u.leaf_id
   JOIN LATERAL (SELECT ti.leaf_id AS parent FROM transfer_input ti WHERE ti.transfer_id = o.transfer_id
                 UNION ALL SELECT f.order_leaf FROM order_fill f WHERE f.transfer_id = o.transfer_id) q ON true
   WHERE u.depth < 8),
 back AS MATERIALIZED (
   SELECT leaf_id, min(t) t FROM (
     SELECT rl.leaf_id, w.created_at t FROM reclaimed_leaf rl JOIN nursery_tx n USING (txid) JOIN watcher_tx w USING (txid) WHERE n.state <> 'lost'
     UNION ALL
     SELECT nr.leaf_id, w.created_at FROM node_release nr JOIN watcher_tx w ON w.kind = 'reclaim' AND w.subject = nr.node_hash
     JOIN nursery_tx n ON n.txid = w.txid WHERE n.state <> 'lost'
     UNION ALL
     SELECT bl.leaf_id, w.created_at FROM batch_leaf bl JOIN batch b ON b.round_id = bl.round_id AND b.vout = bl.vout
     JOIN watcher_tx w ON w.kind = 'forfeit' AND w.subject = bl.leaf_id JOIN nursery_tx n ON n.txid = w.txid
     WHERE b.collect_mtp IS NOT NULL AND n.state = 'final') x GROUP BY 1),
 slots AS (
   SELECT u.root, bool_and(b.delegated_reclaim) dr, bool_and(k.t IS NOT NULL) ret, max(k.t) tb, count(*) n FROM up u
   JOIN batch_leaf bl ON bl.leaf_id = u.leaf_id JOIN batch b ON b.round_id = bl.round_id AND b.vout = bl.vout
   JOIN round r ON r.round_id = b.round_id LEFT JOIN back k ON k.leaf_id = bl.leaf_id
   WHERE b.asset = u.asset AND r.state IN ('broadcast', 'final') AND b.kind = 'tree' GROUP BY 1),
 m AS (
   SELECT g.*, s.dr, s.ret, extract(epoch FROM (s.tb - g.t0)) / 60.0 mins, s.n IS NOT NULL fronted
   FROM given g LEFT JOIN slots s ON s.root = g.leaf_id)
SELECT 'D', encode(asset, 'hex'), cause,
  count(*), coalesce(sum(value) FILTER (WHERE fronted), 0), coalesce(sum(value) FILTER (WHERE NOT fronted), 0),
  coalesce(sum(value) FILTER (WHERE fronted AND dr AND ret), 0),
  coalesce(round(sum(value * mins) FILTER (WHERE fronted AND dr AND ret) / nullif(sum(value) FILTER (WHERE fronted AND dr AND ret), 0)), -1),
  coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) FILTER (WHERE fronted AND dr AND ret)), -1),
  coalesce(round(percentile_cont(0.9) WITHIN GROUP (ORDER BY mins) FILTER (WHERE fronted AND dr AND ret)), -1),
  coalesce(sum(value) FILTER (WHERE fronted AND NOT ret), 0)
FROM m GROUP BY 2, 3 ORDER BY 2, 3;
-- in-Ark payments since :since: what wallets were paid out of round, by asset
SELECT 'P', encode(l.asset, 'hex'), count(*), sum(l.value), coalesce(max(d.v), 0) FROM leaf l
  LEFT JOIN LATERAL (SELECT max(s) v FROM (SELECT date_trunc('day', l2.created_at) dd, sum(l2.value) s FROM leaf l2
     WHERE l2.asset = l.asset AND l2.kind::text IN ('transfer', 'fill') AND l2.created_at >= timestamptz :'trades' GROUP BY 1) z) d ON true
  WHERE l.kind::text IN ('transfer', 'fill') AND l.created_at >= timestamptz :'trades' GROUP BY 2;
SELECT 'H', extract(epoch FROM (now() - timestamptz :'since')) / 3600.0, extract(epoch FROM (now() - timestamptz :'trades')) / 3600.0;
SQL
)

step "what fronting this market needs"
export PRICED_TARGET TSEQ_TARGET TSEQ
IFS= read -r -d '' model <<'PY' || true
import json, os
fd = lambda n: os.fdopen(n).read()
info, chain, tick = json.loads(fd(3)), json.loads(fd(4)), json.loads(fd(5))
CAUSES, DEMAND = fd(6), fd(7)
TSEQ, PT, TT = os.environ["TSEQ"], float(os.environ["PRICED_TARGET"]), float(os.environ["TSEQ_TARGET"])
rate = {a["asset"]: int(a["rate"]["rate"]) for a in info.get("assets", []) if a.get("rate") and a["rate"].get("rate")}
disp = lambda internal: bytes.fromhex(internal)[::-1].hex()          # the database keeps asset ids in internal order
name = lambda a: ("tSEQ" if tick.get(a) == "SEQ" else tick.get(a)) or a[:8]
units = lambda a, atoms: atoms / 1e8
usd = lambda a, atoms: atoms * rate.get(a, 0) / 1e16
money = lambda v: f"${v:,.0f}"
say = lambda s="": print("  " + s if s else "")
rows = lambda txt, tag: [l.split("|") for l in txt.splitlines() if l.startswith(tag + "|")]

# 1. In flight now, by cause.
say("In flight now (/v1/chain pool), and what holds it (each given-up coin classed by the first cause on its node):")
pool = chain.get("pool", {})
causes = {}
for _, a, cls, n, v, f, l in rows(CAUSES, "C"):
    causes.setdefault(disp(a), []).append((cls, int(n), int(v), f, l))
tot_priced = 0
for a in sorted(pool, key=lambda a: -usd(a, int(pool[a].get("in_flight", "0") or 0))):
    inf = int(pool[a].get("in_flight", "0") or 0)
    if inf <= 0: continue
    if a != TSEQ: tot_priced += usd(a, inf)
    say(f"{name(a)}: {units(a, inf):,.0f} ({money(usd(a, inf))})")
    for cls, n, v, f, l in causes.get(a, []):
        say(f"    {cls[2:]}: {units(a, v):,.0f} ({money(usd(a, v))}), {n} coins given up in rounds {f} to {l}")
say(f"priced assets in flight: {money(tot_priced)} against a plan of {money(PT)}")

# 2. Refresh demand by cause, and return times.
dem = rows(DEMAND, "D")
h = [l.split("|") for l in DEMAND.splitlines() if l.startswith("H|")][0]
H, HT = float(h[1]), float(h[2])
pay = {disp(r[1]): (int(r[2]), int(r[3]), int(r[4])) for r in rows(DEMAND, "P")}
say()
say(f"Refresh demand over the last {H:.0f} h, by cause (fronted: the coins given up that rest on a round's leaf;")
say("a board's forfeit pays the operator back at once and fronts nothing), and how long the value took to come back")
say("for coins whose old leaf is in a batch with RECLAIM-D (value-weighted mean, p50, p90, in minutes):")
per = {}
for _, a, cause, n, fr, free, ret, vw, p50, p90, out in dem:
    a = disp(a); fr, ret, vw, out = int(fr), int(ret), int(vw), int(out)
    d = per.setdefault(a, {"causes": {}, "ret": 0, "retmin": 0.0, "W": {}})
    d["causes"][cause] = fr / H
    if vw >= 0: d["W"][cause] = vw / 60.0
    if vw >= 0:
        d["ret"] += ret; d["retmin"] += ret * vw
    if fr:
        say(f"{name(a)} {cause}: {units(a, fr)/H:,.0f}/h ({money(usd(a, fr)/H)}/h); came back: {'-' if vw < 0 else f'{vw} / {p50} / {p90} min'}; still out {units(a, out):,.0f}")

# 3. Steady state: in flight = demand x return time (Little's law), with every node coming back as
# promptly as the ones that came back did: a coin left at rest no longer pins its node (#584), and a
# node short of several holders' coins is not held by the cap (#594). Merges of coins of a round by
# our makers are counted apart: the makers' merge fix leaves them next to nothing to front.
say()
say("Steady state once returns are fast: in flight = refresh demand x mean return time.")
need = {"all": [0.0, 0.0], "market": [0.0, 0.0], "trades": [0.0, 0.0], "today": [0.0, 0.0]}   # [priced USD, tSEQ]
for a, d in sorted(per.items()):
    if not d["ret"]: continue
    W = d["retmin"] / d["ret"] / 60.0
    lam_all = sum(d["causes"].values())
    lam_mkt = lam_all - d["causes"].get("coins of a round refreshed again", 0)
    t = pay.get(a)
    lam_tr = (t[2] / 24.0) if t else 0.0
    i = 1 if a == TSEQ else 0
    Wr = d["W"].get("received coins settled", W)
    for k, lam, w in (("all", lam_all, W), ("market", lam_mkt, W), ("trades", lam_tr, W), ("today", lam_tr, Wr)):
        need[k][i] += (units(a, lam * w) if i else usd(a, lam * w))
    say(f"{name(a)}: mean return {W*60:.0f} min; as measured {units(a, lam_all*W):,.0f} ({money(usd(a, lam_all*W))}); "
        f"without merges {units(a, lam_mkt*W):,.0f} ({money(usd(a, lam_mkt*W))}); "
        f"the busiest day of in-Ark payments ({units(a, t[2]) if t else 0:,.0f}) refreshed once each {units(a, lam_tr*W):,.0f} ({money(usd(a, lam_tr*W))})")
say()
for k, words in (("all", "refreshes as measured"), ("market", "without our makers' merges"), ("trades", "the busiest day of in-Ark trading"),
                 ("today", "the same, received coins coming back as slowly as they do now")):
    p, s = need[k]
    say(f"{words}: priced {money(p)} of {money(PT)} ({'carried' if p <= PT else f'short: {100*(1-PT/p):.0f}% of that flow would settle on the chain'}); "
        f"tSEQ {s:,.0f} of {TT:,.0f} ({'carried' if s <= TT else f'short: {100*(1-TT/s):.0f}% on the chain'})")

# 4. A larger instant budget: a maker that holds what it receives out of round, up to its budget,
# and pays it on before refreshing, refreshes only what it does not pay on, and at most a fifth of it
# once a coin has moved five times (the depth limit).
b = info.get("bond") or {}
ref = int(b.get("reference_value", "0") or 0) / 1e8
ppm = int(b.get("instant_budget_ppm", 100000) or 100000)
B = ref * ppm / 1e6
rec = sum(usd(a, d["causes"].get("received coins settled", 0)) for a, d in per.items())
say()
say(f"Instant budget: the bond is worth {money(ref)}; a counterparty takes {ppm/1e4:.0f}% of it, {money(B)}, out of round at once.")
say(f"Received coins settled: {money(rec)}/h. A maker holding them unrefreshed up to its budget keeps each for about "
    + ", ".join(f"{(k*B)/rec*60:,.0f} min at {k}x the budget" for k in (1, 2, 5)) if rec else "No received coins were settled in the window.")
say("Refreshes avoided are the received coins it pays on within that time, at most 4/5 of them (the depth limit of 5).")
p = need["trades"][0]
if p > PT:
    say(f"To carry the busiest day within {money(PT)}, {100*(1-PT/p):.0f}% of received coins must be paid on rather than refreshed "
        + ("(within the 4/5 a budget can save)." if 1 - PT/p <= 0.8 else "(more than a budget can save: the rest settles on the chain)."))
PY
python3 -I -c "$model" 3<<< "$info" 4<<< "$chain" 5<<< "$tickers" 6<<< "$causes" 7<<< "$demand"
echo
echo "=== done ==="
