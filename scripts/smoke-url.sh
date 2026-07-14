#!/usr/bin/env bash
set -euo pipefail

base_url=${1:-}
if [[ -z "$base_url" ]]; then
  echo "Usage: $0 https://delivery.example.com" >&2
  exit 2
fi
base_url=${base_url%/}

headers=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" || -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  if [[ -z "${CF_ACCESS_CLIENT_ID:-}" || -z "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
    echo "Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required" >&2
    exit 2
  fi
  headers+=(
    -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
  )
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
nonce=$(date +%s)-$$

request() {
  local url=$1
  local output=$2
  local response_headers=$3
  local status
  status=$(curl --silent --show-error --max-time 20 \
    "${headers[@]}" \
    -H 'Cache-Control: no-cache' \
    -D "$response_headers" \
    -o "$output" \
    -w '%{http_code}' \
    "$url")
  if [[ "$status" != 200 ]]; then
    echo "Smoke request returned HTTP $status for $url" >&2
    exit 1
  fi
}

request "$base_url/__origin-smoke-$nonce" "$workdir/index.html" "$workdir/index.headers"
grep -Eq '/assets/index-[^" ]+\.js' "$workdir/index.html"
grep -Eiq '^cache-control:.*no-store' "$workdir/index.headers"

request "$base_url/health?smoke=$nonce" "$workdir/health.json" "$workdir/health.headers"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$workdir/health.json"

echo "Origin smoke passed for $base_url"
