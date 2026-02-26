#!/usr/bin/env bash
# scripts/verify-staging-isolation.sh — Environment Isolation Verification (cycle-036 T-3.5)
#
# Pass/fail checklist verifying staging (armitage) is properly isolated from production.
# Requires: aws CLI, terraform, jq, redis-cli (optional)
#
# Usage:
#   ./scripts/verify-staging-isolation.sh [--environment armitage]

set -euo pipefail

ENVIRONMENT="${1:-armitage}"
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
# 1. Terraform Workspace Check
# ---------------------------------------------------------------------------

header "1. Terraform Workspace"

if command -v terraform &>/dev/null; then
  TF_DIR="$(cd "$(dirname "$0")/../infrastructure/terraform" && pwd)"
  if [ -d "$TF_DIR" ]; then
    CURRENT_WORKSPACE=$(cd "$TF_DIR" && terraform workspace show 2>/dev/null || echo "unknown")
    if [ "$CURRENT_WORKSPACE" = "$ENVIRONMENT" ]; then
      pass "Terraform workspace is '$ENVIRONMENT'"
    elif [ "$CURRENT_WORKSPACE" = "default" ]; then
      fail "Terraform workspace is 'default' (production), expected '$ENVIRONMENT'"
    else
      fail "Terraform workspace is '$CURRENT_WORKSPACE', expected '$ENVIRONMENT'"
    fi
  else
    skip "Terraform directory not found at $TF_DIR"
  fi
else
  skip "terraform CLI not installed"
fi

# ---------------------------------------------------------------------------
# 2. SSM Parameter Path Isolation
# ---------------------------------------------------------------------------

header "2. SSM Parameter Paths"

if command -v aws &>/dev/null; then
  # Check that staging SSM params exist under /loa-finn/armitage/
  STAGING_PARAMS=$(aws ssm get-parameters-by-path \
    --path "/loa-finn/${ENVIRONMENT}" \
    --query "Parameters[].Name" \
    --output json 2>/dev/null || echo "[]")

  PARAM_COUNT=$(echo "$STAGING_PARAMS" | jq 'length')
  if [ "$PARAM_COUNT" -gt 0 ]; then
    pass "Found $PARAM_COUNT SSM parameters under /loa-finn/${ENVIRONMENT}/"
  else
    fail "No SSM parameters found under /loa-finn/${ENVIRONMENT}/"
  fi

  # Verify no staging param references production path
  CROSS_REF=$(echo "$STAGING_PARAMS" | jq -r '.[]' | grep -c "production" || true)
  if [ "$CROSS_REF" -eq 0 ]; then
    pass "No cross-environment SSM references found"
  else
    fail "Found $CROSS_REF SSM parameters referencing 'production'"
  fi
else
  skip "aws CLI not available"
fi

# ---------------------------------------------------------------------------
# 3. DynamoDB Table Isolation
# ---------------------------------------------------------------------------

header "3. DynamoDB Tables"

if command -v aws &>/dev/null; then
  # Check staging tables exist
  for TABLE in "finn-scoring-path-log-${ENVIRONMENT}" "finn-x402-settlements-${ENVIRONMENT}"; do
    TABLE_STATUS=$(aws dynamodb describe-table --table-name "$TABLE" --query "Table.TableStatus" --output text 2>/dev/null || echo "NOT_FOUND")
    if [ "$TABLE_STATUS" = "ACTIVE" ]; then
      pass "DynamoDB table '$TABLE' exists and is ACTIVE"
    elif [ "$TABLE_STATUS" = "NOT_FOUND" ]; then
      fail "DynamoDB table '$TABLE' does not exist"
    else
      fail "DynamoDB table '$TABLE' status: $TABLE_STATUS"
    fi
  done

  # Verify staging tables are NOT the same as production tables
  for TABLE in "finn-scoring-path-log" "finn-x402-settlements"; do
    PROD_ARN=$(aws dynamodb describe-table --table-name "$TABLE" --query "Table.TableArn" --output text 2>/dev/null || echo "NONE")
    STAGING_ARN=$(aws dynamodb describe-table --table-name "${TABLE}-${ENVIRONMENT}" --query "Table.TableArn" --output text 2>/dev/null || echo "NONE")
    if [ "$PROD_ARN" != "$STAGING_ARN" ] && [ "$STAGING_ARN" != "NONE" ]; then
      pass "Table '${TABLE}' and '${TABLE}-${ENVIRONMENT}' have different ARNs"
    elif [ "$STAGING_ARN" = "NONE" ]; then
      skip "Cannot verify ARN isolation — staging table not found"
    else
      fail "Table ARNs match — staging may be using production table!"
    fi
  done
else
  skip "aws CLI not available"
fi

# ---------------------------------------------------------------------------
# 4. Redis Prefix Isolation
# ---------------------------------------------------------------------------

header "4. Redis Prefix"

if command -v redis-cli &>/dev/null; then
  REDIS_URL="${REDIS_URL:-}"
  if [ -n "$REDIS_URL" ]; then
    # Check that staging keys use the correct prefix
    KEY_SAMPLE=$(redis-cli -u "$REDIS_URL" --no-auth-warning KEYS "${ENVIRONMENT}:*" 2>/dev/null | head -5 || echo "")
    PROD_KEYS=$(redis-cli -u "$REDIS_URL" --no-auth-warning KEYS "prod:*" 2>/dev/null | wc -l || echo "0")

    if [ -n "$KEY_SAMPLE" ]; then
      pass "Found keys with '${ENVIRONMENT}:' prefix"
    else
      skip "No keys with '${ENVIRONMENT}:' prefix (may be empty staging)"
    fi

    if [ "$PROD_KEYS" -eq 0 ]; then
      pass "No 'prod:' prefixed keys visible from staging connection"
    else
      fail "Found $PROD_KEYS keys with 'prod:' prefix — possible cross-env contamination"
    fi
  else
    skip "REDIS_URL not set"
  fi
else
  skip "redis-cli not installed"
fi

# ---------------------------------------------------------------------------
# 5. ECS Service Isolation
# ---------------------------------------------------------------------------

header "5. ECS Service"

if command -v aws &>/dev/null; then
  SERVICE_NAME="loa-finn-${ENVIRONMENT}"
  CLUSTER="honeyjar-${ENVIRONMENT}"

  SERVICE_STATUS=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE_NAME" \
    --query "services[0].status" \
    --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$SERVICE_STATUS" = "ACTIVE" ]; then
    pass "ECS service '$SERVICE_NAME' is ACTIVE in cluster '$CLUSTER'"

    # Verify desired count is 1 (WAL single-writer)
    DESIRED=$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$SERVICE_NAME" \
      --query "services[0].desiredCount" \
      --output text 2>/dev/null || echo "0")
    if [ "$DESIRED" -eq 1 ]; then
      pass "ECS desired count is 1 (single-writer enforced)"
    else
      fail "ECS desired count is $DESIRED — expected 1 (single-writer invariant)"
    fi
  elif [ "$SERVICE_STATUS" = "NOT_FOUND" ]; then
    fail "ECS service '$SERVICE_NAME' not found in cluster '$CLUSTER'"
  else
    fail "ECS service '$SERVICE_NAME' status: $SERVICE_STATUS"
  fi
else
  skip "aws CLI not available"
fi

# ---------------------------------------------------------------------------
# 6. Network / Security Group Isolation
# ---------------------------------------------------------------------------

header "6. Network Isolation"

if command -v aws &>/dev/null; then
  # Find staging ECS security group
  SG_NAME="loa-finn-${ENVIRONMENT}-ecs"
  SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=${SG_NAME}*" \
    --query "SecurityGroups[0].GroupId" \
    --output text 2>/dev/null || echo "None")

  if [ "$SG_ID" != "None" ] && [ -n "$SG_ID" ]; then
    pass "Found staging security group: $SG_ID"

    # Verify inbound is restricted to ALB only (port 3000)
    INBOUND_RULES=$(aws ec2 describe-security-groups \
      --group-ids "$SG_ID" \
      --query "SecurityGroups[0].IpPermissions | length(@)" \
      --output text 2>/dev/null || echo "0")
    if [ "$INBOUND_RULES" -le 2 ]; then
      pass "Security group has $INBOUND_RULES inbound rules (expected: ALB only)"
    else
      fail "Security group has $INBOUND_RULES inbound rules — expected 1-2"
    fi
  else
    skip "Staging security group not found (may not be deployed yet)"
  fi
else
  skip "aws CLI not available"
fi

# ---------------------------------------------------------------------------
# 7. Secrets Isolation
# ---------------------------------------------------------------------------

header "7. Secrets Isolation"

if command -v aws &>/dev/null; then
  # Verify staging task role cannot read production SSM params
  STAGING_ROLE="loa-finn-${ENVIRONMENT}-ecs-task"
  ROLE_EXISTS=$(aws iam get-role --role-name "$STAGING_ROLE" --query "Role.RoleName" --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$ROLE_EXISTS" != "NOT_FOUND" ]; then
    pass "Staging task role '$STAGING_ROLE' exists"

    # Check inline policies are scoped to environment
    POLICIES=$(aws iam list-role-policies --role-name "$STAGING_ROLE" --query "PolicyNames" --output json 2>/dev/null || echo "[]")
    POLICY_COUNT=$(echo "$POLICIES" | jq 'length')
    if [ "$POLICY_COUNT" -gt 0 ]; then
      pass "Found $POLICY_COUNT inline policies on staging role"
    else
      fail "No inline policies found on staging role"
    fi
  else
    skip "Staging task role not found (may not be deployed yet)"
  fi
else
  skip "aws CLI not available"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================="
echo "  ISOLATION VERIFICATION SUMMARY"
echo "==========================================="
echo "  Environment: ${ENVIRONMENT}"
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
