# Uplink CLI – Public Release Prep

This doc captures the steps to make the CLI fully public/open while keeping the core backend/relay private.

## Scope
- **Public repo**: `uplink-cli` (new). Contents: `cli/`, `scripts/tunnel/` (clients only), `docs/`, `README.md`, `LICENSE`, `package.json`, `package-lock.json`.
- **Private repo**: `uplink-core` (current repo or a new private one). Contents: `backend/`, infra scripts, deploy configs, database migrations, relay/server configs, secrets.

## Rationale
- Users and agents can install/audit/contribute to the CLI.
- Business logic, billing, and infra stay closed; avoids self-hosting churn and preserves premium features (permanent URLs, aliases).

## What to Publish in `uplink-cli`
- `cli/` (all commands).
- `scripts/tunnel/client-improved.js` and `scripts/tunnel/client.js` (tunnel client only).
- `docs/` (keep `MENU_STRUCTURE.md`, `AGENTS.md`, any usage guides).
- `README.md` rewritten for CLI-only usage.
- `LICENSE` (MIT is fine).
- `package.json`, `package-lock.json`.

## What **Not** to Publish
- `backend/`, database migrations, infra/relay configs, deploy scripts.
- Any tokens/keys/configs.
- Server-side test scripts that hit prod (`scripts/*` that are API smoke tests). Keep only client-side tunnel test if desired.

## Repo Split Steps
1) Create new repo `uplink-cli` (public).
2) Copy in:
   - `cli/`
   - `scripts/tunnel/client-improved.js` (and `client.js` if still needed)
   - `docs/`
   - `README.md` (rewrite for CLI usage)
   - `LICENSE`
   - `package.json`, `package-lock.json`
3) Prune `package.json`:
   - Remove backend deps.
   - Keep only CLI deps (`commander`, `node-fetch`, `tsx`, etc.).
   - Set `"files"` to include `cli/`, `scripts/tunnel/`, `docs/`, `README.md`, `LICENSE`.
   - Verify `"bin": { "uplink": "./cli/bin/uplink.js" }`.
4) Add a minimal `.npmignore` (or rely on `"files"`):
   - Exclude tests not meant for users.
5) Update `README.md` (CLI-focused):
   - Install: `npm install -g uplink-cli`
   - Auth: set `AGENTCLOUD_TOKEN`
   - Quick start: `uplink tunnel create --port 3000` and `uplink menu`
   - Machine/agent mode: `--json`, `--token-stdin`, `--api-base`.
   - Link to `docs/MENU_STRUCTURE.md` and `docs/AGENTS.md`.
6) Audit for secrets/tokens (ensure none in docs/logs).
7) Tag and publish from the new repo:
   - `npm version patch`
   - `npm publish`
   - `git push --tags`

## Current Repo (`uplink-core`, private)
- Keep `backend/`, infra, deployment scripts, smoke tests that touch prod.
- Keep `scripts/tunnel-smoke.sh`, `scripts/db-api-smoke.sh`, etc. here only.
- Optionally keep CLI here for internal dev, but treat `uplink-cli` as the public source of truth (mirror changes back as needed).

## Optional Hardening Before Public
- Ensure CLI defaults point to production `api.uplink.spot` and `tunnel.uplink.spot:7071`.
- Verify `--api-base` override works for staging.
- Confirm `uplink tunnel create --json` surfaces `url` and `alias` correctly.
- Keep premium gating server-side (alias limits, etc.).

## Release Checklist (CLI)
- [ ] `npm install && npm test` (CLI scope)
- [ ] `npm version patch`
- [ ] `npm publish`
- [ ] `git push origin main --tags`
- [ ] Manual sanity: `npm install -g uplink-cli` in a clean shell, run `uplink --version`, `uplink tunnel create --port 3000 --json` (with valid token)

