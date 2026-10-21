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
| `bin/arca-pg-restore-drill.sh` | Restores the Arca operator's database from its newest base backup and every WAL segment after it into a scratch cluster, and checks the last commit is there. |
| `postgres/arca.conf` | PostgreSQL's settings for the Arca operator's database: durability on, and every commit waits until the WAL receiver has it. |
| `backup/` | A script, a service and a timer that keep dated copies of the host configuration under `/var/backups/box`, four times a day, sixty deep; the Arca operator's daily PostgreSQL base backup; and the user timers that pull the bridge state and the Arca backups off the box. |
| `logrotate/` | Rotation for the logs services append to. `bridges` covers the bridge services (`compagesd`, `compages-watch`, `compages-reserves`, `sbtc-bridge`): weekly or at 20 MB, twelve kept, compressed. `seqob-makers` covers every maker log under `/root/seqob-test/run`: at 20 MB, two kept, compressed. `bitcoin-ark` covers the Bitcoin ark's Bitcoin Core and Lightning logs under `/var/log/bitcoin-ark`: daily or at 50 MB, seven kept. |
| `systemd/` | The units of the bridge services on the box (`compagesd`, `compages-watch`, `sbtc-bridge`, and the `compages-reserves` snapshot timer) of the two maker fleets below (`seqob-pureln-fleet`, `seqob-conf-maker`) of the two Bitcoin-side Lightning nodes (`seqob-ln-btc-maker`, `seqob-ln-btc-taker`), of the Arca operator (`arca-signer`, `arcad`, `arca-pg-wal`, `arca-pg-basebackup`, and its Lightning node `arca-ln`, with `arcad.service.d/bitcoin-ark.conf` where the Bitcoin ark runs), of the node JSON-RPC for browser wallets (`node-rpc-proxy`), of the Bitcoin ark (`bitcoin-ark-bitcoind`, `bitcoin-ark-cln`, `bitcoin-ark-captaind`, `bitcoin-ark-watchmand`), and of the oracle-bond watcher (`sequentia-oracle-watcher`, which slashes an oracle's bond on two prices for one pair and time and can see no oracle key); none holds a credential, each service reads its own mode-600 config. |
| `bitcoin-ark/` | The Bitcoin ark's configuration templates (Bitcoin Core, the Lightning gateway, Bark's server and watchman) and the one patch its Bark client carries. |
| `makers/` | The scripts that keep two SeqOB maker fleets running on the box: `pureln-fleet.sh` (pure-Lightning makers) and `supervise-conf.sh` (confidential makers). Installed in `/root/seqob-test`. `seqob-makers.env.example` names the one secret they read. |
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
  Every other method, a wallet's path, a batch and named arguments are
  refused with 403 (or 404, 400) before the node sees them.
- **Rate.** Each source (the address Caddy saw; an IPv6 /48) may make 20
  calls a second, in bursts of 400, and all sources together 200 a second.
  `scantxoutset` reads the whole UTXO set, and a wallet makes a few for each
  command (one per window of its on-chain scripts and per output it looks
  for; three for a wallet with one coin on the chain): thirty in a row from a
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

```sh
install -m 755 makers/pureln-fleet.sh makers/supervise-conf.sh /root/seqob-test/
install -m 644 systemd/seqob-pureln-fleet.service systemd/seqob-conf-maker.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart seqob-pureln-fleet.service seqob-conf-maker.service
```

Each script launches one maker process per price level and keeps it running:
`pureln-fleet.sh` the pure-Lightning makers (six assets against BTC and every
asset pair, both sides, eight levels), `supervise-conf.sh` the confidential
makers (every directed pair, both sides). The maker binaries come from the
`seqdex` checkout on the box; each maker's key is a box-local file created on
first use, and each maker appends to its own log in `/root/seqob-test/run`.

Amounts are computed once, at launch, from the price feed and the asset
registry on the box. Those are separate services, so a script waits until they
answer before it starts anything, and it starts no maker whose amounts did not
come out as whole atoms. A maker that exits within a minute is relaunched with
a doubling delay, up to five minutes; one that ran longer is relaunched after
eight seconds. To requote the whole fleet at current prices, restart its
service.

`supervise-conf.sh` reads the node RPC URL, which carries a password, from
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
| Its configuration | `/var/lib/arca-ln/config`, mode 600: it holds the dexnode's RPC password, as `/etc/arca/arcad.toml` does |
| `arcad`'s side | each `[[assets]]` entry's `[assets.lightning] rpc` names the socket; `[lightning]` sets the send timeout (four days, the window a swap of BTC for an asset needs) and the receive cap |

The Bitcoin side is the Bitcoin ark's own gateway (`bitcoin-ark-cln`, below):
`[lightning.bitcoin]` names its socket and the ark, and `arcad` only reads
the node's state. The gateway's socket is open to its group
(`rpc-file-mode=0660` in `bitcoin-ark/cln.config`), and
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
