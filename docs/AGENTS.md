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

# List tunnels
echo "$TOKEN" | uplink --token-stdin tunnel list --json

# Set alias
echo "$TOKEN" | uplink --token-stdin tunnel alias-set --id tun_xxx --alias myapp --json

# Delete alias
echo "$TOKEN" | uplink --token-stdin tunnel alias-delete --id tun_xxx --json

# Stats
echo "$TOKEN" | uplink --token-stdin tunnel stats --id tun_xxx --json

# Stop/delete tunnel
echo "$TOKEN" | uplink --token-stdin tunnel stop --id tun_xxx --json
```

### JSON shapes (representative)
- Create: `{ "tunnel": { id, url?, ingressHttpUrl?, token?, alias?, status, createdAt }, "alias": "myapp"|null, "aliasError": "..."|null }`
- List: `{ "tunnels": [ { id, url?, ingressHttpUrl?, token?, alias?, status, createdAt } ], "count": n }`
- Stats: alias tunnels include persisted totals + relay overlay; token-only tunnels show in-memory relay stats.

## HTTP (minimal OpenAPI)
- `POST /v1/tunnels` create
- `GET /v1/tunnels` list (user-owned)
- `POST /v1/tunnels/{id}/alias` set
- `DELETE /v1/tunnels/{id}/alias` remove
- `GET /v1/tunnels/{id}/stats` stats
- `DELETE /v1/tunnels/{id}` delete

Auth: `Authorization: Bearer <AGENTCLOUD_TOKEN>`

## Domains
- Public tunnels: `https://<token>.x.uplink.spot`
- Permanent URLs: `https://<alias>.x.uplink.spot` (if enabled)

## Optional JS helper
Use `cli/src/agents/tunnels-client.ts` for the same retry/timeout behavior as the CLI.
