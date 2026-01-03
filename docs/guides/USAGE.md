# AgentCloud Service Usage Guide

## What You Can Do Now

Your AgentCloud service is fully deployed and running! Here's what you can do:

### 🌐 Tunnel Service (ngrok-like)

Expose your local development servers to the internet with a public URL.

#### Using the CLI:

```bash
# Start a tunnel for a local server on port 3000
npm run dev:cli -- dev --tunnel --port 3000

# Or with the tunnel client directly
node scripts/tunnel/client.js --token <token> --port 3000 --ctrl tunnel.uplink.spot:7071
```

#### Using the API:

```bash
# Create a tunnel
curl -X POST https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}'

# Response includes:
# {
#   "id": "tun_...",
#   "token": "abc123...",
#   "url": "https://abc123.t.uplink.spot",
#   "targetPort": 3000,
#   "status": "active"
# }

# List your tunnels
curl https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token"

# Delete a tunnel
curl -X DELETE https://api.uplink.spot/v1/tunnels/<tunnel-id> \
  -H "Authorization: Bearer dev-token"
```

#### How It Works:

1. **Create tunnel**: Request a tunnel from the control plane API
2. **Get token**: Receive a unique token (e.g., `abc123`)
3. **Start client**: Run the tunnel client locally, connecting to the relay
4. **Access**: Your local server is now accessible at `https://abc123.dev.uplink.spot`
5. **HTTPS**: Recommended: Cloudflare DNS hosting + wildcard TLS (`*.t.uplink.spot`)

### 🗄️ Database Service

Create and manage PostgreSQL databases via Neon.

#### Using the CLI:

```bash
# Create a database
npm run dev:cli -- db create myapp-db --project myproject

# List databases
npm run dev:cli -- db list

# Get database info
npm run dev:cli -- db info <db-id>

# Delete database
npm run dev:cli -- db delete <db-id>
```

#### Using the API:

```bash
# Create a database
curl -X POST https://api.uplink.spot/v1/dbs \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "myapp-db",
    "project": "myproject",
    "provider": "neon",
    "region": "us-east-1"
  }'

# List databases
curl https://api.uplink.spot/v1/dbs \
  -H "Authorization: Bearer dev-token"

# Get database details
curl https://api.uplink.spot/v1/dbs/<db-id> \
  -H "Authorization: Bearer dev-token"

# Delete database
curl -X DELETE https://api.uplink.spot/v1/dbs/<db-id> \
  -H "Authorization: Bearer dev-token"
```

### 🔧 Configuration

#### Environment Variables (on server):

- `CONTROL_PLANE_DATABASE_URL`: Postgres connection for control plane
- `CONTROL_PLANE_TOKEN_PEPPER`: Optional HMAC pepper for token hashing (set in prod)
- `ADMIN_TOKENS`: Comma-separated break-glass admin tokens (env-only; bypass DB)
- `NEON_API_KEY`: Neon API key for database provisioning
- `NEON_PROJECT_ID`: Neon project ID
- `PORT`: Backend API port (default: 4000)
- `TUNNEL_DOMAIN`: Domain for tunnels (recommended: `t.uplink.spot`)

#### CLI Configuration:

Set in your local `.env`:
- `AGENTCLOUD_API_BASE`: API base URL (default: http://localhost:4000)
- `AGENTCLOUD_TOKEN`: Auth token (use a minted token; dev-token only for local sqlite)
- `TUNNEL_CTRL`: Tunnel control channel (default: 127.0.0.1:7071)

### 📊 Service Status

Check service health:

```bash
# Backend API health
curl https://api.uplink.spot/health

# Check services on server
ssh root@<SERVER_IP> "systemctl status backend-api tunnel-relay caddy"
```

### 🚀 Example Workflow

1. **Start a local dev server**:
   ```bash
   npm start  # Runs on localhost:3000
   ```

2. **Create a tunnel**:
   ```bash
   npm run dev:cli -- dev --tunnel --port 3000
   ```

3. **Get public URL**: The CLI will output something like:
   ```
   Tunnel URL: https://abc123.dev.uplink.spot
   ```

4. **Access your app**: Open `https://abc123.dev.uplink.spot` in a browser

5. **Create a database** (if needed):
   ```bash
   npm run dev:cli -- db create myapp-db --project myproject
   ```

6. **Use connection string**: The CLI will output connection details

### 🔐 Authentication & Tokens (DB-backed)

- Tokens are stored hashed in the database and can be revoked or set to expire.
- Admin vs user roles are enforced by the backend.
- Break-glass `ADMIN_TOKENS` (env-only) remain as emergency access during transition.
- Local dev with SQLite can still use `AGENTCLOUD_TOKEN_DEV=dev-token`; production should use minted tokens.

**Mint an admin token (one-time raw value shown):**
```bash
uplink admin tokens create --role admin --label "my-admin-laptop"
```
Save the printed token securely, then set locally:
```bash
export AGENTCLOUD_TOKEN=<minted-admin-token>
```

**Mint a user token:**
```bash
uplink admin tokens create --role user --label "teammate"
```

**List tokens (metadata only, no raw tokens):**
```bash
uplink admin tokens list
```

**Revoke a token:**
```bash
uplink admin tokens revoke --id <token-id>
```

**Cleanup legacy tunnels (dev-user):**
```bash
uplink admin cleanup --dev-user-tunnels
```

### 👨‍💼 Admin Commands

View system status and manage resources:

```bash
# Show system statistics
npm run dev:cli -- admin status

# List all tunnels
npm run dev:cli -- admin tunnels
npm run dev:cli -- admin tunnels --status active --limit 50

# List all databases
npm run dev:cli -- admin databases
npm run dev:cli -- admin databases --status ready

# Token management (DB-backed)
npm run dev:cli -- admin tokens create --role admin --label "ops"
npm run dev:cli -- admin tokens list
npm run dev:cli -- admin tokens revoke --id <token-id>

# Cleanup legacy dev-user tunnels
npm run dev:cli -- admin cleanup --dev-user-tunnels

# JSON output for scripting
npm run dev:cli -- admin status --json
```

**Admin API Endpoints:**
- `GET /v1/admin/stats` - System statistics
- `GET /v1/admin/tunnels` - List all tunnels (with filters)
- `GET /v1/admin/databases` - List all databases (with filters)
- `GET /v1/admin/tokens` - List tokens (metadata only)
- `POST /v1/admin/tokens` - Mint token (returns raw token once)
- `POST /v1/admin/tokens/revoke` - Revoke by id or raw token
- `POST /v1/admin/cleanup/dev-user-tunnels` - Soft-delete legacy dev-user tunnels

### 📝 Notes

- Tunnels are stored in the database and persist across server restarts
- Databases are provisioned via Neon API (PostgreSQL)
- HTTPS is handled automatically by Caddy
- All operations are idempotent and agent-friendly
- Admin endpoints require authentication (Bearer token)








