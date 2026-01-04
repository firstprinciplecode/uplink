#!/usr/bin/env bash
# Tunnel smoke test: creates a tunnel, starts a local server, verifies ingress.
# Configurable via env vars:
#   AGENTCLOUD_API_BASE=https://api.uplink.spot  (or API_BASE=...)
#   AGENTCLOUD_TOKEN=dev-token                (or AUTH_TOKEN=...)
#   TUNNEL_CTRL=tunnel.uplink.spot:7071
#   TUNNEL_RELAY_HTTP=https://x.uplink.spot   # HTTPS ingress via Caddy
#   TUNNEL_DOMAIN=x.uplink.spot
#   PORT=39333
set -euo pipefail

API_BASE="${AGENTCLOUD_API_BASE:-${API_BASE:-https://api.uplink.spot}}"
AUTH_TOKEN="${AGENTCLOUD_TOKEN:-${AUTH_TOKEN:-dev-token}}"
# Default to Hetzner control/relay
CTRL="${TUNNEL_CTRL:-178.156.149.124:7071}"
RELAY="${TUNNEL_RELAY_HTTP:-https://x.uplink.spot}"
DOMAIN="${TUNNEL_DOMAIN:-x.uplink.spot}"
PORT="${PORT:-39333}"

# Curl defaults to avoid hangs
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
MAX_TIME="${MAX_TIME:-12}"
RETRIES="${RETRIES:-2}"

echo "API_BASE=${API_BASE}"
echo "CTRL=${CTRL}"
echo "RELAY=${RELAY}"
echo "DOMAIN=${DOMAIN}"
echo "PORT=${PORT}"
echo "CONNECT_TIMEOUT=${CONNECT_TIMEOUT}"
echo "MAX_TIME=${MAX_TIME}"
echo "RETRIES=${RETRIES}"

TMP_PARENT="${TMP_PARENT:-$(pwd)/.tmp}"
mkdir -p "${TMP_PARENT}"
TMP_DIR="$(mktemp -d "${TMP_PARENT}/tunnel-smoke.XXXXXX")"
echo "LOG_DIR=${TMP_DIR}"
SERVER_LOG="${TMP_DIR}/server.log"
CLIENT_LOG="${TMP_DIR}/client.log"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "${SERVER_PID}" 2>/dev/null || true
  [[ -n "${CLIENT_PID:-}" ]] && kill "${CLIENT_PID}" 2>/dev/null || true
  rm -rf "${TMP_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

curl_s() {
  curl -sS --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" --retry "${RETRIES}" "$@"
}

echo "▶ Checking control plane health ..."
if ! curl_s "${API_BASE}/health" | grep -q '"ok"'; then
  echo "❌ Control plane health check failed at ${API_BASE}/health"
  exit 1
fi

echo "▶ Starting local test server on ${PORT} ..."
# Check if port is available, if not, try a random port
if lsof -Pi :${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "⚠️  Port ${PORT} is in use, trying random port..."
  PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('', 0)); print(s.getsockname()[1]); s.close()")
  echo "Using port ${PORT} instead"
fi
python3 -m http.server "${PORT}" >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
sleep 1

echo "▶ Requesting tunnel ..."
CREATE_RES=$(curl_s "${API_BASE}/v1/tunnels" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"port\":${PORT}}") || true

echo "Response: ${CREATE_RES}"

TOKEN=$(node -e "const d=JSON.parse(process.argv[1]||'{}'); console.log(d.token||'');" "${CREATE_RES}")
TUNNEL_URL=$(node -e "const d=JSON.parse(process.argv[1]||'{}'); console.log(d.url||'');" "${CREATE_RES}")

if [[ -z "${TOKEN}" ]]; then
  echo "❌ Failed to get tunnel token"
  echo "Response body:"
  echo "${CREATE_RES}" | head -50
  exit 1
fi

echo "Tunnel URL: ${TUNNEL_URL}"

echo "▶ Starting tunnel client with token ${TOKEN} ..."
node scripts/tunnel/client.js --token "${TOKEN}" --port "${PORT}" --ctrl "${CTRL}" >"${CLIENT_LOG}" 2>&1 &
CLIENT_PID=$!

echo "▶ Waiting for client to register ..."
registered=0
for _ in $(seq 1 30); do
  if ! kill -0 "${CLIENT_PID}" 2>/dev/null; then
    echo "❌ Tunnel client exited early"
    echo "Client logs:"
    cat "${CLIENT_LOG}" 2>/dev/null || true
    exit 1
  fi
  if grep -q "registered with relay" "${CLIENT_LOG}" 2>/dev/null; then
    registered=1
    break
  fi
  sleep 0.25
done
if [[ "${registered}" != "1" ]]; then
  echo "❌ Tunnel client did not register in time"
  echo "Client logs:"
  tail -200 "${CLIENT_LOG}" 2>/dev/null || true
  exit 1
fi

echo "▶ Verifying ingress via relay at ${TUNNEL_URL} ..."
# Use the URL returned by the API (includes correct domain)
HTTP_RES=$(curl_s "${TUNNEL_URL}/") || true

if echo "${HTTP_RES}" | grep -qi "Directory listing\|<!DOCTYPE HTML\|<html"; then
  echo "✅ Tunnel smoke test passed (received HTML response from local server)"
  exit 0
else
  echo "❌ Tunnel smoke test failed. Response:"
  echo "${HTTP_RES}" | head -20
  echo ""
  echo "Client logs:"
  tail -200 "${CLIENT_LOG}" 2>/dev/null || echo "No client logs"
  echo ""
  echo "Server logs:"
  tail -200 "${SERVER_LOG}" 2>/dev/null || echo "No server logs"
  exit 1
fi

