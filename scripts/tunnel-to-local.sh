#!/usr/bin/env bash
# Helper script to create a tunnel to a local port
# Usage: ./scripts/tunnel-to-local.sh <port> [api_base] [ctrl]
# Example: ./scripts/tunnel-to-local.sh 3000

set -euo pipefail

PORT="${1:-3000}"
API_BASE="${AGENTCLOUD_API_BASE:-${2:-https://api.uplink.spot}}"
CTRL="${TUNNEL_CTRL:-${3:-178.156.149.124:7071}}"
DOMAIN="${TUNNEL_DOMAIN:-t.uplink.spot}"
TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Creating tunnel to localhost:${PORT}..."
echo "API: ${API_BASE}"
echo "Control: ${CTRL}"

# Create tunnel via API
RESPONSE=$(curl -sS "${API_BASE}/v1/tunnels" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"port\":${PORT}}")

TOKEN=$(node -e "const d=JSON.parse(process.argv[1]||'{}'); console.log(d.token||'');" "${RESPONSE}")
URL=$(node -e "const d=JSON.parse(process.argv[1]||'{}'); console.log(d.url||'');" "${RESPONSE}")

if [[ -z "${TOKEN}" ]]; then
  echo "❌ Failed to create tunnel"
  echo "${RESPONSE}"
  exit 1
fi

echo ""
echo "✅ Tunnel created!"
echo "🌐 Public URL: ${URL}"
echo ""
echo "Starting tunnel client..."
echo "Press Ctrl+C to stop"
echo ""

cd "${PROJECT_DIR}"
node scripts/tunnel/client.js --token "${TOKEN}" --port "${PORT}" --ctrl "${CTRL}"


