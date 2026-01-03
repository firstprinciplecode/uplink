# Agent Integration Guide

For agents (Cursor/Claude/GPT/Windsurf) to use Uplink non-interactively.

## Auth
- Use `AGENTCLOUD_TOKEN` (bearer). Avoid argv; prefer stdin:
  ```bash
  echo "$TOKEN" | uplink --token-stdin ...
  ```
- API base override: `--api-base https://api.uplink.spot` (or `AGENTCLOUD_API_BASE`).

## Signup (no auth required)
```bash
uplink signup --json
uplink signup --label "cursor-agent" --expires-days 30 --json
```
JSON example:
```json
{
  "id": "tok_xxx",
  "token": "abc123...",
  "tokenPrefix": "abc123",
  "role": "user",
  "userId": "user_xxx",
  "label": "cursor-agent",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "expiresAt": "2025-01-31T00:00:00.000Z",
  "message": "Token created successfully. Save this token securely..."
}
```
Save `token`—shown only once.

## Machine-mode contract
- `--json` → stdout = JSON only; stderr = logs/errors.
- Exit codes: 0 ok; 2 usage; 10 auth missing/invalid; 20 network; 30 server/unknown.
- Premium alias gating: alias commands may return `ALIAS_NOT_ENABLED` / `ALIAS_LIMIT_REACHED`.

## Core CLI flows (non-interactive)
```bash
# Create tunnel (optional alias if enabled)
echo "$TOKEN" | uplink --token-stdin --api-base https://api.uplink.spot \
  tunnel create --port 3000 --alias myapp --json

# List tunnels (includes connection status)
echo "$TOKEN" | uplink --token-stdin tunnel list --json

# Set alias on tunnel
echo "$TOKEN" | uplink --token-stdin tunnel alias-set --id tun_xxx --alias myapp --json

# Delete alias from tunnel
echo "$TOKEN" | uplink --token-stdin tunnel alias-delete --id tun_xxx --json

# Stats
echo "$TOKEN" | uplink --token-stdin tunnel stats --id tun_xxx --json

# Stop/delete tunnel
echo "$TOKEN" | uplink --token-stdin tunnel stop --id tun_xxx --json
```

### JSON shapes (representative)
- Create: `{ "tunnel": { id, url?, token?, alias?, aliasUrl?, targetPort, status, connected?, createdAt }, "alias": "myapp"|null, "aliasError": "..."|null }`
- List: `{ "tunnels": [ { id, url?, token?, alias?, aliasUrl?, targetPort, status, connected, createdAt } ], "count": n }`
- Stats: alias tunnels include persisted totals + relay overlay; token-only tunnels show in-memory relay stats.

**Note:** The `connected` field indicates whether the tunnel is actually connected to the relay server (verified via socket health check).

## HTTP API Reference

Auth: `Authorization: Bearer <AGENTCLOUD_TOKEN>`

### Tunnels
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/tunnels` | Create tunnel (body: `{ port, alias? }`) |
| `GET` | `/v1/tunnels` | List user's tunnels (includes `connected` status) |
| `GET` | `/v1/tunnels/{id}` | Get tunnel details |
| `GET` | `/v1/tunnels/{id}/stats` | Get tunnel statistics |
| `DELETE` | `/v1/tunnels/{id}` | Delete tunnel |
| `POST` | `/v1/tunnels/{id}/alias` | Set alias on tunnel (body: `{ alias }`) |
| `DELETE` | `/v1/tunnels/{id}/alias` | Remove alias from tunnel |

### Port-Based Aliases (Premium)
Aliases are now **port-based**: they persist across tunnel restarts and always point to the same port.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/tunnels/aliases` | List all aliases for user |
| `POST` | `/v1/tunnels/aliases` | Create alias for port (body: `{ alias, port }`) |
| `PUT` | `/v1/tunnels/aliases/{alias}` | Reassign alias to different port (body: `{ port }`) |
| `DELETE` | `/v1/tunnels/aliases/{alias}` | Delete alias |

### Example: Create port-based alias
```bash
curl -X POST https://api.uplink.spot/v1/tunnels/aliases \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"alias": "myapp", "port": 3000}'
```

Response:
```json
{
  "id": "alias_xxx",
  "alias": "myapp",
  "targetPort": 3000,
  "url": "https://myapp.uplink.spot",
  "createdAt": "2025-01-03T00:00:00.000Z"
}
```

## Domains
- Public tunnels: `https://<token>.x.uplink.spot`
- Permanent URLs (aliases): `https://<alias>.uplink.spot`

## Server Deployment (for self-hosted)

### Deploy code changes
```bash
# On server (via SSH)
cd /opt/agentcloud
git pull origin master
systemctl restart tunnel-relay
systemctl restart backend-api  # if backend changed
```

### Services
| Service | Command | Description |
|---------|---------|-------------|
| `tunnel-relay` | `systemctl status tunnel-relay` | WebSocket relay for tunnels |
| `backend-api` | `systemctl status backend-api` | REST API server |

### Relay health check
The relay exposes internal endpoints (protected by `RELAY_INTERNAL_SECRET`):
- `/internal/connected-tokens` - List connected tunnel tokens (with socket health verification)
- `/internal/traffic-stats` - Traffic statistics by token/alias
- `/health` - Basic health check

## Optional JS helper
Use `cli/src/agents/tunnels-client.ts` for the same retry/timeout behavior as the CLI.
