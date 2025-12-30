#!/usr/bin/env bash
set -euo pipefail

# Ensure we run from repo root
cd "$(dirname "$0")/.."

echo "Test: tunnel list without token should exit 10"
if npx tsx cli/src/index.ts tunnel list --json >/tmp/uplink-tunnel-list.out 2>/tmp/uplink-tunnel-list.err; then
  echo "Expected failure due to missing token, but command succeeded"
  exit 1
fi
code=$?
if [[ $code -ne 10 ]]; then
  echo "Expected exit code 10, got $code"
  echo "stderr:"
  cat /tmp/uplink-tunnel-list.err
  exit 1
fi

echo "OK: missing-token behavior verified"
