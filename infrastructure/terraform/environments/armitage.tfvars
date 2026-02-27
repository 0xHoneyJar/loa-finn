# infrastructure/terraform/environments/armitage.tfvars — Staging Overrides
#
# Usage: terraform plan -var-file=environments/armitage.tfvars
# Workspace: armitage (terraform workspace select armitage)
#
# Populated from AWS resource discovery on 2026-02-27.
# Account: 891376933289 (arrakis-deployer)

environment = "armitage"

# ECS cluster — arrakis staging cluster (not honeyjar-* legacy naming)
ecs_cluster_name = "arrakis-staging-cluster"

# Reduced resources for staging (SDD §4.1)
finn_cpu    = 256
finn_memory = 512

# ECR — Docker image source (created by deploy-staging.sh phase 0)
ecr_repository_url = "891376933289.dkr.ecr.us-east-1.amazonaws.com/loa-finn-armitage"
image_tag          = "latest"

# Network — arrakis staging VPC (10.1.0.0/16)
vpc_id             = "vpc-0d08ce69dba7485da"
private_subnet_ids = ["subnet-0a08a8fce7004ee11", "subnet-07973b30fe8f675e7"]

# ALB — arrakis staging load balancer
alb_arn               = "arn:aws:elasticloadbalancing:us-east-1:891376933289:loadbalancer/app/arrakis-staging-alb/0d434b50265789c1"
alb_listener_arn      = "arn:aws:elasticloadbalancing:us-east-1:891376933289:listener/app/arrakis-staging-alb/0d434b50265789c1/e6ff22557f66633c"
alb_security_group_id = "sg-007cdd539bcc3360c"
alb_dns_name          = "arrakis-staging-alb-616899391.us-east-1.elb.amazonaws.com"
alb_zone_id           = "Z35SXDOTRQ7X7K"

# Route53 — arrakis.community public zone
route53_zone_id = "Z01194812Z6NUWBWMFB7T"

# NOTE: elasticache_security_group_id no longer used — ECS SG now references
# finn's dedicated Redis SG (aws_security_group.elasticache) directly.
# Kept for variable declaration compatibility; value is unused.
elasticache_security_group_id = "sg-0d8e3f396915c479d"

# KMS — terraform creates the audit signing key (loa-finn-kms.tf).
# This variable is used for the IAM policy on the task role (loa-finn-ecs.tf).
# On first apply, use a dummy ARN — terraform creates the real key and the
# task role policy references it via aws_kms_key.finn_audit_signing.arn.
# After first apply, update this with the real KMS key ARN from terraform output.
kms_key_arn = "arn:aws:kms:us-east-1:891376933289:key/placeholder-will-be-created"

# finn_task_role_arn and finn_task_role_name removed — now resolved from
# aws_iam_role.ecs_task created by loa-finn-ecs.tf (eliminates circular dependency)
