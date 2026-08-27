# Uplink CLI Menu Structure

> Interactive menu hierarchy for `uplink` / `uplink menu`.  
> Last updated: August 2026

Agents should prefer non-interactive commands in [AGENTS.md](../AGENTS.md).

---

## Overview

The menu adapts by auth and role. Arrow keys + Enter (no numeric entry).

| State | Condition | Main options |
|-------|-----------|--------------|
| Unauthenticated | No / invalid `AGENTCLOUD_TOKEN` | Get Started, Find a domain, About, Exit |
| User | Valid token | Share, Hosting, Domains, About, Exit |
| Admin | `role: admin` | Same as user + Usage, System Status, Manage Tokens |

---

## Unauthenticated

```
UPLINK
● offline

Get Started          → signup; optional save AGENTCLOUD_TOKEN to shell rc
Find a domain        → domain search TUI if Domainking is available
About
Exit
```

---

## Authenticated — Share

Creates tunnels **and** starts the local client (same as `uplink tunnel create`).

```
Share
├── Start tunnel     → scan ports / enter port → create + start client
├── Stop tunnel      → kill local client + delete API record
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
├── Check availability      → domains check
├── Attach to app           → host domains add
├── Verify                  → host domains verify
├── List attached           → host domains list
├── Detach                  → host domains remove
└── Search (optional TUI)   → Domainking if DOMAINKING_ENTRY / sibling repo exists
```

Bare `uplink domains` opens the search TUI when available; otherwise it prints agent-friendly command hints.

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
| `TUNNEL_CTRL` | Relay | `tunnel.uplink.spot:7071` |
| `TUNNEL_DOMAIN` | Tunnel DNS suffix | `x.uplink.spot` |
| `DOMAINKING_ENTRY` | Optional search TUI entry | — |
