# Uplink CLI Menu Structure

> Reference document for the interactive menu hierarchy.  
> Last updated: December 2024

---

## Overview

The Uplink CLI (`uplink menu`) provides an interactive terminal interface for managing tunnels, databases, and system administration. The menu adapts based on authentication status and user role.

---

## Menu States

| State | Condition | Available Options |
|-------|-----------|-------------------|
| Unauthenticated | No `AGENTCLOUD_TOKEN` or invalid token | Get Started, Exit |
| User | Valid token with `role: user` | Tunnels, Exit |
| Admin | Valid token with `role: admin` | Tunnels, Usage (all tunnels/dbs), System Status, Manage Tokens, Stop All, Exit |

---

## Complete Menu Hierarchy

### Unauthenticated User

```
UPLINK
● offline

Get Started
  → Opens browser to uplink.spot
  → Displays instructions to create account and get API token

Exit
```

---

### Authenticated User (Regular)

```
UPLINK
● connected

Manage Tunnels
├── Start (Auto)
│   └── [Port Selection]
│       ├── Port 3000                    → Creates tunnel
│       ├── Port 8080                    → Creates tunnel
│       ├── Enter custom port            → Prompt → Creates tunnel
│       └── ← Back
│
├── Start (Manual)
│   └── Prompt: "Local port to expose (default 3000):"
│       → Creates tunnel (no auto-start client)
│       → Shows manual client command
│
├── Stop Tunnel
│   └── [Running Tunnels Selection]
│       ├── Port 3000 (abc123...)        → Stops tunnel
│       ├── Port 8080 (def456...)        → Stops tunnel
│       ├── Stop all tunnels             → Stops all
│       └── ← Back
│
├── View Tunnel Stats
│   └── [Tunnel Selection]
│       ├── 0cc1ef17...    chat.x.uplink.spot
│       ├── abc12345...    (no permanent URL)
│       └── ← Back
│       
│       → Displays:
│         - Permanent URL (if set)
│         - Connection status
│         - Total stats (requests, bytes in/out)
│         - Current run stats
│
├── Create Permanent URL
│   └── [Tunnel Selection]
│       ├── 0cc1ef17...    chat.x.uplink.spot
│       ├── abc12345...    (no permanent URL)
│       └── ← Back
│       
│       → Prompt: "Enter alias name (e.g. my-app):"
│       → Creates permanent URL at {alias}.x.uplink.spot
│
└── My Tunnels
    └── Displays table:
        Token          Port   Status       Permanent URL
        ────────────────────────────────────────────────
        0cc1ef17...    3000   connected    chat.x.uplink.spot
        abc12345...    8080   unknown      -

Exit
```

> **Note:** Database features are admin-only. Regular users do not see database options.

---

### Admin User (Additional Sections)

```
Usage (admin-only)
├── List All Tunnels
│   └── Shows all tunnels across all users
│
└── List All Databases
    └── Shows all databases across all users

System Status
├── View Status
│   └── Displays:
│       - API health
│       - Relay status (online/offline)
│       - Connected tunnels count
│       - Active databases count
│
├── View Connected Tunnels
│   └── Displays table:
│       Token          Client IP        Port   Uptime     Connected At
│       ─────────────────────────────────────────────────────────────
│       abc123...      192.168.1.5      3000   2h 15m     2024-12-31T10:00:00
│
└── View Traffic Stats
    └── Displays table:
        Alias                    Requests   In         Out        Sts  Last Seen
        ─────────────────────────────────────────────────────────────────────────
        chat                     1,234      45.2 MB    12.8 MB    200  2024-12-31...

Manage Tokens
├── List Tokens
│   └── Displays table:
│       ID           Prefix        Role     Label                   Created
│       ──────────────────────────────────────────────────────────────────────
│       tok_abc...   sk-abc...     admin    Production              2024-12-01...
│
├── Create Token
│   ├── Prompt: "Role (admin/user, default user):"
│   ├── Prompt: "Label (optional):"
│   ├── Prompt: "Expires in days (optional):"
│   └── Displays created token (save immediately!)
│
└── Revoke Token
    ├── Prompt: "Token ID to revoke:"
    └── Confirms revocation

⚠️ Stop All Tunnel Clients
└── Emergency kill switch for all local tunnel processes
```

---

## Result Displays

### Tunnel Created Successfully

```
✓ Tunnel created and client started

→ Public URL    https://abc123.x.uplink.spot
→ Token         abc123
→ Local port    3000

Tunnel client running in background.
Use "Stop Tunnel" to disconnect.
```

### Permanent URL Created

```
✓ Permanent URL created

→ Alias     my-app
→ URL       https://my-app.x.uplink.spot

Your tunnel will now be accessible at this permanent URL.
```

### Error: Premium Feature Required

```
❌ Permanent URLs are a premium feature

Contact us on Discord at uplink.spot to upgrade your account.
```

### Error: URL Limit Reached

```
❌ URL limit reached

You've reached your URL limit. Contact us to increase it.
```

### Error: URL Already Taken

```
❌ Alias "my-app" is already in use. Try a different name.
```

---

## Navigation Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate menu items |
| `Enter` | Select item |
| `←` | Go back to parent menu |
| `Ctrl+C` | Exit immediately |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTCLOUD_TOKEN` | API authentication token | (required) |
| `AGENTCLOUD_API_BASE` | API base URL | `https://api.uplink.spot` |
| `TUNNEL_CTRL` | Tunnel relay control endpoint | `tunnel.uplink.spot:7071` |
| `TUNNEL_DOMAIN` | Tunnel URL domain | `x.uplink.spot` |

---

## Design Decisions

### Current Structure Rationale

**Regular users** see a focused menu:
- All tunnel operations in one place ("Manage Tunnels")
- "My Tunnels" listing included in the same menu
- No database options (admin feature only)

**Admin users** get additional sections:
- "Usage" for cross-user visibility (all tunnels, all databases)
- "System Status" for monitoring
- "Manage Tokens" for access control
- Emergency kill switch

### Future Improvements

Consider consolidating admin sections:

```
Admin (consolidated)
├── Usage
│   ├── All Tunnels
│   └── All Databases
├── System Status
│   ├── View Status
│   ├── Connected Tunnels
│   └── Traffic Stats
├── Manage Tokens
│   ├── List / Create / Revoke
└── Stop All Clients
```

This would reduce top-level clutter for admin users while maintaining all functionality.

---

## Related Documentation

- [AGENTS.md](./AGENTS.md) - Programmatic CLI usage for AI agents
- [QUICKSTART.md](./guides/QUICKSTART.md) - Getting started guide
- [TUNNEL_SETUP.md](./guides/TUNNEL_SETUP.md) - Tunnel configuration
git push origin master
