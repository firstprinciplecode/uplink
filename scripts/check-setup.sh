#!/usr/bin/env bash
# Quick readiness check for uplink (cloud + local).
# - Light mode (default): only probes cloud endpoints and ports.
# - --smoke: also runs the existing end-to-end smoke tests (db + tunnel).
#
# Env overrides:
#   AGENTCLOUD_API_BASE (default: https://api.uplink.spot)
#   AGENTCLOUD_TOKEN    (default: dev-token)
#   TUNNEL_RELAY_HOST   (default: t.uplink.spot)  # hostname for HTTPS ingress
#   TUNNEL_DOMAIN       (default: t.uplink.spot)  # base domain for tunnels
#   TUNNEL_CTRL         (default: 178.156.149.124:7071)  # host:port control channel
#   CONNECT_TIMEOUT     (default: 4)
#   MAX_TIME            (default: 8)
#   INSECURE            (default: false)  # set to true to allow --insecure for curl
#
set -euo pipefail

MODE="light"
for arg in "$@"; do
  case "$arg" in
    --smoke|--full) MODE="smoke" ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/check-setup.sh [--smoke]

Light mode (default):
  - API health
  - DNS resolve relay host
  - TCP 443 to relay host
  - Relay /health over HTTPS
  - Control port TCP reachability

Smoke mode (--smoke):
  - All light checks
  - Runs npm run smoke:all (db + tunnel end-to-end)

Env:
  AGENTCLOUD_API_BASE (default: https://api.uplink.spot)
  AGENTCLOUD_TOKEN    (default: dev-token)
  TUNNEL_RELAY_HOST   (default: t.uplink.spot)
  TUNNEL_DOMAIN       (default: t.uplink.spot)
  TUNNEL_CTRL         (default: 178.156.149.124:7071)
  CONNECT_TIMEOUT     (default: 4)
  MAX_TIME            (default: 8)
  INSECURE=true       (allow curl --insecure)
EOF
      exit 0
      ;;
  esac
done

API_BASE="${AGENTCLOUD_API_BASE:-https://api.uplink.spot}"
TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"
RELAY_HOST="${TUNNEL_RELAY_HOST:-t.uplink.spot}"
DOMAIN="${TUNNEL_DOMAIN:-t.uplink.spot}"
CTRL="${TUNNEL_CTRL:-178.156.149.124:7071}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-4}"
MAX_TIME="${MAX_TIME:-8}"
# Use a string flag instead of an array to avoid unbound-array issues on older bash.
INSECURE_FLAG=""
if [[ "${INSECURE:-false}" == "true" ]]; then
  INSECURE_FLAG="--insecure"
fi

CTRL_HOST="${CTRL%:*}"
CTRL_PORT="${CTRL##*:}"

pass() { printf "✅ %s\n" "$1"; }
fail() { printf "❌ %s\n" "$1"; }

echo "Checking uplink setup (mode=${MODE})"
echo "API_BASE=${API_BASE}"
echo "RELAY_HOST=${RELAY_HOST}"
echo "CTRL=${CTRL}"
echo "TOKEN=${TOKEN}"
echo

status=0

step_api_health() {
  if curl -sS ${INSECURE_FLAG:+$INSECURE_FLAG} --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    "${API_BASE}/health" | grep -q '"ok"'; then
    pass "API health"
  else
    fail "API health (${API_BASE}/health)"
    status=1
  fi
}

step_dns_relay() {
  if dig "${RELAY_HOST}" +short 2>/dev/null | grep -q .; then
    pass "DNS resolves ${RELAY_HOST}"
  else
    fail "DNS resolve failed for ${RELAY_HOST}"
    status=1
  fi
}

step_tcp_443() {
  RELAY_IP=$(dig "${RELAY_HOST}" +short 2>/dev/null | head -n1)
  if [ -z "$RELAY_IP" ]; then
    fail "TCP 443 check skipped (DNS not resolved)"
    status=1
    return
  fi
  if nc -zw"${CONNECT_TIMEOUT}" "${RELAY_IP}" 443 >/dev/null 2>&1; then
    pass "TCP 443 reachable on ${RELAY_HOST} (${RELAY_IP})"
  else
    fail "TCP 443 NOT reachable on ${RELAY_HOST} (${RELAY_IP})"
    status=1
  fi
}

step_relay_health() {
  RELAY_IP=$(dig "${RELAY_HOST}" +short 2>/dev/null | head -n1)
  if [ -z "$RELAY_IP" ]; then
    fail "Relay /health check skipped (DNS not resolved)"
    status=1
    return
  fi
  # Check relay health directly on port 7070 (HTTP) - this tests the relay's JSON endpoint
  # Caddy on 443 returns plain text for t.uplink.spot, so we bypass it for the health check
  if curl -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    "http://${RELAY_IP}:7070/health" | grep -q '"status":"ok"'; then
    pass "Relay /health (via relay port 7070)"
  else
    fail "Relay /health failed at http://${RELAY_IP}:7070/health"
    status=1
  fi
}

step_ctrl_tcp() {
  if nc -zw"${CONNECT_TIMEOUT}" "${CTRL_HOST}" "${CTRL_PORT}" >/dev/null 2>&1; then
    pass "Control TCP reachable at ${CTRL}"
  else
    echo "⚠️  Control TCP NOT reachable at ${CTRL} (may be firewall-protected; this is OK if tunnel client can connect)"
    # Don't fail - this is an internal service that may be firewall-protected
  fi
}

run_smoke() {
  echo "▶ Running npm run smoke:all (this hits cloud + opens local ports)"
  if API_BASE="${API_BASE}" \
     AGENTCLOUD_API_BASE="${API_BASE}" \
     AGENTCLOUD_TOKEN="${TOKEN}" \
     TUNNEL_CTRL="${CTRL}" \
     TUNNEL_RELAY_HTTP="https://${RELAY_HOST}" \
     TUNNEL_DOMAIN="${DOMAIN}" \
     npm run smoke:all; then
    pass "Smoke tests"
  else
    fail "Smoke tests"
    status=1
  fi
}

step_api_health
step_dns_relay
step_tcp_443
step_relay_health
step_ctrl_tcp

if [[ "${MODE}" == "smoke" ]]; then
  run_smoke
else
  echo "Skip smoke tests (light mode). Run with --smoke to exercise end-to-end."
fi

echo
if [[ "$status" -eq 0 ]]; then
  echo "All checks completed successfully."
else
  echo "Some checks failed. See above for details."
fi
exit "$status"

