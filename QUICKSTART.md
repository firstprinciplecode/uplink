# Quick Start: Expose Your Localhost to the Internet

This guide shows you how to expose a local development server to the internet using Uplink tunnels.

## Prerequisites

- Node.js installed
- A local server running on a port (e.g., `localhost:3000`)
- An API token (default: `dev-token`)

**Note:** The CLI connects to `https://api.uplink.spot` by default. To use a local API server, set:
```bash
export AGENTCLOUD_API_BASE=http://localhost:4000
```

## The Simplest Way (Recommended)

### Step 1: Start Your Local Server

Start your development server on any port:

```bash
# Example: Start a Node.js server
npm start

# Or start a Python server
python3 -m http.server 3000

# Or any other server - just make sure it's running!
```

**Verify it's working:** Open `http://localhost:3000` (or your port) in your browser.

---

### Step 2: Run Uplink and Start Tunnel

**Important:** Run `uplink` on your **local machine** (where your dev server is running), not on the server!

```bash
# On your LOCAL machine, open the interactive menu
uplink
```

Then:
1. Use arrow keys to select **"🚀 Start tunnel (auto-detect port)"**
2. Press Enter
3. The system will scan for active servers on your **local machine** and show you a list
4. Select the port your server is running on (or enter a custom port)
5. Done! Your tunnel is created and started automatically

**That's it!** You'll see your public URL like:
```
✅ Tunnel created and client started!

🌐 Public URL: https://abc123def456.t.uplink.spot
🔑 Token: abc123def456
📡 Local port: 3000

Open https://abc123def456.t.uplink.spot in your browser to access your local server!
```

---

## Alternative Methods

### Method 2: Direct CLI Command

If you know the port number:

```bash
# Set your API token (if not using default)
export AGENTCLOUD_TOKEN=dev-token

# Create tunnel and connect automatically
npm run dev:cli -- dev --tunnel --port 3000
```

### Method 3: Manual Steps (Advanced)

**3a. Create tunnel via API:**

```bash
curl -X POST https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}'
```

**Response:**
```json
{
  "id": "tun_abc123...",
  "token": "abc123def456",
  "url": "https://abc123def456.t.uplink.spot",
  "targetPort": 3000,
  "status": "active"
}
```

**3b. Start the tunnel client:**

Copy the `token` from the response above, then run:

```bash
node scripts/tunnel/client-improved.js \
  --token abc123def456 \
  --port 3000 \
  --ctrl 178.156.149.124:7071
```

---

## Complete Example

Here's a complete example from start to finish:

```bash
# Terminal 1: Start your local server
cd my-app
npm start
# Server running on http://localhost:3000

# Terminal 2: Start tunnel (easiest way)
uplink
# Then select "🚀 Start tunnel (auto-detect port)"
# Choose port 3000 from the list
# Done! Your tunnel URL is displayed

# Or use direct command:
export AGENTCLOUD_TOKEN=dev-token
npm run dev:cli -- dev --tunnel --port 3000

# Output:
# ✅ Tunnel created and client started!
# 🌐 Public URL: https://abc123def456.t.uplink.spot
# Open https://abc123def456.t.uplink.spot in your browser!
```

---

## Environment Variables

You can customize the tunnel behavior with environment variables:

```bash
# API endpoint (default: https://api.uplink.spot)
export AGENTCLOUD_API_BASE=https://api.uplink.spot

# Your API token (default: dev-token)
export AGENTCLOUD_TOKEN=dev-token

# Tunnel control server (default: 178.156.149.124:7071)
export TUNNEL_CTRL=178.156.149.124:7071

# Tunnel domain (default: t.uplink.spot)
export TUNNEL_DOMAIN=t.uplink.spot

# Optional: show relay status in the menu (set if you want the banner)
# Set these before running `uplink` locally:
# RELAY_HEALTH_URL points to the relay /health endpoint
# RELAY_INTERNAL_SECRET must match the relay/backend secret if set
export RELAY_HEALTH_URL=http://t.uplink.spot:7070/health
# export RELAY_INTERNAL_SECRET=<your-relay-secret>
```

### Ops notes (relay/backend)
- Relay binds HTTP ingress to loopback by default: `TUNNEL_RELAY_HTTP_HOST=127.0.0.1`
- Protect internal endpoints with a shared secret: `RELAY_INTERNAL_SECRET=<same-secret-on-backend>`
- Set the same `RELAY_INTERNAL_SECRET` on the backend service so admin tunnel status works.

---

## Troubleshooting

### "Connection refused" error
- **Check:** Is your local server running on the specified port?
- **Fix:** Start your server first, then create the tunnel

### "Cannot connect to relay" error
- **Check:** Is the relay server running?
- **Fix:** Verify the `TUNNEL_CTRL` address is correct

### Tunnel URL returns "Gateway timeout"
- **Check:** Is the tunnel client still running?
- **Fix:** Make sure the client process didn't exit. Restart it if needed.

### "Tunnel client failed to register"
- **Check:** Is the token correct?
- **Fix:** Create a new tunnel and use the new token

---

## Stopping the Tunnel

**If using CLI:** Press `Ctrl+C` in the terminal where the CLI is running.

**If using manual client:** Press `Ctrl+C` in the terminal where the client is running.

The tunnel will remain in the database but won't be accessible until you reconnect the client.

---

## Next Steps

- **Multiple tunnels:** Create multiple tunnels for different ports
- **Persistent tunnels:** Keep the client running to maintain the tunnel
- **Production use:** Replace `dev-token` with a proper authentication token

---

## Quick Reference

```bash
# Easiest: Interactive menu (auto-detects ports)
uplink
# Then select "🚀 Start tunnel (auto-detect port)"

# Direct command (if you know the port)
npm run dev:cli -- dev --tunnel --port <PORT>

# Manual: Create tunnel via API
curl -X POST https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": <PORT>}'

# Manual: Connect client
node scripts/tunnel/client-improved.js \
  --token <TOKEN> \
  --port <PORT> \
  --ctrl 178.156.149.124:7071

# Test tunnel
curl https://<TOKEN>.t.uplink.spot
```
