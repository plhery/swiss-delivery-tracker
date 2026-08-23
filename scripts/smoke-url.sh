#!/usr/bin/env bash
set -euo pipefail

base_url=${1:-}
if [[ -z "$base_url" ]]; then
  echo "Usage: $0 https://delivery.example.com" >&2
  exit 2
fi
base_url=${base_url%/}

curl_args=(
  --silent
  --show-error
  --max-time 20
  -H 'Cache-Control: no-cache'
)
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" || -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  if [[ -z "${CF_ACCESS_CLIENT_ID:-}" || -z "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
    echo "Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required" >&2
    exit 2
  fi
  curl_args+=(
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
  status=$(curl "${curl_args[@]}" \
    -D "$response_headers" \
    -o "$output" \
    -w '%{http_code}' \
    "$url")
  if [[ "$status" != 200 ]]; then
    echo "Smoke request returned HTTP $status for $url" >&2
    exit 1
  fi
}

request "$base_url/?smoke=$nonce" "$workdir/index.html" "$workdir/index.headers"
grep -Eq '/_next/static/[^" ]+\.js' "$workdir/index.html"
grep -Eq 'property="og:image"' "$workdir/index.html"
grep -Eq 'content="https?://[^\"]+/og\.png"' "$workdir/index.html"
grep -Eiq '^cache-control:.*no-store' "$workdir/index.headers"

request "$base_url/health?smoke=$nonce" "$workdir/health.json" "$workdir/health.headers"
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$workdir/health.json"

request "$base_url/og.png" "$workdir/og.png" "$workdir/og.headers"
grep -Eiq '^content-type:[[:space:]]*image/png' "$workdir/og.headers"

echo "Origin smoke passed for $base_url"
