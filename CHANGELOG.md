# Changelog

## 0.2.1 — 2026-08-29

Ship `tsconfig.json` in the npm tarball so the menu's JSX compiles with `react-jsx`. 0.2.0 global installs crashed with `React is not defined` because tsx had no config and used the classic `React.createElement` transform.

## 0.2.0 — 2026-08-28

Published on npm as `uplink-cli@0.2.0`.

- **Guest access** — `tunnel create` and the interactive menu mint a guest token when none exists (1 active tunnel, 24-hour expiry). Stored in `~/.uplink/credentials`.
- **Email login** — `uplink login --email` / `--code` upgrades that guest account, keeps the tunnel, and unlocks hosting, databases, and registrar inventory.
- **Public domain check** — `uplink domains check` works with no registrar (DNS + RDAP). Connect a registrar for price.
- **DreamHost** — inventory adapter; DNS-scoped keys and multiple `--token-env` names are supported.
- **GoDaddy** — stop falling back to the v1 API on rate-limit / auth errors.

## 0.1.39 — 2026-08-27

Current version on npm. Agent-ready CLI: `--json`, `--token-stdin`, tunnels, hosting, domains.
