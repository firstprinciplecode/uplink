#!/bin/bash
# Quick script to deploy just the Caddyfile

set -e

# SECURITY NOTE:
# This script supports password-based SSH via sshpass for convenience.
# Never hardcode passwords/tokens in this repo. Use env vars (e.g. DIGITAL_SSH_PASSWORD).
# Rotate credentials immediately if you suspect exposure.

# Load .env if it is readable (Cursor sandbox may block reading ignored files like .env)
if [ -r .env ]; then
  set -a
  . ./.env
  set +a
fi

SERVER_IP="64.227.30.146"
SERVER_USER="root"
PASSWORD="${DIGITAL_SSH_PASSWORD:-${1:-}}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

if [ -z "$PASSWORD" ]; then
  echo "❌ DIGITAL_SSH_PASSWORD not set"
  echo ""
  echo "Usage:"
  echo "  DIGITAL_SSH_PASSWORD='...' ./scripts/deploy-caddyfile.sh"
  echo "  ./scripts/deploy-caddyfile.sh '...'"
  exit 1
fi

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
  echo "❌ sshpass not found. Install with: brew install hudochenkov/sshpass/sshpass"
  echo ""
  echo "Manual deploy:"
  echo "  scp server-config/caddyfile root@${SERVER_IP}:/etc/caddy/Caddyfile"
  echo "  ssh root@${SERVER_IP} 'caddy reload --config /etc/caddy/Caddyfile'"
  exit 1
fi

echo "📤 Deploying Caddyfile..."
#
# NOTE: Use legacy scp mode (-O) to avoid SFTP-related hangs on some hosts.
# Add timeouts/keepalives so the command fails fast instead of hanging forever.
#
sshpass -p "$PASSWORD" scp -O ${SSH_OPTS} server-config/caddyfile ${SERVER_USER}@${SERVER_IP}:/etc/caddy/Caddyfile

echo "🔄 Reloading Caddy..."
sshpass -p "$PASSWORD" ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_IP} "caddy reload --config /etc/caddy/Caddyfile"

echo "✅ Caddyfile deployed and reloaded!"

