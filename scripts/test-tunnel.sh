#!/bin/bash
# Test tunnel URL

set -e

if [ -z "$1" ]; then
    echo "Usage: ./scripts/test-tunnel.sh <token>"
    echo "Example: ./scripts/test-tunnel.sh 518775b4fd89"
    exit 1
fi

TOKEN=$1
URL="http://${TOKEN}.dev.uplink.spot"

echo "🧪 Testing tunnel URL: $URL"
echo ""

echo "1. Testing HTTP connection..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL" || echo "000")
echo "   HTTP Status: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ HTTP works!"
    echo ""
    echo "2. Fetching content..."
    curl -s "$URL" | head -20
    echo ""
    echo "✅ Tunnel is working!"
else
    echo "   ❌ HTTP failed (status: $HTTP_CODE)"
    echo ""
    echo "3. Testing HTTPS..."
    HTTPS_URL="https://${TOKEN}.dev.uplink.spot"
    curl -k -s -o /dev/null -w "   HTTPS Status: %{http_code}\n" "$HTTPS_URL" || echo "   ❌ HTTPS failed"
    echo ""
    echo "⚠️  Tunnel may not be working. Check:"
    echo "   - Is tunnel client running?"
    echo "   - Is marketmaker app running on port 3000?"
    echo "   - Is relay running on server?"
fi





