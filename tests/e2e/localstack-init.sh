#!/bin/bash
# tests/e2e/localstack-init.sh — LocalStack Init Script (T-6.1, cycle-034)
#
# Creates DynamoDB tables, S3 buckets, and KMS key for E2E testing.
# Mounted into LocalStack at /etc/localstack/init/ready.d/init.sh
# Runs automatically when LocalStack services are ready.

set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"

echo "=== LocalStack E2E Init ==="

# ---------------------------------------------------------------------------
# DynamoDB: finn-scoring-path-log (audit trail hash chain)
# ---------------------------------------------------------------------------
echo "Creating DynamoDB table: finn-scoring-path-log"
awslocal dynamodb create-table \
  --table-name finn-scoring-path-log \
  --attribute-definitions \
    AttributeName=partitionId,AttributeType=S \
    AttributeName=sequenceNumber,AttributeType=N \
  --key-schema \
    AttributeName=partitionId,KeyType=HASH \
    AttributeName=sequenceNumber,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION"

# ---------------------------------------------------------------------------
# DynamoDB: finn-x402-settlements (settlement state machine)
# ---------------------------------------------------------------------------
echo "Creating DynamoDB table: finn-x402-settlements"
awslocal dynamodb create-table \
  --table-name finn-x402-settlements \
  --attribute-definitions \
    AttributeName=idempotencyKey,AttributeType=S \
    AttributeName=status,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --key-schema \
    AttributeName=idempotencyKey,KeyType=HASH \
  --global-secondary-indexes \
    '[{"IndexName":"status-updated-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION"

# ---------------------------------------------------------------------------
# S3: finn-audit-anchors-test (Object Lock COMPLIANCE for audit digests)
# ---------------------------------------------------------------------------
echo "Creating S3 bucket: finn-audit-anchors-test"
awslocal s3api create-bucket \
  --bucket finn-audit-anchors-test \
  --region "$REGION"

awslocal s3api put-bucket-versioning \
  --bucket finn-audit-anchors-test \
  --versioning-configuration Status=Enabled \
  --region "$REGION"

# ---------------------------------------------------------------------------
# S3: finn-calibration-test (calibration data with seed JSONL)
# ---------------------------------------------------------------------------
echo "Creating S3 bucket: finn-calibration-test"
awslocal s3api create-bucket \
  --bucket finn-calibration-test \
  --region "$REGION"

awslocal s3api put-bucket-versioning \
  --bucket finn-calibration-test \
  --versioning-configuration Status=Enabled \
  --region "$REGION"

# Seed calibration data (HMAC-signed JSONL)
SEED_DATA='{"nftId":"nft-test-001","poolId":"pool-alpha","routingKey":"chat","score":0.85,"evaluator":"human","timestamp":"2026-02-01T00:00:00Z"}'

# Sign with HMAC if secret available (matches CalibrationEngine HMAC format)
HMAC_SECRET="${FINN_CALIBRATION_HMAC_SECRET:-e2e-calibration-hmac-secret}"
HMAC_HEX=$(printf "%s" "$SEED_DATA" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex 2>/dev/null | awk '{print $NF}')
if [ -n "$HMAC_HEX" ]; then
  printf "%s\n%s\n" "$SEED_DATA" "{\"hmac\":\"$HMAC_HEX\"}" | awslocal s3 cp - s3://finn-calibration-test/calibration/latest.jsonl \
    --region "$REGION"
else
  # Fallback: unsigned seed data (calibration engine will reject but S3 connectivity verified)
  echo "$SEED_DATA" | awslocal s3 cp - s3://finn-calibration-test/calibration/latest.jsonl \
    --region "$REGION"
fi

# ---------------------------------------------------------------------------
# KMS: Audit signing key (RSA_2048 SIGN_VERIFY)
# ---------------------------------------------------------------------------
echo "Creating KMS key: finn-audit-signing"
KEY_ID=$(awslocal kms create-key \
  --key-usage SIGN_VERIFY \
  --customer-master-key-spec RSA_2048 \
  --description "loa-finn audit digest signing key (E2E)" \
  --region "$REGION" \
  --query 'KeyMetadata.KeyId' \
  --output text)

awslocal kms create-alias \
  --alias-name alias/finn-audit-signing \
  --target-key-id "$KEY_ID" \
  --region "$REGION"

echo "=== LocalStack E2E Init Complete ==="
echo "  DynamoDB tables: finn-scoring-path-log, finn-x402-settlements"
echo "  S3 buckets: finn-audit-anchors-test, finn-calibration-test"
echo "  KMS key: $KEY_ID (alias/finn-audit-signing)"
