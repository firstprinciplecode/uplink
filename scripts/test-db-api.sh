#!/usr/bin/env bash
set -euo pipefail

# Helper script to run DB API smoke test with stub server
# Usage: bash scripts/test-db-api.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

STUB_PORT="${STUB_PORT:-4100}"
STUB_TOKEN="${STUB_TOKEN:-dev-token}"

echo "Starting stub control-plane API on port $STUB_PORT..."
PORT="$STUB_PORT" AGENTCLOUD_TOKEN_DEV="$STUB_TOKEN" node scripts/dev/stub-control-plane.js &
STUB_PID=$!

# Cleanup function
cleanup() {
  echo ""
  echo "Stopping stub server (PID: $STUB_PID)..."
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
echo "Waiting for server to start..."
for i in {1..10}; do
  if curl -sS "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Check if server is actually running
if ! kill -0 "$STUB_PID" 2>/dev/null; then
  echo "ERROR: Stub server failed to start" >&2
  exit 1
fi

echo "Running smoke test..."
AGENTCLOUD_TOKEN="$STUB_TOKEN" AGENTCLOUD_API_BASE="http://127.0.0.1:$STUB_PORT" bash scripts/db-api-smoke.sh

echo ""
echo "✅ All tests passed!"



