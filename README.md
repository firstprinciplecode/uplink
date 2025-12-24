# Uplink

**Localhost to public URL in seconds.** No browser, no signup forms, no friction.

Uplink lets you expose your local dev server to the internet with a single command. Everything happens in your terminal—create an account, get a token, start a tunnel. Done.

Perfect for sharing work-in-progress, testing webhooks, or demoing to clients. And because it's 100% CLI-based, AI coding assistants like **Cursor**, **Claude Code**, and **Windsurf** can set it up for you automatically.

![Uplink CLI](./assets/cli-screenshot.png)

## Features

- **Instant Public URLs** - Your `localhost:3000` becomes `https://xyz.t.uplink.spot`
- **Zero Browser Required** - Signup, auth, and tunnel management all in terminal
- **Agent-Friendly** - AI assistants can create tokens and start tunnels via API
- **Auto Port Detection** - Scans for running servers, select with arrow keys

## Quick Start

### 1. Install

```bash
npm install -g uplink-cli
# Or run without global install:
npx uplink-cli
```

### 2. Run Uplink

```bash
uplink
```

This opens an interactive menu. If you don't have a token yet, you'll see:

```
├─ Get Started (Create Account)
└─ Exit
```

### 3. Create Your Account

1. Select **"Get Started (Create Account)"**
2. Enter an optional label (e.g., "my-laptop")
3. Optionally set expiration days (or leave empty for no expiration)
4. Your token will be displayed **once** - save it securely
5. The CLI will offer to automatically add it to your `~/.zshrc` or `~/.bashrc`

After adding the token, run:
```bash
source ~/.zshrc  # or ~/.bashrc
uplink
```

### 4. Start a Tunnel

Once authenticated, select **"Manage Tunnels"** → **"Start Tunnel"**:

- The CLI will scan for active servers on your local machine
- Use arrow keys to select a port, or choose "Enter custom port"
- Press "Back" if you want to cancel
- Your tunnel URL will be displayed (e.g., `https://abc123.t.uplink.spot`)

**Keep the terminal running** - the tunnel client must stay active.

## CLI Commands

### Interactive Menu (Recommended)

```bash
uplink
# or
uplink menu
```

### Direct Commands

```bash
# Start a tunnel for port 3000
uplink dev --tunnel --port 3000

# List databases
uplink db list

# Create a database
uplink db create --name mydb --region us-east-1

# Admin commands (requires admin token)
uplink admin status
uplink admin tunnels
uplink admin databases
```

## Environment Variables

```bash
# API endpoint (default: https://api.uplink.spot)
export AGENTCLOUD_API_BASE=https://api.uplink.spot

# Your API token (required)
export AGENTCLOUD_TOKEN=your-token-here

# Tunnel control server (default: tunnel.uplink.spot:7071)
export TUNNEL_CTRL=tunnel.uplink.spot:7071

# Tunnel domain (default: t.uplink.spot)
export TUNNEL_DOMAIN=t.uplink.spot
```

## Requirements

- **Node.js** 20.x or later
- **API Token** - Created automatically via signup, or provided by an admin

## How It Works

### Tunnel Service

1. **Create tunnel** - Request a tunnel from the API
2. **Get token** - Receive a unique token (e.g., `abc123`)
3. **Start client** - Run the tunnel client locally, connecting to the relay
4. **Access** - Your local server is accessible at `https://abc123.t.uplink.spot`

The tunnel client forwards HTTP requests from the public URL to your local server.

### Database Service

Create and manage PostgreSQL databases via Neon. Databases are provisioned automatically and connection strings are provided.

## Troubleshooting

### "Connection refused" error
- Make sure your local server is running on the specified port
- Start your server first, then create the tunnel

### "Cannot connect to relay" error
- Verify the `TUNNEL_CTRL` address is correct
- Check if the tunnel relay service is running

### Tunnel URL returns "Gateway timeout"
- Make sure the tunnel client is still running
- Restart the tunnel client if it exited

### Token not working
- Verify `AGENTCLOUD_TOKEN` is set: `echo $AGENTCLOUD_TOKEN`
- Make sure you ran `source ~/.zshrc` (or `~/.bashrc`) after adding the token
- Create a new token if needed

## API Endpoints

The CLI communicates with the Uplink API. Main endpoints:

- `POST /v1/signup` - Create account (public, no auth)
- `POST /v1/tunnels` - Create tunnel
- `GET /v1/tunnels` - List your tunnels
- `DELETE /v1/tunnels/:id` - Delete tunnel
- `POST /v1/databases` - Create database
- `GET /v1/databases` - List your databases
- `GET /v1/admin/stats` - System statistics (admin only)

## Security

### Token Security
- Tokens are hashed with HMAC-SHA256 before storage (never stored in plain text)
- Tokens can be revoked instantly or set to auto-expire
- User tokens only see their own resources (tunnels, databases)
- Admin tokens required for system-wide operations

### Rate Limiting
- Signup: 5 requests/hour per IP (strictest)
- Authentication: 10 attempts/15 min per IP
- API calls: 100 requests/15 min per IP
- Token creation: 20/hour
- Tunnel creation: 50/hour

### Production Recommendations

1. **Set a token pepper** (strongly recommended):
   ```bash
   export CONTROL_PLANE_TOKEN_PEPPER=your-random-secret-here
   ```
   This adds an extra layer of protection - even if the database is compromised, tokens can't be used without the pepper.

2. **Disable dev tokens** in production:
   - Don't set `AGENTCLOUD_TOKEN_DEV`
   - Use only database-backed tokens

3. **Break-glass admin access** (emergency only):
   ```bash
   export ADMIN_TOKENS=emergency-admin-token-1,emergency-admin-token-2
   ```
   These bypass the database - use only for emergencies and rotate after use.

4. **Use HTTPS** for all API endpoints (handled by Caddy in production)

## License

MIT

## Support

For issues or questions, check:
- Run `uplink` and use the interactive menu
- Check environment variables are set correctly
- Verify your token is valid: `uplink admin status` (if admin)
