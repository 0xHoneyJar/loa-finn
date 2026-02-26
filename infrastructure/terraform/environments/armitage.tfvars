# infrastructure/terraform/environments/armitage.tfvars — Staging Overrides (cycle-036 T-3.2)
#
# Usage: terraform plan -var-file=environments/armitage.tfvars
# Workspace: armitage (terraform workspace select armitage)

environment = "armitage"

# Reduced resources for staging (SDD §4.1)
finn_cpu    = 256
finn_memory = 512

# Network — same shared VPC/ALB as production
# These values must be provided per-account; placeholders shown.
# vpc_id                    = "vpc-xxxxxxxxx"
# private_subnet_ids        = ["subnet-aaa", "subnet-bbb"]
# alb_arn                   = "arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/honeyjar-alb/xxx"
# alb_listener_arn          = "arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:listener/app/honeyjar-alb/xxx/yyy"
# alb_security_group_id     = "sg-xxxxxxxxx"
# alb_dns_name              = "honeyjar-alb-xxx.us-east-1.elb.amazonaws.com"
# alb_zone_id               = "Z35SXDOTRQ7X7K"
# route53_zone_id           = "Zxxxxxxxxx"
# elasticache_security_group_id = "sg-xxxxxxxxx"

# KMS — staging uses its own audit signing key
# kms_key_arn               = "arn:aws:kms:us-east-1:ACCOUNT:key/staging-key-id"
# finn_task_role_arn        = "arn:aws:iam::ACCOUNT:role/loa-finn-ecs-task-armitage"
# finn_task_role_name       = "loa-finn-ecs-task-armitage"
