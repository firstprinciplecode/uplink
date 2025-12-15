#!/usr/bin/env bash
# Run all smoke tests
set -euo pipefail

echo "🧪 Running all smoke tests..."
echo ""

echo "1️⃣  Database API smoke test..."
if API_BASE="${AGENTCLOUD_API_BASE:-${API_BASE:-https://api.uplink.spot}}" \
  AGENTCLOUD_TOKEN="${AGENTCLOUD_TOKEN:-${AUTH_TOKEN:-dev-token}}" \
  bash scripts/db-api-smoke.sh; then
  echo "✅ Database API test passed"
else
  echo "❌ Database API test failed"
  exit 1
fi

echo ""
echo "2️⃣  Tunnel smoke test..."
if API_BASE="${AGENTCLOUD_API_BASE:-${API_BASE:-https://api.uplink.spot}}" \
  AGENTCLOUD_TOKEN="${AGENTCLOUD_TOKEN:-${AUTH_TOKEN:-dev-token}}" \
  TUNNEL_CTRL="${TUNNEL_CTRL:-178.156.149.124:7071}" \
  TUNNEL_RELAY_HTTP="${TUNNEL_RELAY_HTTP:-https://t.uplink.spot}" \
  TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-t.uplink.spot}" \
  npm run smoke:tunnel; then
  echo "✅ Tunnel test passed"
else
  echo "❌ Tunnel test failed"
  exit 1
fi

echo ""
echo "✅ All smoke tests passed!"



