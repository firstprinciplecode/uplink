#!/bin/bash
# Complete server setup script for tunnel relay
# Run this ON THE SERVER via SSH

set -e

echo "🚀 Setting up tunnel relay server..."

# Update system
echo "📦 Updating system..."
apt-get update
apt-get upgrade -y

# Install Node.js 20.x
echo "📦 Installing Node.js 20..."
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

# Install git (for cloning if needed)
apt-get install -y git

echo "✅ Base packages installed!"
echo ""
echo "Next: Deploy code and configure services"



