# Changelog

## 0.2.10 — 2026-08-31

Find a domain keeps the 15 default TLDs; press **m** (or `uplink domains search acme --more`) for extra geo/shop/studio TLDs. Guests still get availability only — the TUI says to connect a registrar for price.

## 0.2.9 — 2026-08-31

The menu's **My domains** now shows verified registration status (the same as `domains list --verify`) instead of "no expiry data" for zone/hosted entries. RDAP results are cached in `~/.uplink/rdap-cache.json` for 24 hours, so only the first open pays for the lookups.

## 0.2.8 — 2026-08-31

`domains list` is now grouped by provider and honest about what it knows: cPanel entries show as **hosted** (a panel serving a site says nothing about ownership), registrar expiry dates in the past show as **EXPIRED**, and new **`--verify`** RDAP-checks every entry without registration data (DNS zones, hosted sites) to reveal lapsed domains. RDAP goes straight to each TLD registry via the IANA bootstrap, with a DNS-delegation fallback for registries that 404.

## 0.2.7 — 2026-08-31

Multiple **cPanel** accounts: `providers connect cpanel --host …` now appends (people have sites on several hosts), `providers disconnect cpanel --host …` removes one account, and `providers list` shows the connected hosts. One user, many shared hosts, one inventory.

## 0.2.6 — 2026-08-30

Uplink as a **domain hub**: connect any **cPanel** host (Namecheap shared, Bluehost, HostGator, and most shared hosting) alongside registrars, so domains and sites scattered across providers land in one `domains list`. Connect with `uplink domains providers connect cpanel --host server.example.com --user-env CPANEL_USER --token-env CPANEL_API_TOKEN` (token from cPanel → Security → Manage API Tokens), or through the menu under Domains → Connect registrar.

## 0.2.5 — 2026-08-30

Find a domain: ↑↓ / mouse wheel to select results, enter or click for details, then buy via Namecheap API (or open cart / add-funds payment URL when balance is low). New commands: `domains buy`, `domains fund`, `domains contact show|set|seed`.

## 0.2.4 — 2026-08-30

Fix interactive menu crash (`uplink` / `uplink menu`): `domain-check.ts` still statically imported Ink's DomainSearch into the CommonJS graph, so tsx transformed `yoga-layout` as CJS (`Top-level await is currently not supported with the "cjs" output format`). Find a domain from the menu now spawns the ESM child the same way `uplink domains` does. Also stop passing the root CJS `tsconfig` into ESM Ink screens, and resolve `tsx` via `tsx/cli` for newer tsx releases.

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
