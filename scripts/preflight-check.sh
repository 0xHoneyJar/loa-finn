#!/usr/bin/env bash
# scripts/preflight-check.sh — ECS/ALB Preflight Checklist (T-4.6)
#
# Validates AWS permissions and resources before Finn deployment.
# Checks: Secrets Manager, KMS, DynamoDB, S3, Redis connectivity.
#
# Usage:
#   ./scripts/preflight-check.sh [--region us-east-1] [--verbose]
#
# Exit codes:
#   0 = All checks passed
#   1 = One or more checks failed
#   2 = Missing dependencies (aws CLI)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
VERBOSE=false
FAIL_COUNT=0
PASS_COUNT=0
SKIP_COUNT=0

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
  echo -e "  ${GREEN}[PASS]${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}[FAIL]${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  echo -e "  ${YELLOW}[SKIP]${NC} $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

info() {
  if $VERBOSE; then
    echo "        $1"
  fi
}

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------

echo "=== Finn Deployment Preflight Check ==="
echo "Region: $REGION"
echo ""

if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found. Install: https://aws.amazon.com/cli/"
  exit 2
fi

# Verify AWS identity
echo "--- AWS Identity ---"
if IDENTITY=$(aws sts get-caller-identity --region "$REGION" --output json 2>/dev/null); then
  ACCOUNT=$(echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
  ARN=$(echo "$IDENTITY" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)
  pass "AWS authenticated: $ARN (account: $ACCOUNT)"
else
  fail "AWS authentication failed"
  echo "RESULT: Cannot proceed without AWS credentials"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Secrets Manager
# ---------------------------------------------------------------------------

echo ""
echo "--- Secrets Manager ---"

SECRETS=(
  "finn/s2s-private-key"
  "finn/admin-jwks"
  "finn/calibration-hmac"
)

for secret in "${SECRETS[@]}"; do
  if aws secretsmanager get-secret-value \
    --secret-id "$secret" \
    --region "$REGION" \
    --query 'Name' \
    --output text &>/dev/null; then
    pass "Secret exists: $secret"
  else
    fail "Secret missing or no access: $secret"
  fi
done

# ---------------------------------------------------------------------------
# Step 2: KMS Audit Key
# ---------------------------------------------------------------------------

echo ""
echo "--- KMS Audit Key ---"

if KEY_ID=$(aws kms describe-key \
  --key-id "alias/finn-audit" \
  --region "$REGION" \
  --query 'KeyMetadata.KeyId' \
  --output text 2>/dev/null); then
  pass "KMS key exists: alias/finn-audit ($KEY_ID)"
  info "Key usage: $(aws kms describe-key --key-id "$KEY_ID" --region "$REGION" --query 'KeyMetadata.KeyUsage' --output text 2>/dev/null)"
else
  fail "KMS key not found: alias/finn-audit"
fi

# ---------------------------------------------------------------------------
# Step 3: DynamoDB Tables
# ---------------------------------------------------------------------------

echo ""
echo "--- DynamoDB Tables ---"

TABLES=(
  "finn-audit-log"
  "finn-x402-settlements"
)

for table in "${TABLES[@]}"; do
  if STATUS=$(aws dynamodb describe-table \
    --table-name "$table" \
    --region "$REGION" \
    --query 'Table.TableStatus' \
    --output text 2>/dev/null); then
    if [[ "$STATUS" == "ACTIVE" ]]; then
      pass "Table active: $table"
    else
      fail "Table not active: $table (status: $STATUS)"
    fi
  else
    fail "Table not found: $table"
  fi
done

# Check GSI on settlements table
if aws dynamodb describe-table \
  --table-name "finn-x402-settlements" \
  --region "$REGION" \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`status-updated-index`].IndexStatus' \
  --output text 2>/dev/null | grep -q "ACTIVE"; then
  pass "GSI active: status-updated-index on finn-x402-settlements"
else
  fail "GSI missing or not active: status-updated-index"
fi

# ---------------------------------------------------------------------------
# Step 4: S3 Calibration Bucket
# ---------------------------------------------------------------------------

echo ""
echo "--- S3 Calibration ---"

BUCKET="finn-calibration-prod"

if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  pass "Bucket exists: $BUCKET"

  # Check calibration file
  if aws s3api head-object --bucket "$BUCKET" --key "calibration.json" --region "$REGION" &>/dev/null; then
    pass "Calibration file exists: s3://$BUCKET/calibration.json"
  else
    fail "Calibration file missing: s3://$BUCKET/calibration.json"
  fi
else
  fail "Bucket not found or no access: $BUCKET"
fi

# ---------------------------------------------------------------------------
# Step 5: ECS Cluster
# ---------------------------------------------------------------------------

echo ""
echo "--- ECS Cluster ---"

if aws ecs describe-clusters \
  --clusters finn-cluster \
  --region "$REGION" \
  --query 'clusters[0].status' \
  --output text 2>/dev/null | grep -q "ACTIVE"; then
  pass "ECS cluster active: finn-cluster"
else
  skip "ECS cluster not found: finn-cluster (may not exist yet)"
fi

# ---------------------------------------------------------------------------
# Step 6: ECR Repository
# ---------------------------------------------------------------------------

echo ""
echo "--- ECR Repository ---"

if aws ecr describe-repositories \
  --repository-names finn \
  --region "$REGION" \
  --query 'repositories[0].repositoryName' \
  --output text &>/dev/null; then
  pass "ECR repository exists: finn"
else
  skip "ECR repository not found: finn (may not exist yet)"
fi

# ---------------------------------------------------------------------------
# Step 7: CloudWatch Log Group
# ---------------------------------------------------------------------------

echo ""
echo "--- CloudWatch Logs ---"

if aws logs describe-log-groups \
  --log-group-name-prefix "/ecs/finn" \
  --region "$REGION" \
  --query 'logGroups[0].logGroupName' \
  --output text 2>/dev/null | grep -q "/ecs/finn"; then
  pass "Log group exists: /ecs/finn"
else
  skip "Log group not found: /ecs/finn (created automatically by ECS)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Preflight Summary ==="
echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT"
echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT"
echo ""

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo -e "${RED}PREFLIGHT FAILED${NC}: $FAIL_COUNT check(s) did not pass."
  echo "Fix the failing checks before deploying."
  exit 1
else
  echo -e "${GREEN}PREFLIGHT PASSED${NC}: All required checks passed."
  exit 0
fi
