# Testing Guide

This guide covers how to test the Uplink system, including the new security and reliability features.

## Quick Start

### 1. Start the Backend API

```bash
# In one terminal
npm run dev:api
```

The server will start on `http://localhost:4000` (or the port specified in `PORT` env var).

### 2. Run Feature Tests

```bash
# Test new features (validation, rate limiting, logging, etc.)
bash scripts/test-new-features.sh

# Or test against production/staging
AGENTCLOUD_API_BASE=https://api.uplink.spot \
  AGENTCLOUD_TOKEN=your-token \
  bash scripts/test-new-features.sh
```

### 3. Run Existing Smoke Tests

```bash
# All smoke tests
npm run smoke:all

# Individual tests
npm run smoke:tunnel
npm run smoke:db
```

## Testing New Features

### Structured Logging

**What to test:**
- Logs are structured JSON in production
- Pretty-printed in development
- Audit events are logged

**How to test:**
1. Start the server: `npm run dev:api`
2. Make some API calls (create tunnel, create token, etc.)
3. Check console output for structured logs
4. Look for audit events like:
   - `event: "tunnel.created"`
   - `event: "auth.success"`
   - `event: "token.created"`

**Example:**
```bash
# Start server
npm run dev:api

# In another terminal, create a tunnel
curl -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}'

# Check server logs for:
# {"level":30,"time":1234567890,"event":"tunnel.created","userId":"...","tunnelId":"..."}
```

### Rate Limiting

**What to test:**
- API endpoints are rate limited
- Different limits for different endpoints
- Rate limit headers are returned

**How to test:**
```bash
# Test general API rate limiting (100 req/15min)
for i in {1..110}; do
  curl -s -w "\n%{http_code}" http://localhost:4000/v1/tunnels \
    -H "Authorization: Bearer dev-token" | tail -1
  sleep 0.1
done
# Should eventually get 429

# Test auth rate limiting (10 req/15min)
for i in {1..15}; do
  curl -s -w "\n%{http_code}" http://localhost:4000/v1/tunnels \
    -H "Authorization: Bearer invalid-token" | tail -1
done
# Should get 429 after 10 requests

# Test tunnel creation rate limiting (50 req/hour)
for i in {1..55}; do
  curl -s -X POST http://localhost:4000/v1/tunnels \
    -H "Authorization: Bearer dev-token" \
    -H "Content-Type: application/json" \
    -d '{"port": 3000}' | tail -1
done
# Should get 429 after 50 requests
```

**Expected behavior:**
- First requests succeed (200/201)
- After limit, get 429 with error message
- Rate limit info in response headers

### Input Validation

**What to test:**
- Invalid inputs are rejected with 400
- Clear error messages
- Validation errors include field paths

**How to test:**
```bash
# Missing required field
curl -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 400 with validation error

# Invalid type
curl -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": "not-a-number"}'
# Expected: 400 with validation error

# Out of range
curl -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 99999}'
# Expected: 400 with validation error

# Valid input
curl -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}'
# Expected: 201 with tunnel data
```

**Expected response format:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": {
      "errors": [
        {
          "path": "port",
          "message": "Expected number, received string"
        }
      ]
    }
  }
}
```

### Security Headers

**What to test:**
- Helmet.js security headers are present
- XSS protection headers
- Content type options

**How to test:**
```bash
curl -I http://localhost:4000/health

# Should see headers like:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
```

### Configuration Validation

**What to test:**
- Server fails fast with clear errors for missing config
- Validates on startup
- Logs configuration summary

**How to test:**
```bash
# Test with missing required config (if any)
unset CONTROL_PLANE_DATABASE_URL
npm run dev:api
# Should fail with clear error message

# Test with invalid config
CONTROL_PLANE_DATABASE_URL="invalid://url" npm run dev:api
# Should handle gracefully or fail with clear message
```

### Health Endpoints

**What to test:**
- `/health` - Basic health check
- `/health/live` - Liveness probe (process running)
- `/health/ready` - Readiness probe (can serve requests)

**How to test:**
```bash
# Basic health
curl http://localhost:4000/health
# Expected: {"status":"ok","timestamp":"..."}

# Liveness
curl http://localhost:4000/health/live
# Expected: {"status":"alive"}

# Readiness (checks DB connection)
curl http://localhost:4000/health/ready
# Expected: {"status":"ready"} or {"status":"not ready"} if DB unavailable
```

### Audit Logging

**What to test:**
- Security events are logged
- Token operations are audited
- Tunnel operations are audited

**How to test:**
1. Perform security-sensitive operations:
   ```bash
   # Create token (if admin)
   curl -X POST http://localhost:4000/v1/admin/tokens \
     -H "Authorization: Bearer admin-token" \
     -H "Content-Type: application/json" \
     -d '{"role": "user"}'
   
   # Create tunnel
   curl -X POST http://localhost:4000/v1/tunnels \
     -H "Authorization: Bearer dev-token" \
     -H "Content-Type: application/json" \
     -d '{"port": 3000}'
   
   # Delete tunnel
   curl -X DELETE http://localhost:4000/v1/tunnels/TUNNEL_ID \
     -H "Authorization: Bearer dev-token"
   ```

2. Check server logs for audit entries:
   ```json
   {"level":30,"component":"audit","event":"token.created","userId":"...","tokenId":"..."}
   {"level":30,"component":"audit","event":"tunnel.created","userId":"...","tunnelId":"..."}
   {"level":30,"component":"audit","event":"tunnel.deleted","userId":"...","tunnelId":"..."}
   ```

## Manual Testing Checklist

### Authentication & Authorization
- [ ] Missing token returns 401
- [ ] Invalid token returns 401
- [ ] Valid token allows access
- [ ] Admin-only endpoints require admin role
- [ ] Users can only access their own resources

### Rate Limiting
- [ ] General API rate limit works (100/15min)
- [ ] Auth rate limit works (10/15min)
- [ ] Token creation rate limit works (20/hour)
- [ ] Tunnel creation rate limit works (50/hour)
- [ ] Rate limit headers are present
- [ ] Rate limit errors are clear

### Input Validation
- [ ] Missing required fields return 400
- [ ] Invalid types return 400
- [ ] Out of range values return 400
- [ ] Invalid formats return 400
- [ ] Error messages are helpful

### Logging
- [ ] Structured logs in production
- [ ] Pretty logs in development
- [ ] Audit events are logged
- [ ] Errors include stack traces
- [ ] Request/response logging works

### Security
- [ ] Security headers are present
- [ ] CORS is configured (if needed)
- [ ] Input sanitization works
- [ ] SQL injection prevention works

### Reliability
- [ ] Health endpoints work
- [ ] Graceful shutdown works
- [ ] Error handling is consistent
- [ ] Configuration validation works

## Integration Testing

### End-to-End Tunnel Test

```bash
# 1. Start backend API
npm run dev:api

# 2. Create tunnel
TUNNEL_RESPONSE=$(curl -s -X POST http://localhost:4000/v1/tunnels \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}')

TUNNEL_ID=$(echo $TUNNEL_RESPONSE | grep -o '"id":"[^"]*' | cut -d'"' -f4)
TOKEN=$(echo $TUNNEL_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 3. Start local server
python3 -m http.server 3000 &

# 4. Start tunnel client (if relay is running)
node scripts/tunnel/client-improved.js \
  --token $TOKEN \
  --port 3000 \
  --ctrl localhost:7071

# 5. Test tunnel (if configured)
curl https://${TOKEN}.t.uplink.spot

# 6. Clean up
curl -X DELETE http://localhost:4000/v1/tunnels/$TUNNEL_ID \
  -H "Authorization: Bearer dev-token"
```

## Performance Testing

### Load Testing

```bash
# Install Apache Bench if needed
# macOS: brew install httpd
# Linux: apt-get install apache2-utils

# Test health endpoint
ab -n 1000 -c 10 http://localhost:4000/health

# Test authenticated endpoint
ab -n 100 -c 5 -H "Authorization: Bearer dev-token" \
  http://localhost:4000/v1/tunnels

# Monitor rate limiting
ab -n 200 -c 20 -H "Authorization: Bearer dev-token" \
  http://localhost:4000/v1/tunnels
# Should see some 429 responses
```

## Debugging

### Check Logs

```bash
# Development - logs to console
npm run dev:api

# Production - check systemd logs
journalctl -u backend-api -f

# Check for specific events
journalctl -u backend-api | grep "tunnel.created"
journalctl -u backend-api | grep "auth.failed"
```

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm run dev:api
```

### Test Configuration

```bash
# Test config validation
node -e "require('./backend/src/utils/config.ts')"
```

## Continuous Testing

Add to CI/CD pipeline:

```bash
# Run all tests
npm run smoke:all

# Run feature tests
bash scripts/test-new-features.sh

# Check for TypeScript errors
npx tsc --noEmit

# Check for linting errors (if configured)
npm run lint
```

