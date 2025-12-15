#!/bin/bash
# Quick script to create a tunnel for your local app

set -e

# Allow overrides from the caller; default to sane dev values
export AGENTCLOUD_TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"
export AGENTCLOUD_API_BASE="${AGENTCLOUD_API_BASE:-http://64.227.30.146:4000}"
export TUNNEL_CTRL="${TUNNEL_CTRL:-tunnel.dev.uplink.spot:7071}"

# Get port from argument or default to 3000
PORT=${1:-3000}

echo "🚀 Creating tunnel for port $PORT..."
echo ""
echo "Environment:"
echo "  AGENTCLOUD_API_BASE=$AGENTCLOUD_API_BASE"
echo "  TUNNEL_CTRL=$TUNNEL_CTRL"
echo "  Port: $PORT"
echo ""

cd "$(dirname "$0")/.."
npm run dev:cli -- dev --tunnel --port "$PORT"

