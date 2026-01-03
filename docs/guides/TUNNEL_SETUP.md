# Tunnel Setup Guide - Step by Step

## Prerequisites

1. **Backend API running** (recommended: behind Caddy at `api.uplink.spot`)
2. **Tunnel relay running** (on server: ports 7070/7071)
3. **Caddy running** (on server: handles routing)
4. **Your app running locally** (e.g., `npm run dev` on port 3000)

## Step-by-Step Instructions

### Step 1: Start Your App

In **Cursor window #1** (or terminal):

```bash
cd /path/to/marketmaker  # or your app directory
npm run dev              # or whatever starts your app
# Make sure it's running on localhost:3000 (or note the port)
```

**Verify it's running:**
```bash
curl http://localhost:3000
# Should see your app's HTML/response
```

### Step 2: Create Tunnel

In **Terminal 2** (uplink directory):

```bash
cd /path/to/uplink  # or wherever you cloned the repo

# Recommended production env (API via Caddy; tunnel ctrl is raw TCP)
export AGENTCLOUD_API_BASE=https://api.uplink.spot
export TUNNEL_CTRL=tunnel.uplink.spot:7071
export TUNNEL_DOMAIN=t.uplink.spot

# Create tunnel (replace 3000 with your app's port)
npm run dev:cli -- dev --tunnel --port 3000
```

**You'll see:**
```
Tunnel URL: https://abc123.t.uplink.spot
Starting tunnel client...
2025-12-11T18:30:39.424Z connected to relay ctrl
2025-12-11T18:30:39.438Z registered with relay
```

**Keep this terminal running!** (The tunnel client must stay active)

### Step 3: Access Your App

**Via HTTPS (wildcard TLS via Cloudflare DNS-01):**

```bash
curl https://abc123.t.uplink.spot
```

**Direct HTTP (bypasses Caddy):**
```bash
curl -H "Host: abc123.t.uplink.spot" http://<SERVER_IP>:7070/
```

### Step 4: Stop Tunnel

When done, press `Ctrl+C` in the tunnel client terminal to stop it.

## Troubleshooting

### Check What's Running

```bash
# Check local ports
lsof -i -P | grep LISTEN | grep -E ":(3000|4000|7070|7071)"

# Check backend API
curl http://localhost:4000/health
# (production via Caddy)
curl https://api.uplink.spot/health

# Check server services
ssh root@<SERVER_IP> "systemctl status backend-api tunnel-relay caddy"
```

### Common Issues

1. **"Connection refused"** → Tunnel client not running or wrong port
2. **"Tunnel not connected"** → Check tunnel client is running and connected
3. **HTTPS errors** → Use HTTP instead (http:// not https://)
4. **App not accessible** → Make sure your app is running on the correct port

### Manual Method (if CLI doesn't work)

```bash
# 1. Create tunnel
curl -X POST https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port":3000}'

# Response: {"token":"abc123...", "url":"https://abc123.t.uplink.spot"}

# 2. Start tunnel client
node scripts/tunnel/client.js \
  --token abc123... \
  --port 3000 \
  --ctrl tunnel.uplink.spot:7071
```

## Current Status

- ✅ **HTTPS tunnel (recommended)**: Use Cloudflare DNS hosting + wildcard TLS
- ✅ **Tunnel client**: Connects and routes traffic
- ✅ **Database persistence**: Tunnels saved to database

## Quick Reference

```bash
# Create tunnel for port 3000
npm run dev:cli -- dev --tunnel --port 3000

# Create tunnel for port 3001
npm run dev:cli -- dev --tunnel --port 3001

# Access via HTTP
https://<token>.t.uplink.spot
```




