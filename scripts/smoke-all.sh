#!/usr/bin/env bash
# Run all smoke tests
set -euo pipefail

echo "🧪 Running all smoke tests..."
echo ""

echo "1️⃣  Database API smoke test..."
if bash scripts/db-api-smoke.sh; then
  echo "✅ Database API test passed"
else
  echo "❌ Database API test failed"
  exit 1
fi

echo ""
echo "2️⃣  Tunnel smoke test..."
if npm run smoke:tunnel; then
  echo "✅ Tunnel test passed"
else
  echo "❌ Tunnel test failed"
  exit 1
fi

echo ""
echo "✅ All smoke tests passed!"



