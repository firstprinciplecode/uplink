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
- `NEON_API_KEY`: Neon API key for database provisioning
- `NEON_PROJECT_ID`: Neon project ID
- `PORT`: Backend API port (default: 4000)
- `TUNNEL_DOMAIN`: Domain for tunnels (recommended: `t.uplink.spot`)

#### CLI Configuration:

Set in your local `.env`:
- `AGENTCLOUD_API_BASE`: API base URL (default: http://localhost:4000)
- `AGENTCLOUD_TOKEN`: Auth token (default: dev-token for local)
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

### 🔐 Authentication

Currently using a simple token-based auth (`dev-token`). For production, replace with proper authentication middleware.

### 📝 Notes

- Tunnels are stored in the database and persist across server restarts
- Databases are provisioned via Neon API (PostgreSQL)
- HTTPS is handled automatically by Caddy
- All operations are idempotent and agent-friendly



