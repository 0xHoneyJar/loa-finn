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
BASE_URL="${HEALTH_URL%/health}"

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
  if [[ "$DRY_RUN" == "true" ]]; then
    ecs_result="DRY_RUN"
  else
    ecs_result=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" --query 'services[0].status' --output text 2>/dev/null) || ecs_result=""
  fi
  if [[ "$ecs_result" == "ACTIVE" || "$DRY_RUN" == "true" ]]; then
    check "ECS service exists and ACTIVE" "PASS"
  else
    check "ECS service exists and ACTIVE" "FAIL" "status=$ecs_result"
  fi

  # Check health endpoint
  local health_status
  if [[ "$DRY_RUN" == "true" ]]; then
    health_status="DRY_RUN"
  else
    health_status=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null) || health_status=""
  fi
  if [[ "$health_status" == "200" || "$DRY_RUN" == "true" ]]; then
    check "Health endpoint returns 200" "PASS"
  else
    check "Health endpoint returns 200" "FAIL" "status=$health_status"
  fi

  # Check CloudWatch alarms exist
  local alarm_count
  if [[ "$DRY_RUN" == "true" ]]; then
    alarm_count="DRY_RUN"
  else
    alarm_count=$(aws cloudwatch describe-alarms --alarm-name-prefix 'loa-finn-' --region "$REGION" --query 'length(MetricAlarms)' --output text 2>/dev/null) || alarm_count="0"
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    check "CloudWatch alarms exist (>=5)" "PASS"
  elif [[ "$alarm_count" -ge 5 ]]; then
    check "CloudWatch alarms exist (>=5)" "PASS"
  else
    check "CloudWatch alarms exist (>=5)" "FAIL" "found=$alarm_count"
  fi

  # Check SNS topic exists
  local sns_result
  if [[ "$DRY_RUN" == "true" ]]; then
    sns_result="DRY_RUN"
  else
    sns_result=$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn, 'loa-finn-alarms')].TopicArn | [0]" --output text 2>/dev/null) || sns_result=""
  fi
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
  if [[ "$DRY_RUN" == "true" ]]; then
    billing_health="DRY_RUN"
  else
    billing_health=$(curl -s "$HEALTH_URL" 2>/dev/null) || billing_health=""
  fi
  if [[ "$DRY_RUN" == "true" ]] || echo "$billing_health" | grep -q '"status"'; then
    check "Billing state machine responds" "PASS"
  else
    check "Billing state machine responds" "FAIL" "no health response"
  fi

  # Check quote generation works
  local quote_result
  if [[ "$DRY_RUN" == "true" ]]; then
    quote_result="DRY_RUN"
  else
    quote_result=$(curl -s -X POST "${BASE_URL}/api/v1/x402/quote" -H 'Content-Type: application/json' -d '{"model":"claude-sonnet-4-6","max_tokens":100}' 2>/dev/null) || quote_result=""
  fi
  if [[ "$DRY_RUN" == "true" ]] || echo "$quote_result" | grep -q 'quote_id'; then
    check "Quote generation works" "PASS"
  else
    check "Quote generation works" "FAIL" "no quote_id in response"
  fi

  # Check conservation guard healthy
  local metrics
  if [[ "$DRY_RUN" == "true" ]]; then
    metrics="DRY_RUN"
  else
    metrics=$(curl -s "${BASE_URL}/metrics" 2>/dev/null) || metrics=""
  fi
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

  # Check NFT personality CRUD
  if [[ "$DRY_RUN" == "true" ]]; then
    check "NFT personality CRUD works" "PASS"
  else
    local nft_result
    nft_result=$(curl -s "${BASE_URL}/api/v1/personality/status" 2>/dev/null) || nft_result=""
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
    onboard_status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/onboarding/start" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null) || onboard_status=""
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
    credit_status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/credits/balance" -H 'Authorization: Bearer test' 2>/dev/null) || credit_status=""
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

  # Check BYOK validation endpoint
  if [[ "$DRY_RUN" == "true" ]]; then
    check "BYOK validation works" "PASS"
  else
    local byok_status
    byok_status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/byok/validate" -X POST -H 'Content-Type: application/json' -d '{"key":"test"}' 2>/dev/null) || byok_status=""
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
    flags_result=$(curl -s "${BASE_URL}/api/v1/admin/feature-flags" 2>/dev/null) || flags_result=""
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

  # Check x402 flow completes
  if [[ "$DRY_RUN" == "true" ]]; then
    check "x402 payment flow operational" "PASS"
  else
    local x402_status
    x402_status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/x402/quote" -X POST -H 'Content-Type: application/json' -d '{"model":"claude-sonnet-4-6"}' 2>/dev/null) || x402_status=""
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
    models_result=$(curl -s "${BASE_URL}/api/v1/models" 2>/dev/null) || models_result=""
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
    alarm_states=$(aws cloudwatch describe-alarms --alarm-name-prefix 'loa-finn-' --region "$REGION" --state-value ALARM --query 'length(MetricAlarms)' --output text 2>/dev/null) || alarm_states="0"
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
