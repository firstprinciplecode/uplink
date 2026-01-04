#!/usr/bin/env bash
# Demo script to test the tunnel end-to-end
# This will:
# 1. Start a demo server locally
# 2. Create a tunnel via the API
# 3. Connect the tunnel client
# 4. Test the tunnel URL
# 5. Clean up

set -euo pipefail

API_BASE="${AGENTCLOUD_API_BASE:-https://api.uplink.spot}"
TOKEN="${AGENTCLOUD_TOKEN:-dev-token}"
CTRL="${TUNNEL_CTRL:-178.156.149.124:7071}"
DOMAIN="${TUNNEL_DOMAIN:-x.uplink.spot}"

# Find an available port
find_free_port() {
  local port=${DEMO_PORT:-3000}
  while lsof -ti:$port > /dev/null 2>&1; do
    port=$((port + 1))
  done
  echo $port
}

LOCAL_PORT=$(find_free_port)

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Uplink Tunnel Demo${NC}"
echo "================================"
echo "API: $API_BASE"
echo "Control: $CTRL"
echo "Domain: $DOMAIN"
echo "Local Port: $LOCAL_PORT"
echo ""

# Step 1: Start demo server
echo -e "${YELLOW}Step 1: Starting demo server on port $LOCAL_PORT...${NC}"
node demo-server.js "$LOCAL_PORT" > /tmp/demo-server.log 2>&1 &
SERVER_PID=$!
sleep 2

# Verify server is running
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "❌ Failed to start demo server"
  exit 1
fi
echo -e "${GREEN}✅ Demo server running (PID: $SERVER_PID)${NC}"
echo ""

# Step 2: Create tunnel via API
echo -e "${YELLOW}Step 2: Creating tunnel via API...${NC}"
TUNNEL_RESPONSE=$(curl -sS -X POST "$API_BASE/v1/tunnels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"port\": $LOCAL_PORT}")

TUNNEL_TOKEN=$(echo "$TUNNEL_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
TUNNEL_URL=$(echo "$TUNNEL_RESPONSE" | grep -o '"url":"[^"]*' | cut -d'"' -f4)

if [ -z "$TUNNEL_TOKEN" ] || [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to create tunnel"
  echo "Response: $TUNNEL_RESPONSE"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

echo -e "${GREEN}✅ Tunnel created${NC}"
echo "   Token: $TUNNEL_TOKEN"
echo "   URL: $TUNNEL_URL"
echo ""

# Step 3: Start tunnel client
echo -e "${YELLOW}Step 3: Starting tunnel client...${NC}"
node scripts/tunnel/client-improved.js \
  --token "$TUNNEL_TOKEN" \
  --port "$LOCAL_PORT" \
  --ctrl "$CTRL" \
  > /tmp/demo-client.log 2>&1 &
CLIENT_PID=$!

# Wait for client to register
echo "   Waiting for client to register..."
for i in {1..10}; do
  sleep 1
  if curl -sS --max-time 2 "$TUNNEL_URL" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Tunnel client connected and registered${NC}"
    break
  fi
  if [ $i -eq 10 ]; then
    echo "❌ Tunnel client failed to register within 10 seconds"
    kill $SERVER_PID $CLIENT_PID 2>/dev/null || true
    exit 1
  fi
done
echo ""

# Step 4: Test the tunnel
echo -e "${YELLOW}Step 4: Testing tunnel URL...${NC}"
echo "   Testing: $TUNNEL_URL"

RESPONSE=$(curl -sS --max-time 5 "$TUNNEL_URL")
if echo "$RESPONSE" | grep -q "Uplink Tunnel Demo"; then
  echo -e "${GREEN}✅ Tunnel is working!${NC}"
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}🎉 SUCCESS!${NC}"
  echo ""
  echo "Your tunnel is live at:"
  echo -e "  ${BLUE}$TUNNEL_URL${NC}"
  echo ""
  echo "Open it in your browser to see the demo!"
  echo ""
  echo "Press Ctrl+C to stop the demo (server + client)"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo "❌ Tunnel test failed"
  echo "Response preview: ${RESPONSE:0:200}"
  kill $SERVER_PID $CLIENT_PID 2>/dev/null || true
  exit 1
fi

# Cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}Cleaning up...${NC}"
  kill $SERVER_PID $CLIENT_PID 2>/dev/null || true
  echo -e "${GREEN}✅ Demo stopped${NC}"
}

trap cleanup EXIT INT TERM

# Keep running until interrupted
wait

