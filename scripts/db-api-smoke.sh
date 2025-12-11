#!/usr/bin/env bash
set -euo pipefail

# Simple API smoke test for /v1/dbs endpoints.
# Prereqs: curl, node, AGENTCLOUD_TOKEN set; API running and reachable.

API_BASE="${AGENTCLOUD_API_BASE:-http://localhost:4000}"
TOKEN="${AGENTCLOUD_TOKEN:-}"
PROJECT="${PROJECT:-smoke-project}"
SERVICE="${SERVICE:-myapp-api}"
ENV_VAR="${ENV_VAR:-DATABASE_URL}"
REGION="${REGION:-eu-central-1}"
PLAN="${PLAN:-dev}"
PROVIDER="${PROVIDER:-neon}"

if [ -z "$TOKEN" ]; then
  echo "AGENTCLOUD_TOKEN is required" >&2
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

api() {
  local method="$1" path="$2" body="${3:-}"
  local out_body="$TMP/body.json" out_status="$TMP/status.txt"
  if [ -n "$body" ]; then
    curl -sS -o "$out_body" -w "%{http_code}" \
      -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" >"$out_status"
  else
    curl -sS -o "$out_body" -w "%{http_code}" \
      -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" >"$out_status"
  fi
}

assert_status() {
  local expected="$1" status_file="$2" body_file="$3" label="$4"
  local status
  status="$(cat "$status_file")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL $label: expected $expected got $status" >&2
    cat "$body_file" >&2 || true
    exit 1
  fi
  echo "OK   $label ($status)"
}

echo "Running DB API smoke against $API_BASE (project=$PROJECT)"
DB_NAME="db_smoke_$(date +%s)"

# Create
api POST "/v1/dbs" "{\"name\":\"$DB_NAME\",\"project\":\"$PROJECT\",\"provider\":\"$PROVIDER\",\"region\":\"$REGION\",\"plan\":\"$PLAN\"}"
assert_status "201" "$TMP/status.txt" "$TMP/body.json" "create"
DB_ID="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1]));if(!r.id){process.exit(1);}console.log(r.id);" "$TMP/body.json")"
echo "Created DB: $DB_ID"

# List
PROJECT_QS=$(node -e "console.log(encodeURIComponent(process.env.PROJECT || ''))")
api GET "/v1/dbs?project=$PROJECT_QS"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "list"

# Info
api GET "/v1/dbs/$DB_ID"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "info"

# Link
api POST "/v1/dbs/$DB_ID/link-service" "{\"service\":\"$SERVICE\",\"envVar\":\"$ENV_VAR\"}"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "link"

# Delete
api DELETE "/v1/dbs/$DB_ID"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "delete"

echo "Smoke test passed."

