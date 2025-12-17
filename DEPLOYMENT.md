# Deployment Guide for uplink.spot

## Overview

This guide walks through deploying the tunnel relay service to make `uplink.spot` publicly accessible.

## Architecture

```
Internet
  ↓
*.dev.uplink.spot (DNS → Server IP)
  ↓
Caddy (TLS termination, port 443)
  ↓
Tunnel Relay (port 7070/7071)
  ↓
Tunnel Clients (connect from user machines)
  ↓
User's localhost:3000
```

## Step 1: Provision Server

Choose a provider and create a VM:

**DigitalOcean:**
```bash
# Create droplet via CLI or web UI
# Recommended: Ubuntu 22.04, 1GB RAM minimum, $6/mo
```

**AWS EC2:**
```bash
# Launch instance: Ubuntu 22.04, t3.micro or larger
```

**Notes:**
- Need public IP address
- Open ports: 22 (SSH), 443 (HTTPS), 80 (HTTP redirect)
- Can close 7070/7071 after Caddy is set up (Caddy handles external traffic)

## Step 2: DNS Configuration

In your domain registrar (where you bought `uplink.spot`):

1. **Add A record:**
   - Name: `dev` (or `*` for wildcard)
   - Type: `A`
   - Value: Your server's IP address
   - TTL: 300 (5 minutes)

2. **For wildcard subdomains, add:**
   - Name: `*`
   - Type: `A`
   - Value: Your server's IP address

This allows `abc123.dev.uplink.spot`, `xyz789.dev.uplink.spot`, etc.

## Step 3: Server Setup

SSH into your server:

```bash
ssh root@YOUR_SERVER_IP
```

### Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should show v20.x
```

### Install Caddy (for TLS)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Clone/Deploy Code

```bash
# Option 1: Clone repo
git clone YOUR_REPO_URL
cd agentcloud

# Option 2: Upload files via SCP
# scp -r . root@YOUR_SERVER_IP:/opt/agentcloud
```

### Install Dependencies

```bash
cd /opt/agentcloud  # or wherever you cloned
npm install --production
```

## Step 4: Configure Caddy

Create `/etc/caddy/Caddyfile`:

```caddy
*.dev.uplink.spot {
    reverse_proxy localhost:7070
}

dev.uplink.spot {
    reverse_proxy localhost:7070
}
```

Start Caddy:

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
sudo systemctl status caddy
```

Caddy will automatically:
- Get Let's Encrypt certificates for `*.dev.uplink.spot`
- Handle TLS termination
- Forward requests to your relay on port 7070

## Step 5: Configure Tunnel Relay

Create `/etc/systemd/system/tunnel-relay.service`:

```ini
[Unit]
Description=AgentCloud Tunnel Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/agentcloud
Environment="NODE_ENV=production"
Environment="TUNNEL_RELAY_HTTP=7070"
Environment="TUNNEL_RELAY_CTRL=7071"
ExecStart=/usr/bin/node /opt/agentcloud/scripts/tunnel/relay.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable tunnel-relay
sudo systemctl start tunnel-relay
sudo systemctl status tunnel-relay
```

## Step 6: Update Environment Variables

Update your local `.env`:

```bash
# Tunnel configuration
TUNNEL_CTRL=tunnel.dev.uplink.spot:7071  # or use IP if DNS not ready
TUNNEL_RELAY_HTTP=https://dev.uplink.spot
TUNNEL_DOMAIN=dev.uplink.spot
```

## Step 7: Update Tunnel Code for Host-Based Routing

The tunnel relay needs to support host-based routing (`abc123.dev.uplink.spot`) instead of path-based (`/t/abc123/`).

See `scripts/tunnel/relay-host.js` for updated version.

## Step 8: Test

From your local machine:

```bash
export AGENTCLOUD_API_BASE=http://localhost:4000
export AGENTCLOUD_TOKEN=dev-token
export TUNNEL_CTRL=tunnel.dev.uplink.spot:7071

# Start a local app
python -m http.server 3000

# In another terminal, tunnel it
npx tsx cli/src/index.ts dev --tunnel --port 3000
```

You should get a URL like `https://abc123.dev.uplink.spot`.

## Troubleshooting

**DNS not resolving:**
- Wait 5-10 minutes for DNS propagation
- Check with: `dig dev.uplink.spot` or `nslookup dev.uplink.spot`

**Caddy not starting:**
- Check logs: `sudo journalctl -u caddy -f`
- Verify DNS is pointing to your server

**Tunnel relay not connecting:**
- Check logs: `sudo journalctl -u tunnel-relay -f`
- Verify port 7071 is accessible (may need firewall rules)

**TLS certificate issues:**
- Caddy logs will show Let's Encrypt challenges
- Ensure port 80/443 are open
- Check DNS is correct

## Security Notes

- Consider using a non-root user for the tunnel relay
- Set up firewall rules (UFW) to only allow necessary ports
- Monitor logs for abuse
- Consider rate limiting in the relay





