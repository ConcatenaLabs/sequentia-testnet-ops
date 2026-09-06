#!/bin/sh
# Put this checkout's Caddyfile on the box: validate it against the secrets
# file, install it, reload Caddy, and check the routes still answer.
# Usage: bin/apply-caddy.sh            (run on the box, from the checkout)
set -eu
case "${1:-}" in
  -h|--help) sed -n 2,4p "$0" | sed 's/^# //'; exit 0 ;;
esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/caddy/Caddyfile"
DEST=/etc/caddy/Caddyfile
ENV=/etc/caddy/caddy.env
[ -r "$ENV" ] || { echo "apply-caddy: $ENV is missing; copy caddy/caddy.env.example there and fill it in" >&2; exit 1; }
# Validate with the secrets in the environment, read as systemd reads them:
# no shell expansion, quotes stripped.
if ! python3 - "$SRC" "$ENV" <<'PY'
import os, subprocess, sys
src, envfile = sys.argv[1], sys.argv[2]
env = dict(os.environ)
for line in open(envfile):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); env[k] = v.strip("'\"")
r = subprocess.run(["caddy", "validate", "--config", src, "--adapter", "caddyfile"], capture_output=True, text=True, env=env)
if r.returncode:
    sys.stderr.write(r.stderr[-800:]); sys.exit(1)
PY
then echo "apply-caddy: the Caddyfile does not validate; nothing installed" >&2; exit 1; fi
install -m 644 "$HERE/caddy/caddy.service.d/env.conf" /etc/systemd/system/caddy.service.d/env.conf
cp -p "$DEST" "/root/Caddyfile.bak-apply-$(date +%s)" 2>/dev/null || true
install -m 644 "$SRC" "$DEST"
systemctl daemon-reload
systemctl reload caddy
sleep 1
fail=0
for u in / /wallet/ /levo/api/health /explorer/ /dex/ /seqpal/ /lending/ /emissio/ /coinjoin/ /registry/ /pools/ /faucet /download/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://sequentiatestnet.com$u")
  case "$code" in 2*|3*) ;; *) echo "apply-caddy: $u answered $code" >&2; fail=1 ;; esac
done
[ "$fail" = 0 ] && echo "apply-caddy: installed and every route answers" || { echo "apply-caddy: installed, but a route is off; the previous file is beside it in /root" >&2; exit 1; }
