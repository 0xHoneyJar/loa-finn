# infrastructure/terraform/environments/armitage.tfvars — Staging Overrides (cycle-036 T-3.2)
#
# Usage: terraform plan -var-file=environments/armitage.tfvars
# Workspace: armitage (terraform workspace select armitage)
#
# REQUIRED: Replace all PLACEHOLDER values before first apply.
# terraform plan will fail if required variables are not set.

environment = "armitage"

# Reduced resources for staging (SDD §4.1)
finn_cpu    = 256
finn_memory = 512

# ECR — Docker image source
ecr_repository_url = "PLACEHOLDER" # e.g. "123456789012.dkr.ecr.us-east-1.amazonaws.com/loa-finn"
image_tag          = "latest"

# Network — same shared VPC/ALB as production
vpc_id             = "PLACEHOLDER" # e.g. "vpc-xxxxxxxxx"
private_subnet_ids = ["PLACEHOLDER"] # e.g. ["subnet-aaa", "subnet-bbb"]

# ALB — shared load balancer
alb_arn                   = "PLACEHOLDER" # e.g. "arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/honeyjar-alb/xxx"
alb_listener_arn          = "PLACEHOLDER" # e.g. "arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:listener/app/honeyjar-alb/xxx/yyy"
alb_security_group_id     = "PLACEHOLDER" # e.g. "sg-xxxxxxxxx"
alb_dns_name              = "PLACEHOLDER" # e.g. "honeyjar-alb-xxx.us-east-1.elb.amazonaws.com"
alb_zone_id               = "PLACEHOLDER" # e.g. "Z35SXDOTRQ7X7K"

# Route53
route53_zone_id           = "PLACEHOLDER" # e.g. "Zxxxxxxxxx"

# Security
elasticache_security_group_id = "PLACEHOLDER" # e.g. "sg-xxxxxxxxx"

# KMS — staging uses its own audit signing key
kms_key_arn               = "arn:aws:kms:us-east-1:000000000000:key/placeholder-staging-key"
finn_task_role_arn        = "PLACEHOLDER" # e.g. "arn:aws:iam::ACCOUNT:role/loa-finn-ecs-task-armitage"
finn_task_role_name       = "PLACEHOLDER" # e.g. "loa-finn-ecs-task-armitage"
