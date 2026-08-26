#!/bin/sh
# Mint an API token for the demo hub.
#
#   ./token.sh            token for /hub
#   ./token.sh weather    token for /weather/mcp
#   ./token.sh --all      one token per resource, labelled
#
# Tokens are bound to one resource: a /hub token opens /hub and nothing else.
# That is the default and it is worth seeing — it is why this script takes an
# argument at all.
set -eu

cd "$(dirname "$0")"

if [ -z "$(docker compose ps --status running --quiet mcp-hub)" ]; then
  echo "The demo hub is not running. Start it with:  docker compose up -d" >&2
  exit 1
fi

# The admin CLI prints the token on stdout and its metadata on stderr, so
# dropping stderr leaves exactly the token — which is what makes
# `TOKEN=$(./token.sh)` work.
mint() {
  token=$(docker compose exec -T mcp-hub node dist/admin.js tokens create \
    --resource "$1" --days 30 --label "demo-$1" 2>/dev/null)
  if [ -z "$token" ]; then
    echo "Minting a token for \"$1\" failed. For the reason, run it without this script:" >&2
    echo "  docker compose exec -T mcp-hub node dist/admin.js tokens create --resource $1" >&2
    exit 1
  fi
  printf '%s\n' "$token"
}

if [ "${1:-hub}" = "--all" ]; then
  for resource in hub weather tickets docs; do
    printf '%-8s %s\n' "$resource" "$(mint "$resource")"
  done
else
  mint "${1:-hub}"
fi
