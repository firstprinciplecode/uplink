#!/usr/bin/env bash
# Quick script to deploy admin files to server
# Usage: ./scripts/deploy-admin-to-server.sh

set -e

SERVER_IP="${HETZNER_SERVER_IP:-178.156.149.124}"
SERVER_USER="root"

echo "🚀 Deploying admin files to server..."

# Copy admin files
scp backend/src/routes/admin.ts ${SERVER_USER}@${SERVER_IP}:/opt/agentcloud/backend/src/routes/
scp cli/src/subcommands/admin.ts ${SERVER_USER}@${SERVER_IP}:/opt/agentcloud/cli/src/subcommands/
scp backend/src/server.ts ${SERVER_USER}@${SERVER_IP}:/opt/agentcloud/backend/src/
scp cli/src/index.ts ${SERVER_USER}@${SERVER_IP}:/opt/agentcloud/cli/src/

echo "✅ Files copied. Restarting backend API on server..."

# Restart backend API
ssh ${SERVER_USER}@${SERVER_IP} << 'ENDSSH'
cd /opt/agentcloud
systemctl restart backend-api
sleep 2
systemctl status backend-api --no-pager | head -15
ENDSSH

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Test with:"
echo "  AGENTCLOUD_API_BASE=https://api.uplink.spot AGENTCLOUD_TOKEN=dev-token npm run dev:cli -- admin status"



