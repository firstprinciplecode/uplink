# Uplink CLI Menu Structure

> Interactive menu hierarchy for `uplink` / `uplink menu`.  
> Last updated: August 2026

Agents should prefer non-interactive commands in [AGENTS.md](../AGENTS.md).

---

## Overview

The menu adapts by auth and role. Arrow keys + Enter (no numeric entry).

| State | Condition | Main options |
|-------|-----------|--------------|
| Guest | No / invalid token → guest access is created silently on menu open | Share, Check domain availability, Continue with email, About, Exit |
| Verified user | Email-verified token | Share, Domains, Hosting, About, Exit |
| Admin | `role: admin` | Same as user + Usage, System Status, Manage Tokens |
| Offline | API unreachable | Connection details, About, Exit |

There is no separate "unauthenticated" menu: opening the menu without a usable token mints a guest token (1 active tunnel, 24-hour expiry) and shows the same Share menu everyone gets — including port scanning and tunnel management.

---

## Guest

```
UPLINK
● connected

Share                     → same full Share menu as verified users (no Aliases)
Check domain availability → built-in Find a domain (DNS/RDAP across common TLDs)
Continue with email       → preserve guest tunnel; unlock Hosting + Domains
About
Exit
```

---

## Authenticated — Share

Creates tunnels **and** starts the local client (same as `uplink tunnel create`).

```
Share
├── Share localhost  → scan ports / enter port → create + start client
├── Stop localhost   → kill local client + delete API record
├── View tunnel stats
├── Active tunnels   → connected tunnels table
└── Aliases          → list / create permanent URLs (premium)
```

Admins also get **Stop ALL Tunnel Clients** under Share.

---

## Authenticated — Hosting

```
Hosting
├── Setup wizard     → analyze + create + deploy
├── Deploy           → deploy to existing app
├── List apps
├── Analyze project
├── Delete app
└── (Apps subtree may show live apps + logs in the Ink TUI)
```

CLI equivalents: `uplink host setup|deploy|list|status|logs|delete|analyze|preflight`.

---

## Authenticated — Domains

```
Domains
├── My domains              → uplink domains list
├── Connect registrar       → providers connect (token via env)
├── Find a domain           → built-in search TUI (also `uplink domains` / `domains search`)
├── Attach to app           → host domains add
├── Verify                  → host domains verify
├── List attached           → host domains list
├── Detach                  → host domains remove
└── Help
```

Bare `uplink domains` opens Find a domain. Agents use `domains search NAME --json` and `domains check example.com --json`.

---

## Admin extras

- **Usage** — cross-user tunnels / databases visibility  
- **System Status** — API health + stats (+ smoke where configured)  
- **Manage Tokens** — create / list / revoke  

CLI: `uplink admin status|tunnels|databases|tokens …`

---

## Environment

| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENTCLOUD_TOKEN` | Auth bearer | — |
| `AGENTCLOUD_API_BASE` | API host | `https://api.uplink.spot` |
| `TUNNEL_CTRL` | Relay | `tunnel.uplink.spot:7443` |
| `TUNNEL_DOMAIN` | Tunnel DNS suffix | `x.uplink.spot` |
