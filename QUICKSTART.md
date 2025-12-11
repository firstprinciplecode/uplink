# Quick Start Guide

## Prerequisites

1. **Postgres database** for the control plane (local or managed)
2. **Neon account** with API key and project ID set in `.env`

## Setup Steps

### 1. Configure Environment

Copy `env.template` to `.env` and fill in your values:

```bash
cp env.template .env
# Edit .env with your real values
```

Required variables:
- `CONTROL_PLANE_DATABASE_URL` - Postgres connection string for control plane
- `NEON_API_KEY` - Your Neon API key
- `NEON_PROJECT_ID` - Your Neon project ID (e.g., `broad-sea-29282882`)

### 2. Run Database Migrations

```bash
npm run migrate
```

This creates the `databases` table in your control plane Postgres.

### 3. Start the Control Plane API

```bash
npm run dev:api
```

The API will start on port 4000 (or `PORT` env var).

### 4. Test Database Creation

In another terminal:

```bash
export AGENTCLOUD_API_BASE=http://localhost:4000
export AGENTCLOUD_TOKEN=dev-token

# Create a database
npx tsx cli/src/index.ts db create --project myapp --name mydb --json

# List databases
npx tsx cli/src/index.ts db list --project myapp --json

# Get database info
npx tsx cli/src/index.ts db info --id <db-id> --json
```

Or use curl:

```bash
curl -X POST http://localhost:4000/v1/dbs \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"mydb","project":"myapp"}' | jq
```

### 5. Test Tunnel (Optional)

Start the relay:
```bash
npm run dev:relay
```

In another terminal, start a local app and tunnel it:
```bash
# Start a local server
python -m http.server 3000

# In another terminal, tunnel it
export AGENTCLOUD_API_BASE=http://localhost:4000
export AGENTCLOUD_TOKEN=dev-token
export TUNNEL_CTRL=127.0.0.1:7071
npx tsx cli/src/index.ts dev --tunnel --port 3000
```

Then access your app via the tunnel URL printed by the CLI.

## Troubleshooting

- **"Missing NEON_API_KEY"**: Check your `.env` file has the key set
- **"Missing NEON_PROJECT_ID"**: Set it in `.env` (e.g., `NEON_PROJECT_ID=broad-sea-29282882`)
- **Database connection errors**: Verify `CONTROL_PLANE_DATABASE_URL` is correct and Postgres is running
- **401 Unauthorized**: Make sure you're using `dev-token` (or whatever `AGENTCLOUD_TOKEN_DEV` is set to)

