#!/bin/bash
# tests/e2e/keys/generate-keys.sh — Generate deterministic ES256 test keypairs (cycle-035 T-3.1)
#
# Generates 4 EC P-256 keypair sets for E2E testing:
#   - finn     (S2S signing: finn → freeside, finn → dixie)
#   - freeside (S2S signing: freeside → finn)
#   - dixie    (S2S signing: dixie → finn)
#   - admin    (Admin JWT signing for /admin/mode endpoint)
#
# These are seed material for LocalStack Secrets Manager.
# Application services use SecretsLoader — they do NOT mount PEM files directly.
#
# Usage:
#   cd tests/e2e/keys && bash generate-keys.sh
#   # Or from repo root:
#   bash tests/e2e/keys/generate-keys.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICES=(finn freeside dixie admin)

echo "=== Generating ES256 test keypairs ==="

for svc in "${SERVICES[@]}"; do
  echo "  Generating ${svc} keypair..."

  # Generate EC P-256 private key (PKCS8 format for jose compatibility)
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 \
    -out "${svc}-private.pem" 2>/dev/null

  # Extract public key
  openssl pkey -in "${svc}-private.pem" -pubout \
    -out "${svc}-public.pem" 2>/dev/null

  # Set restrictive permissions on private keys
  chmod 600 "${svc}-private.pem"
  chmod 644 "${svc}-public.pem"
done

echo ""
echo "=== Generated keypairs ==="
for svc in "${SERVICES[@]}"; do
  echo "  ${svc}-private.pem ($(wc -c < "${svc}-private.pem") bytes)"
  echo "  ${svc}-public.pem  ($(wc -c < "${svc}-public.pem") bytes)"
done

echo ""
echo "These keys are test-only seed material for LocalStack Secrets Manager."
echo "Do NOT use in production."
