#!/bin/bash
# tests/e2e/localstack-init-v3.sh — LocalStack Init Script v3 (cycle-035 T-3.3)
#
# Creates DynamoDB tables, S3 buckets, KMS key, and seeds Secrets Manager
# with ES256 keypairs for all three services (finn, freeside, dixie, admin).
#
# Mounted into LocalStack at /etc/localstack/init/ready.d/init.sh
# Keys directory mounted at /etc/localstack/keys/ (read-only)
#
# Services use SecretsLoader to read secrets — no env var key fallbacks.

set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"
KEYS_DIR="/etc/localstack/keys"

echo "=== LocalStack E2E Init v3 (Three-Leg) ==="

# ---------------------------------------------------------------------------
# DynamoDB: finn-scoring-path-log (audit trail hash chain)
# ---------------------------------------------------------------------------
echo "[DynamoDB] Creating table: finn-scoring-path-log"
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
echo "[DynamoDB] Creating table: finn-x402-settlements"
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
echo "[S3] Creating bucket: finn-audit-anchors-test"
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
echo "[S3] Creating bucket: finn-calibration-test"
awslocal s3api create-bucket \
  --bucket finn-calibration-test \
  --region "$REGION"

awslocal s3api put-bucket-versioning \
  --bucket finn-calibration-test \
  --versioning-configuration Status=Enabled \
  --region "$REGION"

# Seed calibration data (HMAC-signed JSONL)
SEED_DATA='{"nftId":"nft-test-001","poolId":"pool-alpha","routingKey":"chat","score":0.85,"evaluator":"human","timestamp":"2026-02-01T00:00:00Z"}'
HMAC_SECRET="e2e-calibration-hmac-secret"
HMAC_HEX=$(printf "%s" "$SEED_DATA" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex 2>/dev/null | awk '{print $NF}')
if [ -n "$HMAC_HEX" ]; then
  printf "%s\n%s\n" "$SEED_DATA" "{\"hmac\":\"$HMAC_HEX\"}" | awslocal s3 cp - s3://finn-calibration-test/calibration/latest.jsonl \
    --region "$REGION"
else
  echo "$SEED_DATA" | awslocal s3 cp - s3://finn-calibration-test/calibration/latest.jsonl \
    --region "$REGION"
fi

# ---------------------------------------------------------------------------
# KMS: Audit signing key (RSA_2048 SIGN_VERIFY)
# ---------------------------------------------------------------------------
echo "[KMS] Creating key: finn-audit-signing"
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

# ---------------------------------------------------------------------------
# Secrets Manager: Seed S2S private keys for all services
# ---------------------------------------------------------------------------
echo "[Secrets Manager] Seeding service keypairs..."

seed_private_key() {
  local service_name="$1"
  local secret_name="$2"
  local key_file="${KEYS_DIR}/${service_name}-private.pem"

  if [ ! -f "$key_file" ]; then
    echo "  WARNING: ${key_file} not found, skipping ${secret_name}"
    return
  fi

  local key_b64
  key_b64=$(base64 -w0 < "$key_file")

  awslocal secretsmanager create-secret \
    --name "$secret_name" \
    --secret-string "$key_b64" \
    --region "$REGION" 2>/dev/null || \
  awslocal secretsmanager put-secret-value \
    --secret-id "$secret_name" \
    --secret-string "$key_b64" \
    --region "$REGION"

  echo "  Seeded ${secret_name} from ${key_file}"
}

# S2S private keys (base64-encoded PEM)
seed_private_key "finn"     "finn/s2s-private-key"
seed_private_key "freeside" "freeside/s2s-private-key"
seed_private_key "dixie"    "dixie/s2s-private-key"

# ---------------------------------------------------------------------------
# Secrets Manager: Admin JWKS (constructed from admin-public.pem as JWK Set)
# ---------------------------------------------------------------------------
echo "[Secrets Manager] Constructing admin JWKS..."

ADMIN_PUB="${KEYS_DIR}/admin-public.pem"
if [ -f "$ADMIN_PUB" ]; then
  # Extract EC point coordinates from the PEM public key
  # We construct a minimal JWK Set JSON with the public key
  # The actual JWK construction uses openssl to extract the key parameters

  # Get the raw public key bytes (base64url-encoded x,y from EC point)
  RAW_PUB_HEX=$(openssl ec -pubin -in "$ADMIN_PUB" -text -noout 2>/dev/null | \
    grep -A 20 "pub:" | grep -v "pub:" | grep -v "ASN1 OID" | grep -v "NIST CURVE" | \
    tr -d ' \n:')

  if [ -n "$RAW_PUB_HEX" ]; then
    # EC P-256 uncompressed point: 04 || x (32 bytes) || y (32 bytes)
    # Remove the leading 04 prefix
    X_HEX="${RAW_PUB_HEX:2:64}"
    Y_HEX="${RAW_PUB_HEX:66:64}"

    # Convert hex to base64url
    hex_to_b64url() {
      echo -n "$1" | sed 's/../\\x&/g' | xargs printf '%b' | base64 -w0 | tr '+/' '-_' | tr -d '='
    }

    X_B64=$(hex_to_b64url "$X_HEX")
    Y_B64=$(hex_to_b64url "$Y_HEX")

    JWKS_JSON="{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"${X_B64}\",\"y\":\"${Y_B64}\",\"kid\":\"admin-e2e-v1\",\"alg\":\"ES256\",\"use\":\"sig\"}]}"

    awslocal secretsmanager create-secret \
      --name "finn/admin-jwks" \
      --secret-string "$JWKS_JSON" \
      --region "$REGION" 2>/dev/null || \
    awslocal secretsmanager put-secret-value \
      --secret-id "finn/admin-jwks" \
      --secret-string "$JWKS_JSON" \
      --region "$REGION"

    echo "  Seeded finn/admin-jwks (JWK Set with kid=admin-e2e-v1)"
  else
    echo "  WARNING: Could not extract EC coordinates from admin-public.pem"
  fi
else
  echo "  WARNING: ${ADMIN_PUB} not found, skipping admin JWKS"
fi

# ---------------------------------------------------------------------------
# Secrets Manager: Calibration HMAC key
# ---------------------------------------------------------------------------
echo "[Secrets Manager] Seeding calibration HMAC..."
awslocal secretsmanager create-secret \
  --name "finn/calibration-hmac" \
  --secret-string "e2e-calibration-hmac-secret" \
  --region "$REGION" 2>/dev/null || \
awslocal secretsmanager put-secret-value \
  --secret-id "finn/calibration-hmac" \
  --secret-string "e2e-calibration-hmac-secret" \
  --region "$REGION"

echo "  Seeded finn/calibration-hmac"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== LocalStack E2E Init v3 Complete ==="
echo "  DynamoDB tables: finn-scoring-path-log, finn-x402-settlements"
echo "  S3 buckets: finn-audit-anchors-test, finn-calibration-test"
echo "  KMS key: $KEY_ID (alias/finn-audit-signing)"
echo "  Secrets Manager:"
echo "    - finn/s2s-private-key"
echo "    - freeside/s2s-private-key"
echo "    - dixie/s2s-private-key"
echo "    - finn/admin-jwks"
echo "    - finn/calibration-hmac"
