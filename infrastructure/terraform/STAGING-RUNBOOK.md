# Terraform Staging Runbook

**Purpose:** Safe multi-environment Terraform operations for loa-finn.

**Key principle:** Staging work must never touch production Terraform state.

---

## Workspace Management

### List workspaces

```bash
cd infrastructure/terraform
terraform workspace list
```

### Create staging workspace (first time only)

```bash
cd infrastructure/terraform
terraform workspace new armitage
```

### Switch to staging workspace

```bash
cd infrastructure/terraform
terraform workspace select armitage
```

### Switch back to production

```bash
cd infrastructure/terraform
terraform workspace select default
```

---

## Staging Operations

### Plan staging changes

```bash
cd infrastructure/terraform
terraform workspace select armitage
terraform plan -var-file=environments/armitage.tfvars
```

### Apply staging changes

```bash
cd infrastructure/terraform
terraform workspace select armitage
terraform apply -var-file=environments/armitage.tfvars
```

### Destroy staging (full teardown)

```bash
cd infrastructure/terraform
terraform workspace select armitage
terraform destroy -var-file=environments/armitage.tfvars
```

---

## Production Operations

### Plan production (read-only verification)

```bash
cd infrastructure/terraform
terraform workspace select default
terraform plan
```

Production apply should only happen via CI/CD pipeline (merge to main).

---

## Safety Checks

### Verify current workspace before any operation

```bash
terraform workspace show
```

### Verify environment variable matches workspace

The `null_resource.workspace_environment_check` in `variables.tf` will abort if:
- Workspace is not "default" AND
- Workspace name does not match `var.environment`

This prevents applying `armitage.tfvars` in the default (production) workspace.

### Pre-apply checklist

1. Run `terraform workspace show` -- confirm correct workspace
2. Run `terraform plan -var-file=environments/armitage.tfvars` -- review changes
3. Verify no production resources appear in the plan output
4. Confirm all new resource names contain the environment suffix (e.g., `-armitage`)
5. Apply only after all checks pass

---

## State Inspection

### List resources in current workspace state

```bash
terraform state list
```

### Show a specific resource

```bash
terraform state show aws_ecs_service.loa_finn
```

### Verify staging resources are isolated

```bash
terraform workspace select armitage
terraform state list | grep -v armitage && echo "WARNING: resources without armitage suffix found"
```

---

## Emergency Procedures

### Staging is affecting production

1. Immediately switch to staging workspace and destroy:
   ```bash
   terraform workspace select armitage
   terraform destroy -var-file=environments/armitage.tfvars -auto-approve
   ```
2. Verify production is unaffected:
   ```bash
   terraform workspace select default
   terraform plan
   ```
   Plan should show "No changes."

### State corruption

1. Do NOT run `terraform apply` on corrupted state
2. Pull fresh state from backend:
   ```bash
   terraform state pull > state-backup-$(date +%Y%m%d-%H%M%S).json
   ```
3. Contact infrastructure team before proceeding

### Wrong workspace applied

If you accidentally applied staging config in production workspace:
1. Do NOT panic -- `prevent_destroy` on ECS service blocks destructive changes
2. Run `terraform plan` to see what changed
3. Revert by re-applying without the staging tfvars:
   ```bash
   terraform workspace select default
   terraform apply
   ```

---

## Environment Matrix

| Property | Production (default) | Staging (armitage) |
|----------|--------------------|--------------------|
| Workspace | `default` | `armitage` |
| tfvars | none (defaults) | `environments/armitage.tfvars` |
| ECS Service | `loa-finn` | `loa-finn-armitage` |
| CPU / Memory | 1024 / 2048 | 256 / 512 |
| SSM Prefix | `/loa-finn/production/` | `/loa-finn/armitage/` |
| DNS | `loa-finn.honeyjar.xyz` | `finn-armitage.arrakis.community` |
| DynamoDB | `finn-scoring-path-log` | `finn-scoring-path-log-armitage` |
| ECS Cluster | `honeyjar-production`* | `arrakis-staging-cluster` |
| Redis | Dedicated (multi-AZ) | Dedicated (single node) |

\* Production cluster name TBD — may need `ecs_cluster_name` override.

---

## ADR: Deployment Bugs Found During Staging Setup (2026-02-27)

These issues were discovered during the first staging deployment attempt and fixed in PR `feature/staging-deployment-fixes`:

### ADR-001: ECS Cluster Name Mismatch

**Problem:** Terraform hardcoded `honeyjar-${var.environment}` as the ECS cluster name, producing `honeyjar-armitage`. The actual staging cluster is `arrakis-staging-cluster`.

**Fix:** Added `ecs_cluster_name` variable with fallback to legacy naming. All ECS/monitoring references now use `local.ecs_cluster`.

**Impact:** Without this fix, `terraform apply` would fail trying to create an ECS service in a non-existent cluster.

### ADR-002: Circular Dependency — KMS Policy vs Task Role

**Problem:** `loa-finn-kms.tf` referenced `var.finn_task_role_arn` in the KMS key policy, but the task role is created by `loa-finn-ecs.tf` in the same apply. On first apply, the role ARN doesn't exist yet, causing a chicken-and-egg failure.

**Fix:** Replaced `var.finn_task_role_arn` with `aws_iam_role.ecs_task.arn` (direct resource reference). Terraform resolves the dependency graph automatically.

**Impact:** Without this fix, first `terraform apply` would fail with "invalid principal" in KMS key policy.

### ADR-003: ECS Execution Role Missing SSM Permissions

**Problem:** The ECS task execution role only had `AmazonECSTaskExecutionRolePolicy`, which does NOT include `ssm:GetParameters`. Since the container definition injects 13 secrets from SSM Parameter Store, the execution role needs explicit SSM read access.

**Fix:** Added inline policy `ecs_task_execution_ssm` granting `ssm:GetParameters` scoped to `${local.ssm_prefix}/*`.

**Impact:** Without this fix, ECS tasks would fail to start with `ResourceInitializationError: unable to pull secrets or registry auth`.

### ADR-004: ECS Security Group Egress Mismatch

**Problem:** The ECS task SG had an egress rule pointing to `var.elasticache_security_group_id` (the shared arrakis Redis SG). But finn creates its own dedicated Redis cluster with its own SG. The ECS tasks couldn't connect to their own Redis.

**Fix:** Changed egress to reference `aws_security_group.elasticache.id` (finn's own dedicated Redis SG, created by `loa-finn-redis.tf`).

**Impact:** Without this fix, finn would get connection timeouts to its Redis, with confusing "connection refused" errors despite the Redis cluster being healthy.

### ADR-005: No ECR Repository

**Problem:** No `loa-finn` or `loa-finn-armitage` ECR repository existed. The deploy workflow needs somewhere to push the Docker image.

**Fix:** `deploy/staging-deploy.sh` Phase 1 creates the ECR repo with `scanOnPush=true` and `IMMUTABLE` tags.

**Impact:** Without this, `docker push` would fail with "repository does not exist".

### ADR-006: Security Group Cycle — ECS ↔ ElastiCache

**Problem:** Fix ADR-004 changed the ECS SG egress to reference `aws_security_group.elasticache.id` (finn's own Redis SG). But that Redis SG already has an ingress rule referencing `aws_security_group.ecs_tasks.id`. Two inline cross-references create a Terraform dependency cycle.

**Fix:** Extracted the ECS → Redis egress into a standalone `aws_security_group_rule.ecs_to_redis` resource. Standalone rules depend on both SGs without either SG depending on the other.

**Impact:** Without this fix, `terraform validate` fails with `Cycle: aws_security_group.ecs_tasks, aws_security_group.elasticache`.

### ADR-007: Invalid `deployment_configuration` Block

**Problem:** The `aws_ecs_service.loa_finn` resource used a `deployment_configuration` block, which is not a valid block type in AWS provider v5.x. The correct syntax uses top-level `deployment_maximum_percent` and `deployment_minimum_healthy_percent` arguments.

**Fix:** Replaced the block with top-level arguments. `deployment_circuit_breaker` remains a valid nested block.

**Impact:** Without this fix, `terraform validate` fails with `Unsupported block type "deployment_configuration"`.
