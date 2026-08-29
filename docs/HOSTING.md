# Hosting

Verified accounts can deploy apps to `*.host.uplink.spot`. Guests cannot — the API returns `ACCOUNT_VERIFICATION_REQUIRED`.

## Commands

```bash
echo "$TOKEN" | uplink --token-stdin host setup --path . --name myapp --yes --json
echo "$TOKEN" | uplink --token-stdin host deploy --path . --name myapp --wait --json
echo "$TOKEN" | uplink --token-stdin host list --json
echo "$TOKEN" | uplink --token-stdin host status --id app_xxx --json
echo "$TOKEN" | uplink --token-stdin host logs --id app_xxx --json
echo "$TOKEN" | uplink --token-stdin host delete --id app_xxx --yes --json
```

Public URL is `https://<app_id>.host.uplink.spot` (the app **id**, not the name). Custom hostnames attach with `host domains add` / `verify`.

## What gets deployed

- Next.js (App Router): `output: "standalone"` in `next.config`.
- Vite / CRA: static `dist` or `build`.
- Anything else: a `Dockerfile` in the project root.

Use a `.uplinkignore` so `node_modules`, `.next`, `dist`, logs, and local databases are not uploaded.

## Free-plan quotas

From `GET /v1/me` → `hosting`:

| Limit | Typical free account |
|-------|----------------------|
| Apps | 1 |
| Live artifacts | 100 MB |
| Custom domains | off (`HOST_DOMAIN_NOT_ENABLED`) |
| Idle sleep | 30 minutes with no traffic |

The platform URL still works when custom domains are gated.

## Sleep and wake

After idle timeout the runner stops the container and keeps the image. Status is `sleeping`, not deleted.

The next HTTPS request to the app URL (or a verified custom domain) tells the router to wake it. Expect ~1–4 seconds on first hit, then normal latency.

`host list` still shows sleeping apps. `host status` is where you see `running` vs `sleeping`.

## Errors

| Code | Meaning |
|------|---------|
| `ACCOUNT_VERIFICATION_REQUIRED` | Guest token — run `uplink login` |
| `HOST_APP_LIMIT_REACHED` | Delete an app or raise the plan |
| `HOST_STORAGE_LIMIT_REACHED` | Artifact too large |
| `HOST_DOMAIN_NOT_ENABLED` | Custom domain not on this plan |
| `NOT_READY` | Logs/status before a deployment is running |
