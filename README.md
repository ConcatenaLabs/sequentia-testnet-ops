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
| `downloads/index.html` | The download page at `sequentiatestnet.com/download/`, installed at `/root/sequentia/downloads/index.html` beside the release files it links; the explorer's server serves that directory. A release edits the product's card here, merges, pulls on the box and runs `bin/apply-downloads.sh`. |

## The routes

Read `caddy/Caddyfile`: each `handle_path` names a path and the port the
product listens on. The wallet, the explorer, the bridge, the faucet, the
registry and the download page fall through to the explorer's own server on
port 8080, which serves them; everything else is proxied to its own process.
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

## A release on the download page

The page names each product's current file. After the release file is on
the box under `/root/sequentia/downloads/`, edit the product's card here (the
`data-ver` span, the file name, the link), open a pull request, merge, and on
the box:

```sh
cd /root/sequentia/sequentia-testnet-ops && git pull --ff-only
bin/apply-downloads.sh
```

which installs the page and checks every file it links is there.

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
