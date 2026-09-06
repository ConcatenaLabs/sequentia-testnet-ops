#!/bin/sh
# Say whether the box's live Caddyfile differs from this checkout's.
# Usage: bin/caddy-drift.sh
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
if diff -u "$HERE/caddy/Caddyfile" /etc/caddy/Caddyfile; then echo "caddy-drift: the live Caddyfile is this checkout's"; else echo "caddy-drift: the live Caddyfile has drifted; commit it here or apply the checkout" >&2; exit 1; fi
