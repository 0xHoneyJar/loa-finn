#!/usr/bin/env bash
# deploy/staging-deploy.sh — Cross-Repo Staging Deployment Orchestrator
#
# Deploys loa-finn to the arrakis staging environment (armitage).
# Documents the exact sequence, verifies prerequisites, and notes issues.
#
# Usage:
#   ./deploy/staging-deploy.sh check     # Phase 0: Verify all prerequisites
#   ./deploy/staging-deploy.sh ecr       # Phase 1: Create ECR repo + push image
#   ./deploy/staging-deploy.sh terraform  # Phase 2: Terraform plan + apply
#   ./deploy/staging-deploy.sh ssm       # Phase 3: Populate SSM parameters
#   ./deploy/staging-deploy.sh verify    # Phase 4: Health check + smoke test
#   ./deploy/staging-deploy.sh all       # Run all phases sequentially
#
# Prerequisites:
#   - AWS CLI configured (aws sts get-caller-identity works)
#   - Docker installed and running
#   - Terraform >= 1.5 installed
#   - On main branch with PR #109 merged
#
# Environment: arrakis staging
#   Account:  891376933289
#   Region:   us-east-1
#   VPC:      vpc-0d08ce69dba7485da (arrakis-staging-vpc, 10.1.0.0/16)
#   Cluster:  arrakis-staging-cluster
#   ALB:      arrakis-staging-alb
#   Redis:    Dedicated ElastiCache (created by terraform)
#   DNS:      finn-armitage.arrakis.community

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TF_DIR="$REPO_ROOT/infrastructure/terraform"

# AWS constants (discovered 2026-02-27)
AWS_ACCOUNT="891376933289"
AWS_REGION="us-east-1"
ECR_REPO_NAME="loa-finn-armitage"
ECR_URL="$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME"
ECS_CLUSTER="arrakis-staging-cluster"
ECS_SERVICE="loa-finn-armitage"
SSM_PREFIX="/loa-finn/armitage"
STAGING_HOSTNAME="finn-armitage.arrakis.community"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*"; }
note() { echo -e "    ${YELLOW}NOTE:${NC} $*"; }

# ---------------------------------------------------------------------------
# Phase 0: Check Prerequisites
# ---------------------------------------------------------------------------
phase_check() {
  log "Phase 0: Checking prerequisites..."
  local errors=0

  # AWS credentials
  if aws sts get-caller-identity --query "Account" --output text 2>/dev/null | grep -q "$AWS_ACCOUNT"; then
    ok "AWS credentials valid (account $AWS_ACCOUNT)"
  else
    fail "AWS credentials not configured or wrong account"
    ((errors++))
  fi

  # Docker
  if docker info >/dev/null 2>&1; then
    ok "Docker is running"
  else
    fail "Docker is not running"
    ((errors++))
  fi

  # Terraform
  if terraform version >/dev/null 2>&1; then
    local tf_version
    tf_version=$(terraform version -json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['terraform_version'])" 2>/dev/null || terraform version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    ok "Terraform $tf_version"
  else
    fail "Terraform not installed"
    ((errors++))
  fi

  # S3 backend bucket
  if aws s3 ls "s3://honeyjar-terraform-state" >/dev/null 2>&1; then
    ok "Terraform state bucket exists"
  else
    fail "Terraform state bucket 'honeyjar-terraform-state' not accessible"
    ((errors++))
  fi

  # DynamoDB lock table
  if aws dynamodb describe-table --table-name terraform-locks --query "Table.TableName" --output text 2>/dev/null | grep -q "terraform-locks"; then
    ok "Terraform lock table exists"
  else
    fail "Terraform lock table 'terraform-locks' not found"
    ((errors++))
  fi

  # ECR repository
  if aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" >/dev/null 2>&1; then
    ok "ECR repository '$ECR_REPO_NAME' exists"
  else
    warn "ECR repository '$ECR_REPO_NAME' does not exist (will be created in Phase 1)"
  fi

  # ECS cluster
  if aws ecs describe-clusters --clusters "$ECS_CLUSTER" --query "clusters[0].status" --output text 2>/dev/null | grep -q "ACTIVE"; then
    ok "ECS cluster '$ECS_CLUSTER' is ACTIVE"
  else
    fail "ECS cluster '$ECS_CLUSTER' not found or not active"
    ((errors++))
  fi

  # Existing SSM parameters
  local ssm_count
  ssm_count=$(aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=$SSM_PREFIX" --query "length(Parameters)" --output text 2>/dev/null || echo "0")
  if [[ "$ssm_count" -gt 0 ]]; then
    ok "SSM parameters: $ssm_count params under $SSM_PREFIX"
  else
    warn "No SSM parameters under $SSM_PREFIX (will be created by terraform + Phase 3)"
  fi

  # Dockerfile exists
  if [[ -f "$REPO_ROOT/deploy/Dockerfile" ]]; then
    ok "Dockerfile found"
  else
    fail "deploy/Dockerfile not found"
    ((errors++))
  fi

  echo ""
  if [[ $errors -gt 0 ]]; then
    fail "Phase 0 failed with $errors error(s). Fix above issues before proceeding."
    return 1
  else
    ok "Phase 0 complete — all prerequisites met"
  fi
}

# ---------------------------------------------------------------------------
# Phase 1: Create ECR Repo + Build + Push Docker Image
# ---------------------------------------------------------------------------
phase_ecr() {
  log "Phase 1: ECR repository + Docker image..."

  # Create ECR repo if needed
  if ! aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" >/dev/null 2>&1; then
    log "Creating ECR repository '$ECR_REPO_NAME'..."
    aws ecr create-repository \
      --repository-name "$ECR_REPO_NAME" \
      --image-scanning-configuration scanOnPush=true \
      --image-tag-mutability IMMUTABLE \
      --tags Key=Project,Value=loa-finn Key=Environment,Value=armitage \
      --query "repository.repositoryUri" --output text
    ok "ECR repository created"
  else
    ok "ECR repository already exists"
  fi

  # Docker login
  log "Authenticating Docker to ECR..."
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
  ok "Docker authenticated to ECR"

  # Build image
  local git_sha
  git_sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
  log "Building Docker image (tag: $git_sha)..."
  docker build -t "$ECR_REPO_NAME:$git_sha" -t "$ECR_REPO_NAME:latest" \
    -f "$REPO_ROOT/deploy/Dockerfile" "$REPO_ROOT"
  ok "Docker image built: $ECR_REPO_NAME:$git_sha"

  # Tag and push
  docker tag "$ECR_REPO_NAME:$git_sha" "$ECR_URL:$git_sha"
  docker tag "$ECR_REPO_NAME:latest" "$ECR_URL:latest"

  log "Pushing to ECR..."
  docker push "$ECR_URL:$git_sha"
  ok "Pushed $ECR_URL:$git_sha"

  note "Update armitage.tfvars image_tag to '$git_sha' for immutable deploys"
  echo ""
  ok "Phase 1 complete — image available at $ECR_URL:$git_sha"
}

# ---------------------------------------------------------------------------
# Phase 2: Terraform Init + Plan + Apply
# ---------------------------------------------------------------------------
phase_terraform() {
  log "Phase 2: Terraform infrastructure..."

  cd "$TF_DIR"

  # Init with backend
  log "Initializing Terraform..."
  terraform init -input=false
  ok "Terraform initialized"

  # Select or create workspace
  if terraform workspace list | grep -q "armitage"; then
    terraform workspace select armitage
    ok "Workspace 'armitage' selected"
  else
    terraform workspace new armitage
    ok "Workspace 'armitage' created"
  fi

  # Plan
  log "Planning..."
  terraform plan -var-file=environments/armitage.tfvars -out=armitage.tfplan
  ok "Plan saved to armitage.tfplan"

  echo ""
  echo -e "${YELLOW}Review the plan above carefully.${NC}"
  echo -e "Resources to be created: ECS service, ALB rule, Route53 record,"
  echo -e "DynamoDB tables, S3 buckets, KMS key, dedicated Redis, SNS alarms."
  echo ""
  read -rp "Apply this plan? (yes/no): " confirm
  if [[ "$confirm" != "yes" ]]; then
    warn "Apply cancelled. Plan saved at $TF_DIR/armitage.tfplan"
    return 0
  fi

  # Apply
  log "Applying..."
  terraform apply armitage.tfplan
  ok "Terraform applied"

  # Capture outputs for SSM phase
  echo ""
  log "Key resources created:"
  echo "  KMS Key:     $(terraform output -raw finn_audit_signing_key_arn 2>/dev/null || echo 'check terraform state')"
  echo "  Redis:       $(terraform output -raw finn_redis_endpoint 2>/dev/null || echo 'check terraform state')"
  echo "  S3 Audit:    $(terraform output -raw finn_audit_bucket 2>/dev/null || echo 'check terraform state')"
  echo "  S3 Calibr:   $(terraform output -raw finn_calibration_bucket 2>/dev/null || echo 'check terraform state')"
  echo ""
  ok "Phase 2 complete — infrastructure deployed"

  cd "$REPO_ROOT"
}

# ---------------------------------------------------------------------------
# Phase 3: Populate SSM Parameters (secrets)
# ---------------------------------------------------------------------------
phase_ssm() {
  log "Phase 3: SSM parameter values..."
  echo ""
  echo "Terraform created the SSM parameters with PLACEHOLDER values."
  echo "You must now set the real values via AWS CLI or Console."
  echo ""
  echo "Required parameters under $SSM_PREFIX/:"
  echo ""
  echo "  CRITICAL (service won't start without these):"
  echo "  ─────────────────────────────────────────────"
  echo "  REDIS_URL           = rediss://master.<endpoint>:6379"
  echo "                        (note: rediss:// with double-s for TLS)"
  echo "                        Get from: terraform output finn_redis_endpoint"
  echo ""
  echo "  ARRAKIS_URL         = https://staging.api.arrakis.community"
  echo "  FINN_S2S_SECRET     = <shared secret with arrakis>"
  echo "  BASE_RPC_URL        = <Base chain RPC endpoint>"
  echo "  TREASURY_ADDRESS    = <treasury wallet address>"
  echo ""
  echo "  IMPORTANT (features degrade without these):"
  echo "  ─────────────────────────────────────────────"
  echo "  JWT_KMS_KEY_ID      = <KMS key ID for JWT signing>"
  echo "  CHEVAL_HMAC_SECRET  = <HMAC secret for Cheval>"
  echo "  R2_BUCKET           = <R2 bucket name>"
  echo ""
  echo "  AUTO-SET by Terraform (verify, don't override):"
  echo "  ─────────────────────────────────────────────"
  echo "  FINN_REPUTATION_ROUTING  = shadow"
  echo "  X402_SETTLEMENT_MODE     = verify_only"
  echo "  DIXIE_BASE_URL           = PLACEHOLDER (update when Dixie staging is live)"
  echo ""
  echo "  STAGING-ONLY (metrics/calibration):"
  echo "  ─────────────────────────────────────────────"
  echo "  FINN_METRICS_BEARER_TOKEN    = <bearer token for /metrics>"
  echo "  FINN_CALIBRATION_BUCKET_NAME = <S3 bucket from terraform>"
  echo "  FINN_CALIBRATION_HMAC_KEY    = <HMAC key for calibration>"
  echo ""

  echo "Example commands:"
  echo ""
  echo "  aws ssm put-parameter --name '$SSM_PREFIX/REDIS_URL' \\"
  echo "    --value 'rediss://master.loa-finn-armitage.xxx.use1.cache.amazonaws.com:6379' \\"
  echo "    --type SecureString --overwrite"
  echo ""
  echo "  aws ssm put-parameter --name '$SSM_PREFIX/ARRAKIS_URL' \\"
  echo "    --value 'https://staging.api.arrakis.community' \\"
  echo "    --type SecureString --overwrite"
  echo ""

  # Check which params still have PLACEHOLDER
  log "Checking current parameter values..."
  local params
  params=$(aws ssm get-parameters-by-path --path "$SSM_PREFIX" --recursive --with-decryption \
    --query "Parameters[*].{Name:Name,Value:Value}" --output json 2>/dev/null || echo "[]")

  if [[ "$params" != "[]" ]]; then
    echo "$params" | python3 -c "
import json, sys
params = json.load(sys.stdin)
for p in params:
    name = p['Name'].split('/')[-1]
    val = p['Value']
    status = '✓' if val != 'PLACEHOLDER' else '✗ PLACEHOLDER'
    if val not in ('PLACEHOLDER', 'shadow', 'verify_only') and len(val) > 8:
        val = val[:4] + '****'
    print(f'  {status:20s} {name}')
" 2>/dev/null || warn "Could not parse parameters"
  else
    warn "No parameters found yet — run Phase 2 (terraform) first"
  fi

  echo ""
  ok "Phase 3: Review above and set all PLACEHOLDER values before proceeding"
}

# ---------------------------------------------------------------------------
# Phase 4: Verify Deployment
# ---------------------------------------------------------------------------
phase_verify() {
  log "Phase 4: Verifying deployment..."

  # Check ECS service
  log "Checking ECS service status..."
  local service_status
  service_status=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
    --query "services[0].{Status:status,Running:runningCount,Desired:desiredCount,Pending:pendingCount}" \
    --output json 2>/dev/null || echo '{}')

  if echo "$service_status" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('Status')=='ACTIVE'" 2>/dev/null; then
    ok "ECS service is ACTIVE"
    echo "$service_status" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(f'    Running: {d[\"Running\"]}  Desired: {d[\"Desired\"]}  Pending: {d[\"Pending\"]}')
" 2>/dev/null
  else
    fail "ECS service not found or not active"
    note "Check: aws ecs describe-services --cluster $ECS_CLUSTER --services $ECS_SERVICE"
    return 1
  fi

  # Check task health
  log "Checking task health..."
  local task_arns
  task_arns=$(aws ecs list-tasks --cluster "$ECS_CLUSTER" --service-name "$ECS_SERVICE" \
    --query "taskArns" --output json 2>/dev/null)

  if [[ "$task_arns" == "[]" || -z "$task_arns" ]]; then
    fail "No running tasks found"
    note "Check CloudWatch logs: /ecs/loa-finn-armitage"
    note "Common causes: SSM PLACEHOLDER values, missing secrets, image pull failure"
    return 1
  else
    ok "Task(s) running"
  fi

  # DNS check
  log "Checking DNS resolution..."
  if host "$STAGING_HOSTNAME" >/dev/null 2>&1; then
    ok "DNS resolves: $STAGING_HOSTNAME"
  else
    warn "DNS not resolving yet — Route53 propagation can take 60s"
  fi

  # Health endpoint
  log "Checking /health endpoint..."
  local health_status
  health_status=$(curl -s -o /dev/null -w "%{http_code}" "https://$STAGING_HOSTNAME/health" 2>/dev/null || echo "000")

  if [[ "$health_status" == "200" ]]; then
    ok "Health check passed (HTTP 200)"
    curl -s "https://$STAGING_HOSTNAME/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  elif [[ "$health_status" == "000" ]]; then
    warn "Cannot reach $STAGING_HOSTNAME — DNS may not have propagated yet"
    note "Try: curl -v https://$STAGING_HOSTNAME/health"
  else
    fail "Health check returned HTTP $health_status"
    note "Check logs: aws logs tail /ecs/loa-finn-armitage --follow"
  fi

  echo ""
  ok "Phase 4 complete — deployment verification done"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════╗"
  echo "║     loa-finn Staging Deployment (armitage)               ║"
  echo "╚═══════════════════════════════════════════════════════════╝"
  echo ""

  local phase="${1:-help}"

  case "$phase" in
    check)     phase_check ;;
    ecr)       phase_ecr ;;
    terraform) phase_terraform ;;
    ssm)       phase_ssm ;;
    verify)    phase_verify ;;
    all)
      phase_check || exit 1
      echo ""
      phase_ecr || exit 1
      echo ""
      phase_terraform || exit 1
      echo ""
      phase_ssm
      echo ""
      echo -e "${YELLOW}Set SSM parameter values, then run: $0 verify${NC}"
      ;;
    help|*)
      echo "Usage: $0 <phase>"
      echo ""
      echo "Phases (run in order):"
      echo "  check      Verify prerequisites (AWS, Docker, Terraform)"
      echo "  ecr        Create ECR repo + build and push Docker image"
      echo "  terraform  Init, plan, and apply Terraform infrastructure"
      echo "  ssm        Guide for populating SSM parameter values"
      echo "  verify     Health check and smoke test"
      echo "  all        Run check → ecr → terraform → ssm sequentially"
      echo ""
      echo "ADR/Issues discovered during deployment:"
      echo "  See infrastructure/terraform/STAGING-RUNBOOK.md"
      ;;
  esac
}

main "$@"
