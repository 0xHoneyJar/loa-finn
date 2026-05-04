#!/usr/bin/env bash
# scripts/staging-readiness-gate.sh — Staging Readiness Gate (cycle-036 T-3.8)
#
# Aggregates all staging readiness checks into a single pass/fail gate.
# Checks: health, shadow counter, killswitch, auth, isolation, CI workflows, beads.
#
# Usage:
#   STAGING_URL=https://finn-armitage.arrakis.community ./scripts/staging-readiness-gate.sh
#   # With auth token for deeper checks:
#   STAGING_URL=... AUTH_TOKEN="Bearer eyJ..." ./scripts/staging-readiness-gate.sh

set -euo pipefail

STAGING_URL="${STAGING_URL:-https://finn-armitage.arrakis.community}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
ENVIRONMENT="${ENVIRONMENT:-armitage}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
WARN_COUNT=0
GATE_RESULTS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  GATE_RESULTS+=("PASS: $1")
  echo "  [PASS] $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  GATE_RESULTS+=("FAIL: $1")
  echo "  [FAIL] $1"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  GATE_RESULTS+=("SKIP: $1")
  echo "  [SKIP] $1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  GATE_RESULTS+=("WARN: $1")
  echo "  [WARN] $1"
}

header() {
  echo ""
  echo "--- $1 ---"
}

# ===========================================================================
# Gate 1: Health Check
# ===========================================================================

header "Gate 1: Service Health"

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${STAGING_URL}/health" 2>/dev/null || echo "000")
if [ "$HEALTH_STATUS" = "200" ]; then
  HEALTH_BODY=$(curl -sf "${STAGING_URL}/health" 2>/dev/null || echo "{}")
  pass "Health endpoint returns 200"

  # Extract service version if available
  VERSION=$(echo "$HEALTH_BODY" | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown")
  if [ "$VERSION" != "unknown" ] && [ "$VERSION" != "null" ]; then
    pass "Service version: $VERSION"
  else
    skip "Version not exposed in health endpoint"
  fi
elif [ "$HEALTH_STATUS" = "000" ]; then
  fail "Cannot reach staging at ${STAGING_URL}"
else
  fail "Health endpoint returns $HEALTH_STATUS"
fi

# ===========================================================================
# Gate 2: Shadow Mode Counter
# ===========================================================================

header "Gate 2: Shadow Mode Active"

METRICS=$(curl -sf "${STAGING_URL}/metrics" 2>/dev/null || echo "")
if [ -n "$METRICS" ]; then
  # Check shadow total counter exists
  SHADOW_TOTAL=$(echo "$METRICS" | grep -oP 'finn_shadow_total\s+\K[0-9.]+' || echo "0")
  if [ "$SHADOW_TOTAL" != "0" ]; then
    pass "Shadow counter active: $SHADOW_TOTAL requests processed"
  else
    # Zero is OK if just deployed — shadow hasn't received traffic yet
    warn "Shadow counter is 0 (may need traffic to verify)"
  fi

  # Check routing mode gauge
  ROUTING_MODE=$(echo "$METRICS" | grep 'finn_goodhart_routing_mode' || echo "")
  if [ -n "$ROUTING_MODE" ]; then
    pass "Routing mode gauge present in metrics"
  else
    skip "Routing mode gauge not found in metrics"
  fi
else
  fail "Cannot fetch metrics from ${STAGING_URL}/metrics"
fi

# ===========================================================================
# Gate 3: KillSwitch Toggle
# ===========================================================================

header "Gate 3: KillSwitch State"

if [ -n "$METRICS" ]; then
  KILLSWITCH=$(echo "$METRICS" | grep 'finn_killswitch_state' || echo "")
  if [ -n "$KILLSWITCH" ]; then
    # Check that killswitch is in "normal" state
    KS_NORMAL=$(echo "$KILLSWITCH" | grep 'state="normal"' | grep -oP '\s+\K[0-9.]+' || echo "0")
    if [ "$KS_NORMAL" = "1" ]; then
      pass "KillSwitch state is 'normal'"
    else
      warn "KillSwitch may not be in 'normal' state"
    fi
  else
    skip "KillSwitch metrics not found (may not be initialized)"
  fi
fi

# Also check via health endpoint
if [ -n "${HEALTH_BODY:-}" ]; then
  KS_STATE=$(echo "$HEALTH_BODY" | jq -r '.killSwitchState // "unknown"' 2>/dev/null || echo "unknown")
  if [ "$KS_STATE" = "normal" ]; then
    pass "KillSwitch health check: normal"
  elif [ "$KS_STATE" = "unknown" ]; then
    skip "KillSwitch state not in health response"
  else
    fail "KillSwitch state is '$KS_STATE' (expected 'normal')"
  fi
fi

# ===========================================================================
# Gate 4: Auth Enforcement
# ===========================================================================

header "Gate 4: Auth Enforcement"

# Unauthenticated access to protected endpoint must be rejected
UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" "${STAGING_URL}/v1/score" 2>/dev/null || echo "000")
if [ "$UNAUTH" = "401" ] || [ "$UNAUTH" = "403" ]; then
  pass "Auth enforcement active (unauthenticated → $UNAUTH)"
elif [ "$UNAUTH" = "000" ]; then
  fail "Cannot reach /v1/score endpoint"
else
  fail "Unauthenticated /v1/score returns $UNAUTH (expected 401/403)"
fi

# JWKS endpoint accessible
JWKS=$(curl -sf "${STAGING_URL}/.well-known/jwks.json" 2>/dev/null || echo "{}")
JWKS_KEYS=$(echo "$JWKS" | jq '.keys | length' 2>/dev/null || echo "0")
if [ "$JWKS_KEYS" -gt 0 ]; then
  pass "JWKS endpoint: $JWKS_KEYS key(s) available"
else
  fail "JWKS endpoint returns no keys"
fi

# ===========================================================================
# Gate 5: Zero Stale References
# ===========================================================================

header "Gate 5: Zero Stale References"

# Check for hardcoded production URLs in staging config
STALE_REFS=0

# Check for production hostnames in staging-related files
PROD_IN_STAGING=$(grep -r "loa-finn\.honeyjar\.xyz" "${REPO_ROOT}/.github/workflows/deploy-staging.yml" 2>/dev/null | wc -l || echo "0")
if [ "$PROD_IN_STAGING" -eq 0 ]; then
  pass "No production hostname in deploy-staging.yml"
else
  fail "Found $PROD_IN_STAGING production hostname references in deploy-staging.yml"
  STALE_REFS=$((STALE_REFS + PROD_IN_STAGING))
fi

# Check for hardcoded "production" in staging tfvars
PROD_IN_TFVARS=$(grep -c "production" "${REPO_ROOT}/infrastructure/terraform/environments/armitage.tfvars" 2>/dev/null || echo "0")
if [ "$PROD_IN_TFVARS" -eq 0 ]; then
  pass "No 'production' references in armitage.tfvars"
else
  fail "Found $PROD_IN_TFVARS 'production' references in armitage.tfvars"
fi

# Check for Fly.io/Railway references that should have been removed
FLYIO_REFS=$(grep -rl "fly\.io\|flyctl\|railway" "${REPO_ROOT}/infrastructure/" "${REPO_ROOT}/.github/workflows/" 2>/dev/null | wc -l || echo "0")
if [ "$FLYIO_REFS" -eq 0 ]; then
  pass "No Fly.io/Railway references in infrastructure/ or workflows/"
else
  warn "Found $FLYIO_REFS files with Fly.io/Railway references"
fi

# ===========================================================================
# Gate 6: CI Workflows
# ===========================================================================

header "Gate 6: CI Workflows"

# Verify staging deploy workflow exists
if [ -f "${REPO_ROOT}/.github/workflows/deploy-staging.yml" ]; then
  pass "deploy-staging.yml exists"
else
  fail "deploy-staging.yml not found"
fi

# Verify production deploy workflow exists
if [ -f "${REPO_ROOT}/.github/workflows/deploy.yml" ]; then
  pass "deploy.yml (production) exists"
else
  fail "deploy.yml (production) not found"
fi

# Verify CI workflow exists
if [ -f "${REPO_ROOT}/.github/workflows/ci.yml" ]; then
  pass "ci.yml exists"
else
  fail "ci.yml not found"
fi

# ===========================================================================
# Gate 7: Terraform State
# ===========================================================================

header "Gate 7: Terraform Configuration"

TF_DIR="${REPO_ROOT}/infrastructure/terraform"

# Variables file exists
if [ -f "${TF_DIR}/variables.tf" ]; then
  pass "variables.tf exists"
else
  fail "variables.tf not found"
fi

# Staging tfvars exists
if [ -f "${TF_DIR}/environments/armitage.tfvars" ]; then
  pass "environments/armitage.tfvars exists"
else
  fail "environments/armitage.tfvars not found"
fi

# Staging runbook exists
if [ -f "${TF_DIR}/STAGING-RUNBOOK.md" ]; then
  pass "STAGING-RUNBOOK.md exists"
else
  fail "STAGING-RUNBOOK.md not found"
fi

# Check that all TF files reference local.service_name (not hardcoded)
HARDCODED_SERVICE=$(grep -l '"loa-finn-\${var\.environment}"' "${TF_DIR}"/*.tf 2>/dev/null | wc -l || echo "0")
if [ "$HARDCODED_SERVICE" -eq 0 ]; then
  pass "No hardcoded service name patterns (using local.service_name)"
else
  warn "Found $HARDCODED_SERVICE TF files with old naming pattern"
fi

# ===========================================================================
# Gate 8: Beads Status
# ===========================================================================

header "Gate 8: Beads Task Tracking"

if command -v br &>/dev/null; then
  # Check for open sprint-3 tasks
  OPEN_TASKS=$(br list --status open 2>/dev/null | grep -c "T-3\." || echo "0")
  CLOSED_TASKS=$(br list --status closed 2>/dev/null | grep -c "T-3\." || echo "0")

  if [ "$OPEN_TASKS" -eq 0 ] && [ "$CLOSED_TASKS" -gt 0 ]; then
    pass "All Sprint 3 tasks closed ($CLOSED_TASKS tasks)"
  elif [ "$OPEN_TASKS" -gt 0 ]; then
    fail "$OPEN_TASKS Sprint 3 task(s) still open"
  else
    skip "No Sprint 3 tasks found in beads"
  fi
else
  skip "br (beads_rust) CLI not available"
fi

# ===========================================================================
# Summary
# ===========================================================================

echo ""
echo "==========================================="
echo "  STAGING READINESS GATE — SUMMARY"
echo "==========================================="
echo "  Environment: ${ENVIRONMENT}"
echo "  URL:         ${STAGING_URL}"
echo "  PASS: ${PASS_COUNT}"
echo "  FAIL: ${FAIL_COUNT}"
echo "  WARN: ${WARN_COUNT}"
echo "  SKIP: ${SKIP_COUNT}"
echo "==========================================="
echo ""

for RESULT in "${GATE_RESULTS[@]}"; do
  echo "  $RESULT"
done

echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "GATE VERDICT: BLOCKED — $FAIL_COUNT check(s) failed"
  echo ""
  echo "Fix all FAIL items before proceeding with staging deployment."
  exit 1
elif [ "$WARN_COUNT" -gt 0 ]; then
  echo "GATE VERDICT: CONDITIONAL PASS — $WARN_COUNT warning(s)"
  echo ""
  echo "Review WARN items. Proceed with caution."
  exit 0
else
  echo "GATE VERDICT: PASSED — staging is ready for deployment"
  exit 0
fi
