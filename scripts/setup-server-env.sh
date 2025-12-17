#!/bin/bash
# Interactive script to create .env file on the server
# Usage: ./scripts/setup-server-env.sh

set -e

# Load local .env if it exists (for reference, not to copy secrets)
if [ -f .env ]; then
  source .env
fi

SERVER_IP="${DIGITAL_OCEAN_IP:-64.227.30.146}"
SERVER_USER="root"

echo "🔧 Setting up .env file on server: ${SERVER_IP}"
echo ""

# Check if sshpass is available (for password-based SSH)
USE_SSHPASS=false
if command -v sshpass &> /dev/null && [ -n "$DIGITAL_SSH_PASSWORD" ]; then
  USE_SSHPASS=true
fi

# Function to run SSH command
run_ssh() {
  if [ "$USE_SSHPASS" = true ]; then
    sshpass -p "$DIGITAL_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP} "$@"
  else
    ssh ${SERVER_USER}@${SERVER_IP} "$@"
  }
}

# Function to run SCP command
run_scp() {
  if [ "$USE_SSHPASS" = true ]; then
    sshpass -p "$DIGITAL_SSH_PASSWORD" scp -o StrictHostKeyChecking=no "$@"
  else
    scp "$@"
  }
}

echo "Please provide the following values:"
echo ""

# Get values interactively
read -p "CONTROL_PLANE_DATABASE_URL (Postgres connection string): " DB_URL
read -p "NEON_API_KEY: " NEON_KEY
read -p "NEON_PROJECT_ID: " NEON_PROJECT
read -p "NEON_ORGANIZATION_ID (optional, press Enter to skip): " NEON_ORG
read -p "PORT (default 4000, press Enter for default): " PORT_INPUT
PORT=${PORT_INPUT:-4000}

# Create .env content
ENV_CONTENT="CONTROL_PLANE_DATABASE_URL=${DB_URL}
NEON_API_KEY=${NEON_KEY}
NEON_PROJECT_ID=${NEON_PROJECT}
PORT=${PORT}
TUNNEL_DOMAIN=dev.uplink.spot
TUNNEL_USE_HOST=true"

# Add optional NEON_ORGANIZATION_ID if provided
if [ -n "$NEON_ORG" ]; then
  ENV_CONTENT="${ENV_CONTENT}
NEON_ORGANIZATION_ID=${NEON_ORG}"
fi

# Create .env file on server
echo ""
echo "📝 Creating .env file on server..."
run_ssh "cat > /opt/agentcloud/.env << 'ENVEOF'
${ENV_CONTENT}
ENVEOF
"

echo "✅ .env file created!"
echo ""

# Verify file was created
echo "📋 Verifying .env file (hiding sensitive values)..."
run_ssh "cat /opt/agentcloud/.env | sed 's/=.*/=***/'"

echo ""
echo "🔄 Restarting backend API service..."
run_ssh "systemctl restart backend-api && sleep 2"

echo ""
echo "📊 Backend API status:"
run_ssh "systemctl status backend-api --no-pager -l | head -20"

echo ""
echo "✅ Setup complete!"
echo ""
echo "To check logs:"
echo "  ssh ${SERVER_USER}@${SERVER_IP} 'journalctl -u backend-api -f'"





