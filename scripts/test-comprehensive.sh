#!/usr/bin/env bash
# Comprehensive test suite for Uplink API
# Tests authentication, authorization, signup, tokens, tunnels, and databases
set -euo pipefail

# Configuration
API_BASE="${AGENTCLOUD_API_BASE:-https://api.uplink.spot}"
ADMIN_TOKEN="${AGENTCLOUD_TOKEN:-}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
MAX_TIME="${MAX_TIME:-15}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Temp files
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

log_pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}❌ FAIL${NC}: $1"; ((FAILED++)); }
log_skip() { echo -e "${YELLOW}⏭️  SKIP${NC}: $1"; ((SKIPPED++)); }
log_info() { echo -e "${BLUE}ℹ️  INFO${NC}: $1"; }
log_section() { echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"; }

# HTTP request helper
# Usage: api METHOD PATH [BODY] [TOKEN]
# Returns: Sets $HTTP_STATUS and $HTTP_BODY
api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token="${4:-}"
  
  local curl_args=(-sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME")
  curl_args+=(-X "$method")
  curl_args+=(-H "Content-Type: application/json")
  
  if [[ -n "$token" ]]; then
    curl_args+=(-H "Authorization: Bearer $token")
  fi
  
  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi
  
  HTTP_BODY=$(curl "${curl_args[@]}" -o "$TMP_DIR/body.json" -w "%{http_code}" "$API_BASE$path" 2>/dev/null || echo "000")
  HTTP_STATUS="$HTTP_BODY"
  HTTP_BODY=$(cat "$TMP_DIR/body.json" 2>/dev/null || echo "")
}

# Check if admin token is set
check_admin_token() {
  if [[ -z "$ADMIN_TOKEN" ]]; then
    echo -e "${RED}ERROR: AGENTCLOUD_TOKEN not set. Please set an admin token.${NC}"
    exit 1
  fi
}

# ============================================================================
# SECTION 1: Health Checks
# ============================================================================
test_health() {
  log_section "1. HEALTH CHECKS"
  
  # Test /health endpoint (no auth required)
  api GET "/health" "" ""
  if [[ "$HTTP_STATUS" == "200" ]] && echo "$HTTP_BODY" | grep -q '"ok"'; then
    log_pass "GET /health returns 200 with status ok"
  else
    log_fail "GET /health - expected 200 with ok, got $HTTP_STATUS"
  fi
  
  # Test /health/live endpoint
  api GET "/health/live" "" ""
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /health/live returns 200"
  else
    log_fail "GET /health/live - expected 200, got $HTTP_STATUS"
  fi
  
  # Test /health/ready endpoint
  api GET "/health/ready" "" ""
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /health/ready returns 200"
  else
    log_fail "GET /health/ready - expected 200, got $HTTP_STATUS"
  fi
}

# ============================================================================
# SECTION 2: Authentication Tests
# ============================================================================
test_authentication() {
  log_section "2. AUTHENTICATION"
  
  # Test missing token
  api GET "/v1/me" "" ""
  if [[ "$HTTP_STATUS" == "401" ]]; then
    log_pass "Missing token returns 401"
  else
    log_fail "Missing token - expected 401, got $HTTP_STATUS"
  fi
  
  # Test invalid token
  api GET "/v1/me" "" "invalid-token-12345"
  if [[ "$HTTP_STATUS" == "401" ]]; then
    log_pass "Invalid token returns 401"
  else
    log_fail "Invalid token - expected 401, got $HTTP_STATUS"
  fi
  
  # Test valid admin token
  api GET "/v1/me" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    local role=$(echo "$HTTP_BODY" | grep -o '"role":"[^"]*"' | cut -d'"' -f4)
    if [[ "$role" == "admin" ]]; then
      log_pass "Valid admin token returns 200 with role=admin"
    else
      log_fail "Admin token returned role=$role instead of admin"
    fi
  else
    log_fail "Valid token - expected 200, got $HTTP_STATUS"
  fi
}

# ============================================================================
# SECTION 3: Signup Flow (Public Endpoint)
# ============================================================================
test_signup() {
  log_section "3. SIGNUP FLOW"
  
  # Test signup without auth (should work)
  api POST "/v1/signup" '{"label":"test-signup-'$(date +%s)'"}' ""
  if [[ "$HTTP_STATUS" == "201" ]]; then
    USER_TOKEN=$(echo "$HTTP_BODY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    USER_TOKEN_ID=$(echo "$HTTP_BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    USER_ROLE=$(echo "$HTTP_BODY" | grep -o '"role":"[^"]*"' | cut -d'"' -f4)
    
    if [[ -n "$USER_TOKEN" ]]; then
      log_pass "POST /v1/signup creates token (status 201)"
      
      # Verify role is user (not admin)
      if [[ "$USER_ROLE" == "user" ]]; then
        log_pass "Signup creates user role (not admin)"
      else
        log_fail "Signup created role=$USER_ROLE instead of user"
      fi
      
      # Test the new token works
      api GET "/v1/me" "" "$USER_TOKEN"
      if [[ "$HTTP_STATUS" == "200" ]]; then
        log_pass "New user token is valid"
      else
        log_fail "New user token doesn't work - status $HTTP_STATUS"
      fi
    else
      log_fail "Signup didn't return a token"
    fi
  elif [[ "$HTTP_STATUS" == "429" ]]; then
    log_skip "Signup rate limited (429) - try again later"
    USER_TOKEN=""
    USER_TOKEN_ID=""
  else
    log_fail "POST /v1/signup - expected 201, got $HTTP_STATUS: $HTTP_BODY"
    USER_TOKEN=""
    USER_TOKEN_ID=""
  fi
}

# ============================================================================
# SECTION 4: Authorization (Role-Based Access)
# ============================================================================
test_authorization() {
  log_section "4. AUTHORIZATION (Role-Based Access)"
  
  # Skip if no user token from signup
  if [[ -z "${USER_TOKEN:-}" ]]; then
    log_skip "User token not available - skipping authorization tests"
    return
  fi
  
  # Test user can't access admin endpoints
  api GET "/v1/admin/stats" "" "$USER_TOKEN"
  if [[ "$HTTP_STATUS" == "403" ]]; then
    log_pass "User token blocked from /v1/admin/stats (403)"
  else
    log_fail "User accessed admin endpoint - expected 403, got $HTTP_STATUS"
  fi
  
  api GET "/v1/admin/tokens" "" "$USER_TOKEN"
  if [[ "$HTTP_STATUS" == "403" ]]; then
    log_pass "User token blocked from /v1/admin/tokens (403)"
  else
    log_fail "User accessed admin tokens - expected 403, got $HTTP_STATUS"
  fi
  
  api GET "/v1/admin/tunnels" "" "$USER_TOKEN"
  if [[ "$HTTP_STATUS" == "403" ]]; then
    log_pass "User token blocked from /v1/admin/tunnels (403)"
  else
    log_fail "User accessed admin tunnels - expected 403, got $HTTP_STATUS"
  fi
  
  # Test admin CAN access admin endpoints
  api GET "/v1/admin/stats" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "Admin token can access /v1/admin/stats"
  else
    log_fail "Admin blocked from admin endpoint - status $HTTP_STATUS"
  fi
}

# ============================================================================
# SECTION 5: Token Management (Admin Only)
# ============================================================================
test_token_management() {
  log_section "5. TOKEN MANAGEMENT (Admin)"
  
  # List tokens
  api GET "/v1/admin/tokens" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    local count=$(echo "$HTTP_BODY" | grep -o '"count":[0-9]*' | cut -d':' -f2)
    log_pass "GET /v1/admin/tokens returns 200 (count: ${count:-0})"
  else
    log_fail "GET /v1/admin/tokens - expected 200, got $HTTP_STATUS"
  fi
  
  # Create a test token
  api POST "/v1/admin/tokens" '{"role":"user","label":"test-token-'$(date +%s)'"}' "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "201" ]]; then
    CREATED_TOKEN_ID=$(echo "$HTTP_BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    log_pass "POST /v1/admin/tokens creates token (status 201)"
    
    # Revoke the test token
    if [[ -n "$CREATED_TOKEN_ID" ]]; then
      api DELETE "/v1/admin/tokens/$CREATED_TOKEN_ID" "" "$ADMIN_TOKEN"
      if [[ "$HTTP_STATUS" == "200" ]]; then
        log_pass "DELETE /v1/admin/tokens/:id revokes token"
      else
        log_fail "Token revocation - expected 200, got $HTTP_STATUS"
      fi
    fi
  else
    log_fail "POST /v1/admin/tokens - expected 201, got $HTTP_STATUS: $HTTP_BODY"
  fi
}

# ============================================================================
# SECTION 6: Tunnel API
# ============================================================================
test_tunnels() {
  log_section "6. TUNNEL API"
  
  # List tunnels (user)
  api GET "/v1/tunnels" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /v1/tunnels returns 200"
  else
    log_fail "GET /v1/tunnels - expected 200, got $HTTP_STATUS"
  fi
  
  # Create tunnel
  api POST "/v1/tunnels" '{"port":3000}' "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "201" ]]; then
    TUNNEL_ID=$(echo "$HTTP_BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    TUNNEL_TOKEN=$(echo "$HTTP_BODY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    log_pass "POST /v1/tunnels creates tunnel (status 201)"
    
    # Delete the test tunnel
    if [[ -n "$TUNNEL_ID" ]]; then
      api DELETE "/v1/tunnels/$TUNNEL_ID" "" "$ADMIN_TOKEN"
      if [[ "$HTTP_STATUS" == "200" ]]; then
        log_pass "DELETE /v1/tunnels/:id deletes tunnel"
      else
        log_fail "Tunnel deletion - expected 200, got $HTTP_STATUS"
      fi
    fi
  else
    log_fail "POST /v1/tunnels - expected 201, got $HTTP_STATUS: $HTTP_BODY"
  fi
  
  # Test missing port validation
  api POST "/v1/tunnels" '{}' "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "400" ]]; then
    log_pass "POST /v1/tunnels without port returns 400"
  else
    log_fail "Missing port validation - expected 400, got $HTTP_STATUS"
  fi
  
  # Test invalid port validation
  api POST "/v1/tunnels" '{"port":"not-a-number"}' "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "400" ]]; then
    log_pass "POST /v1/tunnels with invalid port returns 400"
  else
    log_fail "Invalid port validation - expected 400, got $HTTP_STATUS"
  fi
}

# ============================================================================
# SECTION 7: Database API
# ============================================================================
test_databases() {
  log_section "7. DATABASE API"
  
  # List databases
  api GET "/v1/dbs" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /v1/dbs returns 200"
  else
    log_fail "GET /v1/dbs - expected 200, got $HTTP_STATUS"
  fi
  
  # Note: We don't test database creation as it provisions real resources
  log_info "Skipping database creation test (provisions real resources)"
}

# ============================================================================
# SECTION 8: Admin Stats
# ============================================================================
test_admin_stats() {
  log_section "8. ADMIN STATS"
  
  api GET "/v1/admin/stats" "" "$ADMIN_TOKEN"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /v1/admin/stats returns 200"
    
    # Check structure
    if echo "$HTTP_BODY" | grep -q '"tunnels"'; then
      log_pass "Stats include tunnels data"
    else
      log_fail "Stats missing tunnels data"
    fi
    
    if echo "$HTTP_BODY" | grep -q '"databases"'; then
      log_pass "Stats include databases data"
    else
      log_fail "Stats missing databases data"
    fi
  else
    log_fail "GET /v1/admin/stats - expected 200, got $HTTP_STATUS"
  fi
}

# ============================================================================
# SECTION 9: Cleanup
# ============================================================================
cleanup_test_data() {
  log_section "9. CLEANUP"
  
  # Clean up user token created during signup test
  if [[ -n "${USER_TOKEN_ID:-}" ]]; then
    api DELETE "/v1/admin/tokens/$USER_TOKEN_ID" "" "$ADMIN_TOKEN"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      log_pass "Cleaned up test user token"
    else
      log_info "Could not clean up test token (may already be deleted)"
    fi
  else
    log_info "No test user token to clean up"
  fi
}

# ============================================================================
# MAIN
# ============================================================================
main() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════╗"
  echo "║       UPLINK COMPREHENSIVE TEST SUITE                     ║"
  echo "╚═══════════════════════════════════════════════════════════╝"
  echo ""
  echo "API Base: $API_BASE"
  echo ""
  
  check_admin_token
  
  test_health
  test_authentication
  test_signup
  test_authorization
  test_token_management
  test_tunnels
  test_databases
  test_admin_stats
  cleanup_test_data
  
  # Summary
  log_section "TEST SUMMARY"
  echo ""
  echo -e "  ${GREEN}Passed${NC}:  $PASSED"
  echo -e "  ${RED}Failed${NC}:  $FAILED"
  echo -e "  ${YELLOW}Skipped${NC}: $SKIPPED"
  echo ""
  
  TOTAL=$((PASSED + FAILED))
  if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✅ ALL TESTS PASSED ($PASSED/$TOTAL)${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    exit 0
  else
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ❌ SOME TESTS FAILED ($FAILED/$TOTAL failed)${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    exit 1
  fi
}

main "$@"



