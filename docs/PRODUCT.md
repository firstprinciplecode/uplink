# Uplink

**Software for agents** — share localhost, host apps, and attach domains from the terminal. No dashboard required.

Website: [uplink.spot](https://uplink.spot) · CLI: [`uplink-cli`](https://www.npmjs.com/package/uplink-cli) · Agents: [AGENTS.md](../AGENTS.md)

## What it is

Three surfaces, one CLI (`uplink`):

1. **Share** — expose `localhost:<port>` as HTTPS (`https://<token>.x.uplink.spot`).
2. **Hosting** — deploy a project to `https://<app_id>.host.uplink.spot` (email-verified accounts).
3. **Domains** — check availability, list registrar inventory, attach a hostname to a hosted app.

Humans use `uplink` (keyboard menu). Agents use subcommands with `--json` and `--token-stdin`.

## Accounts

| Kind | How you get it | Can do | Cannot do |
|------|----------------|--------|-----------|
| **Guest** | Automatic on `tunnel create` or menu open | 1 tunnel (24h), public domain search/check | Hosting, databases, aliases, custom domains |
| **Verified** | `uplink login --email` then OTP | Guest plus hosting / DBs / registrars | Plan-gated extras (aliases, custom domains) |
| **Admin** | Operator token in the control plane | Everything + Usage / System Status / Manage Tokens | — |

Guest → verified **merges**: the existing tunnel stays; credentials land in `~/.uplink/credentials` (mode 600). Gate error for locked features: `ACCOUNT_VERIFICATION_REQUIRED`.

## URLs

| Kind | Format |
|------|--------|
| Tunnel | `https://<token>.x.uplink.spot` |
| Alias (plan) | `https://<alias>.uplink.spot` |
| Hosted app | `https://<app_id>.host.uplink.spot` |
| Custom domain | hostname attached + verified on an app |

Reserved alias labels include `www`, `api`, `x`, `host`, `docs`, `status`.

## Architecture (high level)

```
localhost  --tunnel client-->  relay (*.x.uplink.spot)
                               control plane API (api.uplink.spot)
hosted app --container------>  runner + router (*.host.uplink.spot)
Caddy terminates TLS (Cloudflare DNS-01 wildcards).
```

The CLI repo is public. The control plane, builder, runner, router, and relay live in a private runtime repo.

## Hosting behavior

Free apps **sleep after 30 minutes idle**. A request wakes them (first hit is slower). See [HOSTING.md](./HOSTING.md).

## vs a typical tunnel SaaS

| | Uplink | Typical tunnel dashboard |
|--|--------|--------------------------|
| Signup to share localhost | Guest token, no email | Account + browser |
| Agent install | `npx uplink-cli` + `--json` | Scraping a UI |
| Hosting | Same CLI | Separate product |
| Custom domains | Attach to a hosted app | Often a paid add-on |

## License

CLI: MIT. Runtime: private.
