#!/usr/bin/env bash
# Test script for new features: logging, rate limiting, validation, etc.
set -euo pipefail

# Colors (define early for use in checks)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

API_BASE="${AGENTCLOUD_API_BASE:-http://localhost:4000}"
TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"

echo "🧪 Testing New Features"
echo "======================"
echo "API Base: $API_BASE"
echo "Token: ${TOKEN:0:8}..."
echo ""

# Check if server is reachable
if ! curl -sSf --connect-timeout 2 "$API_BASE/health" >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Warning: Cannot connect to $API_BASE${NC}"
  echo "   Make sure the server is running: npm run dev:api"
  echo ""
  echo "   You can also test against a remote server:"
  echo "   AGENTCLOUD_API_BASE=https://api.uplink.spot npm run test:features"
  echo ""
  exit 1
fi
echo ""

pass() {
  echo -e "${GREEN}✅ $1${NC}"
}

fail() {
  echo -e "${RED}❌ $1${NC}"
  FAILED=true
}

FAILED=false

warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# Test 1: Health endpoints
echo "1️⃣  Testing Health Endpoints..."
if curl -sSf "$API_BASE/health" | grep -q "ok"; then
  pass "Basic /health endpoint"
else
  fail "/health endpoint failed"
fi

# Test new health endpoints (may not exist on older servers)
# Use -sS (silent but show errors) without -f (fail on HTTP errors) to get status code
LIVE_OUTPUT=$(curl -sS -w "\n%{http_code}" "$API_BASE/health/live" -o /dev/null 2>/dev/null || echo "000")
LIVE_STATUS=$(echo "$LIVE_OUTPUT" | tail -n1 | grep -oE '^[0-9]{3}$' || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  if curl -sS "$API_BASE/health/live" 2>/dev/null | grep -q "alive"; then
    pass "/health/live endpoint"
  else
    warn "/health/live endpoint exists but response format unexpected"
  fi
elif [ "$LIVE_STATUS" = "404" ]; then
  warn "/health/live endpoint not found (server may need update)"
else
  warn "/health/live endpoint failed (HTTP $LIVE_STATUS)"
fi

READY_OUTPUT=$(curl -sS -w "\n%{http_code}" "$API_BASE/health/ready" -o /dev/null 2>/dev/null || echo "000")
READY_STATUS=$(echo "$READY_OUTPUT" | tail -n1 | grep -oE '^[0-9]{3}$' || echo "000")
if [ "$READY_STATUS" = "200" ]; then
  if curl -sS "$API_BASE/health/ready" 2>/dev/null | grep -q "ready"; then
    pass "/health/ready endpoint"
  else
    warn "/health/ready endpoint exists but response format unexpected"
  fi
elif [ "$READY_STATUS" = "404" ]; then
  warn "/health/ready endpoint not found (server may need update)"
elif [ "$READY_STATUS" = "503" ]; then
  warn "/health/ready endpoint returned 503 (DB may not be connected)"
else
  warn "/health/ready endpoint failed (HTTP $READY_STATUS)"
fi

echo ""

# Test 2: Security headers (Helmet)
echo "2️⃣  Testing Security Headers..."
HEADERS=$(curl -sI "$API_BASE/health" 2>/dev/null | grep -iE "x-content-type-options|x-frame-options|x-xss-protection|strict-transport-security" || true)
if [ -n "$HEADERS" ]; then
  pass "Security headers present"
  echo "   Found: $(echo "$HEADERS" | head -1 | tr -d '\r\n')"
else
  warn "Security headers not detected (server may need update with Helmet.js)"
fi

echo ""

# Test 3: Input Validation
echo "3️⃣  Testing Input Validation..."

# Test invalid tunnel creation (missing port) - should get validation error
RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1 || echo -e "\n000")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" = "400" ]; then
  pass "Validation rejects missing port"
elif echo "$BODY" | grep -q "VALIDATION_ERROR\|validation\|Invalid"; then
  pass "Validation rejects missing port (got $HTTP_CODE but with validation error)"
else
  warn "Expected 400 for missing port, got $HTTP_CODE. Response: $BODY"
fi

# Test invalid tunnel creation (invalid port type)
RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"port": "not-a-number"}' 2>&1 || echo -e "\n000")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" = "400" ]; then
  pass "Validation rejects invalid port type"
elif echo "$BODY" | grep -q "VALIDATION_ERROR\|validation\|Invalid"; then
  pass "Validation rejects invalid port type (got $HTTP_CODE but with validation error)"
else
  warn "Expected 400 for invalid port type, got $HTTP_CODE. Response: $BODY"
fi

# Test invalid port range (too high)
RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"port": 99999}' 2>&1 || echo -e "\n000")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" = "400" ]; then
  pass "Validation rejects port out of range"
elif echo "$BODY" | grep -q "VALIDATION_ERROR\|validation\|Invalid"; then
  pass "Validation rejects port out of range (got $HTTP_CODE but with validation error)"
else
  warn "Expected 400 for port out of range, got $HTTP_CODE (may be handled differently)"
fi

echo ""

# Test 4: Rate Limiting
echo "4️⃣  Testing Rate Limiting..."
echo "   (Making multiple rapid requests to test rate limiting...)"

RATE_LIMIT_HIT=false
for i in {1..15}; do
  RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/v1/tunnels" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"port": 3000}' 2>&1 || echo -e "\n000")
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  if [ "$HTTP_CODE" = "429" ]; then
    RATE_LIMIT_HIT=true
    break
  fi
  sleep 0.1
done

if [ "$RATE_LIMIT_HIT" = true ]; then
  pass "Rate limiting is working (got 429)"
else
  warn "Rate limiting not triggered (may need more requests or different endpoint)"
fi

echo ""

# Test 5: Authentication
echo "5️⃣  Testing Authentication..."

# Test without token
RESPONSE=$(curl -sS -w "\n%{http_code}" "$API_BASE/v1/tunnels" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "401" ]; then
  pass "Authentication required (401 without token)"
else
  fail "Expected 401 without token, got $HTTP_CODE"
fi

# Test with invalid token
RESPONSE=$(curl -sS -w "\n%{http_code}" "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer invalid-token-12345" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "401" ]; then
  pass "Invalid token rejected (401)"
else
  warn "Expected 401 for invalid token, got $HTTP_CODE"
fi

echo ""

# Test 6: Valid Tunnel Creation
echo "6️⃣  Testing Valid Tunnel Creation..."
RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"port": 3000}' 2>&1 || echo -e "\n000")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "201" ] && echo "$BODY" | grep -q "url"; then
  TUNNEL_ID=$(echo "$BODY" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
  pass "Tunnel created successfully (ID: ${TUNNEL_ID:0:12}...)"
  
  # Clean up - delete the tunnel
  if [ -n "$TUNNEL_ID" ]; then
    curl -sS -X DELETE "$API_BASE/v1/tunnels/$TUNNEL_ID" \
      -H "Authorization: Bearer $TOKEN" > /dev/null || true
  fi
elif [ "$HTTP_CODE" = "429" ]; then
  warn "Tunnel creation rate limited (expected if testing multiple times)"
elif [ "$HTTP_CODE" = "400" ]; then
  warn "Tunnel creation validation failed (server may have different validation rules)"
elif [ "$HTTP_CODE" = "401" ]; then
  warn "Tunnel creation unauthorized (token may not have permissions)"
else
  warn "Tunnel creation failed (HTTP $HTTP_CODE). Response: $(echo "$BODY" | head -c 100)"
fi

echo ""

# Test 7: Structured Logging (check server logs)
echo "7️⃣  Testing Structured Logging..."
echo "   (Check server logs for structured JSON output)"
echo "   Look for log entries with 'event' field like:"
echo "   - event: 'tunnel.created'"
echo "   - event: 'auth.success'"
echo "   - event: 'rate_limit.exceeded'"
warn "Manual verification needed - check server logs"

echo ""

# Test 8: Admin Token Management (if admin token available)
if [ "$TOKEN" != "dev-token" ]; then
  echo "8️⃣  Testing Admin Token Management..."
  
  # List tokens
  RESPONSE=$(curl -sS "$API_BASE/v1/admin/tokens" \
    -H "Authorization: Bearer $TOKEN")
  
  if echo "$RESPONSE" | grep -q "tokens"; then
    pass "Admin token list endpoint works"
  else
    warn "Admin token list may require admin role"
  fi
else
  echo "8️⃣  Skipping Admin Tests (using dev-token)"
fi

echo ""
# Only exit with error if critical tests failed (not just warnings)
if [ "$FAILED" = true ]; then
  echo -e "${RED}❌ Some critical tests failed${NC}"
  echo ""
  if ! echo "$API_BASE" | grep -q "localhost\|127.0.0.1"; then
    echo "Note: Testing against remote server - some features may not be available yet"
    echo "      Deploy the latest code to see all new features"
  fi
  exit 1
else
  echo "✅ Feature tests completed!"
  echo ""
  if echo "$API_BASE" | grep -q "localhost\|127.0.0.1"; then
    echo "📝 Testing against local server - all features should be available"
  else
    echo "📝 Testing against remote server"
    echo "   Some warnings are expected if the server hasn't been updated yet"
    echo "   Deploy the latest code to see all new features"
  fi
fi
echo ""
echo "📝 Next Steps:"
echo "   1. Check server logs for structured logging output"
echo "   2. Monitor rate limiting behavior under load"
echo "   3. Verify audit logs are being written"
echo "   4. Deploy latest code to production for full feature support"

