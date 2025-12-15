# Uplink Manual - Complete Feature Reference

## Table of Contents
1. [Overview](#overview)
2. [CLI Commands](#cli-commands)
3. [Tunnel Service](#tunnel-service)
4. [Database Service](#database-service)
5. [Admin Features](#admin-features)
6. [Security Features](#security-features)
7. [Performance Features](#performance-features)
8. [Configuration](#configuration)

---

## Overview

Uplink is an agent-friendly cloud platform providing:
- **Tunnel Service**: Expose local development servers to the internet
- **Database Service**: Managed PostgreSQL databases via Neon
- **Admin Interface**: Terminal-based system management
- **CLI Tools**: Simple command-line interface

### Quick Start

```bash
# Install globally (optional)
npm link

# Open interactive menu
uplink

# Or use specific commands
uplink dev --tunnel --port 3000
uplink admin status
uplink db list
```

---

## CLI Commands

### Main Commands

#### `uplink` (no arguments)
Opens the interactive terminal menu with arrow-key navigation.

#### `uplink dev [options]`
Run local development with optional tunnel.

**Options:**
- `--tunnel` - Enable tunnel
- `--port <port>` - Local port to expose (default: 3000)
- `--improved` - Use improved client with auto-reconnect
- `--json` - Output JSON

**Examples:**
```bash
uplink dev --tunnel --port 3000
uplink dev --tunnel --port 3000 --improved
```

#### `uplink admin [command]`
Admin commands for system management.

**Subcommands:**
- `status` - Show system status and statistics
- `tunnels` - List all tunnels
- `databases` - List all databases

**Options:**
- `--status <status>` - Filter by status
- `--limit <limit>` - Limit results (default: 20)
- `--json` - Output JSON

**Examples:**
```bash
uplink admin status
uplink admin tunnels --status active --limit 50
uplink admin databases --json
```

#### `uplink db [command]`
Database management commands.

**Subcommands:**
- `list` - List databases
- `create` - Create a new database
- `delete <id>` - Delete a database

**Examples:**
```bash
uplink db list
uplink db create --name mydb --region us-east-1
uplink db delete db_123456
```

---

## Tunnel Service

### Features

#### ✅ Phase 1 (Implemented)
- **Auto-Reconnect**: Automatic reconnection with exponential backoff
- **Better Error Messages**: Contextual error messages with troubleshooting hints
- **Health Checks**: Periodic local service health checks
- **Request Size Limits**: Configurable max request/response size (default: 10MB)
- **Connection Statistics**: Request/error/reconnect tracking
- **Improved Request Handling**: Timeouts, better error responses

#### ✅ Phase 2 (Implemented)
- **Token Validation**: ✅ Validate tokens against database via API
- **Rate Limiting**: ✅ Per-token request rate limits (default: 1000/min)
- **Request Size Limits**: ✅ Configurable max request size (default: 10MB)
- **Token Caching**: ✅ Cache token validation results (1min TTL)
- **Health Endpoint**: ✅ `/health` endpoint with statistics
- **Better Error Handling**: ✅ Improved error messages and logging
- **Connection Statistics**: ✅ Request/error/rate limit tracking

#### 🚧 Phase 2 (In Progress)
- **TLS Encryption**: TLS for control channel
- **Keep-Alive Connections**: HTTP keep-alive support
- **Simplified CLI**: Single `uplink tunnel` command

#### 📋 Phase 3 (Planned)
- **WebSocket Support**: WebSocket upgrade for persistent connections
- **SDK/API Wrapper**: Node.js and Python SDKs
- **Auto-Port Detection**: Detect running services automatically
- **Metrics & Monitoring**: Request count, latency, errors
- **Connection Pooling**: Pool connections, multiplex requests

### Creating a Tunnel

**Method 1: Via CLI**
```bash
uplink dev --tunnel --port 3000
```

**Method 2: Via API**
```bash
curl -X POST https://api.uplink.spot/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}'
```

**Method 3: Direct Client**
```bash
# Standard client
node scripts/tunnel/client.js --token <token> --port 3000 --ctrl 178.156.149.124:7071

# Improved client (recommended)
node scripts/tunnel/client-improved.js --token <token> --port 3000 --ctrl 178.156.149.124:7071
```

### Tunnel URLs

Tunnels are accessible at:
```
https://<token>.t.uplink.spot
```

Example:
```
https://abc123def456.t.uplink.spot
```

### Tunnel Status

Check tunnel status:
```bash
uplink admin tunnels --status active
```

### Tunnel Configuration

**Client Environment Variables:**
- `TUNNEL_CTRL` - Control server address (default: 127.0.0.1:7071)
- `TUNNEL_DOMAIN` - Tunnel domain (default: t.uplink.spot)
- `TUNNEL_MAX_SIZE` - Max request/response size (default: 10MB)
- `TUNNEL_REQUEST_TIMEOUT` - Request timeout (default: 30s)
- `TUNNEL_HEALTH_CHECK_INTERVAL` - Health check interval (default: 30s)

**Relay Environment Variables:**
- `TUNNEL_RELAY_HTTP` - HTTP ingress port (default: 7070)
- `TUNNEL_RELAY_CTRL` - Control channel port (default: 7071)
- `TUNNEL_DOMAIN` - Tunnel domain (default: t.uplink.spot)
- `TUNNEL_VALIDATE_TOKENS` - Enable token validation (default: false)
- `AGENTCLOUD_API_BASE` - API base URL for token validation
- `TUNNEL_RATE_LIMIT_REQUESTS` - Requests per minute per token (default: 1000)
- `TUNNEL_MAX_REQUEST_SIZE` - Max request size (default: 10MB)

---

## Database Service

### Features

- **Managed PostgreSQL**: Databases via Neon
- **Multiple Regions**: Support for various AWS regions
- **Automatic Provisioning**: Databases created automatically
- **Connection Strings**: Secure connection strings provided

### Creating a Database

**Via CLI:**
```bash
uplink db create --name mydb --region us-east-1
```

**Via API:**
```bash
curl -X POST https://api.uplink.spot/v1/databases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "mydb", "region": "us-east-1"}'
```

### Listing Databases

```bash
uplink db list
```

### Database Status

Databases can have the following statuses:
- `ready` - Database is ready to use
- `provisioning` - Database is being created
- `failed` - Database creation failed
- `deleted` - Database has been deleted

---

## Admin Features

### System Status

View overall system status:
```bash
uplink admin status
```

Shows:
- API health
- Tunnel statistics (active, inactive, deleted, total, created last 24h)
- Database statistics (ready, provisioning, failed, deleted, total, created last 24h)

### Tunnel Management

List all tunnels:
```bash
uplink admin tunnels [--status <status>] [--limit <limit>]
```

Shows:
- Tunnel ID
- Token
- Target port
- Status
- Created date

### Database Management

List all databases:
```bash
uplink admin databases [--status <status>] [--limit <limit>]
```

Shows:
- Database ID
- Name
- Provider
- Region
- Status
- Created date

---

## Security Features

### ✅ Implemented

- **Request Size Limits**: Prevents DoS attacks (default: 10MB)
- **Token-Based Authentication**: Bearer token authentication
- **Error Message Sanitization**: Prevents information leakage
- **Connection State Tracking**: Better security monitoring

### ✅ Implemented (Phase 2)

- **Token Validation**: ✅ Database-backed token validation via API
- **Rate Limiting**: ✅ Per-token request limits (1000/min default)
- **Request Size Limits**: ✅ Configurable limits (10MB default)
- **Token Caching**: ✅ Cache validation results for performance

### 🚧 In Progress

- **TLS Encryption**: Encrypted control channel
- **IP Whitelisting**: Optional IP allowlist per tunnel

### 📋 Planned

- **Token Expiration**: Automatic token expiration
- **Token Rotation**: Support for token rotation
- **Audit Logging**: Structured security logs
- **DDoS Protection**: Advanced DDoS mitigation

---

## Performance Features

### ✅ Implemented

- **Health Checks**: Periodic service health monitoring
- **Request Timeouts**: Configurable timeouts (default: 30s)
- **Connection Statistics**: Performance metrics tracking
- **Error Recovery**: Auto-reconnect with exponential backoff

### ✅ Implemented (Phase 2)

- **Token Caching**: ✅ Reduces database load
- **Rate Limiting**: ✅ Prevents abuse
- **Request Size Limits**: ✅ Prevents memory exhaustion

### 🚧 In Progress

- **Keep-Alive Connections**: HTTP keep-alive support
- **Compression**: Gzip/Brotli compression for responses

### 📋 Planned

- **WebSocket Support**: Lower latency for real-time apps
- **Connection Pooling**: Better throughput
- **Binary Protocol**: Optimized message serialization
- **Caching**: Response caching for static content

---

## Configuration

### Environment Variables

#### API Configuration
- `AGENTCLOUD_API_BASE` - API base URL (default: http://localhost:4000)
- `AGENTCLOUD_TOKEN` - Authentication token (default: dev-token for localhost)

#### Tunnel Configuration
- `TUNNEL_CTRL` - Control server address
- `TUNNEL_DOMAIN` - Tunnel domain
- `TUNNEL_MAX_SIZE` - Max request/response size
- `TUNNEL_REQUEST_TIMEOUT` - Request timeout
- `TUNNEL_HEALTH_CHECK_INTERVAL` - Health check interval

#### Database Configuration
- `CONTROL_PLANE_DATABASE_URL` - Control plane database URL
- `NEON_API_KEY` - Neon API key
- `NEON_PROJECT_ID` - Neon project ID

### Configuration Files

#### `.env` (Server)
```bash
PORT=4000
CONTROL_PLANE_DATABASE_URL=postgresql://...
NEON_API_KEY=...
NEON_PROJECT_ID=...
TUNNEL_DOMAIN=t.uplink.spot
TUNNEL_URL_SCHEME=https
CLOUDFLARE_API_TOKEN=...
```

#### `package.json`
```json
{
  "bin": {
    "uplink": "./cli/bin/uplink.js"
  }
}
```

---

## API Endpoints

### Health Check
```
GET /health
```

### Tunnels
```
POST /v1/tunnels - Create tunnel
GET /v1/tunnels/:id - Get tunnel
GET /v1/tunnels - List tunnels
DELETE /v1/tunnels/:id - Delete tunnel
```

### Databases
```
POST /v1/databases - Create database
GET /v1/databases/:id - Get database
GET /v1/databases - List databases
DELETE /v1/databases/:id - Delete database
```

### Admin
```
GET /v1/admin/stats - System statistics
GET /v1/admin/tunnels - List all tunnels
GET /v1/admin/databases - List all databases
```

---

## Troubleshooting

### Tunnel Issues

**Connection refused:**
- Check if relay is running: `systemctl status tunnel-relay`
- Verify firewall rules allow port 7071
- Check `TUNNEL_CTRL` environment variable

**Tunnel not connected:**
- Verify tunnel client is running
- Check token is correct
- Verify local service is running on specified port

**Request timeout:**
- Check local service is responding
- Verify network connectivity
- Increase timeout if needed: `TUNNEL_REQUEST_TIMEOUT=60000`

### Database Issues

**Database provisioning failed:**
- Check Neon API key is valid
- Verify Neon project ID is correct
- Check Neon account limits

**Connection string not working:**
- Verify database status is `ready`
- Check connection string format
- Verify network access to Neon

---

## Changelog

### Phase 1 (Current)
- ✅ Auto-reconnect with exponential backoff
- ✅ Better error messages
- ✅ Health checks
- ✅ Request size limits
- ✅ Connection statistics
- ✅ Improved request handling
- ✅ Interactive terminal menu
- ✅ Simple `uplink` command

### Phase 2 (Completed)
- ✅ Token validation on relay
- ✅ Rate limiting (1000 req/min per token)
- ✅ Request size limits (10MB)
- ✅ Token caching (1min TTL)
- ✅ Health endpoint with statistics
- ✅ Improved error handling

### Phase 2 (In Progress)
- 🚧 TLS encryption for control channel
- 🚧 Keep-alive connections
- 🚧 Simplified CLI commands

### Phase 3 (Planned)
- 📋 WebSocket support
- 📋 SDK/API wrapper
- 📋 Auto-port detection
- 📋 Metrics & monitoring
- 📋 Connection pooling

---

## Support

For issues or questions:
- Check the troubleshooting section
- Review logs: `journalctl -u backend-api -u tunnel-relay`
- Run smoke tests: `npm run smoke:all`

