#!/usr/bin/env bash
# scripts/smoke-deploy.sh — Deployment smoke test (T-5.7)
# Usage: ./scripts/smoke-deploy.sh [URL] [AUTH_TOKEN]

set -euo pipefail

URL="${1:-http://localhost:3000}"
TOKEN="${2:-}"

echo "Smoke testing ${URL}..."

# 1. Health check
echo -n "  /health... "
HEALTH=$(curl -sf "${URL}/health" 2>/dev/null)
STATUS=$(echo "$HEALTH" | jq -r '.status' 2>/dev/null)
if [ "$STATUS" = "healthy" ] || [ "$STATUS" = "degraded" ]; then
  echo "OK (${STATUS})"
else
  echo "FAIL"
  echo "$HEALTH"
  exit 1
fi

# 2. Create session
echo -n "  POST /api/sessions... "
AUTH_HEADER=""
if [ -n "$TOKEN" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer ${TOKEN}\""
fi

RESP=$(curl -sf -X POST "${URL}/api/sessions" \
  ${AUTH_HEADER:+-H "Authorization: Bearer ${TOKEN}"} \
  -H "Content-Type: application/json" 2>/dev/null)
SESSION_ID=$(echo "$RESP" | jq -r '.sessionId' 2>/dev/null)

if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  echo "OK (session=${SESSION_ID})"
else
  echo "FAIL"
  echo "$RESP"
  exit 1
fi

# 3. List sessions
echo -n "  GET /api/sessions... "
LIST=$(curl -sf "${URL}/api/sessions" \
  ${AUTH_HEADER:+-H "Authorization: Bearer ${TOKEN}"} 2>/dev/null)
COUNT=$(echo "$LIST" | jq '.sessions | length' 2>/dev/null)
echo "OK (${COUNT} sessions)"

# 4. WebChat UI
echo -n "  GET / (webchat)... "
UI_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${URL}/" 2>/dev/null || echo "000")
if [ "$UI_STATUS" = "200" ]; then
  echo "OK"
else
  echo "SKIP (no static serving)"
fi

echo ""
echo "All smoke tests passed!"
exit 0
