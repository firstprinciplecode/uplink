#!/bin/bash
# Server setup script for DigitalOcean droplet
# Run this on the server after SSH'ing in

set -e

echo "🚀 Setting up tunnel relay server..."

# Update system
echo "📦 Updating system packages..."
apt-get update
apt-get upgrade -y

# Install Node.js 20.x
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

# Install Caddy
echo "📦 Installing Caddy..."
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

# Install git (if not already installed)
apt-get install -y git

# Create app directory
mkdir -p /opt/agentcloud
cd /opt/agentcloud

echo "✅ Server setup complete!"
echo ""
echo "Next steps:"
echo "1. Upload your code to /opt/agentcloud"
echo "2. Run: cd /opt/agentcloud && npm install"
echo "3. Configure Caddy (see DEPLOYMENT.md)"
echo "4. Create systemd service for tunnel relay"



