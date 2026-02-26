# Deployment Runbook — Finn Production Go-Live

> Cycle-035 T-4.6 | SDD §6.2 deployment order | 10-step sequence

---

## Prerequisites

- [ ] All 4 sprint tasks merged to `main`
- [ ] CI green on `main`
- [ ] `scripts/preflight-check.sh` passes in target AWS account
- [ ] Graduation evaluation script available (`scripts/evaluate-graduation.ts`)
- [ ] Admin JWT signing key rotated (not the test key)

---

## Step 1: AWS Secrets Manager

Seed production secrets. Each secret must exist before ECS task starts.

| Secret Name | Description | Format |
|-------------|-------------|--------|
| `finn/s2s-private-key` | Finn S2S ES256 private key | PEM (PKCS8) base64 |
| `finn/admin-jwks` | Admin JWT verification JWKS | JSON (`{"keys":[...]}`) |
| `finn/calibration-hmac` | Calibration HMAC key | Hex string |

```bash
# Verify secrets exist
aws secretsmanager get-secret-value --secret-id finn/s2s-private-key --query 'Name' --output text
aws secretsmanager get-secret-value --secret-id finn/admin-jwks --query 'Name' --output text
aws secretsmanager get-secret-value --secret-id finn/calibration-hmac --query 'Name' --output text
```

**Rollback**: Delete secrets with `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`.

---

## Step 2: DynamoDB Tables

Create audit and settlement tables.

```bash
# Audit table (append-only WAL)
aws dynamodb create-table \
  --table-name finn-audit-log \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# Settlement state table (x402)
aws dynamodb create-table \
  --table-name finn-x402-settlements \
  --attribute-definitions \
    AttributeName=idempotencyKey,AttributeType=S \
    AttributeName=status,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --key-schema AttributeName=idempotencyKey,KeyType=HASH \
  --global-secondary-indexes \
    'IndexName=status-updated-index,KeySchema=[{AttributeName=status,KeyType=HASH},{AttributeName=updatedAt,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST
```

**Rollback**: `aws dynamodb delete-table --table-name <name>`.

---

## Step 3: KMS Key for Audit

```bash
aws kms create-key --description "finn-audit-signing" --key-usage SIGN_VERIFY --key-spec ECC_NIST_P256
# Note the KeyId from output

aws kms create-alias --alias-name alias/finn-audit --target-key-id <KeyId>
```

**Rollback**: Schedule key deletion with `aws kms schedule-key-deletion --key-id <KeyId> --pending-window-in-days 7`.

---

## Step 4: S3 Calibration Bucket

```bash
aws s3 mb s3://finn-calibration-prod
aws s3api put-bucket-versioning --bucket finn-calibration-prod --versioning-configuration Status=Enabled

# Upload initial calibration data
aws s3 cp calibration/initial.json s3://finn-calibration-prod/calibration.json
```

**Rollback**: `aws s3 rb s3://finn-calibration-prod --force`.

---

## Step 5: ElastiCache Redis

Ensure Redis cluster is available. Finn uses direct GET/SET (no caching layer).

```bash
aws elasticache describe-cache-clusters --cache-cluster-id finn-redis --show-cache-node-info
```

**Verify**: Connection from VPC, port 6379, TLS enabled.

---

## Step 6: ECR Image Push

```bash
# Build and push
docker build -t finn:latest .
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag finn:latest <account>.dkr.ecr.<region>.amazonaws.com/finn:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/finn:latest
```

---

## Step 7: ECS Task Definition

Register task definition with these requirements:

```json
{
  "family": "finn",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "finn",
      "image": "<account>.dkr.ecr.<region>.amazonaws.com/finn:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "stopTimeout": 30,
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/healthz || exit 1"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/finn",
          "awslogs-region": "<region>",
          "awslogs-stream-prefix": "finn"
        }
      },
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "ROUTING_MODE", "value": "shadow" },
        { "name": "X402_SETTLEMENT_MODE", "value": "verify_only" },
        { "name": "REDIS_URL", "value": "rediss://finn-redis.<region>.cache.amazonaws.com:6379" },
        { "name": "PROMETHEUS_ENABLED", "value": "true" }
      ]
    }
  ],
  "taskRoleArn": "arn:aws:iam::<account>:role/finn-task-role",
  "executionRoleArn": "arn:aws:iam::<account>:role/finn-execution-role"
}
```

**Critical settings**:
- `containerPort`: 3000
- `stopTimeout`: >= 30 (aligns with 25s graceful shutdown deadline)
- `essential`: true
- `logDriver`: awslogs
- `healthCheck.startPeriod`: 30 (allows SecretsLoader + Redis init)

---

## Step 8: ALB Target Group

```bash
aws elbv2 create-target-group \
  --name finn-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id <vpc-id> \
  --target-type ip \
  --health-check-path /healthz \
  --health-check-protocol HTTP \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --matcher HttpCode=200

# Set deregistration delay
aws elbv2 modify-target-group-attributes \
  --target-group-arn <tg-arn> \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30
```

**ALB target group requirements**:
- Health check path: `/healthz`
- Success codes: `200`
- Interval: 30s
- Timeout: 5s
- Healthy threshold: 2
- Unhealthy threshold: 3
- Deregistration delay: 30s

---

## Step 9: IAM Preflight

Task role (`finn-task-role`) must have:

| Permission | Resource | Purpose |
|-----------|----------|---------|
| `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:*:*:secret:finn/*` | Load S2S keys, JWKS, HMAC |
| `kms:Sign`, `kms:Verify` | `arn:aws:kms:*:*:key/<audit-key-id>` | Audit chain signing |
| `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Query` | `arn:aws:dynamodb:*:*:table/finn-audit-log` | Audit WAL writes |
| `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Query` | `arn:aws:dynamodb:*:*:table/finn-x402-settlements*` | Settlement state (incl. GSI) |
| `s3:GetObject` | `arn:aws:s3:::finn-calibration-prod/*` | Calibration data polling |

Run preflight check:

```bash
scripts/preflight-check.sh
```

---

## Step 10: Deploy & Verify

### 10a. Deploy Code First

```bash
aws ecs update-service \
  --cluster finn-cluster \
  --service finn \
  --task-definition finn:<revision> \
  --force-new-deployment

# Wait for stable
aws ecs wait services-stable --cluster finn-cluster --services finn
```

### 10b. Then Configure ALB Path

```bash
# Add listener rule for /v1/* path
aws elbv2 create-rule \
  --listener-arn <listener-arn> \
  --priority 100 \
  --conditions Field=path-pattern,Values='/v1/*' \
  --actions Type=forward,TargetGroupArn=<tg-arn>
```

### 10c. Verify

```bash
# Health check
curl -f https://finn.example.com/healthz

# Metrics endpoint
curl -s https://finn.example.com/metrics | head -20

# Admin mode (VPN required)
curl -H "Authorization: Bearer $ADMIN_JWT" https://finn-admin.internal/admin/mode
```

### 10d. Monitor

- CloudWatch logs: `/ecs/finn`
- Prometheus scrape: job `finn`, port 3000, path `/metrics`
- Watch `finn_shadow_total` counter for routing activity
- Watch `finn_reputation_query_total` for reputation subsystem

**Rollback**: `aws ecs update-service --cluster finn-cluster --service finn --task-definition finn:<previous-revision> --force-new-deployment`

---

## Post-Deploy: Graduation

After 72h in shadow mode:

```bash
npx tsx scripts/evaluate-graduation.ts --config scripts/graduation-config.json --json
```

| Verdict | Action |
|---------|--------|
| `GRADUATE` | Safe to flip `ROUTING_MODE=enabled` |
| `NOT_READY` | Review failing thresholds, continue shadow |
| `INSUFFICIENT_DATA` | Wait longer, check Prometheus scrape |

### Mode Flip to Production

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"mode":"enabled"}' \
  https://finn-admin.internal/admin/mode
```

### x402 Settlement Activation

After graduation with mode `enabled`:

```bash
# Update env: X402_SETTLEMENT_MODE=live
aws ecs update-service --cluster finn-cluster --service finn \
  --task-definition finn:<revision-with-live-settlement> \
  --force-new-deployment
```

---

## Emergency Procedures

### Kill Switch

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"mode":"disabled"}' \
  https://finn-admin.internal/admin/mode
```

### Full Rollback

1. Set mode to `disabled`
2. Revert ECS task to previous revision
3. Remove ALB listener rule if needed

### Circuit Breaker Status

Monitor settlement circuit breaker via structured logs:

```
{"metric":"settlement.circuit.state_change","from":"CLOSED","to":"OPEN",...}
```

If circuit opens repeatedly, check facilitator connectivity and gas balance.
