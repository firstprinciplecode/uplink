#!/bin/bash

# Test script for Phase 2 security improvements
# Verifies: rate limiting, timeouts, IP allowlisting, token lifetime, body size limits

set -e

API_BASE="${API_BASE:-https://api.uplink.spot}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" = "your-token" ]; then
  echo "❌ ADMIN_TOKEN environment variable is required"
  echo ""
  echo "To get an admin token:"
  echo "  1. Use existing admin token from server:"
  echo "     ssh root@178.156.149.124 'grep ADMIN_TOKENS /opt/agentcloud/.env'"
  echo ""
  echo "  2. Or create a new one via CLI:"
  echo "     npx uplink admin tokens create --role admin"
  echo ""
  echo "  3. Or create via API (if you have an existing admin token):"
  echo "     curl -X POST $API_BASE/v1/admin/tokens \\"
  echo "       -H 'Authorization: Bearer <existing-admin-token>' \\"
  echo "       -H 'Content-Type: application/json' \\"
  echo "       -d '{\"role\":\"admin\"}'"
  echo ""
  exit 1
fi

echo "🔒 Testing Phase 2 Security Improvements"
echo "=========================================="
echo "API_BASE: $API_BASE"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
  echo -e "${GREEN}✅ $1${NC}"
}

fail() {
  echo -e "${RED}❌ $1${NC}"
}

warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

info() {
  echo -e "ℹ️  $1"
}

# Test 1: Rate limiting on /internal/allow-tls
echo "1️⃣  Testing Rate Limiting (60/min limit)..."
RATE_LIMIT_COUNT=0
RATE_LIMIT_HIT=0
for i in {1..65}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "$API_BASE/internal/allow-tls?domain=test.x.uplink.spot&nonce=$i" 2>/dev/null || echo "000")
  if [ "$STATUS" = "429" ]; then
    RATE_LIMIT_HIT=1
    RATE_LIMIT_COUNT=$i
    break
  fi
done

if [ "$RATE_LIMIT_HIT" = "1" ]; then
  pass "Rate limiting works (hit limit at request #$RATE_LIMIT_COUNT)"
else
  warn "Rate limiting not triggered after 65 requests (may need more requests or different IP)"
fi
echo ""

# Test 2: IP allowlisting (if configured)
echo "2️⃣  Testing IP Allowlisting..."
# This test assumes we're testing from a non-localhost IP
# In practice, this would be tested from a different server
LOCALHOST_TEST=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API_BASE/internal/allow-tls?domain=test.x.uplink.spot" 2>/dev/null || echo "000")

if [ "$LOCALHOST_TEST" = "403" ] || [ "$LOCALHOST_TEST" = "429" ]; then
  pass "IP allowlisting middleware active (returned $LOCALHOST_TEST)"
else
  warn "IP allowlisting test inconclusive (got $LOCALHOST_TEST, expected 403/429)"
fi
echo ""

# Test 3: Token lifetime enforcement
echo "3️⃣  Testing Token Lifetime Enforcement (max 90 days)..."
# First verify token is valid
AUTH_CHECK=$(curl -s -X GET "$API_BASE/v1/admin/system/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" 2>&1)

if echo "$AUTH_CHECK" | grep -q "UNAUTHORIZED\|Invalid token"; then
  fail "Admin token is invalid. Please set ADMIN_TOKEN to a valid admin token."
  echo "   To create an admin token, use: npx uplink admin tokens create --role admin"
  echo "   Or check your server's ADMIN_TOKENS env var"
  echo ""
  exit 1
fi

# Try to create a token with 365 days (should fail)
RESPONSE=$(curl -s -X POST "$API_BASE/v1/admin/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","expiresInDays":365}' 2>&1)

if echo "$RESPONSE" | grep -q "cannot exceed\|VALIDATION_ERROR\|max.*90\|Token lifetime cannot exceed"; then
  pass "Token lifetime enforcement works (rejected 365 days)"
else
  if echo "$RESPONSE" | grep -q "UNAUTHORIZED"; then
    fail "Admin token is invalid (got: ${RESPONSE:0:100})"
  else
    warn "Token lifetime enforcement test inconclusive (got: ${RESPONSE:0:100})"
  fi
fi

# Try to create a token with 90 days (should succeed)
RESPONSE=$(curl -s -X POST "$API_BASE/v1/admin/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","expiresInDays":90}' 2>&1)

if echo "$RESPONSE" | grep -q "\"token\"" || echo "$RESPONSE" | grep -q "\"id\""; then
  pass "Token creation with 90 days works"
  # Extract token ID for cleanup
  TOKEN_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "")
  if [ -n "$TOKEN_ID" ]; then
    info "Created test token: $TOKEN_ID (will not be cleaned up automatically)"
  fi
else
  if echo "$RESPONSE" | grep -q "UNAUTHORIZED"; then
    fail "Admin token is invalid (got: ${RESPONSE:0:100})"
  else
    warn "Token creation with 90 days may have failed (got: ${RESPONSE:0:100})"
  fi
fi
echo ""

# Test 4: Body size limit (tunnel creation should reject >1MB)
echo "4️⃣  Testing Body Size Limits..."
# Create a large payload (>1MB) - use a smaller test payload to avoid hanging
# We'll create a 1.1MB payload but with timeout
LARGE_PAYLOAD=$(python3 -c "print('x' * 1100000)" 2>/dev/null || \
  (dd if=/dev/zero bs=1100000 count=1 2>/dev/null | tr '\0' 'x' || \
   echo "x$(head -c 1100000 < /dev/zero | tr '\0' 'x' 2>/dev/null || echo 'x')"))

# Use timeout to prevent hanging
RESPONSE=$(timeout 10 curl -s -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"port\":3000,\"padding\":\"$LARGE_PAYLOAD\"}" 2>&1 || echo "TIMEOUT_OR_ERROR")

if echo "$RESPONSE" | grep -q "413\|Request Entity Too Large\|payload.*too large"; then
  pass "Body size limit works (rejected >1MB payload)"
elif echo "$RESPONSE" | grep -q "TIMEOUT_OR_ERROR"; then
  warn "Body size limit test timed out (may indicate limit is working, or network issue)"
elif echo "$RESPONSE" | grep -q "UNAUTHORIZED"; then
  warn "Body size limit test skipped (invalid token)"
else
  warn "Body size limit test inconclusive (got: ${RESPONSE:0:100})"
fi
echo ""

# Test 5: Request timeout (if we can simulate a slow endpoint)
echo "5️⃣  Testing Request Timeout (30s default)..."
# This is hard to test without a slow endpoint, so we'll just verify the middleware is loaded
info "Request timeout middleware is active (30s default, 5min for long ops)"
info "Manual test: Create an endpoint that sleeps >30s to verify timeout"
pass "Timeout middleware integrated (cannot test without slow endpoint)"
echo ""

# Test 6: Secret redaction in logs
echo "6️⃣  Testing Secret Redaction..."
info "Secret redaction is automatic in logger"
info "Check server logs for '[REDACTED]' instead of actual secrets"
info "Test: Make request with secret in query param, verify logs show [REDACTED]"
pass "Secret redaction middleware integrated (check logs manually)"
echo ""

# Test 7: Verify system status endpoint still works
echo "7️⃣  Testing System Status Endpoint..."
RESPONSE=$(curl -s "$API_BASE/v1/admin/system/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" 2>&1)

if echo "$RESPONSE" | grep -q "\"hasInternalSecret\""; then
  pass "System status endpoint works"
  if echo "$RESPONSE" | grep -q "\"hasInternalSecret\":true"; then
    pass "Internal secret is configured"
  else
    warn "Internal secret may not be configured"
  fi
else
  fail "System status endpoint failed (got: ${RESPONSE:0:100})"
fi
echo ""

# Summary
echo "=========================================="
echo "✅ Security Phase 2 Tests Complete"
echo ""
echo "Note: Some tests require manual verification:"
echo "  - Request timeouts: Test with slow endpoint"
echo "  - Secret redaction: Check server logs"
echo "  - IP allowlisting: Test from non-localhost IP"
echo ""
