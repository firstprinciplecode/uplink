# Uplink

**Localhost to public URL in seconds. No signup forms, no browser — everything in your terminal.**

---

## What is Uplink?

Uplink is a CLI-first tunneling service that exposes your local development servers to the internet. Unlike traditional tools that require accounts, dashboards, and browser workflows, Uplink is designed for terminal-native workflows and AI agent automation.

```bash
npx uplink-cli menu
```

That's it. No signup. No browser. No account creation.

---

## Core Features

### 🚀 Instant Tunnels

Expose any local port to the internet with a single command:

```
→ Start Tunnel
  Port: 3000
  
✓ Tunnel created and client started

→ Public URL    https://94a7165a94b3.x.uplink.spot
→ Token         94a7165a94b3
→ Local port    3000
```

- **Ephemeral URLs**: Auto-generated token-based URLs (`{token}.x.uplink.spot`)
- **Instant HTTPS**: Wildcard TLS via Cloudflare DNS-01
- **No registration**: Start tunneling immediately

### 🔗 Permanent Aliases

Claim a memorable URL that persists across sessions:

```
→ Set Permanent Alias
  Alias: myapp
  
✓ Alias updated
→ Alias URL   https://myapp.uplink.spot
→ Token URL   https://94a7165a94b3.x.uplink.spot
```

- **Stable URLs**: Share `myapp.uplink.spot` — it never changes
- **Token hidden**: The underlying token stays private
- **Instant reassignment**: Stop/start tunnels without changing URLs

### 🎛️ Interactive CLI Menu

A beautiful terminal UI for managing your infrastructure:

```
██╗   ██╗██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗
██║   ██║██╔══██╗██║     ██║████╗  ██║██║ ██╔╝
██║   ██║██████╔╝██║     ██║██╔██╗ ██║█████╔╝ 
██║   ██║██╔═══╝ ██║     ██║██║╚██╗██║██╔═██╗ 
╚██████╔╝██║     ███████╗██║██║ ╚████║██║  ██╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝

├─ Active   1 tunnel
│
└─ https://myapp.uplink.spot → localhost:3000

├─ System Status ›
├─ Manage Tunnels ›
├─ Usage ›
└─ Exit
```

- **Keyboard navigation**: Arrow keys + Enter
- **Real-time status**: See active tunnels at a glance
- **Nested menus**: Organized by function

### 🗄️ Database Provisioning

Create PostgreSQL databases instantly:

```bash
uplink db create mydb
# → Database URL: postgres://...
```

- **Neon-backed**: Serverless Postgres
- **Per-user limits**: Configurable quotas
- **No dashboard**: Connection strings in terminal

### 🔐 Token Management

API tokens for programmatic access:

- **Self-service signup**: `POST /v1/signup`
- **Token creation**: Multiple tokens per user
- **Revocation**: Instant invalidation
- **Expiry**: Time-limited tokens

### 👑 Admin Features

For operators managing the platform:

- **List all tunnels**: See every connected client
- **View client IPs**: Track connection sources
- **Usage stats**: Monitor platform health
- **Rate limiting**: Prevent abuse

---

## URL Scheme

| Type | Format | Example | Persistence |
|------|--------|---------|-------------|
| Ephemeral | `{token}.x.uplink.spot` | `94a7165a94b3.x.uplink.spot` | Until deleted |
| Permanent | `{alias}.uplink.spot` | `myapp.uplink.spot` | Forever (claimed) |

**Reserved aliases**: `www`, `api`, `x`, `t`, `docs`, `support`, `status`, `health`, `mail`

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Your Local  │────▶│    Uplink    │────▶│   Internet   │
│   Server     │     │    Relay     │     │   (HTTPS)    │
│ localhost:X  │◀────│  x.uplink.spot     │◀────│              │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │
       │                    ▼
       │             ┌──────────────┐
       │             │  Control     │
       └────────────▶│  Plane API   │
                     │ api.uplink.spot    │
                     └──────────────┘
```

**Components:**

| Component | Purpose | Port |
|-----------|---------|------|
| Tunnel Relay | HTTP ingress & client connections | 7070 (HTTP), 7071 (control) |
| Backend API | Auth, tunnels, databases | 4000 |
| Caddy | TLS termination, reverse proxy | 443 |

---

## CLI Commands

### Interactive Menu
```bash
uplink menu              # Launch interactive menu
uplink menu --admin      # Admin mode (requires admin token)
```

### Tunnel Management
```bash
# Via menu:
├─ Manage Tunnels
│  ├─ Start Tunnel
│  ├─ Stop Tunnel
│  ├─ Set Permanent Alias
│  ├─ Remove Alias
│  └─ View Connected (with IPs)
```

### Database Management
```bash
uplink db create <name>  # Create database
uplink db list           # List databases
uplink db delete <id>    # Delete database
```

### Development
```bash
uplink dev               # Auto-detect and tunnel local services
```

---

## API Reference

### Authentication

```bash
# All requests require Bearer token
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.uplink.spot/v1/tunnels
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/signup` | Create account + token |
| `POST` | `/v1/signup/token` | Generate additional token |
| `GET` | `/v1/me` | Current user info |
| `POST` | `/v1/tunnels` | Create tunnel |
| `GET` | `/v1/tunnels` | List tunnels |
| `GET` | `/v1/tunnels/:id` | Get tunnel |
| `DELETE` | `/v1/tunnels/:id` | Delete tunnel |
| `POST` | `/v1/tunnels/:id/alias` | Set permanent alias |
| `DELETE` | `/v1/tunnels/:id/alias` | Remove alias |
| `POST` | `/v1/dbs` | Create database |
| `GET` | `/v1/dbs` | List databases |
| `DELETE` | `/v1/dbs/:id` | Delete database |

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/admin/tunnels` | List all tunnels |
| `GET` | `/v1/admin/stats` | Platform statistics |
| `GET` | `/v1/admin/relay-status` | Connected tunnel IPs |
| `GET` | `/v1/admin/tokens` | List all tokens |
| `DELETE` | `/v1/admin/tokens/:id` | Revoke token |

---

## Why Uplink?

### For Developers

- **Zero friction**: No accounts, no forms, no waiting
- **Terminal native**: Never leave your workflow
- **Stable URLs**: Share links that don't change
- **Fast**: Tunnels connect in under 2 seconds

### For AI Agents

- **Deterministic**: Same input → same output
- **Machine-readable**: JSON responses, no HTML scraping
- **Stateless**: No hidden UI state to manage
- **Idempotent**: Safe to retry operations

### vs. ngrok

| Feature | Uplink | ngrok |
|---------|--------|-------|
| Signup required | No | Yes |
| Browser needed | No | Yes (dashboard) |
| Permanent URLs | Yes (aliases) | Paid only |
| Self-hostable | Yes | No |
| CLI-first | Yes | Partial |
| AI-friendly | Yes | No |

---

## Self-Hosting

Uplink is fully self-hostable. Deploy on any Linux server:

```bash
# Clone and configure
git clone https://github.com/firstprinciplecode/uplink
cd uplink

# Set up environment
cp env.template .env
# Edit .env with your values

# Run migrations
npm run migrate

# Start services
npm run dev:api     # Backend
npm run dev:relay   # Tunnel relay
```

See [DEPLOYMENT.md](docs/deployment/DEPLOYMENT.md) for production setup.

---

## Roadmap

Based on the CLI-first philosophy, planned expansions:

- [ ] **Permanent Hosting**: `uplink host create myapp --from localhost:3000`
- [ ] **DNS Management**: `uplink dns add example.com A 1.2.3.4`
- [ ] **Certificates**: `uplink cert issue example.com`
- [ ] **Secrets**: `uplink secret set DATABASE_URL`
- [ ] **Monitoring**: `uplink logs myapp --follow`

---

## Quick Start

```bash
# Install
npm install -g uplink-cli

# Set API (optional, defaults to uplink.spot)
export AGENTCLOUD_API_BASE=https://api.uplink.spot

# Launch
uplink menu
```

---

## License

MIT © First Principle Code

---

*Built for developers who live in the terminal. Designed for AI agents that need infrastructure without dashboards.*

