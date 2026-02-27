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

# ECR — Docker image source (created by deploy-staging.sh phase 1)
ecr_repository_url = "891376933289.dkr.ecr.us-east-1.amazonaws.com/loa-finn-armitage"
# image_tag must be set to the git SHA at deploy time (ECR uses IMMUTABLE tags).
# Example: terraform plan -var-file=environments/armitage.tfvars -var='image_tag=abc1234'
image_tag          = "DEPLOY_SHA_REQUIRED"

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

# DEPRECATED: elasticache_security_group_id no longer used — ECS SG now references
# finn's dedicated Redis SG (aws_security_group.elasticache) directly.
# Variable has default="" in variables.tf; this line can be removed.

# KMS — terraform creates the audit signing key (loa-finn-kms.tf).
# kms_key_arn removed: task role policy now references aws_kms_key.finn_audit_signing.arn directly.

# finn_task_role_arn and finn_task_role_name removed — now resolved from
# aws_iam_role.ecs_task created by loa-finn-ecs.tf (eliminates circular dependency)
