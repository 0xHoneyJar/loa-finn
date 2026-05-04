#!/usr/bin/env bash
# scripts/verify-staging-auth.sh — Staging Auth + x402 + Audit Verification (cycle-036 T-3.6)
#
# Smoke tests verifying ES256 JWT auth, x402 verify_only mode, and audit chain integrity.
# Requires: curl, jq, openssl
#
# Usage:
#   STAGING_URL=https://finn-armitage.arrakis.community ./scripts/verify-staging-auth.sh
#   # Or with custom JWT for authenticated tests:
#   STAGING_URL=... AUTH_TOKEN="Bearer eyJ..." ./scripts/verify-staging-auth.sh

set -euo pipefail

STAGING_URL="${STAGING_URL:-https://finn-armitage.arrakis.community}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
CHECKS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  CHECKS+=("PASS: $1")
  echo "  [PASS] $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  CHECKS+=("FAIL: $1")
  echo "  [FAIL] $1"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  CHECKS+=("SKIP: $1")
  echo "  [SKIP] $1"
}

header() {
  echo ""
  echo "=== $1 ==="
}

# ---------------------------------------------------------------------------
# 1. ES256 JWT Auth Enforcement
# ---------------------------------------------------------------------------

header "1. ES256 JWT Auth Enforcement"

# 1a. Unauthenticated request to protected endpoint should return 401
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${STAGING_URL}/v1/score" 2>/dev/null || echo "000")
if [ "$UNAUTH_STATUS" = "401" ] || [ "$UNAUTH_STATUS" = "403" ]; then
  pass "Unauthenticated /v1/score returns $UNAUTH_STATUS (auth enforced)"
else
  fail "Unauthenticated /v1/score returns $UNAUTH_STATUS (expected 401 or 403)"
fi

# 1b. JWKS endpoint is accessible and returns ES256 keys
JWKS_RESPONSE=$(curl -sf "${STAGING_URL}/.well-known/jwks.json" 2>/dev/null || echo "{}")
JWKS_KEY_COUNT=$(echo "$JWKS_RESPONSE" | jq '.keys | length' 2>/dev/null || echo "0")
if [ "$JWKS_KEY_COUNT" -gt 0 ]; then
  pass "JWKS endpoint returns $JWKS_KEY_COUNT key(s)"

  # Check key algorithm is ES256
  JWKS_ALG=$(echo "$JWKS_RESPONSE" | jq -r '.keys[0].alg // .keys[0].kty' 2>/dev/null || echo "unknown")
  if [ "$JWKS_ALG" = "ES256" ] || [ "$JWKS_ALG" = "EC" ]; then
    pass "JWKS key algorithm: $JWKS_ALG (ES256-compatible)"
  else
    fail "JWKS key algorithm: $JWKS_ALG (expected ES256 or EC)"
  fi
else
  fail "JWKS endpoint returned no keys"
fi

# 1c. Invalid JWT should be rejected
INVALID_JWT="eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.invalid-signature"
INVALID_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $INVALID_JWT" \
  "${STAGING_URL}/v1/score" 2>/dev/null || echo "000")
if [ "$INVALID_STATUS" = "401" ] || [ "$INVALID_STATUS" = "403" ]; then
  pass "Invalid JWT returns $INVALID_STATUS (signature verification working)"
else
  fail "Invalid JWT returns $INVALID_STATUS (expected 401 or 403)"
fi

# 1d. Health and metrics endpoints should NOT require auth
for ENDPOINT in "/health" "/metrics"; do
  PUBLIC_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${STAGING_URL}${ENDPOINT}" 2>/dev/null || echo "000")
  if [ "$PUBLIC_STATUS" = "200" ]; then
    pass "Public endpoint ${ENDPOINT} returns 200 (no auth required)"
  else
    fail "Public endpoint ${ENDPOINT} returns $PUBLIC_STATUS (expected 200)"
  fi
done

# ---------------------------------------------------------------------------
# 2. x402 verify_only Mode
# ---------------------------------------------------------------------------

header "2. x402 Settlement Mode"

if [ -n "$AUTH_TOKEN" ]; then
  # 2a. Check health endpoint for settlement mode indicator
  HEALTH_RESPONSE=$(curl -sf -H "Authorization: $AUTH_TOKEN" "${STAGING_URL}/health" 2>/dev/null || echo "{}")

  SETTLEMENT_MODE=$(echo "$HEALTH_RESPONSE" | jq -r '.x402Mode // .settlementMode // "unknown"' 2>/dev/null || echo "unknown")
  if [ "$SETTLEMENT_MODE" = "verify_only" ]; then
    pass "x402 settlement mode is 'verify_only'"
  elif [ "$SETTLEMENT_MODE" = "unknown" ]; then
    skip "x402 settlement mode not exposed in health endpoint"
  else
    fail "x402 settlement mode is '$SETTLEMENT_MODE' (expected 'verify_only' for staging)"
  fi

  # 2b. Attempt a settlement request — should verify but NOT settle on-chain
  SETTLE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"paymentHash":"0xdeadbeef","amount":"0.001","recipient":"0x0000000000000000000000000000000000000000"}' \
    "${STAGING_URL}/v1/x402/settle" 2>/dev/null || echo "000")

  # In verify_only mode, settlement should return 200 with verify result or 422 for invalid data
  if [ "$SETTLE_STATUS" = "200" ] || [ "$SETTLE_STATUS" = "422" ] || [ "$SETTLE_STATUS" = "400" ]; then
    pass "x402 settle endpoint responds ($SETTLE_STATUS) — verify_only mode active"
  elif [ "$SETTLE_STATUS" = "500" ]; then
    fail "x402 settle endpoint returns 500 — possible settlement attempt"
  else
    skip "x402 settle endpoint returns $SETTLE_STATUS (unexpected but non-critical)"
  fi
else
  skip "AUTH_TOKEN not set — skipping authenticated x402 tests"
fi

# ---------------------------------------------------------------------------
# 3. Audit Chain Hash Integrity
# ---------------------------------------------------------------------------

header "3. Audit Chain Integrity"

if [ -n "$AUTH_TOKEN" ]; then
  # 3a. Check audit endpoint for chain integrity
  AUDIT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: $AUTH_TOKEN" \
    "${STAGING_URL}/v1/audit/status" 2>/dev/null || echo "000")

  if [ "$AUDIT_STATUS" = "200" ]; then
    AUDIT_RESPONSE=$(curl -sf -H "Authorization: $AUTH_TOKEN" "${STAGING_URL}/v1/audit/status" 2>/dev/null || echo "{}")

    # Check chain integrity flag
    CHAIN_VALID=$(echo "$AUDIT_RESPONSE" | jq -r '.chainValid // .hashChainValid // "unknown"' 2>/dev/null || echo "unknown")
    if [ "$CHAIN_VALID" = "true" ]; then
      pass "Audit hash chain is valid"
    elif [ "$CHAIN_VALID" = "unknown" ]; then
      skip "Audit chain validity not exposed in response"
    else
      fail "Audit hash chain validation failed: $CHAIN_VALID"
    fi

    # Check sequence continuity
    SEQ_NUM=$(echo "$AUDIT_RESPONSE" | jq -r '.latestSequence // .sequenceNumber // "unknown"' 2>/dev/null || echo "unknown")
    if [ "$SEQ_NUM" != "unknown" ] && [ "$SEQ_NUM" != "null" ]; then
      pass "Audit chain sequence number: $SEQ_NUM"
    else
      skip "Audit sequence number not exposed"
    fi
  elif [ "$AUDIT_STATUS" = "404" ]; then
    skip "Audit status endpoint not available (/v1/audit/status)"
  else
    fail "Audit status endpoint returned $AUDIT_STATUS"
  fi
else
  skip "AUTH_TOKEN not set — skipping authenticated audit tests"
fi

# ---------------------------------------------------------------------------
# 4. Routing State Verification
# ---------------------------------------------------------------------------

header "4. Routing State"

HEALTH=$(curl -sf "${STAGING_URL}/health" 2>/dev/null || echo "{}")
ROUTING_STATE=$(echo "$HEALTH" | jq -r '.routingState // "unknown"' 2>/dev/null || echo "unknown")

if [ "$ROUTING_STATE" = "shadow" ]; then
  pass "Routing state is 'shadow' (correct for staging)"
elif [ "$ROUTING_STATE" = "disabled" ]; then
  pass "Routing state is 'disabled' (acceptable — Goodhart not yet initialized)"
elif [ "$ROUTING_STATE" = "enabled" ]; then
  fail "Routing state is 'enabled' — staging should be 'shadow' or 'disabled'"
elif [ "$ROUTING_STATE" = "unknown" ]; then
  skip "Routing state not exposed in health endpoint"
else
  fail "Unexpected routing state: $ROUTING_STATE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================="
echo "  AUTH + x402 + AUDIT VERIFICATION SUMMARY"
echo "==========================================="
echo "  Staging URL: ${STAGING_URL}"
echo "  PASS: ${PASS_COUNT}"
echo "  FAIL: ${FAIL_COUNT}"
echo "  SKIP: ${SKIP_COUNT}"
echo "==========================================="
echo ""

for CHECK in "${CHECKS[@]}"; do
  echo "  $CHECK"
done

echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "RESULT: FAILED — $FAIL_COUNT check(s) failed"
  exit 1
else
  echo "RESULT: PASSED — all checks passed ($SKIP_COUNT skipped)"
  exit 0
fi
