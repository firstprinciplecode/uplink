# Hetzner Cloud Deployment Guide

Complete step-by-step guide to deploy AgentCloud on Hetzner Cloud with Cloudflare DNS and wildcard HTTPS.

## Prerequisites

- Hetzner server IP: `178.156.149.124`
- Cloudflare API token: `6I__Cyj4haiemIOxVrPn0iiEy11x_PgcpqHqTrd4`
- Domain: `uplink.spot` (DNS hosted on Cloudflare)
- DNS records already configured:
  - `api.uplink.spot` → `178.156.149.124`
  - `tunnel.uplink.spot` → `178.156.149.124`
  - `*.t.uplink.spot` → `178.156.149.124`

## Step 1: SSH into Server

```bash
ssh root@178.156.149.124
```

## Step 2: Update System & Install Dependencies

```bash
apt update && apt upgrade -y
apt install -y curl git build-essential
```

## Step 3: Install Node.js (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt install -y nodejs
node --version  # Should show v20.x or v22.x
```

## Step 4: Install Go (required for building Caddy)

```bash
apt install -y golang-go
go version
```

## Step 5: Build Caddy with Cloudflare DNS Module

```bash
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
/root/go/bin/xcaddy build --with github.com/caddy-dns/cloudflare
mv caddy /usr/local/bin/
chmod +x /usr/local/bin/caddy
caddy version
```

## Step 6: Clone AgentCloud Repository

```bash
cd /opt
git clone <YOUR_REPO_URL> agentcloud
# Or if you need to upload manually:
# mkdir -p /opt/agentcloud
# Then upload files via scp/rsync
cd /opt/agentcloud
npm ci
```

## Step 7: Create Environment File

```bash
cat > /opt/agentcloud/.env << 'EOF'
# Control-plane API
PORT=4000
CONTROL_PLANE_DATABASE_URL=postgresql://user:password@host:5432/dbname

# Auth tokens
AGENTCLOUD_TOKEN_DEV=dev-token

# Database provider (Neon)
NEON_API_KEY=your_neon_api_key
NEON_PROJECT_ID=your_neon_project_id
DB_LIMIT_PER_USER=5

# Tunnel configuration
TUNNEL_DOMAIN=t.uplink.spot
TUNNEL_URL_SCHEME=https
EOF

chmod 600 /opt/agentcloud/.env
```

**⚠️ IMPORTANT:** Replace the placeholder values:
- `CONTROL_PLANE_DATABASE_URL`: Your Postgres connection string
- `NEON_API_KEY`: Your Neon API key
- `NEON_PROJECT_ID`: Your Neon project ID

## Step 8: Create Caddyfile

```bash
cat > /etc/caddy/Caddyfile << 'EOF'
{
	# Optional: set your email for ACME notifications
	# email you@example.com
}

(cloudflare_tls) {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
}

api.uplink.spot {
	import cloudflare_tls
	reverse_proxy 127.0.0.1:4000
}

# Tunnel ingress: host routing relies on preserving the Host header (<token>.t.uplink.spot)
*.t.uplink.spot {
	import cloudflare_tls
	reverse_proxy 127.0.0.1:7070 {
		header_up Host {http.request.host}
	}
}

# Optional base host (handy for health checks / debugging)
t.uplink.spot {
	import cloudflare_tls
	respond "uplink tunnel ingress ok" 200
}
EOF
```

## Step 9: Create Caddy Environment File

```bash
cat > /etc/caddy/caddy.env << 'EOF'
CLOUDFLARE_API_TOKEN=6I__Cyj4haiemIOxVrPn0iiEy11x_PgcpqHqTrd4
EOF

chmod 600 /etc/caddy/caddy.env
```

## Step 10: Create Caddy Systemd Service

```bash
cat > /etc/systemd/system/caddy.service << 'EOF'
[Unit]
Description=Caddy web server
Documentation=https://caddyserver.com/docs/
After=network.target

[Service]
Type=notify
User=www-data
Group=www-data
EnvironmentFile=-/etc/caddy/caddy.env
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable caddy
```

## Step 11: Create Backend API Systemd Service

```bash
cat > /etc/systemd/system/backend-api.service << 'EOF'
[Unit]
Description=AgentCloud Backend API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/agentcloud
Environment="NODE_ENV=production"
EnvironmentFile=-/opt/agentcloud/.env
ExecStart=/usr/bin/npx tsx backend/src/server.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
```

## Step 12: Create Tunnel Relay Systemd Service

```bash
cat > /etc/systemd/system/tunnel-relay.service << 'EOF'
[Unit]
Description=AgentCloud Tunnel Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/agentcloud
Environment="NODE_ENV=production"
Environment="TUNNEL_DOMAIN=t.uplink.spot"
ExecStart=/usr/bin/node /opt/agentcloud/scripts/tunnel/relay-host.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
```

## Step 13: Configure Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7070/tcp
ufw allow 7071/tcp
ufw --force enable
ufw status
```

## Step 14: Run Database Migrations

```bash
cd /opt/agentcloud
npm run migrate
```

## Step 15: Start Services

```bash
systemctl start caddy
systemctl start backend-api
systemctl start tunnel-relay

# Check status
systemctl status caddy
systemctl status backend-api
systemctl status tunnel-relay
```

## Step 16: Verify Everything Works

### Check Caddy logs:
```bash
journalctl -u caddy -f
```

### Check API health:
```bash
curl https://api.uplink.spot/health
```

### Check tunnel ingress:
```bash
curl https://t.uplink.spot
# Should return: "uplink tunnel ingress ok"
```

## Troubleshooting

### Caddy fails to start:
- Check logs: `journalctl -u caddy -n 50`
- Verify Cloudflare token: `cat /etc/caddy/caddy.env`
- Test Caddy config: `caddy validate --config /etc/caddy/Caddyfile`

### API not accessible:
- Check logs: `journalctl -u backend-api -n 50`
- Verify .env file: `cat /opt/agentcloud/.env`
- Check if port 4000 is listening: `netstat -tlnp | grep 4000`

### Tunnel relay not working:
- Check logs: `journalctl -u tunnel-relay -n 50`
- Verify ports are open: `netstat -tlnp | grep -E '7070|7071'`

## Next Steps

1. **Test tunnel creation** from your local machine:
   ```bash
   export AGENTCLOUD_API_BASE=https://api.uplink.spot
   export AGENTCLOUD_TOKEN=dev-token
   export TUNNEL_CTRL=tunnel.uplink.spot:7071
   npm run dev:cli -- dev --tunnel --port 3000
   ```

2. **Update your local `.env`** to use the new production endpoints:
   ```bash
   AGENTCLOUD_API_BASE=https://api.uplink.spot
   TUNNEL_CTRL=tunnel.uplink.spot:7071
   TUNNEL_DOMAIN=t.uplink.spot
   ```

3. **Run smoke tests**:
   ```bash
   # Option A: Using DNS (requires tunnel.uplink.spot A record pointing to server IP)
   AGENTCLOUD_API_BASE=https://api.uplink.spot AGENTCLOUD_TOKEN=dev-token \
   TUNNEL_CTRL=tunnel.uplink.spot:7071 TUNNEL_DOMAIN=t.uplink.spot \
   npm run smoke:all
   
   # Option B: Using server IP directly (no DNS needed for tunnel control)
   AGENTCLOUD_API_BASE=https://api.uplink.spot AGENTCLOUD_TOKEN=dev-token \
   TUNNEL_CTRL=178.156.149.124:7071 TUNNEL_DOMAIN=t.uplink.spot \
   npm run smoke:all
   ```
   
   **Note**: The tunnel control endpoint (port 7071) uses raw TCP, so you can use either:
   - `tunnel.uplink.spot:7071` (requires DNS A record)
   - `178.156.149.124:7071` (works without DNS)

## Security Notes

- **Rotate secrets**: The Cloudflare API token and database credentials should be rotated regularly
- **Firewall**: Only ports 22, 80, 443, 7070, 7071 are open
- **SSH keys**: Disable password SSH and use key-based auth only
- **Updates**: Keep system and Node.js updated: `apt update && apt upgrade`
- **Backups**: Set up regular backups of `/opt/agentcloud/.env` and database

