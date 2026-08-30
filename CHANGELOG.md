# Changelog

## 0.2.3 — 2026-08-30

New **`uplink upgrade`** (Uplink Pro subscription — $9/mo or `--yearly` $90/yr via Stripe Checkout) and **`uplink billing`** (Stripe billing portal for cancel/card changes). Pro unlocks unlimited hosted apps within 1 GB of storage, always-on for your 5 most-active apps, custom domains, and permanent aliases.

Fix global CLI crash on every command (`host list`, `login`, …): `domains.ts` was statically importing Ink, so tsx tried to load `yoga-layout` as CommonJS (`Top-level await is currently not supported with the "cjs" output format`). Interactive Find a domain now runs as a child ESM process, same as the menu.

## 0.2.2 — 2026-08-29

Built-in **Find a domain** in the CLI (no Domainking install). Type a label to check common TLDs via DNS/RDAP. `uplink domains` opens it; agents use `uplink domains search acme --json`. Domainking remains a separate app.

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
