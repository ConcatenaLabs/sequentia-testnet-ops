# sequentia-testnet-ops

What the Sequentia testnet box serves, and the host configuration that routes
it. The box is `sequentiatestnet.com`; every product on it is its own
repository, pulled and built there. This repository holds the one file that
ties them together, the reverse proxy's configuration, and the scripts that
put it in place and keep copies of it.

## What is here

| Path | What |
|---|---|
| `caddy/Caddyfile` | The reverse proxy's configuration: one site, one path per product, TLS from Let's Encrypt. Installed at `/etc/caddy/Caddyfile`. |
| `caddy/caddy.env.example` | The secrets the Caddyfile reads as `{$NAME}` placeholders. The real file is `/etc/caddy/caddy.env`, mode 600, on the box and in the offline backups, never here. |
| `caddy/caddy.service.d/env.conf` | The systemd drop-in that hands `caddy.service` that file. |
| `bin/apply-caddy.sh` | Validates this checkout's Caddyfile against the secrets, installs it, reloads Caddy and checks every route answers. |
| `bin/caddy-drift.sh` | Says whether the live Caddyfile differs from this checkout's. |
| `bin/node-rpc-proxy.py` | The node JSON-RPC for browser wallets behind `/node-rpc`: the calls a wallet makes and no other, rate-limited, with the node's credential added on the box. Installed at `/usr/local/lib/node-rpc-proxy/`. |
| `makers/liquidity-health.sh`, `makers/maker_funds.py`, `makers/liquidity-targets.json` | The makers' and the Arca operator's health, every ten minutes: the depth audit, treasury2026 kept at its floors (minting the faucet assets it runs short of), and every consumer refilled below its floor from `treasury2026` and `maker-bridged` only. See "The makers' health". |
| `makers/volume-takers.mjs` | Traders that trade against the makers on every rail and pair, both ways, at a daily volume target, ramped under load, health and wallet-latency rules. See "Trading volume: the volume takers". |
| `bin/seqdex-depth-audit.py` | How deep every SeqDEX market is on every rail, and whether its best level can be taken now: one table and a verdict per directed market. See "How deep the books are". |
| `bin/arca-pg-restore-drill.sh` | Restores the Arca operator's database from its newest base backup and every WAL segment after it into a scratch cluster, and checks the last commit is there. |
| `postgres/arca.conf` | PostgreSQL's settings for the Arca operator's database: durability on, and every commit waits until the WAL receiver has it. |
| `backup/` | A script, a service and a timer that keep dated copies of the host configuration under `/var/backups/box`, four times a day, sixty deep; the Arca operator's daily PostgreSQL base backup; and the user timers that pull the bridge state and the Arca backups off the box. |
| `logrotate/` | Rotation for the logs services append to. `bridges` covers the bridge services (`compagesd`, `compages-watch`, `compages-reserves`, `sbtc-bridge`): weekly or at 20 MB, twelve kept, compressed. `seqob-makers` covers every maker log under `/root/seqob-test/run`: at 20 MB, two kept, compressed. `bitcoin-ark` covers the Bitcoin ark's Bitcoin Core and Lightning logs under `/var/log/bitcoin-ark`: daily or at 50 MB, seven kept. |
| `systemd/` | The units of the bridge services on the box (`compagesd`, `compages-watch`, `sbtc-bridge`, and the `compages-reserves` snapshot timer) of the makers below (`seqob-pureln-fleet`, `seqob-conf-maker`, `seqob-samechain-fleet`, the `seqob-liquidity-health` timer, `seqob-mixed-gold-eurx-buyer-side`, `seqob-mixed-gold-eurx-seller-side`) of the two Bitcoin-side Lightning nodes (`seqob-ln-btc-maker`, `seqob-ln-btc-taker`), of the Arca operator (`arca-signer`, `arcad`, `arca-pg-wal`, `arca-pg-basebackup`, and its Lightning node `arca-ln`, with `arcad.service.d/bitcoin-ark.conf` where the Bitcoin ark runs), of the node JSON-RPC for browser wallets (`node-rpc-proxy`), of the Bitcoin ark (`bitcoin-ark-bitcoind`, `bitcoin-ark-cln`, `bitcoin-ark-captaind`, `bitcoin-ark-watchmand`), of the oracle-bond watcher (`sequentia-oracle-watcher`, which slashes an oracle's bond on two prices for one pair and time and can see no oracle key), and of the status page's checker (`gatus`); none holds a credential, each service reads its own mode-600 config. |
| `bitcoin-ark/` | The Bitcoin ark's configuration templates (Bitcoin Core, the Lightning gateway, Bark's server and watchman) and the one patch its Bark client carries. |
| `makers/` | The scripts that keep SeqOB makers running on the box: `pureln-fleet.sh` (pure-Lightning makers), `supervise-conf.sh` (confidential makers), `samechain-fleet.sh` (interactive same-chain makers), `mixed-maker.sh` (the two mixed GOLD/EURX makers), `covenant_seed_all.mjs` (the on-chain covenant ladder) and `covenant_reclaim.py` (which takes back the coins of its expired orders). Installed in `/root/seqob-test`. `seqob-makers.env.example` names the one secret the shell scripts read; the seeder reads the node's `elements.conf`. |
| `status/gatus.yaml`, `status/site/index.html` | The testnet status page at `sequentiatestnet.com/status/`: the checks [Gatus](https://github.com/TwiN/gatus) runs every minute against the public address (the chain, the explorer, the web wallet, the faucet, Compages, the staking pools, Emissio and the Sequentia Core download), and the page that shows them. See "The status page". |
| `bin/apply-docs.sh` | Pulls [sequentia-docs](https://github.com/ConcatenaLabs/sequentia-docs), the tester guide, builds it with its own `build.sh` and installs it in `/srv/docs`, which the Caddyfile serves at `/docs/`. |
| `bin/apply-status.sh` | Builds Gatus at the pinned version if it is not there, installs its config, its unit (`systemd/gatus.service`) and the page, restarts it and checks every check has run. |
| `regression/` | The regression suite: every capability a person relies on in the web wallet, SeqDEX, Ambra browser and Ambra mobile, checked on the live testnet from a laptop in headless Chromium after each deploy, `node regression/run.mjs`. See `regression/README.md`. |
| `downloads/index.html` | The full download page at `sequentiatestnet.com/download/`, every product the box publishes, installed at `/root/sequentia/downloads/index.html` beside the release files it links; the explorer's server serves that directory. A release edits the product's card here, merges, pulls on the box and runs `bin/apply-downloads.sh`. |
| `downloads/core/index.html` | The Sequentia Core download page at `sequentiatestnet.com/download/core/`, the one the site's front page links: the node and desktop wallet only, reaching the same files through `../`. Installed by the same script. |

## The routes

Read `caddy/Caddyfile`: each `handle_path` names a path and the port the
product listens on. The wallet, the explorer, the bridge, the faucet, the
registry and the download pages fall through to the explorer's own server on
port 8080, which serves them; everything else is proxied to its own process.
That server also renders the site's two menu pages: the front page at `/`,
which links the explorer, the staking pool board, the faucet, the Compages
bridge, Emissio and the Sequentia Core download, and the full menu of every product at
`/secretfullmenu`, which nothing links to.
Two paths sit behind basic auth because they show simulated regulated data;
the SBTC peg path carries a bearer token the browser never sees.

The SeqDEX order-book relays each have a mount. `/seqob` is the on-chain book
(the relay on port 9955), `/seqob-pln` the Lightning book (9965), `/seqob-subas`
and `/seqob-subasbuy` the sub-asset books (9971, 9966): the Caddyfile hands each
to the explorer's server, which forwards every path under a mount to its relay,
the courier's WebSocket included. `/seqob-conf` is the confidential book (9975),
proxied directly. The SeqDEX site at `/dex/` reads a market's book and the fills
of its covenant orders under `/seqob`
(`/seqob/v1/market/{base}/{quote}/orderbook` and `…/fills`), so both come from
the same relay. `apply-caddy.sh` checks that `/seqob`, `/seqob-pln` and
`/seqob-conf` answer, besides the products' pages.

`/leafmaker` is the live leaf maker on port 9979 (the web wallet's
`tooling/lsp/leaf-maker.mjs`, run by `leaf-maker.service` as its own user): the
web wallet's and Ambra's user mode ask it for in-tree swaps at
`/leafmaker/v1/…`. It is not among the routes `apply-caddy.sh` checks, since
the maker runs only once its own owner script has set it up.

`/leafmaker-btc` is the live BTC maker on port 9978: the same program with its
BTC desk, run by `leaf-maker-btc.service` as its own user, its Bitcoin Lightning
node `leaf-maker-btc-ln.service` of its own (channel peer: the service's Bitcoin
node every wallet's hosted Bitcoin node has its channel with). User mode asks it
for BTC trades at `/leafmaker-btc/v1/…`. Like `/leafmaker`, `apply-caddy.sh`
does not check it.

## The status page

`sequentiatestnet.com/status/` says whether the testnet works: the chain's
height, the age of its last block and whether its Bitcoin anchor is current,
then each public service, working or not, with its last hour of checks and its
share of passed checks over a day.

Gatus does the checking. It runs every check in `status/gatus.yaml` once a
minute through the public address, keeps a day of results in
`/var/lib/gatus/data.db` and listens on `127.0.0.1:8097` only. The page,
`status/site/index.html`, is static: it reads two views of Gatus's API that the
Caddyfile publishes under `/status/api/` (the newest results, and one check's
uptime), and the chain's figures from `/chainstatus`, which the explorer's
server computes from its node and the testnet4 indexer. A group on the page is
working when every check in it passed its newest run.

To add or change a check, edit `status/gatus.yaml` (and `SERVICES` in the page
for a new group), merge, then on the box:

```sh
cd /root/sequentia/sequentia-testnet-ops && git pull --ff-only
bin/apply-status.sh
```

A new route under `/status/` also needs `bin/apply-caddy.sh`.

## Changing a route

On a laptop, in a branch: edit `caddy/Caddyfile`, open a pull request, merge
it. On the box:

```sh
cd /root/sequentia/sequentia-testnet-ops && git pull --ff-only
bin/apply-caddy.sh
```

`apply-caddy.sh` refuses a Caddyfile that does not validate and installs
nothing then. An edit made on the box by hand shows up in
`bin/caddy-drift.sh`; commit it here or apply the checkout, so the file the
repository holds is the file that runs.

## The node JSON-RPC for browser wallets

A browser wallet that follows the chain itself (the leaf wallet of the web
wallet and of the extension) needs a node's JSON-RPC, and a browser can hold
no node credential. `/node-rpc` is that node, same-origin with the wallet's
page: `bin/node-rpc-proxy.py`, run by `node-rpc-proxy.service` on
`127.0.0.1:18940`, forwards one call at a time to the node the Arca operator
uses, which runs with `-txindex` and `-validateanchor`, and adds the node's
credential itself. Nothing links to the path.

- **Methods.** Exactly the calls the wallet makes, each with the arguments it
  sends: `getblockchaininfo`, `getblockhash`, `getblockheader`, `getblock`
  (the raw block only), `getrawtransaction`, `gettxout`, `getrawmempool`
  (txids only), `getmempoolentry`, `getmempoolinfo`, `scantxoutset` (`start`
  with single `raw()` or `addr()` scripts), `decodescript`, `getanchorstatus`,
  `getfeeexchangerates`, `dumpassetlabels` (the node's rates are keyed by
  label) and `sendrawtransaction`, the one call that writes.
  Every other method, a wallet's path and named arguments are refused with
  403 (or 404, 400) before the node sees them. A batch of up to 64 of these
  calls is taken as one request, except `sendrawtransaction` and
  `scantxoutset`, which go one at a time; a batch carrying any other call is
  refused whole. The leaf wallet asks for what one check reads of all its
  coins in a batch, and makes the calls one by one where a batch is refused.
- **Rate.** Each source (the address Caddy saw; an IPv6 /48) may make 20
  calls a second, in bursts of 400, and all sources together 200 a second;
  each call in a batch counts as one. `scantxoutset` reads the whole UTXO
  set, and a wallet makes a few after each new block (one per window of its
  on-chain scripts and per output it looks for), none while the chain has not
  moved since its last command: thirty in a row from a
  source, then one a second, and four a second in all, bursts of sixty; they
  run one at a time, each waiting up to a minute for the one before it. A call past a limit is refused with 429.
  Caddy refuses a body over 1 MB.
- **The credential.** The unit runs as a dynamic user with nothing of its own
  to read. A drop-in, `/etc/systemd/system/node-rpc-proxy.service.d/node.conf`,
  names the node's address and hands the process the node's `elements.conf`
  as a systemd credential, from which it reads `rpcuser` and `rpcpassword`;
  the password is in no other file.

Installing it, or changing it, from the checkout:

```sh
install -D -m 644 bin/node-rpc-proxy.py /usr/local/lib/node-rpc-proxy/node-rpc-proxy.py
install -m 644 systemd/node-rpc-proxy.service /etc/systemd/system/
mkdir -p /etc/systemd/system/node-rpc-proxy.service.d
printf '[Service]\nEnvironment=NODE_RPC_URL=http://127.0.0.1:18300/\nLoadCredential=node.conf:/root/seq-testnet/dexnode/elements.conf\n' \
  > /etc/systemd/system/node-rpc-proxy.service.d/node.conf
systemctl daemon-reload && systemctl enable --now node-rpc-proxy.service
bin/apply-caddy.sh
```

## What the proxy answers while levod is down

Caddy answers a 502 or 503 on Levo's paths itself when levod is not there,
so a restart is not a blank page. A page path gets "Levo is restarting", a
small HTML page that says nothing about any sale changes while it is down;
an API path (`/levo/api/*`) gets JSON in the shape levod's own refusals have,
`{"code": "unavailable", "error": "levod is not answering; try again in a
minute"}`, so a client reads a code rather than parses a page. Both come from
the `handle_errors` block in `caddy/Caddyfile`, and Levo's `doc/api.md`
names the JSON answer in its status table.

## A new secret

Add the placeholder to the Caddyfile as `{$NAME}`, the name to
`caddy/caddy.env.example` with a description, and the value to
`/etc/caddy/caddy.env` on the box, in single quotes. `apply-caddy.sh` reads
the file the way systemd does, so a `$` inside a value is safe.

## A release on the download pages

Each page names each product's current file. After the release file is on
the box under `/root/sequentia/downloads/`, edit the product's card here (the
`data-ver` span, the file name, the link) on the full page, and on the Core
page too when the product is Sequentia Core, open a pull request, merge, and
on the box:

```sh
cd /root/sequentia/sequentia-testnet-ops && git pull --ff-only
bin/apply-downloads.sh
```

which installs both pages and checks every file they link is there.

## Backups

```sh
install -m 644 backup/box-config-backup.service backup/box-config-backup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now box-config-backup.timer
backup/box-config-backup.sh                 # the first copy now
```

A copy is a tarball of `/etc/caddy/Caddyfile` and Caddy's own systemd
drop-in, and nothing else under `/etc`: another unit's drop-in may carry a
token, and a copy is meant to hold no secret. Copy `/var/backups/box` off the
box with the rest of the deployment's backups: a lost disk otherwise loses
every route at once.

## Log rotation

```sh
install -m 644 logrotate/bridges logrotate/seqob-makers /etc/logrotate.d/
logrotate -d /etc/logrotate.d/seqob-makers   # dry run: what it would do
```

`compagesd`, `compages-watch`, `compages-reserves` and `sbtc-bridge` append their output to a file
(`StandardOutput=append:`), which keeps it open, so rotation copies the file
and truncates it in place (`copytruncate`) rather than moving it. The maker
supervisors under `/root/seqob-test` append one file per maker to
`/root/seqob-test/run` with a shell `>>` redirect, which rotates the same way.
The system's daily logrotate timer applies both; nothing needs restarting.

## The maker fleets

Every SeqDEX book's depth comes from a maker that is there, or from coins
locked in a covenant on the chain; an offer nobody can fill is never posted. The
assets made markets in are native BTC, tSEQ, USDX, EURX, GOLD, SILVR, OILX,
USDC.e and EURC.e. Restricted assets and sale tokens are left out: their issuers
govern every transfer of them. Each rail, what keeps it deep, and whose coins:

| Rail | Book or endpoint | Maker | Pairs | Coins |
|---|---|---|---|---|
| Covenant orders | `/seqob` (9955) | `makers/covenant_seed_all.mjs`, run by the covenant-reseed and seqob-covenant-topup timers, its stale orders parked by seqob-covenant-park.timer | every pair of the eight Sequentia assets, twenty levels a side | node wallet `covenant-seeder` (dexnode) |
| Interactive same-chain | `/seqob` (9955) | `makers/samechain-fleet.sh`, `seqob-samechain-fleet.service` | every pair of the eight, both sides, ten levels | Ocean accounts `lq-sc-<BASE>-<QUOTE>` |
| Orders resting in the Arca tree | `/seqob` (9955) | the leaf maker's resting desk (`leaf-maker.service`) | every directed pair of the six non-supervised assets, eight levels | the leaf maker's own wallet |
| In-tree swaps (the wallets' user mode) | `/leafmaker` (9979) | `leaf-maker.service` (sequentia-web-wallet `tooling/lsp/leaf-maker.mjs`) | every directed pair of the eight, eight levels | the leaf maker's own wallet |
| BTC in one hash-lock | `/leafmaker-btc` (9978) | `leaf-maker-btc.service`, the same maker with its BTC desk and its own testnet4 Lightning node | BTC against each of the six non-supervised assets, both ways, eight levels | its own wallet and node |
| Lightning | `/seqob-pln` (9965) | `makers/pureln-fleet.sh` | BTC and every pair of the six non-supervised assets, eight levels | the `ln-asset` and `btc-maker` Lightning nodes |
| Cross-chain BTC | `/seqob` (9955) | `supervise-xmakers.sh` on the box | BTC against each of the six, twelve levels | `xmm` (Sequentia), `seqdex-mm-btc` (testnet4) |
| Confidential | `/seqob-conf` (9975) | `makers/supervise-conf.sh` | every directed pair of the six, twenty levels | Ocean accounts `conf2-<BASE>-<QUOTE>` |

USDC.e and EURC.e are supervised: they are never confidential, they do not rest
in the Arca tree, and no Lightning leg carries them, so they trade on the
covenant, interactive and in-tree rails only, and there is no one-step trade
between them and BTC. They are minted by the Compages bridge as deposits arrive,
into the dexnode wallet `maker-bridged`, so their levels are cents and deepen as
supply does. The makers are funded from `treasury2026` (node000) and, for those
two, `maker-bridged`, and from nowhere else; "The makers' health" keeps them
topped up. To see how deep every book is right now, run
`bin/seqdex-depth-audit.py` (see "How deep the books are"), or read
`/root/seqob-test/run/depth-audit.txt` on the box, which the health timer
rewrites every ten minutes.

```sh
install -m 755 makers/pureln-fleet.sh makers/pln_size.py makers/supervise-conf.sh makers/mixed-maker.sh makers/samechain-fleet.sh /root/seqob-test/
install -m 644 makers/covenant_seed_all.mjs /root/seqob-test/
install -m 755 makers/covenant_reclaim.py /root/seqob-test/
install -m 644 systemd/seqob-pureln-fleet.service systemd/seqob-conf-maker.service systemd/seqob-samechain-fleet.service   systemd/seqob-mixed-gold-eurx-buyer-side.service systemd/seqob-mixed-gold-eurx-seller-side.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart seqob-pureln-fleet.service seqob-conf-maker.service seqob-samechain-fleet.service   seqob-mixed-gold-eurx-buyer-side.service seqob-mixed-gold-eurx-seller-side.service
```

Each script launches one maker process per price level and keeps it running:
`pureln-fleet.sh` the pure-Lightning makers (six assets against BTC and every
asset pair, both sides, eight levels), `supervise-conf.sh` the confidential
makers (every directed pair, both sides), `samechain-fleet.sh` the interactive
same-chain makers on the on-chain book (every pair of tSEQ, USDX, EURX, GOLD,
SILVR, OILX, USDC.e and EURC.e, both sides, ten levels a side from one process
each). The maker binaries come from the
`seqdex` checkout on the box; each maker's key is a box-local file created on
first use, and each maker appends to its own log in `/root/seqob-test/run`.

Amounts come from the price feed and the asset registry on the box. Those are
separate services, so a script waits until they answer before it starts
anything, and it starts no maker whose amounts did not come out as whole atoms.
Both scripts compute them each time they launch a maker: a maker retires its
offers at expiry (an hour) and is relaunched at the price of that moment. In
`pureln-fleet.sh` each level is priced on its own size, so the ladder moves away
from the market by its offset only (20 bps at the touch against BTC, 40 bps
between assets, +25 bps a level). Its first level is worth $6,200 against BTC and $10,500
between assets (`PLN_BTC_L1_USD`, `PLN_AA_L1_USD`), so the first 1% holds about $50,000 a
side, and each level is 1.5 times the one before, up to five times the first. Every launch caps
that by the room the Lightning channels have (`makers/pln_size.py`: what the node can send of
what the maker gives and receive of what it gets, shared by the six ladders that give the same
asset), so the fleet quotes no level a taker could not fill; with the channels unreadable it
falls back to the small fixed sizes in the script. A maker that exits within a minute is relaunched with
a doubling delay, up to five minutes; one that ran longer is relaunched after
eight seconds. To requote a whole fleet at current prices at once, restart its
service.

`samechain-fleet.sh` gives each pair one Ocean account, `lq-sc-<BASE>-<QUOTE>`:
the sell maker gives the base and the buy maker the quote, so the two never
reach for the same coin, and each pays its fees in what it gives. Level 0 rests
20 bps off the feed and holds $10,000 of the base (about $50,000 a side within 1% of the
price), or less where an asset names a
smaller level 0 in the script's list and a pair takes the smaller of its two
(USDC.e and EURC.e, minted by the bridge a few units at a time, $0.20); each deeper level is 25 bps
further and 1.2 times larger, and the maker trims the deepest levels to what
its account holds. A maker re-posts a level a lift filled, asks the node about
every coin its wallet selects (`-node-rpc`), so it never answers a lift with a
coin one of its own swaps spent, and retires its ladder to be priced again after
ten minutes, or as soon as the feed's price has moved to within 10 bps of its
level 0 (`seqob-maker -guard-feed`). Level 0 is kept clear of the pair's best
bid and ask on the book (see "How the makers price"). A pair whose account holds nothing of what one side gives shows no
offers on that side until it is funded. Every setting is an environment
variable at the top of the script.

`mixed-maker.sh sell` and `mixed-maker.sh buy` are the two mixed GOLD/EURX
makers (GOLD over Lightning, EURX on-chain): the first sells GOLD on the relay
at :9966, the second buys it on :9971. Each launch prices the offer from the
feed, 20 bps off it on the maker's side, and the maker retires it hourly.

`covenant_seed_all.mjs` keeps the on-chain covenant ladder of every pair of
tSEQ, USDX, EURX, GOLD, SILVR, OILX, USDC.e and EURC.e: twenty levels a side, 30
bps from the feed at the touch and 25 bps more a level, each level a fixed sum in
the reference unit, multiplied by `COVSEED_SCALE` (50: $1,500 to $13,000 a level) for the faucet
assets, and cents for USDC.e and EURC.e, which the bridge mints a few
units at a time. Amounts are computed in each asset's atoms (USDC.e and EURC.e
have six decimals), and the seeder checks a level against the book in atoms too:
it leaves out a level that would cross the book or come within 10 bps of its best
price on the other side. A listed order the feed's price has moved through is
parked (see "How the makers price"), by every pass and by the park pass that
`seqob-covenant-park.timer` runs every two minutes (`COVSEED_MODE=park`, under
its own lock, writing only `run/covenant-parked.json`). A fill pays
the seeder at a taproot address of its own wallet (drawn once, kept in its keys
file as `payoutAddress`), so what the ladder earns funds its next levels; the
raw payout key in that file is the REFUND key. A legacy wallet has no taproot
addresses: its fills pay that raw key, which no wallet holds, and the seeder
says so on each pass. An order
is written to the seeder's state before it is listed: one the relay refuses for
a passing reason (its rate limit, a restart) is listed again on the next pass,
never funded twice, and one it refuses outright waits for its reclaim at expiry.
Every path and endpoint can be named in the environment (`COVSEED_*` at the top
of the file). The covenant-reseed and seqob-covenant-topup timers run it. A covenant
keeps the price it was funded at until its locktime (40,000 blocks), so a level
takes the current price only when it is funded again, after a fill or once it
expires. An order 30 blocks from its lock leaves the ladder for the state's
`expired` list, and each pass ends by running `covenant_reclaim.py`: for every
expired order whose lock has passed it spends the covenant through its REFUND
leaf back to the seeder wallet, the fee paid in the same asset, and an order
whose covenant is spent is written to `run/covenant-reclaimed.jsonl`. The
refund is built with the node's Python test framework and seqdex's
`seqob_covenant.py` (the regtest-proven spend), from the checkouts at
`/root/sequentia/Sequentia` and `/root/sequentia/seqdex`.
`covenant_reclaim.py --dry-run` builds and tests each refund without
broadcasting it.

```sh
install -m 644 makers/covenant_seed_all.mjs /root/seqob-test/
install -m 644 systemd/seqob-covenant-park.service systemd/seqob-covenant-park.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now seqob-covenant-park.timer
```

`COVSEED_MODE=probe COVSEED_PROBE=GOLD_USDX:ask:100` funds one deliberately
crossing order, here GOLD sold for USDX 100 bps under the feed's price (the two
assets may be named in either order), of
`COVSEED_PROBE_USD` ($20), and exits; pasted again while it rests, it funds
nothing more, and once it has been taken, a new one. It checks that the book un-crosses by itself: the park passes
leave a probe alone for its first ten minutes, so the order crosser has the
first chance to take it.

### How the makers price

Every maker of the on-chain book follows one rule, so that the book every wallet
shows (covenant, resting, interactive and cross-chain offers, both orientations
of a pair taken together) is never crossed by its makers:

- **One feed.** Prices come from the box's market-data feed (`/prices`, port 8088;
  Caddy serves the same values publicly through the :8080 app). Each ticker carries
  `as_of`, the time of the reading it serves, and a maker takes a price more than ten
  minutes old as no price: its pair is not quoted until the feed reads its source again.
- **Never through the book.** Before it quotes, a maker reads the pair's best bid
  and ask from the relay's ticker (`/v1/market/<base>/<quote>/ticker`, every
  rail, both orientations, liftable offers only). It never asks at or below the
  best bid plus 10 bps, nor bids at or above the best ask less 10 bps; a level
  that would is left out or moved clear of it.
- **Stale is withdrawn.** A quote is stale once the feed's mid has moved to
  within 10 bps of it on the wrong side (an ask at or below mid × 1.001, a bid
  at or above mid × 0.999). The interactive fleet retires and re-quotes; the
  leaf maker's resting desk cancels and rests the order again; the covenant
  seeder, whose coins stay in a covenant until its lock, cancels the listing and
  parks the order. A parked order is listed again, under a new offer id, once
  the price is back on its right side and clear of the book; parked for a day,
  its level is funded again and its coins are reclaimed at the lock.

| Maker | Feed read | Book checked | Stale quote |
|---|---|---|---|
| interactive fleet (`samechain-fleet.sh`) | at each launch, and every 20 s while it quotes | at each launch | retired and re-quoted |
| resting desk (`leaf-maker.service`, `rest.guard_bps`) | every minute | before each level is rested | cancelled and rested again |
| covenant seeder (`covenant_seed_all.mjs`) | at each pass | before each level is funded or listed again | parked, every two minutes |

A cross can still appear: an order from anyone else, or two makers quoting in
the same second. The order crosser, `seqob-crosser.service` (seqdex
`cmd/seqob-crosser`, configured in `/etc/sequentia/seqob-crosser.env`), reads
every relay's book in both orientations of every pair and, when a bid meets an
ask of another maker at a profit over its costs, takes both: covenant legs with
`seqob-cli covfill` from the dexnode wallet `lsp-inventory`, interactive legs
with `seqob-cli lift` from its taker key, cross-chain and Lightning legs on
their own rails. It keeps the spread, and its exposure to a second leg that
fails is capped by `-max-exposure-atoms`.

`supervise-conf.sh`, `samechain-fleet.sh` and `mixed-maker.sh` read the node RPC URL, which carries a password, from
`/etc/sequentia/seqob-makers.env` (mode 600); `makers/seqob-makers.env.example`
names it.

The pure-Lightning makers that trade against BTC, and the submarine makers,
pay and receive bitcoin through one Lightning node on Bitcoin testnet4, in
`/root/sequentia/lsp/btc-maker`. While it is down they have no BTC leg: each
exits on "btc lightning-rpc unreachable" and waits to be relaunched.

The other end of its largest channel is a second testnet4 node, in
`/root/sequentia/lsp/btc-taker`, which the order crosser (`seqob-crosser`)
takes offers through.

```sh
install -m 644 systemd/seqob-ln-btc-maker.service systemd/seqob-ln-btc-taker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now seqob-ln-btc-maker.service seqob-ln-btc-taker.service
```

Each node reads its Bitcoin RPC credentials from the `config` file in its own
directory, on the box only, and the Lightning binaries come from the `seqln`
checkout there.

## Trading volume: the volume takers

`makers/volume-takers.mjs` trades against the makers, so the testnet carries the
volume of a busy market: every pair of the faucet assets and every pair against
BTC, both ways, at sizes from tens to tens of thousands of dollars, the side
leaning with the price feed. Every trade is a real one, settled by the makers'
own code on its rail and recorded by the relays in the one trade log the tickers
and charts read.

| Rail | How a trade is made |
|---|---|
| `tree` | an in-tree swap through a headless wallet running the wallets' own composer engine (sequentia-web-wallet `tooling/user-mode-wallet.mjs`, `POST /trade`, units `seqob-volume-wallet@<port>`), against the agents' leaf maker `leaf-maker-agents.service` (127.0.0.1:9977), so a person's trade never queues behind theirs. That maker signs its trade reports with the public leaf maker's relay key (a copy of its `rest-offer.key`), which the relay already lists, so its trades reach the trade log with no change to the relay; it rests no orders, so the key signs nothing else for it |
| `pln` | a pure-Lightning swap: `seqob-crosser -take … -take-families pureln` |
| `onchain` | a covenant fill or an interactive lift: `seqob-crosser -take … -take-families covenant,samechain` |

Each pair's trades arrive at random at the rate that makes its daily target at
the ramp's step. A trade picks its rail by the configured mix, waits for a free
slot on it (a full rail is counted as `busy`, a capacity signal), and is sized
log-uniformly between the configured bounds. The ramp holds each step (a share
of the target) for a while and goes up only after a clean stretch. A broken rule
holds it, and after ten minutes steps it back, saying which rule (`HOLD`): the
box's load average over a share of its cores; a rail's success rate under 98%;
the in-tree trade's p95 time over its bound; or the wallet probe (a person's
trade, through the public wallet-facing maker, every five minutes) slower by more
than a second than at the first step. While the operator's finality waits on
the Bitcoin anchor (`chain` names its `/v1/chain`), the takers make no trade and
the ramp holds where it is (`HOLD PAUSE`), never stepping back for it. The configuration names the assets, the
pairs and their targets, the mix, each rail's concurrency, the sizes, the ramp,
the takers' wallets and the crosser's command line. The takers' coins come from
their own wallets, which the health pass refills.

They run as `seqob-volume-takers.service` (`systemd/`), from this checkout, with
their configuration in `/etc/sequentia/volume-takers.json` (mode 600: it holds
the node RPC URL the on-chain rail spends through). Their on-chain coins are the
dexnode wallet `volume-taker`, which the health pass keeps at its target; their
Lightning legs go through the crosser's taker nodes (`ln-asset-b` and
`btc-taker`).

```sh
node makers/volume-takers.mjs --config /etc/sequentia/volume-takers.json            # trades
node makers/volume-takers.mjs --config /etc/sequentia/volume-takers.json --dry-run  # no trade: the schedule, sizes and ramp
```

It writes one line a trade to `<state>/trades.jsonl` and, every minute, a summary
to `<state>/summary.json` and stdout: each pair's settled volume over the last
day and hour, and each rail's trades, success rate, p50 and p95 times and busy
count.

## How deep the books are

`bin/seqdex-depth-audit.py` reads every book and maker a wallet reaches and
prints one row per directed market (the taker gives one asset and gets
another) and one cell per rail: how many price levels the offers make against
the rail's target, their depth in the price server's reference unit, and
whether the best level can be taken right now. It runs anywhere with Python 3
and no packages:

```sh
bin/seqdex-depth-audit.py                     # the public site's books
bin/seqdex-depth-audit.py --quiet --json /tmp/depth.json   # only what falls short, and the full report
bin/seqdex-depth-audit.py --awaiting USDC.e,EURC.e     # report these assets' markets without counting them
bin/seqdex-depth-audit.py --crossed-only      # every pair's best bid and ask, and the crossed ones
```

The assets are native BTC, tSEQ, USDX, EURX, GOLD, SILVR, OILX, USDC.e and
EURC.e: 36 pairs, 72 directed markets. Restricted assets and sale tokens
are left out, because their issuers govern every transfer of them. The rails:

| Rail | Where | Target | The check on the best level |
|---|---|---|---|
| `cov` | covenant orders on the on-chain book (`/seqob`) | 20 | the order's coin is unspent at the tip |
| `rest` | orders resting as leaves in an operator's tree (`/seqob`) | 8 | the operator calls the order active, at the coin the offer names |
| `int` | interactive same-chain offers (`/seqob`) | 8 | a lift the relay must refuse (below) |
| `xbtc` | cross-chain BTC offers (`/seqob`) | 8 | the same |
| `pln` | the Lightning book (`/seqob-pln`) | 8 | the same |
| `conf` | the confidential book (`/seqob-conf`) | 8 | the same |
| `leaf` | the leaf maker's quotes (`/leafmaker`) | 8 | its quote |
| `leafbtc` | the BTC leaf maker's quotes (`/leafmaker-btc`) | 8 | its quote |

The audit also lists the interactive offers older than `--stale-minutes` (30):
the fleet re-quotes every ten minutes, so an older one is an earlier run's offer
no one co-signs, which a taker meets as "maker did not answer". Any such offer
makes the exit status 1.

An offer is counted in whichever orientation its maker listed it, as every
wallet and the SeqDEX site read a pair: an order selling the quote for the base
on the reversed market is a bid. The check on an interactive, cross-chain or
Lightning offer asks the relay's courier to lift one atom more than the offer
has left. The relay answers "maker is not connected" when nobody can fill it
and "take_amount exceeds active_amount" when its maker is there; either way no
session opens, nobody signs, and the maker is not disturbed.

Some rails cannot carry some markets, and the table shows `-` there: BTC lives
on the parent chain, so no covenant, resting, interactive, confidential or
in-tree order holds it; and the supervised assets (USDC.e, EURC.e) are never
confidential and have no Lightning leg at the Arca operator, so they do not
rest in the tree and have no one-step trade against BTC in default mode. A
market passes when every rail a default-mode surface uses for it reaches its
target with a liftable best level: covenant, interactive, resting and in-tree
for a pair of Sequentia assets, the Lightning book and the BTC leaf maker for a
pair against BTC. `--awaiting` names assets whose markets are shown but not
counted: a bridged, fully backed asset (USDC.e, EURC.e) that no maker can
hold until a deposit has minted it. The cross-chain and confidential books are the developer
views' and are reported, marked `~`, without being required.

Last, the audit prints every pair's best bid and ask in the book every wallet
shows (the covenant, resting, interactive and cross-chain offers of `/seqob`,
both orientations together) beside the feed's price, and marks a pair whose
best bid is at or above its best ask `CROSSED`, naming the two offers, their
rails and makers, their distance from the feed and their age.
`--crossed-only` reads only that book and the feed and prints only this. The
exit status is 0 when every market passes and none is crossed, 1 when one
falls short or is crossed, and 2 when a book or the price feed could not be
read.

## The DEX wallet daemon's limits

`seqdex-wallet.service` (Ocean, the wallet daemon the interactive and
confidential makers hold their coins in) runs under the limits in
`systemd/seqdex-wallet.service.d/limits.conf`: slowed at 14 GB, restarted at
18 GB, never in swap, at most six cores. Ocean's scan of its accounts after a
start was measured above 6.5 GB, and above `MemoryHigh` the kernel throttles a
process hard enough that its calls hang, so the limits sit well above that peak;
they keep a runaway (29-45 GB were seen) from starving the nodes and the Arca
operator that share the box. The health pass says when it is throttled
(`MEMORY THROTTLED`). A restart costs Ocean its startup rescan and
nothing else.

```sh
install -D -m 644 systemd/seqdex-wallet.service.d/limits.conf /etc/systemd/system/seqdex-wallet.service.d/limits.conf
systemctl daemon-reload && systemctl restart seqdex-wallet.service
```

## The makers' health

`seqob-liquidity-health.timer` runs `makers/liquidity-health.sh` every ten
minutes, from this checkout on the box:

```sh
install -m 644 systemd/seqob-liquidity-health.service systemd/seqob-liquidity-health.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now seqob-liquidity-health.timer
```

Each run audits every book (`bin/seqdex-depth-audit.py`, kept as
`/root/seqob-test/run/depth-audit.json` and `depth-audit.txt`; every crossed
market goes to the log as a `CROSSED` line), keeps the treasury at its floors,
and then refills every consumer that holds less than its floor of a target, back
to the target. The targets are in the reference unit (USD on the testnet), sized
for a busy public testnet: several million dollars a day traded in every pair of
the faucet assets.

| Consumer | Target of each asset it gives | Refilled below | Where it is set |
|---|---|---|---|
| treasury2026 itself | $30M of USDX, EURX, GOLD, SILVR and OILX | half, by minting | `treasury_floors` in `makers/liquidity-targets.json` |
| the Arca operator's pool | $20M of every asset it serves, from the moment it serves it ($18M of tSEQ) | half | `arca-operator` in the targets file |
| the covenant seeder's wallet | $1.5M ($2.5M of tSEQ, its fundings' fee asset) | half | `covenant-seeder` |
| the order crosser's wallet (`lsp-inventory`) | $200,000 | half | `lsp-inventory` |
| the volume takers' wallet (`volume-taker`) | $300,000 | half | `volume-taker` |
| Emissio's Bitcoin side (its `arca` wallet's Bitcoin ark wallet) | 5,000,000 sats | half | `emissio-btc` |
| each interactive fleet account | one and a half times its ten-level ladder ($390,000 a side) | half | `HEALTH_SC_USD` |
| the in-tree leaf maker | $1M | half | `HEALTH_LEAF_MAKERS` |
| the agents' leaf maker (`leaf-maker-agents`, the volume takers' in-tree counterparty) | $1M | half | `HEALTH_LEAF_MAKERS` |
| the BTC leaf maker (its asset side) | $300,000 | half | `HEALTH_LEAF_MAKERS` |

A consumer of the targets file is a node wallet (`kind: wallet`), paid at an
address it draws itself, or an Arca operator (`kind: arca`), paid at the
addresses in its `address_file`, one coin each, so that the first round after
a payment need not spend all of it (the operator splits its change into shares
of its pool as well). An operator is counted as what its wallet holds, final or
not (`holdings` in its `/v1/chain`), or, from an operator that does not report
it, as its info's `fundable` (its final coins, less what it owes) plus what
reached its addresses in the last hour and is not final yet. A payment still in
the mempool counts as held too, and so does what the operator's batches hand
back within the hour: the batches every leaf of which its holder released,
which the operator reclaims (`reclaimable` in its `/v1/chain` `pool`). Its
target covers at least `cover_hours` (6 by default) of what its pool drains an
hour net of what reclaims and sweeps bring back (`net_drawn_last_hour`): an
operator whose rounds draw faster than its batches come back is refilled to
that many hours of it. Each run prints, per asset, what the operator's batches
hold until a reclaim or their expiry, what of it is released and comes back
within the hour, and what the last hour drew and brought back. When coins an hour old or more wait at the
address and `fundable` is less than they hold, the operator's finality has
stalled: the pass pays nothing more and logs `OPERATOR FINALITY STALLED`.
While the operator's `/v1/chain` says its finality waits on the Bitcoin anchor
(`waiting_on` `anchor`: Bitcoin runs competing chains above the height the
chain anchors to, and nothing new is buried until it settles), the pass pays it
nothing and logs `PAUSED`: a pause, not a fault, which the operator's final
coins carry. A consumer
may carry its own `floor`. The interactive fleet's accounts are listed in
`/root/lq1/sc-accounts.json`, written when they are made. A leaf maker is paid at
its on-chain address, where it boards what arrives; what it quotes is taken as
what it holds, plus what waits at the address.

Each pass logs `MEMORY THROTTLED <unit>` when the kernel has throttled one of
the services the books depend on (Ocean, arcad, the leaf makers, the volume
takers) for memory since the last pass: its cgroup's `memory.events` `high`
count rose, which means it is over its `MemoryHigh` and slowed until its calls
hang.

Each pass first loads every service wallet the targets file lists
(`service_wallets`, node by node) that a node restart dropped, with
`load_on_startup`, and names any other wallet on a node's disk that is not
loaded, leaving it alone (a wallet must never be loaded on two nodes at once). A
consumer whose wallet does not exist yet (made later by its own setup) is
skipped. All the consumers of the targets file are funded in one run: one
transaction per source and asset for all of them together.

Funds come from two wallets only: `treasury2026` on node000, and `maker-bridged`
on the dexnode for USDC.e and EURC.e, which the bridge mints there as deposits
arrive. `makers/maker_funds.py` refuses any other source by name. It sends one
transaction an asset, the fee paid in that asset, or, where a node takes no fee
in it, in an asset the node does take, saying which.

treasury2026 is never short of a faucet asset for long. When it holds less than
half its floor of USDX, EURX, GOLD, SILVR or OILX, or less than a refill needs,
`maker_funds.py` mints more: it reissues the asset with its reissuance token in
wallet `recovered` on node000, which holds the issuance records the node needs
for that, and delivers what it minted to treasury2026, then waits until the
delivery is in a block. That is the one mint route, and it can be run by hand:

```sh
python3 -I makers/maker_funds.py mint --asset EURX --units 1000000 --assets /root/lq1/assets-leaf.txt
```

tSEQ, the Sequence token, has a fixed supply and is never minted; USDC.e and
EURC.e are minted only by their bridge, against deposits, and an asset of theirs
the sources are short of is logged `AWAITING SUPPLY` and skipped. Every mint is
a line of `/root/lq1/mints.jsonl`. Node credentials come from each node's
`elements.conf`. Every run's lines go to
`/root/seqob-test/run/liquidity-health.log`, rotated with the makers' logs.

The BTC desk (`leaf-maker-btc.service`) gives BTC from what its own testnet4
Lightning node can send and buys BTC up to 90% of what that node can be paid;
every pair quotes from the same balance. Each pass logs its room against its
ladder (`makers/btc_desk_room.py`), `BTC desk SHORT` when either way falls short;
the room comes from a channel opened by the owner script, funded from the
testnet4 service wallet.

A consumer of `kind: bitcoin-ark` is an `arca` wallet's Bitcoin side (Bark's
wallet for the Bitcoin ark): each pass boards the coins confirmed in its
on-chain wallet into the ark, and when it holds less than half its target, ark
and on-chain together, pays its on-chain address from the testnet4 service
wallet it names, at most `max_sats` a pass (`maker_funds.py bark-refill`).
It pays the going rate of the live testnet4 mempool, never less than 30 sat/vB:
the most of the node's own estimate, the rate that makes the next block of the
node's mempool, and the public mempool's going rate (mempool.space: its fastest
rate, or the median rate of its next projected block when higher), capped at
500. testnet4 often mines empty blocks while its public mempool queues at tens
of sat/vB, so a payment at the node's estimate alone can wait for hours. The
payment spends confirmed coins only, so it can always be bumped, and its address
is labelled in the service wallet (`bark-refill <name>`); while a payment to a
labelled address is unconfirmed, a pass pays nothing more and bumps it (RBF) to
the going rate when that rate has risen past it.

BTC is the one asset no script can mint. The BTC sides of the books are what
the BTC desk's and the pure-Lightning fleet's Lightning channels hold, and what
the order crosser and the cross-chain makers hold on testnet4; they are sized
from the testnet4 coins the service wallets hold.

## The SeqLN nodes' channel options

Each SeqLN node offers the channel types its peers can use with it. The options
are lines in the node's own config file, never on a unit's command line, and
`lightningd` refuses an option its binary does not know, so they are written
only once the node runs a SeqLN build that has them, and removed before it goes
back to one that does not.

| Node | Options | Why |
|---|---|---|
| The node the LSP's `SUBAS_LP_RPC` names | `taproot-covenant-channels`, `point-locks`, `credit-channels`, `plugin=/root/sequentia/seqln/contrib/credit-seq/credit.py` | It opens the inbound channels toward hosted users, so it provides their credit: its `creditinvoice` makes an invoice whose payment it owes the user, while the user's device is away. |
| Every other node on Sequentia that holds its own key, `arca-ln` among them | `taproot-covenant-channels`, `point-locks` | It hosts no user: the covenant channel type and point locks with every peer that offers them, and no credit. |
| The hosted nodes on Sequentia (the LSP's `PROV_DIR`) | `taproot-covenant-channels`, `credit-channels` | Each is keyless: its user's device signs. `lightningd` withdraws each option the device cannot sign, so a user's node offers the covenant type once the device can sign it and holds credit once the device can hold notes. |
| `btc-maker`, `btc-taker`, the hosted nodes on Bitcoin | none | On Bitcoin the options offer nothing: its scripts have no introspection opcodes. |

The options change only channels opened after them; every channel keeps the
type it was opened with. A point-locked HTLC rides only on a covenant channel:
SeqLN's `pay` locks a payment to a point only over its own covenant channels
and pays by the payment hash wherever a channel cannot carry one, so a node
takes `point-locks` beside channels of an older type. A SeqLN build whose
`plugins/libplugin-pay.c` has no `payment_point_lock_channels` does not: its
`pay` sends a point-locked HTLC over an older channel between two nodes that
both take point locks, the first hop refuses it
(`WIRE_REQUIRED_CHANNEL_FEATURE_MISSING`) and the payment fails, so with such
a build `point-locks` goes only on a node whose channels are all covenant
channels. Hosted nodes take no point locks: no device signer takes them. The
LSP writes a new hosted node's config
without these options, so a node it provisions offers them only once they are
added to that config.

## Bridge state off the box

```sh
mkdir -p ~/.config/systemd/user
cp backup/pull-bridge-state.service backup/pull-bridge-state.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now pull-bridge-state.timer
backup/pull-bridge-state.sh                  # the first copy now
```

Run on an operator's machine that can `ssh` to the box (`BRIDGE_STATE_HOST`,
default `seq`). Twice a day it copies the Compages daemon's and watcher's state
and the SBTC peg service's state into `~/.local/share/sequentia/bridge-state`,
dated and mode 600, sixty deep. The state records every deposit, redemption and
peg; the keys are backed up separately.

## The bridge units

```sh
install -m 644 systemd/compagesd.service systemd/compages-watch.service systemd/sbtc-bridge.service /etc/systemd/system/
systemctl daemon-reload
```

`compages-reserves.timer` runs the Compages reserve snapshot tool every ten
minutes. A run does nothing until the next snapshot height is due and deep
enough, then writes one signed snapshot into the directory the daemon serves
as `/api/por/history`. The attestation key sits beside the tool's config
(mode 600), with its backup off the box.

```sh
install -m 644 systemd/compages-reserves.service systemd/compages-reserves.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now compages-reserves.timer
```

## The Arca operator

An Arca operator runs on the box, reached at `https://sequentiatestnet.com/arca/`
(every call under `/v1/`; no page links to it). Arca's own documentation is in
its repository, `ConcatenaLabs/arca`: `server/README.md` for the server,
`bark-cli/README.md` for the command-line wallet.

| What | Where |
|---|---|
| The checkout and its build | `/opt/arca`, at the commit the binaries in `/opt/arca/target/release` are built from (`BUILT_FROM` beside them); a new revision is built in a clone of its own, `/opt/arca-head`, and its three binaries installed there |
| `arca-signer.service` | Holds the operator key (`/etc/arca/operator.key`) and signs on `/run/arca/signer.sock`; its append-only record is `/var/lib/arca/signer.record` |
| `arcad.service` | The server, its rounds and its watcher, on `127.0.0.1:3535`; metrics on `127.0.0.1:3536`; configuration `/etc/arca/arcad.toml` |
| Its node | The dexnode (`seq-dexnode`, RPC 18300), which runs with `-txindex` and `-validateanchor` |
| Its database | PostgreSQL 16, cluster `16/main`, database `arca`, reached over the Unix socket as the `arca` role |
| Its secrets | `/etc/arca/operator.key`, `/etc/arca/wallet.mnemonic` and `/etc/arca/arcad.toml` (which holds the node's RPC password), each mode 600, owned by the `arca` user |

Both services run as the `arca` system user, read-only outside
`/var/lib/arca` and `/run/arca`. `arcad` is stopped with SIGINT, which is what
lets it stop its tasks. The two log to the journal (`journalctl -u arcad`),
which bounds its own size, so neither can fill the disk. `systemctl reload
arcad` sends it SIGHUP, on which it reads the assets it serves from its
configuration again (an asset added, a rate source changed) without a restart.

A move to a new revision follows Arca's `server/README.md` ("Moving to a new
revision"): the new revision built beside the running one, then `arcad`
stopped, then the signer, the database dumped and the signer's record and the
files beside it copied, the binaries and the configuration installed, the
signer started on its record and `arcad` after it, which moves the database
to the new schema at its start. The schema only moves forward: going back
means the dump, and the server then forgets whatever it did after the dump,
while the signer's record, which is never rolled back, keeps it.

The signer starts only on its record, which it never makes by itself: a
record that is lost is never silently replaced by an empty one. A new
operator key gets one record, once, before the signer's first start:

```sh
. /etc/arca/signer.env && runuser -u arca -- /opt/arca/target/release/arca-signer --key-file /etc/arca/operator.key \
    --genesis "$ARCA_GENESIS" --record /var/lib/arca/signer.record --create-record
install -m 644 systemd/arca-signer.service systemd/arcad.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now arca-signer.service arcad.service
```

The route is `handle_path /arca/*` in `caddy/Caddyfile`. Caddy closes a
pooled connection to `arcad` after 30 idle seconds, so it never sends a
request down a connection `arcad` has dropped. Caddy is the one proxy
`arcad` trusts (`[limits] trusted_proxies`, loopback), so each request counts
against the address that reached Caddy, and the `[limits]` rates in
`/etc/arca/arcad.toml` (one operator nonce and one witness of the signer's
record a second for each address, bursts of ten) are shared by every wallet
behind one address, a wallet run on the box itself included.

### Its Lightning legs

Payments between a leaf and Lightning go through the operator's own SeqLN
node, `arca-ln.service`, which holds one channel in each asset the operator
serves over Lightning, to the box's `ln-asset` node, half of each channel's
coins on each side so payments go both ways. It is the operator's alone:
the makers' nodes run as root under `/root`, which `arcad`'s unit cannot
reach and which would be full control of the makers' coins, and their
channels move with the makers' trades, while `arcad` reads what it can send
and receive, and its cap on received payments, from its node's channels.
One node serves every asset: SeqLN's channels and holds are each in one
asset, and `arcad` names the asset on every hold and payment.

| What | Where |
|---|---|
| The node | `arca-ln.service`, as the `arca` user; `/var/lib/arca-ln`, its JSON-RPC socket `/var/lib/arca-ln/sequentia-testnet/lightning-rpc`, peers on `127.0.0.1:19850` |
| Its binaries | `/opt/arca-ln/<commit>`, copied from the box's SeqLN checkout with SeqLN's hold-invoice plugin (`contrib/holdinvoice-seq`), which receiving needs; `/opt/arca-ln/current` names the one in use |
| Its configuration | `/var/lib/arca-ln/config`, mode 600: it holds the dexnode's RPC password, as `/etc/arca/arcad.toml` does, and its channel option (see "The SeqLN nodes' channel options") |
| `arcad`'s side | each `[[assets]]` entry's `[assets.lightning] rpc` names the socket; `[lightning]` sets the send timeout (four days, the window a swap of BTC for an asset needs) and the receive cap |

The Bitcoin side is the Bitcoin ark's own gateway (`bitcoin-ark-cln`, below):
`[lightning.bitcoin]` names its socket and the ark, and `arcad` only reads
the node's state. The gateway's socket is open to its group
(`rpc-file-mode=0660` in `bitcoin-ark/cln.config`, and its unit opens the
network directory that holds the socket, which Core Lightning makes mode 0700,
to the group as well), and
`systemd/arcad.service.d/bitcoin-ark.conf` puts `arcad` in that group; it is
installed only where the ark runs, since the group exists only there.

```sh
install -m 644 systemd/arca-ln.service /etc/systemd/system/
install -d /etc/systemd/system/arcad.service.d
install -m 644 systemd/arcad.service.d/bitcoin-ark.conf /etc/systemd/system/arcad.service.d/
systemctl daemon-reload && systemctl enable --now arca-ln.service
journalctl -u arca-ln                        # its log
```

An asset added to `[[assets]]` takes `systemctl reload arcad`; a change to
`[lightning]` or `[lightning.bitcoin]` takes a restart.

### When the signer stops

Every head of the signer's record that `arcad` hands out, an entry and its
running hash, is signed with the operator key, and every wallet command that
reaches the server hands the heads the wallet holds back to the signer. A
head the signer signed that its record does not hold proves the record was
rolled back or replaced. The signer then writes that proof beside its record,
in `/var/lib/arca/signer.record.stopped`, logs `arca-signer: STOPPED: …`
(`journalctl -u arca-signer`), and from then on, across restarts, co-signs no
transfer and no forfeit, so no round completes, and signs no head; it still
signs the operator's own claims and sweeps. `arcad` keeps running, serves
`/v1/info` without `signer_record`, and tells every wallet that witnesses the record that the signer is stopped. Each
wallet then takes on the chain every coin that a transfer recorded after the
last entry it agrees with made, and asks this operator nothing more.

The stop ends this operator. Leave both services running until the
watcher's own transactions are final (`SELECT count(*) FROM nursery_tx WHERE
state = 'pending'` in the `arca` database reads 0), then stop them, and keep
the record and the proof where they are. Nothing on the box clears the proof
to carry on: `arca-signer --clear-stopped` removes it, printing it first, and
an operator carries on only under a new key with a new record, which every
wallet treats as a new operator.

### Keeping its database

The database holds what the chain does not, and must never lose a commit
(Arca's `server/README.md`, "Keeping the database"). On the box:

- `postgres/arca.conf`, installed as `/etc/postgresql/16/main/conf.d/arca.conf`,
  keeps `fsync`, `full_page_writes` and `synchronous_commit` on and names the
  WAL receiver as the synchronous standby: a commit returns only once the
  receiver has flushed it.
- `arca-pg-wal.service` is that receiver: `pg_receivewal --synchronous` on a
  replication slot, into `/var/backups/arca-pg/wal`. While it is down, commits
  wait for it rather than go unrecorded, and `arcad` waits with them.
- `arca-pg-basebackup.timer` takes a base backup every day into
  `/var/backups/arca-pg/base/<UTC time>`, keeps seven, and deletes the WAL
  older than the oldest kept.
- `backup/pull-arca-pg.timer`, a user timer on an operator's machine, copies
  `/var/backups/arca-pg` off the box every hour into
  `~/.local/share/sequentia/arca-pg`. The box's own copy holds every commit;
  the off-box copy is as recent as its last run, and is the operator's
  history (its rounds and their preimages, its transfers, its watcher's
  log) when the box is lost, not a way to start it again (below).

```sh
install -m 644 postgres/arca.conf /etc/postgresql/16/main/conf.d/arca.conf
install -d -o postgres -g postgres -m 700 /var/backups/arca-pg /var/backups/arca-pg/wal /var/backups/arca-pg/base
install -m 644 systemd/arca-pg-wal.service systemd/arca-pg-basebackup.service systemd/arca-pg-basebackup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl restart postgresql
systemctl enable --now arca-pg-wal.service arca-pg-basebackup.timer
backup/arca-pg-basebackup.sh                 # the first base backup now
bin/arca-pg-restore-drill.sh                 # and prove it restores
```

`bin/arca-pg-restore-drill.sh` commits a random token into a database of its
own (`arca_drill`), restores the newest base backup and every WAL segment
after it into a scratch cluster on port 5499, waits for recovery to reach the
end of the WAL, and checks the token is there and that the restored copy
knows the same latest entry of the signer's record as the live database; it
prints the row count of every table of `arca` in the restored copy, then
deletes the scratch cluster. The live database is not touched.

A restore is for one case: the database's own data directory lost or
damaged on this box, while `/var/backups/arca-pg` and the signer's record
`/var/lib/arca/signer.record` are intact. It is the drill's restore into the
cluster's own data directory: stop `arcad`, stop PostgreSQL, move
`/var/lib/postgresql/16/main` aside, extract the newest base backup into it
as `postgres`, add `recovery.signal` and a `restore_command` reading
`/var/backups/arca-pg/wal` (taking a segment's `.partial` copy when the whole
one is not there), and start PostgreSQL: it replays to the last commit and
opens, the state the record agrees with. Never stop the replay at an earlier
point, and never restore the signer's record: it is not backed up, and it
only grows.

A restore is not a way back to an earlier state, and not a way to bring the
operator back on another disk:

- A database older than its last commit beside the record as it is: `arcad`
  refuses to start on it once it lacks an entry of the record, or a round or
  board spend the chain shows, and names each one.
- A snapshot of the box's disk, the database and the record rolled back
  together: they agree with each other. `arcad` still refuses to start when
  the chain holds a round the snapshot lacks, naming it. Otherwise it starts,
  and the first wallet that was shown a later head stops the signer at its
  next command (above): the operator co-signs nothing again.
- The box's disk lost: the record is lost with it, and a new record for the
  same key is refused against a database that knows an entry of the old one,
  so no copy of the database, the off-box one included, starts this operator
  again. Every holder still takes its coins on the chain alone, from its own
  wallet's records.

## The Bitcoin ark

A Bitcoin ark runs on the box beside the Arca operator: Bark's server
(`captaind`, from Second's Bark), on testnet4, the Bitcoin network the
testnet anchors to. A wallet joins it with Bark's client:

```sh
bark create --testnet4 --ark https://sequentiatestnet.com \
    --bitcoind <a testnet4 Bitcoin Core 29 or later> --bitcoind-cookie <its cookie>
```

Its coins are testnet4 BTC, the same BTC the testnet's other wallets hold, so
a payment can cross from this ark's Lightning gateway to the SeqLN nodes and
back. No page links to it.

### What runs

| Unit | What | Where |
|---|---|---|
| `bitcoin-ark-bitcoind` | Bitcoin Core 31.1 on testnet4, with a transaction index, no wallet, outbound peers only (the box's own testnet4 node first) | `/opt/bitcoin-ark/core`, data `/var/lib/bitcoin-ark/bitcoind`, RPC `127.0.0.1:18342` by cookie |
| `bitcoin-ark-cln` | The Lightning gateway: Core Lightning 26.06.6 with Boltz's hold-invoice plugin v0.3.3 and its own gRPC interface | `/opt/bitcoin-ark/cln`, data `/var/lib/bitcoin-ark/cln`, peers on `127.0.0.1:19746`, gRPC `19747`, hold gRPC `19748` |
| `bitcoin-ark-captaind` | Bark's server: rounds, in-ark payments, Lightning through the gateway | `/opt/bitcoin-ark/bin/captaind`, data `/var/lib/bitcoin-ark/captaind`, public gRPC `127.0.0.1:3545`, admin `3546`, integrations `3547` (loopback only) |
| `bitcoin-ark-watchmand` | Bark's watchman: answers exits, sweeps expired rounds back to the server's wallet | `/opt/bitcoin-ark/bin/watchmand`, data `/var/lib/bitcoin-ark/watchmand` |

All four run as the `bark` system user. The configuration files are the ones
in `bitcoin-ark/`, with the box's paths and ports filled in:
`/etc/bitcoin-ark/bitcoin.conf`, `/var/lib/bitcoin-ark/cln/config`,
`/etc/bitcoin-ark/captaind.toml`, `/etc/bitcoin-ark/watchmand.toml`. None
holds a secret: Bitcoin Core is reached by its cookie and PostgreSQL over its
Unix socket as `bark`. The server's key is the mnemonic in
`/var/lib/bitcoin-ark/captaind/mnemonic` (mode 600; the watchman holds a
copy); keep a copy of it off the box.

The database is `bark_captaind` in the box's PostgreSQL 16, owned by the role
`bark`. That role commits with `synchronous_commit = local`: the cluster's
synchronous standby is the Arca operator's WAL receiver, and the ark does not
wait on it.

`captaind` and `watchmand` log to the journal at `info` (`CAPTAIND_LOG` and
`WATCHMAND_LOG` in their units; unset, they log every trace event).
Bitcoin Core and the gateway write `/var/log/bitcoin-ark/bitcoind.log` and
`cln.log`, which `logrotate/bitcoin-ark` rotates daily or at 50 MB, seven
kept.

The route is the `@bitcoinark` block in `caddy/Caddyfile`. Bark speaks gRPC,
whose paths are the services' names, so the block matches Bark's two public
services (`/bark_server.ArkService/*` and `/mailbox_server.MailboxService/*`)
on the site's own address and proxies them over cleartext HTTP/2. The admin
and integration interfaces are never routed.

### Why these

- **Bark at a pinned upstream release.** `captaind`, `watchmand` and the
  client are Bark 0.7.1 (`server-0.7.1`, commit `8f5d8c4f`), built from the
  release as published, so the Bitcoin side stays a plain Bark ark that any
  Bark wallet can join. The client carries one patch,
  `bitcoin-ark/bark-testnet4.patch`, offered upstream: Bark's library and
  server run on any Bitcoin network, but its client lists only mainnet,
  signet, Mutinynet and regtest, and it compares a BOLT11 invoice's network
  with the wallet's, which refuses every testnet4 invoice (the `tb` currency
  is shared with testnet3 and reads as testnet3). The patch adds `--testnet4`
  and compares currencies instead.
- **Boltz's hold plugin with one line.** The gateway's hold-invoice plugin is
  hold v0.3.3, the release Bark tests with, plus `bitcoin-ark/hold-testnet4.patch`:
  hold maps Core Lightning's network name to an invoice currency and knows no
  `testnet4`, so it disables itself there without a word in the journal; the patch
  maps `testnet4` to the testnet currency, which is what its `lntb` invoices are.
- **Bitcoin Core 31.** Bark's server refuses an older node: it reads the
  chunk fee rates `getmempoolentry` gained in 31, and it needs a transaction
  index. A leaf's exit transactions pay no fee themselves and carry a
  zero-value anchor that a child spends to pay for both, relayed as a
  package; Bitcoin Core relays and mines such anchors from version 29, and
  refuses them before (`dust`). The box's own testnet4 node is older and
  serves the SeqLN nodes, so the ark has a node of its own, with outbound
  peers of its own, and a wallet's chain source must be Bitcoin Core 29 or
  later too (Bark's client checks).
- **Upstream Core Lightning for the gateway.** Bark's server drives its
  gateway through Core Lightning's gRPC plugin and Boltz's hold-invoice
  plugin, the pair Bark's own tests run with (Core Lightning 26.06.6, hold
  v0.3.3). Bark's Lightning tests pass against SeqLN as well, built with its
  gRPC plugin; but the box's SeqLN nodes are built without it and carry the
  makers' channels, and a gateway of its own keeps the ark out of every SeqLN
  cutover.
- **Fixed fee rates for the gateway.** testnet4 often mines empty blocks, so
  the ark's own node can go hours with no fee estimate, and Core Lightning
  then refuses to open or close a channel ("Cannot estimate fees (yet)").
  `bitcoin-ark/cln.config` sets `force-feerates=500` (2 sat/vB), an option
  that exists on test networks only.
- **A Lightning receive needs its wallet online.** Bark's server holds an
  incoming payment for three minutes (`receive_htlc_forward_timeout`) while
  the wallet claims it (`bark lightning claim`); unclaimed, the payment fails
  back to the payer.
- **The settings** (`bitcoin-ark/captaind.toml`): a round every 30 seconds
  (a round nobody joins makes no transaction); leaves live 2,016 blocks; an
  exit waits 72 blocks at each step, the watchman checking every minute;
  boards need two confirmations; boards, payments and Lightning amounts up to
  0.05 tBTC (0.01 over Lightning); Bark's own fee schedule, in satoshis.

### Installing it

Four owner scripts do it, each safe to paste again: prepare (download, check
and build), install (users, database, configuration, units, the first sync,
funding from the box's testnet4 wallet, the gateway's channel to
`btc-taker`, the route), verify (two throwaway wallets: a board, an in-ark
payment, a refresh, a Lightning payment each way and a unilateral exit, then
everything sent back), and remove (every coin back to the box wallet, then
the units, the database and the data moved under `/var/backups`).
