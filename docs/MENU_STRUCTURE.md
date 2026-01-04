# Uplink CLI Menu Structure

> Reference document for the interactive menu hierarchy.  
> Last updated: January 2026

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
  → Creates a user token via the API (`POST /v1/signup`)
  → Optionally saves `AGENTCLOUD_TOKEN` into your shell rc file

Exit
```

---

### Authenticated User (Regular)

```
UPLINK
● connected
├─ Active   2 tunnels

Manage Tunnels
├── Start Tunnel
│   └── [Port Selection]
│       ├── Port 3000                    → Creates tunnel & starts client
│       ├── Port 8080                    → Creates tunnel & starts client
│       ├── Enter custom port            → Prompt → Creates tunnel
│       └── ← Back
│
├── Stop Tunnel
│   └── [Running Tunnels Selection]
│       ├── Port 3000 (abc123...)        → Stops tunnel client
│       ├── Port 8080 (def456...)        → Stops tunnel client
│       ├── Stop all tunnels             → Stops all clients
│       └── ← Back
│
├── View Tunnel Stats
│   └── [Running Tunnel Selection]
│       ├── abc123...  Port 3000
│       └── ← Back
│       
│       → Displays:
│         - Permanent URL (if set)
│         - Connection status (verified via relay)
│         - Total stats (requests, bytes in/out)
│         - Current run stats
│
└── Active Tunnels
    └── Displays table (only shows tunnels connected to relay):
        Token          Port   Status       Permanent URL
        ────────────────────────────────────────────────
        abc123...      3000   connected    myapp.uplink.spot
        def456...      8080   connected    -

Manage Aliases (Premium)
├── My Aliases
│   └── Displays table:
│       Alias            Port    Status
│       ────────────────────────────────
│       myapp            3000    active
│       api              8080    inactive
│       
│       (active = tunnel running on that port)
│
├── Create Alias
│   └── [Port Selection]
│       ├── Port 3000 (tunnel running)   → Prompt alias name
│       ├── Enter custom port            → Prompt port → Prompt alias
│       └── ← Back
│       
│       → Creates permanent URL at {alias}.uplink.spot
│       → Alias is port-based (persists across tunnel restarts)
│
├── Reassign Alias
│   └── [Alias Selection]
│       ├── myapp → Port 3000
│       └── ← Back
│       
│       → Select new port for alias
│
└── Delete Alias
    └── [Alias Selection]
        ├── myapp
        └── ← Back
        
        → Removes permanent URL

Exit
```

> **Note:** 
> - Database features are admin-only. Regular users do not see database options.
> - Aliases are port-based: they persist even when tunnels restart. The same alias always points to the same port.
> - "Active Tunnels" verifies connection status with the relay server (not just local processes).

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

### Alias Created

```
✓ Alias created

→ Alias     my-app
→ Port      3000
→ URL       https://my-app.uplink.spot

Your tunnel will now be accessible at this permanent URL.
Alias is port-based - it will persist across tunnel restarts.
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
| `RELAY_HEALTH_URL` | Optional: show API/relay banner in menu | (unset) |

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

## Implementation Reference (Maintainers)

This section is a **single source of truth** for how the interactive menu is implemented and how it should evolve. It intentionally stays high-level and avoids security-sensitive details.

### Goals
- **Deterministic**: UI output is a function of state (no hidden UI state).
- **Maintainable**: Separate **rendering**, **input/events**, and **side-effects** (API calls, spawning clients).
- **Safe defaults**: Avoid leaking secrets; avoid printing raw tokens except in the explicit signup/token-creation flows.

### Proposed refactor shape (Textual-inspired, Node/TS)

Current `cli/src/subcommands/menu.ts` mixes rendering + input handling + actions in one file. The refactor splits into a tiny internal “menu framework”:

- `cli/src/subcommands/menu/state.ts`
  - Exports `MenuState`, `MenuRole`, `MenuAuthStatus`
  - Single state object drives all rendering
- `cli/src/subcommands/menu/events.ts`
  - Exports `MenuEvent` (key presses, navigation, action results)
- `cli/src/subcommands/menu/reducer.ts`
  - Pure reducer: `(state, event) => { state, effect? }`
- `cli/src/subcommands/menu/effects.ts`
  - Side-effects runner (API calls, spawn/kill tunnel clients)
  - Dispatches `MenuEvent` results back into the reducer
- `cli/src/subcommands/menu/render.ts`
  - `render(state): string[]` (or a single string) composing widget renderers
- `cli/src/subcommands/menu/widgets.ts`
  - Small, testable “views”: header, breadcrumbs, menu list, message area, footer, active tunnel panel
- `cli/src/subcommands/menu/menu-tree.ts`
  - Build `MenuChoice[]` based on auth status + role (unauth/user/admin)

Existing primitives continue to be reused:
- `cli/src/subcommands/menu/colors.ts` (palette)
- `cli/src/subcommands/menu/io.ts` (prompt/clear/raw-mode helpers)
- `cli/src/subcommands/menu/inline-select.ts` (arrow-key selector)
- `cli/src/subcommands/menu/requests.ts` (unauthenticated API requests)

### Migration order (keep behavior stable)
1. Remove duplicate palette + selector from `menu.ts` and use `menu/colors.ts`, `menu/io.ts`, `menu/inline-select.ts`.
2. Extract a pure `render(state)` and keep current behavior.
3. Introduce `MenuState` and move mutable globals into state.
4. Introduce `MenuEvent` + reducer loop (keypress → event → state update → render).
5. Move actions (API/spawn) into `effects.ts` and keep render side-effect free.

---

## Related Documentation

- [AGENTS.md](./AGENTS.md) - Programmatic CLI usage for AI agents
- [README.md](./README.md) - Public docs index