#!/usr/bin/env bash
# tests/e2e/smoke-test.sh — E2E Billing Wire Smoke Test (Sprint B T6)
# Runs on the HOST, hits services via mapped ports.
# Verifies: health → inference → billing finalize status via response headers.
#
# Usage: ./tests/e2e/smoke-test.sh
# Exit: 0 = all pass, 1 = failure

set -euo pipefail

# --- Configuration ---
FINN_URL="${FINN_URL:-http://localhost:3001}"
ARRAKIS_URL="${ARRAKIS_URL:-http://localhost:3000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-10}"
TRACE_ID="e2e-$(date +%s)-$$"
RESERVATION_ID="e2e-res-${TRACE_ID}"
HEADER_FILE=$(mktemp)

# --- Counters ---
PASSED=0
FAILED=0
TESTS=()

cleanup() {
  rm -f "$HEADER_FILE"
}
trap cleanup EXIT

# --- Helpers ---

# Escape backslash, quotes, and control characters for safe JSON string embedding
json_escape() {
  awk '
    BEGIN { ORS="" }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\t/, "\\t")
      gsub(/\r/, "\\r")
      if (NR > 1) printf "\\n"
      printf "%s", $0
    }
  '
}

pass() {
  local name="$1"
  PASSED=$((PASSED + 1))
  local escaped_name
  escaped_name=$(printf '%s' "$name" | json_escape)
  TESTS+=("{\"name\":\"$escaped_name\",\"status\":\"pass\"}")
  echo "  PASS: $name"
}

fail() {
  local name="$1"
  local detail="${2:-}"
  FAILED=$((FAILED + 1))
  local escaped_name escaped_detail
  escaped_name=$(printf '%s' "$name" | json_escape)
  escaped_detail=$(printf '%s' "$detail" | json_escape)
  TESTS+=("{\"name\":\"$escaped_name\",\"status\":\"fail\",\"detail\":\"$escaped_detail\"}")
  echo "  FAIL: $name${detail:+ — $detail}"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected='$expected' actual='$actual'"
  fi
}

assert_one_of() {
  local actual="$1"
  shift
  local name="${!#}"  # last argument is the test name
  local values=("${@:1:$#-1}")
  for v in "${values[@]}"; do
    if [[ "$actual" == "$v" ]]; then
      pass "$name"
      return
    fi
  done
  fail "$name" "actual='$actual' not in [${values[*]}]"
}

# --- Step 1: Health Check Polling ---
echo "[Step 1] Waiting for services to be healthy..."

poll_health() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [[ $SECONDS -lt $deadline ]]; do
    if curl -sf --max-time 3 "$url" > /dev/null 2>&1; then
      pass "$label health"
      return 0
    fi
    sleep 2
  done
  fail "$label health" "timeout after ${HEALTH_TIMEOUT}s"
  return 1
}

poll_health "$ARRAKIS_URL/v1/health" "arrakis" || true
poll_health "$FINN_URL/health" "loa-finn" || true

# Bail early if services aren't up
if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "[ABORT] Services not healthy — skipping inference test"
  echo ""
  # Output JSON report
  TESTS_JSON=$(printf '%s,' "${TESTS[@]}")
  TESTS_JSON="[${TESTS_JSON%,}]"
  echo "{\"trace_id\":\"$TRACE_ID\",\"tests\":$TESTS_JSON,\"passed\":$PASSED,\"failed\":$FAILED}"
  exit 1
fi

# --- Step 2: Send Inference Request ---
echo ""
echo "[Step 2] Sending inference request (trace_id=$TRACE_ID)..."

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -D "$HEADER_FILE" \
  --max-time "$REQUEST_TIMEOUT" \
  -X POST "$FINN_URL/api/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-trace-id: $TRACE_ID" \
  -H "x-reservation-id: $RESERVATION_ID" \
  -d '{"model":"mock","messages":[{"role":"user","content":"e2e smoke test"}]}')

assert_eq "$HTTP_CODE" "200" "inference HTTP status"

# --- Step 3: Verify Billing Finalize Status ---
echo ""
echo "[Step 3] Verifying billing finalize response headers..."

# Extract headers (case-insensitive grep, strip CR)
FINALIZE_STATUS=$(grep -i "^x-billing-finalize-status:" "$HEADER_FILE" | sed 's/^[^:]*: *//' | tr -d '\r\n' || echo "")
BILLING_TRACE=$(grep -i "^x-billing-trace-id:" "$HEADER_FILE" | sed 's/^[^:]*: *//' | tr -d '\r\n' || echo "")

if [[ -z "$FINALIZE_STATUS" ]]; then
  fail "billing finalize status header present" "header missing — finalize may not have run"
else
  # finalized or idempotent = success; dlq = arrakis rejected
  assert_one_of "$FINALIZE_STATUS" "finalized" "idempotent" "billing finalize status"
fi

# --- Step 4: Trace ID Correlation ---
echo ""
echo "[Step 4] Verifying trace ID correlation..."

if [[ -z "$BILLING_TRACE" ]]; then
  fail "billing trace ID header present" "header missing"
else
  assert_eq "$BILLING_TRACE" "$TRACE_ID" "trace ID correlation"
fi

# --- Step 5: Optional arrakis log check (non-blocking) ---
echo ""
echo "[Step 5] Checking arrakis logs (informational)..."

COMPOSE_FILE="$(dirname "$0")/docker-compose.e2e.yml"
if docker compose -f "$COMPOSE_FILE" logs arrakis-e2e 2>&1 | grep -q "$TRACE_ID"; then
  echo "  INFO: arrakis logged trace_id=$TRACE_ID"
else
  echo "  WARN: arrakis log check inconclusive (non-blocking)"
fi

# --- Report ---
echo ""
echo "========================================"
echo "  E2E Smoke Test Results"
echo "  trace_id: $TRACE_ID"
echo "  passed: $PASSED  failed: $FAILED"
echo "========================================"

# JSON report for CI parsing
TESTS_JSON=$(printf '%s,' "${TESTS[@]}")
TESTS_JSON="[${TESTS_JSON%,}]"
echo ""
echo "{\"trace_id\":\"$TRACE_ID\",\"tests\":$TESTS_JSON,\"passed\":$PASSED,\"failed\":$FAILED}"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
exit 0
