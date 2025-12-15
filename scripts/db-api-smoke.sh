#!/usr/bin/env bash
set -euo pipefail

# Simple API smoke test for /v1/dbs endpoints.
# By default this runs a "light" smoke (no Neon provisioning).
# To run full create/link/delete against the provider, set: DB_SMOKE_MODE=full

API_BASE="${AGENTCLOUD_API_BASE:-https://api.uplink.spot}"
TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"
PROJECT="${PROJECT:-smoke-project}"
SERVICE="${SERVICE:-myapp-api}"
ENV_VAR="${ENV_VAR:-DATABASE_URL}"
REGION="${REGION:-eu-central-1}"
PLAN="${PLAN:-dev}"
PROVIDER="${PROVIDER:-neon}"
MODE="${DB_SMOKE_MODE:-light}" # light|full
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
MAX_TIME="${MAX_TIME:-20}"

TMP="$(mktemp -d)"
cleanup() {
  # Best-effort cleanup for full mode
  if [ "${MODE}" = "full" ] && [ -n "${DB_ID:-}" ]; then
    curl -sS --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" \
      -X DELETE "$API_BASE/v1/dbs/$DB_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

api() {
  local method="$1" path="$2" body="${3:-}"
  local out_body="$TMP/body.json" out_status="$TMP/status.txt"
  if [ -n "$body" ]; then
    curl -sS --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" \
      -o "$out_body" -w "%{http_code}" \
      -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" >"$out_status"
  else
    curl -sS --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" \
      -o "$out_body" -w "%{http_code}" \
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

echo "Running DB API smoke against $API_BASE (mode=$MODE project=$PROJECT)"

echo "OK   health (no-auth)"
curl -sS --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" \
  "$API_BASE/health" | grep -q '"ok"' || {
  echo "FAIL health: $API_BASE/health did not return status ok" >&2
  exit 1
}

# Always do an authenticated read to validate auth + control-plane DB connectivity.
PROJECT_QS=$(node -e "console.log(encodeURIComponent(process.argv[1]||''))" "$PROJECT")
api GET "/v1/dbs?project=$PROJECT_QS"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "list"

if [ "$MODE" != "full" ]; then
  echo "Smoke test passed (light mode; no provider provisioning)."
  exit 0
fi

DB_NAME="db_smoke_$(date +%s)"

# Create
api POST "/v1/dbs" "{\"name\":\"$DB_NAME\",\"project\":\"$PROJECT\",\"provider\":\"$PROVIDER\",\"region\":\"$REGION\",\"plan\":\"$PLAN\"}"
assert_status "201" "$TMP/status.txt" "$TMP/body.json" "create"
DB_ID="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1]));if(!r.id){process.exit(1);}console.log(r.id);" "$TMP/body.json")"
echo "Created DB: $DB_ID"

# Info
api GET "/v1/dbs/$DB_ID"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "info"

# Link
api POST "/v1/dbs/$DB_ID/link-service" "{\"service\":\"$SERVICE\",\"envVar\":\"$ENV_VAR\"}"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "link"

# Delete
api DELETE "/v1/dbs/$DB_ID"
assert_status "200" "$TMP/status.txt" "$TMP/body.json" "delete"
DB_ID="" # prevents cleanup from double-deleting

echo "Smoke test passed."

