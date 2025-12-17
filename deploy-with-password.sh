#!/bin/bash
# Deploy script using password from .env
# Usage: bash deploy-with-password.sh

set -e

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

SERVER_IP="64.227.30.146"
SERVER_USER="root"
APP_DIR="/opt/agentcloud"
PASSWORD="${DIGITAL_SSH_PASSWORD:-}"

if [ -z "$PASSWORD" ]; then
  echo "❌ DIGITAL_SSH_PASSWORD not found in .env"
  echo "Please add: DIGITAL_SSH_PASSWORD=your_password"
  exit 1
fi

echo "🚀 Deploying to server $SERVER_IP..."

# Install sshpass if not available (for password auth)
if ! command -v sshpass &> /dev/null; then
  echo "📦 Installing sshpass..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install hudochenkov/sshpass/sshpass || echo "⚠️  Please install sshpass: brew install hudochenkov/sshpass/sshpass"
  else
    sudo apt-get install -y sshpass
  fi
fi

# Test SSH connection first
echo "🔍 Testing SSH connection..."
if sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${SERVER_USER}@${SERVER_IP} "echo 'SSH OK'" 2>/dev/null; then
  echo "✅ SSH connection successful!"
else
  echo "❌ SSH connection failed. Please:"
  echo "1. Use DigitalOcean web console to access server"
  echo "2. Run: systemctl start ssh && systemctl enable ssh"
  echo "3. Run: ufw allow 22/tcp (if firewall is active)"
  exit 1
fi

# Create deployment package
echo "📦 Creating deployment package..."
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='data' \
    --exclude='*.log' \
    -czf /tmp/agentcloud-deploy.tar.gz .

# Upload to server
echo "📤 Uploading to server..."
sshpass -p "$PASSWORD" scp -o StrictHostKeyChecking=no /tmp/agentcloud-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/

# Run setup on server
echo "🔧 Setting up on server..."
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP} << ENDSSH
set -e
mkdir -p ${APP_DIR}
cd ${APP_DIR}
if [ -f "package.json" ]; then
  echo "Code exists, updating..."
  tar -xzf /tmp/agentcloud-deploy.tar.gz -C ${APP_DIR} --overwrite
else
  echo "Extracting code..."
  tar -xzf /tmp/agentcloud-deploy.tar.gz -C ${APP_DIR}
fi
npm install --production
echo "✅ Code deployed!"
ENDSSH

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. SSH into server: sshpass -p 'YOUR_PASSWORD' ssh root@${SERVER_IP}"
echo "2. Configure Caddy and systemd service (see DEPLOYMENT.md)"





