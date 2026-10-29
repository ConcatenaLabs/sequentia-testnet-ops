#!/bin/sh
# Install the status page and its checker from this checkout: Gatus at the
# version below (built here with Go if /usr/local/bin/gatus is another one),
# its config, its unit and the page; then check the checker answers.
# Usage: bin/apply-status.sh            (run on the box, from the checkout)
set -eu
case "${1:-}" in -h|--help) sed -n 2,5p "$0" | sed 's/^# //'; exit 0 ;; esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
GATUS_VERSION=v5.37.0
GO=${GO:-/usr/local/go/bin/go}
PORT=$(sed -n 's/^  port: \([0-9]*\)$/\1/p' "$HERE/status/gatus.yaml")

if [ ! -x /usr/local/bin/gatus ] || ! "$GO" version -m /usr/local/bin/gatus 2>/dev/null | grep -q "gatus/v5.*$GATUS_VERSION"; then
  [ -x "$GO" ] || { echo "apply-status: no Go at $GO to build Gatus with; set GO=" >&2; exit 1; }
  echo "apply-status: building Gatus $GATUS_VERSION"
  GOTOOLCHAIN=auto CGO_ENABLED=0 GOBIN=/usr/local/bin GOFLAGS=-p=2 "$GO" install "github.com/TwiN/gatus/v5@$GATUS_VERSION"
fi
"$GO" version -m /usr/local/bin/gatus | grep -q "gatus/v5.*$GATUS_VERSION" || { echo "apply-status: /usr/local/bin/gatus is not $GATUS_VERSION" >&2; exit 1; }

install -d -m 755 /etc/gatus /srv/status
install -m 644 "$HERE/status/gatus.yaml" /etc/gatus/config.yaml
install -m 644 "$HERE/status/site/index.html" /srv/status/index.html
install -m 644 "$HERE/systemd/gatus.service" /etc/systemd/system/gatus.service
systemctl daemon-reload
systemctl enable gatus.service >/dev/null 2>&1
systemctl restart gatus.service

# The checker answers, and has run every check once (the first round starts
# at once and takes a few seconds).
n=0
for i in $(seq 1 30); do
  body=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/api/v1/endpoints/statuses?pageSize=1" || true)
  n=$(printf '%s' "$body" | python3 -c 'import json,sys
try: print(sum(1 for e in json.load(sys.stdin) if e.get("results")))
except Exception: print(0)')
  want=$(grep -c '^  - name: ' "$HERE/status/gatus.yaml")
  [ "$n" = "$want" ] && break
  sleep 2
done
[ "$n" = "$want" ] || { echo "apply-status: the checker reports $n of $want checks; see journalctl -u gatus" >&2; exit 1; }
echo "apply-status: Gatus $GATUS_VERSION runs all $want checks on 127.0.0.1:$PORT; the page is in /srv/status"
