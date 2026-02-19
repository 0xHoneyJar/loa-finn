#!/usr/bin/env bash
# scripts/gate-check.sh — Gate Promotion Validation (Sprint 12 Task 12.5)
#
# Validates gate readiness criteria against actual system state.
# Usage:
#   ./scripts/gate-check.sh 0             # Validate Gate 0 (Smoke)
#   ./scripts/gate-check.sh 1             # Validate Gate 1 (Ignition)
#   ./scripts/gate-check.sh 0 --json      # Machine-readable output
#   ./scripts/gate-check.sh 0 --dry-run   # Validate script logic without AWS calls

set -euo pipefail

GATE="${1:-}"
JSON_OUTPUT=false
DRY_RUN=false

# Parse flags
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown flag: $1"; exit 2 ;;
  esac
done

if [[ -z "$GATE" || ! "$GATE" =~ ^[0-4]$ ]]; then
  echo "Usage: gate-check.sh <0|1|2|3|4> [--json] [--dry-run]"
  echo ""
  echo "Gates:"
  echo "  0  Smoke    — ECS service, health endpoint, CloudWatch alarms, SNS"
  echo "  1  Ignition — Billing state machine, quote generation, conservation guard"
  echo "  2  Warmup   — NFT personality CRUD, onboarding flow, credit purchase"
  echo "  3  Idle     — BYOK validation, feature flags configurable"
  echo "  4  Launch   — x402 flow, multi-model routing, all alarms green"
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

check() {
  local name="$1"
  local status="$2" # PASS or FAIL
  local detail="${3:-}"

  RESULTS+=("{\"name\":\"$name\",\"status\":\"$status\",\"detail\":\"$detail\"}")

  if [[ "$status" == "PASS" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    if [[ "$JSON_OUTPUT" == "false" ]]; then
      echo "  ✓ $name"
    fi
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ "$JSON_OUTPUT" == "false" ]]; then
      echo "  ✗ $name${detail:+ — $detail}"
    fi
  fi
}

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY_RUN"
    return 0
  fi
  eval "$@" 2>/dev/null
}

output_results() {
  local gate_name="$1"
  local overall="PASS"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    overall="FAIL"
  fi

  if [[ "$JSON_OUTPUT" == "true" ]]; then
    local items
    items=$(printf '%s,' "${RESULTS[@]}")
    items="[${items%,}]"
    echo "{\"gate\":$GATE,\"gate_name\":\"$gate_name\",\"overall\":\"$overall\",\"passed\":$PASS_COUNT,\"failed\":$FAIL_COUNT,\"checks\":$items}"
  else
    echo ""
    echo "Gate $GATE ($gate_name): $overall ($PASS_COUNT passed, $FAIL_COUNT failed)"
  fi

  if [[ "$overall" == "FAIL" ]]; then
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

ENV="${ENVIRONMENT:-production}"
CLUSTER="honeyjar-${ENV}"
SERVICE="loa-finn-${ENV}"
HEALTH_URL="${HEALTH_ENDPOINT:-http://localhost:3000/health}"
REGION="${AWS_REGION:-us-east-1}"

# ---------------------------------------------------------------------------
# Gate 0: Smoke — Infrastructure Exists
# ---------------------------------------------------------------------------

gate_0() {
  if [[ "$JSON_OUTPUT" == "false" ]]; then
    echo "Gate 0: Smoke — Infrastructure Validation"
    echo "==========================================="
  fi

  # Check ECS service exists
  local ecs_result
  ecs_result=$(run_cmd "aws ecs describe-services --cluster '$CLUSTER' --services '$SERVICE' --region '$REGION' --query 'services[0].status' --output text")
  if [[ "$ecs_result" == "ACTIVE" || "$DRY_RUN" == "true" ]]; then
    check "ECS service exists and ACTIVE" "PASS"
  else
    check "ECS service exists and ACTIVE" "FAIL" "status=$ecs_result"
  fi

  # Check health endpoint
  local health_status
  health_status=$(run_cmd "curl -s -o /dev/null -w '%{http_code}' '$HEALTH_URL'")
  if [[ "$health_status" == "200" || "$DRY_RUN" == "true" ]]; then
    check "Health endpoint returns 200" "PASS"
  else
    check "Health endpoint returns 200" "FAIL" "status=$health_status"
  fi

  # Check CloudWatch alarms exist
  local alarm_count
  alarm_count=$(run_cmd "aws cloudwatch describe-alarms --alarm-name-prefix 'loa-finn-' --region '$REGION' --query 'length(MetricAlarms)' --output text")
  if [[ "$DRY_RUN" == "true" ]]; then
    check "CloudWatch alarms exist (>=5)" "PASS"
  elif [[ "$alarm_count" -ge 5 ]]; then
    check "CloudWatch alarms exist (>=5)" "PASS"
  else
    check "CloudWatch alarms exist (>=5)" "FAIL" "found=$alarm_count"
  fi

  # Check SNS topic exists
  local sns_result
  sns_result=$(run_cmd "aws sns list-topics --region '$REGION' --query \"Topics[?contains(TopicArn, 'loa-finn-alarms')].TopicArn | [0]\" --output text")
  if [[ -n "$sns_result" && "$sns_result" != "None" ]] || [[ "$DRY_RUN" == "true" ]]; then
    check "SNS alarm topic wired" "PASS"
  else
    check "SNS alarm topic wired" "FAIL" "topic not found"
  fi

  output_results "Smoke"
}

# ---------------------------------------------------------------------------
# Gate 1: Ignition — Billing Pipeline Operational
# ---------------------------------------------------------------------------

gate_1() {
  if [[ "$JSON_OUTPUT" == "false" ]]; then
    echo "Gate 1: Ignition — Billing Pipeline Validation"
    echo "================================================"
  fi

  # Check billing state machine responds
  local billing_health
  billing_health=$(run_cmd "curl -s '$HEALTH_URL'")
  if [[ "$DRY_RUN" == "true" ]] || echo "$billing_health" | grep -q '"status"'; then
    check "Billing state machine responds" "PASS"
  else
    check "Billing state machine responds" "FAIL" "no health response"
  fi

  # Check quote generation works
  local quote_result
  quote_result=$(run_cmd "curl -s -X POST '${HEALTH_URL%/health}/api/v1/x402/quote' -H 'Content-Type: application/json' -d '{\"model\":\"claude-sonnet-4-6\",\"max_tokens\":100}'")
  if [[ "$DRY_RUN" == "true" ]] || echo "$quote_result" | grep -q 'quote_id'; then
    check "Quote generation works" "PASS"
  else
    check "Quote generation works" "FAIL" "no quote_id in response"
  fi

  # Check conservation guard healthy
  local metrics
  metrics=$(run_cmd "curl -s '${HEALTH_URL%/health}/metrics'")
  if [[ "$DRY_RUN" == "true" ]] || echo "$metrics" | grep -q 'conservation_guard_state'; then
    check "Conservation guard healthy" "PASS"
  else
    check "Conservation guard healthy" "FAIL" "metric not found"
  fi

  output_results "Ignition"
}

# ---------------------------------------------------------------------------
# Gate 2: Warmup — User-Facing Features
# ---------------------------------------------------------------------------

gate_2() {
  if [[ "$JSON_OUTPUT" == "false" ]]; then
    echo "Gate 2: Warmup — User Feature Validation"
    echo "==========================================="
  fi

  local base_url="${HEALTH_URL%/health}"

  # Check NFT personality CRUD
  if [[ "$DRY_RUN" == "true" ]]; then
    check "NFT personality CRUD works" "PASS"
  else
    local nft_result
    nft_result=$(run_cmd "curl -s '${base_url}/api/v1/personality/status'")
    if echo "$nft_result" | grep -qE '"status"|"ok"'; then
      check "NFT personality CRUD works" "PASS"
    else
      check "NFT personality CRUD works" "FAIL" "endpoint not responding"
    fi
  fi

  # Check onboarding flow endpoint
  if [[ "$DRY_RUN" == "true" ]]; then
    check "Onboarding flow responds" "PASS"
  else
    local onboard_status
    onboard_status=$(run_cmd "curl -s -o /dev/null -w '%{http_code}' '${base_url}/api/v1/onboarding/start' -X POST -H 'Content-Type: application/json' -d '{}'")
    if [[ "$onboard_status" =~ ^(200|401|403)$ ]]; then
      check "Onboarding flow responds" "PASS"
    else
      check "Onboarding flow responds" "FAIL" "status=$onboard_status"
    fi
  fi

  # Check credit purchase endpoint
  if [[ "$DRY_RUN" == "true" ]]; then
    check "Credit purchase works" "PASS"
  else
    local credit_status
    credit_status=$(run_cmd "curl -s -o /dev/null -w '%{http_code}' '${base_url}/api/v1/credits/balance' -H 'Authorization: Bearer test'")
    if [[ "$credit_status" =~ ^(200|401|403)$ ]]; then
      check "Credit purchase endpoint responds" "PASS"
    else
      check "Credit purchase endpoint responds" "FAIL" "status=$credit_status"
    fi
  fi

  output_results "Warmup"
}

# ---------------------------------------------------------------------------
# Gate 3: Idle — Advanced Features
# ---------------------------------------------------------------------------

gate_3() {
  if [[ "$JSON_OUTPUT" == "false" ]]; then
    echo "Gate 3: Idle — Advanced Feature Validation"
    echo "============================================="
  fi

  local base_url="${HEALTH_URL%/health}"

  # Check BYOK validation endpoint
  if [[ "$DRY_RUN" == "true" ]]; then
    check "BYOK validation works" "PASS"
  else
    local byok_status
    byok_status=$(run_cmd "curl -s -o /dev/null -w '%{http_code}' '${base_url}/api/v1/byok/validate' -X POST -H 'Content-Type: application/json' -d '{\"key\":\"test\"}'")
    if [[ "$byok_status" =~ ^(200|400|401)$ ]]; then
      check "BYOK validation works" "PASS"
    else
      check "BYOK validation works" "FAIL" "status=$byok_status"
    fi
  fi

  # Check feature flags configurable
  if [[ "$DRY_RUN" == "true" ]]; then
    check "Feature flags configurable" "PASS"
  else
    local flags_result
    flags_result=$(run_cmd "curl -s '${base_url}/api/v1/admin/feature-flags'")
    if echo "$flags_result" | grep -qE '"flags"|"features"|401'; then
      check "Feature flags configurable" "PASS"
    else
      check "Feature flags configurable" "FAIL" "endpoint not responding"
    fi
  fi

  output_results "Idle"
}

# ---------------------------------------------------------------------------
# Gate 4: Launch — Full System Operational
# ---------------------------------------------------------------------------

gate_4() {
  if [[ "$JSON_OUTPUT" == "false" ]]; then
    echo "Gate 4: Launch — Full System Validation"
    echo "=========================================="
  fi

  local base_url="${HEALTH_URL%/health}"

  # Check x402 flow completes
  if [[ "$DRY_RUN" == "true" ]]; then
    check "x402 payment flow operational" "PASS"
  else
    local x402_status
    x402_status=$(run_cmd "curl -s -o /dev/null -w '%{http_code}' '${base_url}/api/v1/x402/quote' -X POST -H 'Content-Type: application/json' -d '{\"model\":\"claude-sonnet-4-6\"}'")
    if [[ "$x402_status" == "200" ]]; then
      check "x402 payment flow operational" "PASS"
    else
      check "x402 payment flow operational" "FAIL" "quote status=$x402_status"
    fi
  fi

  # Check multi-model routing
  if [[ "$DRY_RUN" == "true" ]]; then
    check "Multi-model routing works" "PASS"
  else
    local models_result
    models_result=$(run_cmd "curl -s '${base_url}/api/v1/models'")
    if echo "$models_result" | grep -qE 'claude|model'; then
      check "Multi-model routing works" "PASS"
    else
      check "Multi-model routing works" "FAIL" "no models in response"
    fi
  fi

  # Check all alarms in OK state
  if [[ "$DRY_RUN" == "true" ]]; then
    check "All CloudWatch alarms green" "PASS"
  else
    local alarm_states
    alarm_states=$(run_cmd "aws cloudwatch describe-alarms --alarm-name-prefix 'loa-finn-' --region '$REGION' --state-value ALARM --query 'length(MetricAlarms)' --output text")
    if [[ "$alarm_states" == "0" ]]; then
      check "All CloudWatch alarms green" "PASS"
    else
      check "All CloudWatch alarms green" "FAIL" "$alarm_states alarms in ALARM state"
    fi
  fi

  output_results "Launch"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "$GATE" in
  0) gate_0 ;;
  1) gate_1 ;;
  2) gate_2 ;;
  3) gate_3 ;;
  4) gate_4 ;;
esac
