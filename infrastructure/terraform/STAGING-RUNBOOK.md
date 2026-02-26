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
