#!/usr/bin/env bash
# scripts/seed-e2e-fixtures.sh — Seed E2E test fixtures (Sprint 3)
#
# Seeds the test wallet with credits via the admin API.
# Designed for CI — exits non-zero on any failure.
#
# Environment:
#   FINN_AUTH_TOKEN  — Required. Bearer token for admin auth.
#   E2E_BASE_URL    — Optional. Default: http://localhost:3000
#
# Usage:
#   export FINN_AUTH_TOKEN=dev-token-change-me
#   ./scripts/seed-e2e-fixtures.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"  # strip trailing slash

TEST_WALLET="0x00000000000000000000000000000000deadbeef"
TEST_CREDITS=1000

if [ -z "${FINN_AUTH_TOKEN:-}" ]; then
  echo "FATAL: FINN_AUTH_TOKEN environment variable is required" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Seed credits
# ---------------------------------------------------------------------------

echo "Seeding E2E fixtures at ${BASE_URL}..."
echo ""

echo -n "  POST /api/v1/admin/seed-credits (wallet=${TEST_WALLET}, credits=${TEST_CREDITS})... "

HTTP_CODE=$(curl -s -o /tmp/seed-response.json -w "%{http_code}" \
  -X POST "${BASE_URL}/api/v1/admin/seed-credits" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${FINN_AUTH_TOKEN}" \
  -d "{\"wallet_address\":\"${TEST_WALLET}\",\"credits\":${TEST_CREDITS}}")

if [ "${HTTP_CODE}" -eq 200 ]; then
  SEEDED=$(cat /tmp/seed-response.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('seeded',''))" 2>/dev/null || echo "")
  if [ "${SEEDED}" = "True" ] || [ "${SEEDED}" = "true" ]; then
    echo "OK (seeded=${SEEDED})"
  else
    echo "OK (HTTP 200)"
  fi
else
  echo "FAIL (HTTP ${HTTP_CODE})"
  echo "  Response:" >&2
  cat /tmp/seed-response.json >&2
  echo "" >&2
  rm -f /tmp/seed-response.json
  exit 1
fi

rm -f /tmp/seed-response.json

echo ""
echo "E2E fixture seeding complete."
exit 0
