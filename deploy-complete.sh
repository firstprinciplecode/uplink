#!/bin/bash
# Complete deployment script - run from local machine
# Deploys code and configures services on the server

set -e

# Load .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

SERVER_IP="64.227.30.146"
SERVER_USER="root"
APP_DIR="/opt/agentcloud"
PASSWORD="${DIGITAL_SSH_PASSWORD:-}"

if [ -z "$PASSWORD" ]; then
  echo "❌ DIGITAL_SSH_PASSWORD not found in .env"
  exit 1
fi

echo "🚀 Deploying to $SERVER_IP..."

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
  echo "⚠️  sshpass not found. Install with: brew install hudochenkov/sshpass/sshpass"
  echo "Or run commands manually via SSH"
  exit 1
fi

# Create deployment package
echo "📦 Creating deployment package..."
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='data' \
    --exclude='*.log' \
    --exclude='.cursor' \
    -czf /tmp/agentcloud-deploy.tar.gz .

# Upload to server
echo "📤 Uploading code..."
sshpass -p "$PASSWORD" scp -o StrictHostKeyChecking=no /tmp/agentcloud-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/

# Run deployment on server
echo "🔧 Setting up on server..."
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP} << 'ENDSSH'
set -e
APP_DIR="/opt/agentcloud"

# Extract code
mkdir -p ${APP_DIR}
cd ${APP_DIR}
tar -xzf /tmp/agentcloud-deploy.tar.gz -C ${APP_DIR} --overwrite

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install --production

# Configure Caddy
echo "🔧 Configuring Caddy..."
cp ${APP_DIR}/server-config/caddyfile /etc/caddy/Caddyfile

# Validate Caddyfile syntax
caddy validate --config /etc/caddy/Caddyfile || {
  echo "⚠️  Caddyfile validation failed. Checking logs..."
  journalctl -u caddy -n 20 --no-pager || true
  echo "⚠️  Continuing anyway - DNS may not be ready yet"
}

# Enable and try to start Caddy
systemctl enable caddy
systemctl start caddy 2>&1 || {
  echo "⚠️  Caddy start failed. This is OK if DNS isn't configured yet."
  echo "    Once DNS is ready (*.dev.uplink.spot -> 64.227.30.146), run:"
  echo "    systemctl restart caddy"
  echo ""
  echo "    Check logs: journalctl -u caddy -f"
}

# Configure tunnel relay service
echo "🔧 Configuring tunnel relay service..."
cp ${APP_DIR}/server-config/tunnel-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable tunnel-relay
systemctl restart tunnel-relay

# Check status
echo ""
echo "📊 Service status:"
echo ""
echo "Tunnel Relay:"
systemctl status tunnel-relay --no-pager -l | head -15 || echo "  ⚠️  Service not running"
echo ""
echo "Caddy:"
systemctl status caddy --no-pager -l | head -15 || echo "  ⚠️  Service not running (DNS may not be ready)"

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Tunnel relay should be running at:"
echo "  - HTTP ingress: port 7070 (behind Caddy)"
echo "  - Control: port 7071"
echo ""
echo "Check logs with:"
echo "  journalctl -u tunnel-relay -f"
echo "  journalctl -u caddy -f"
ENDSSH

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Test your tunnel:"
echo "  export TUNNEL_CTRL=tunnel.dev.uplink.spot:7071"
echo "  export TUNNEL_DOMAIN=dev.uplink.spot"
echo "  npx tsx cli/src/index.ts dev --tunnel --port 3000"

