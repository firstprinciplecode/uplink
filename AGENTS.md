# Agent Integration Guide

For agents (Cursor, Claude Code, Codex, Windsurf, and similar) to use Uplink **non-interactively**.

Install: `npm install -g uplink-cli` or `npx uplink-cli …`  
Package name: `uplink-cli` · Binary: `uplink`

## Auth

- `uplink tunnel create` automatically creates guest access when no token exists. Guest access includes **1 active tunnel**, expiring after **24 hours**.
- Use `AGENTCLOUD_TOKEN` (bearer). Prefer stdin over argv:
  ```bash
  echo "$TOKEN" | uplink --token-stdin …
  ```
- Humans: `uplink login --email you@example.com` then `--code 123456`. This upgrades current guest access, preserves its tunnel, and unlocks persistent features. Credentials are saved to `~/.uplink/credentials` (chmod 600).
- API base: `--api-base https://api.uplink.spot` or `AGENTCLOUD_API_BASE`.

## Explicit guest token (optional)

```bash
uplink signup --json
uplink signup --label "cursor-agent" --expires-days 30 --json
```

Save `token` from the JSON — it is shown only once. Then:

```bash
export AGENTCLOUD_TOKEN='…'
```

Explicit signup creates guest access. A later email login upgrades that guest account when the current token is available.

## Machine-mode contract

| Rule | Detail |
|------|--------|
| `--json` | stdout = JSON only; logs/errors go to stderr |
| Exit `0` | success |
| Exit `2` | usage / bad args |
| Exit `10` | auth missing/invalid |
| Exit `20` | network |
| Exit `30` | server / unknown |

Guest accounts can share one local port and use public domain search. Hosting, databases, aliases, and custom domains require a verified email account. Gate error: `ACCOUNT_VERIFICATION_REQUIRED`.

Premium aliases may return `ALIAS_NOT_ENABLED` / `ALIAS_LIMIT_REACHED`.

Free hosting (new accounts): **1 app**, **100 MB** of live artifacts, **no custom domains**, app **sleeps after 30 minutes idle**. Errors: `HOST_APP_LIMIT_REACHED`, `HOST_STORAGE_LIMIT_REACHED`, `HOST_DOMAIN_NOT_ENABLED`. Check quota: the `hosting` object on `GET /v1/me`.

## Tunnels (share localhost)

`tunnel create` **creates the API record and starts the local client** so the public URL works. Use `--api-only` only if you will start the client yourself.

```bash
# Create + start client (optional alias if enabled)
echo "$TOKEN" | uplink --token-stdin \
  tunnel create --port 3000 --alias myapp --json

# List (includes connected status)
echo "$TOKEN" | uplink --token-stdin tunnel list --json

# Alias on an existing tunnel
echo "$TOKEN" | uplink --token-stdin tunnel alias-set --id tun_xxx --alias myapp --json
echo "$TOKEN" | uplink --token-stdin tunnel alias-delete --id tun_xxx --json

# Stats / stop
echo "$TOKEN" | uplink --token-stdin tunnel stats --id tun_xxx --json
echo "$TOKEN" | uplink --token-stdin tunnel stop --id tun_xxx --json
echo "$TOKEN" | uplink --token-stdin tunnel stop --all --json
```

JSON create shape (representative):

```json
{
  "tunnel": { "id": "tun_…", "url": "https://abc.x.uplink.spot", "token": "…", "status": "…" },
  "alias": "myapp",
  "aliasError": null,
  "url": "https://myapp.uplink.spot",
  "client": { "pid": 12345, "started": true }
}
```

`connected` on `tunnel list` means the local client is attached to the relay.

## Hosting

Use `--json`. For prompts, pass `--yes`.

```bash
echo "$TOKEN" | uplink --token-stdin host setup \
  --path /path/to/app --name myapp --env-file /path/to/.env \
  --wait-timeout 900 --wait-interval 5 --yes --json

echo "$TOKEN" | uplink --token-stdin host deploy \
  --path /path/to/app --name myapp --wait --json

echo "$TOKEN" | uplink --token-stdin host analyze --path /path/to/app --json
echo "$TOKEN" | uplink --token-stdin host preflight --path /path/to/app --json
echo "$TOKEN" | uplink --token-stdin host list --json
echo "$TOKEN" | uplink --token-stdin host status --id app_xxx --json
echo "$TOKEN" | uplink --token-stdin host logs --id app_xxx --json
echo "$TOKEN" | uplink --token-stdin host delete --id app_xxx --yes --json
```

Notes:
- Next.js server hosting expects `output: "standalone"`. Vite/CRA → static `dist`/`build`.
- Prefer a `.uplinkignore` (`node_modules`, `.next`, `dist`, `*.log`, local `.db`, …).
- `host logs` may return `NOT_READY` until a deployment is running.
- `host delete` requires `--yes` (or typing `DELETE` interactively).

## Custom domains

Registrar inventory is CLI. Attach/verify is under `host domains`.  
The bare `uplink domains` command opens Find a domain. Agents should use JSON:

```bash
uplink domains search acme --json
uplink domains check example.com --json
uplink domains list --json
uplink domains providers connect godaddy --token-env GODADDY_PAT --json
uplink domains providers connect cloudflare --token-env CF_API_TOKEN --json
uplink domains providers connect hostinger --token-env HOSTINGER_API_TOKEN --json
uplink domains providers connect dreamhost --token-env DREAMHOST_API_KEY --json
uplink domains providers connect namecheap --token-env NAMECHEAP_API_KEY --user-env NAMECHEAP_API_USER --json
uplink domains providers list --json
uplink domains providers disconnect godaddy --json

echo "$TOKEN" | uplink --token-stdin host domains add --id app_xxx --hostname example.com --json
echo "$TOKEN" | uplink --token-stdin host domains verify --id app_xxx --hostname example.com --json
echo "$TOKEN" | uplink --token-stdin host domains list --id app_xxx --json
echo "$TOKEN" | uplink --token-stdin host domains remove --id app_xxx --hostname example.com --json
```

`domains check` works without a registrar: it falls back to public DNS/RDAP and returns `provider: "public"` with no price. Do not treat RDAP “available” as buyable unless `domains check` says `buyable: true`. Purchase is not wired yet.

## Databases (optional)

```bash
echo "$TOKEN" | uplink --token-stdin db create --name mydb --project myproj --json
echo "$TOKEN" | uplink --token-stdin db list --json
echo "$TOKEN" | uplink --token-stdin db info --id db_xxx --json
echo "$TOKEN" | uplink --token-stdin db delete --id db_xxx --yes --json
```

## Failure modes agents should expect

| Symptom | Likely cause |
|---------|----------------|
| URL 502 / not connected | Local process on `--port` not running, or client died — re-run `tunnel create` or check `tunnel list` |
| Auth errors | Missing/invalid `AGENTCLOUD_TOKEN`; use `--token-stdin` |
| `ALIAS_NOT_ENABLED` | Account does not have permanent aliases |
| Domain search TUI missing | Not a TTY — use `domains search NAME --json` |
| `HOST_APP_LIMIT_REACHED` | Free plan is 1 hosted app — delete one or the account needs hosting granted |
| `HOST_STORAGE_LIMIT_REACHED` | Upload exceeds the 100 MB free hosting budget |
| `HOST_DOMAIN_NOT_ENABLED` | Custom domains are paid — `*.host.uplink.spot` still works |
| First request after idle is slow | Free apps sleep after 30 minutes; the router wakes them |
| Hosting stuck `queued` | Edge builder/runner issue — check `host status` / `host logs` |

## Interactive menu

Humans: `uplink` or `uplink menu` (Share · Hosting · Domains).  
Agents should prefer the non-interactive commands above.

## URLs

- Ephemeral tunnels: `https://<token>.x.uplink.spot`
- Aliases: `https://<alias>.uplink.spot`

## More

- Menu map: `docs/MENU_STRUCTURE.md`
- Hosting: `docs/HOSTING.md`
- Product: `docs/PRODUCT.md`
- Website: https://uplink.spot
- npm: https://www.npmjs.com/package/uplink-cli
