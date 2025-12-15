#!/bin/bash
# Deploy script - run from your local machine
# Uploads code to server and sets up services

set -e

SERVER_IP="64.227.30.146"
SERVER_USER="root"
APP_DIR="/opt/agentcloud"

echo "🚀 Deploying to server $SERVER_IP..."

# Create deployment package (exclude node_modules, .git, etc.)
echo "📦 Creating deployment package..."
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='data' \
    --exclude='*.log' \
    -czf /tmp/agentcloud-deploy.tar.gz .

# Upload to server
echo "📤 Uploading to server..."
scp /tmp/agentcloud-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/

# Run setup on server
echo "🔧 Setting up on server..."
ssh ${SERVER_USER}@${SERVER_IP} << 'ENDSSH'
set -e
cd /opt/agentcloud
if [ -d ".git" ]; then
  echo "Code already exists, updating..."
  git pull || true
else
  echo "Extracting code..."
  tar -xzf /tmp/agentcloud-deploy.tar.gz -C /opt/agentcloud
fi
npm install --production
echo "✅ Code deployed!"
ENDSSH

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next: SSH into server and configure:"
echo "  ssh root@${SERVER_IP}"
echo "  See DEPLOYMENT.md for Caddy and systemd setup"



