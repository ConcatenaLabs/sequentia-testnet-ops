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
| `backup/` | A script, a service and a timer that keep dated copies of the host configuration under `/var/backups/box`, four times a day, sixty deep. |
| `logrotate/` | Rotation for the logs services append to. `bridges` covers the bridge services (`compagesd`, `compages-watch`, `compages-reserves`, `sbtc-bridge`): weekly or at 20 MB, twelve kept, compressed. `seqob-makers` covers every maker log under `/root/seqob-test/run`: at 20 MB, two kept, compressed. |
| `systemd/` | The units of the bridge services on the box (`compagesd`, `compages-watch`, `sbtc-bridge`, and the `compages-reserves` snapshot timer) of the two maker fleets below (`seqob-pureln-fleet`, `seqob-conf-maker`) and of the Lightning node their BTC leg runs on (`seqob-ln-btc-maker`); none holds a credential, each service reads its own mode-600 config. |
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

```sh
install -m 644 systemd/seqob-ln-btc-maker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now seqob-ln-btc-maker.service
```

The node reads its Bitcoin RPC credentials from the `config` file in its own
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
