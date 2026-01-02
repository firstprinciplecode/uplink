# Uplink CLI

Localhost to public URL in seconds. Fully terminal-native and agent-friendly.

![Uplink CLI](https://raw.githubusercontent.com/firstprinciplecode/uplink/master/assets/cli-screenshot.png)

## What it does
- Expose `localhost:3000` as `https://abc123.x.uplink.spot`
- Create permanent URLs (if enabled on your account)
- Works great with agents (Cursor, Claude Code, GPT‑5, Windsurf)

## Install
```bash
npm install -g uplink-cli
# or
npx uplink-cli --help
```

## Authenticate (no browser)
```bash
uplink signup --json                     # creates account + token
# or interactive: uplink (Get Started)
export AGENTCLOUD_TOKEN=your-token-here  # save securely
```

## Quick start (interactive)
```bash
uplink        # open menu
```
- Start Tunnel → pick or enter port → get URL (e.g., https://abc123.x.uplink.spot)
- My Tunnels → see status and permanent URL if set
- Create Permanent URL → pick tunnel → enter alias (if premium enabled)

## Quick start (non-interactive)
```bash
# Create tunnel
echo "$AGENTCLOUD_TOKEN" | uplink --token-stdin tunnel create --port 3000 --json

# List tunnels
echo "$AGENTCLOUD_TOKEN" | uplink --token-stdin tunnel list --json

# Set alias (if enabled on account)
echo "$AGENTCLOUD_TOKEN" | uplink --token-stdin tunnel alias-set --id tun_xxx --alias myapp --json
```

## Agent essentials
- `--json` → stdout JSON only; stderr logs/errors.
- `--token-stdin` → read token once from stdin (avoid argv leaks).
- `--api-base` → override API host if needed.
- Exit codes: 0 ok; 2 usage; 10 auth missing/invalid; 20 network; 30 server/unknown.
See `docs/AGENTS.md` for full contract.

## Key commands
- `uplink menu` — interactive UI
- `uplink tunnel create --port <p> [--alias <a>] [--json]`
- `uplink tunnel list --json`
- `uplink tunnel alias-set --id <id> --alias <a> --json`
- `uplink tunnel alias-delete --id <id> --json`
- `uplink tunnel stats --id <id> --json`
- `uplink tunnel stop --id <id> --json`
- `uplink signup --json` — create user + token (no auth)

## Environment
```bash
export AGENTCLOUD_TOKEN=your-token
export AGENTCLOUD_API_BASE=https://api.uplink.spot
export TUNNEL_CTRL=tunnel.uplink.spot:7071
export TUNNEL_DOMAIN=x.uplink.spot
```

## Troubleshooting
- “No running tunnel clients found” — make sure the tunnel client is still running; restart `uplink` and start a tunnel.
- Auth errors — verify `AGENTCLOUD_TOKEN` is set/exported; use `--token-stdin`.
- Relay errors — ensure `TUNNEL_CTRL=tunnel.uplink.spot:7071`.

## Docs
- Menu reference: `docs/MENU_STRUCTURE.md`
- Agent guide: `docs/AGENTS.md`
- Open source CLI scope vs backend: `docs/OPEN_SOURCE_CLI.md`

## License
MIT
