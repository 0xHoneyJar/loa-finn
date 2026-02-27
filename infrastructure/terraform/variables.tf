# infrastructure/terraform/variables.tf — Centralized Variable Definitions (cycle-036 T-3.1)
#
# All variable declarations consolidated here to prevent redeclaration conflicts.
# Environment variable includes workspace validation for deployment safety.

# ---------------------------------------------------------------------------
# Terraform Configuration + Backend (T-6.9: workspace-keyed state isolation)
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "honeyjar-terraform-state"
    key            = "loa-finn/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
    # Workspace isolation: each workspace gets its own state file
    # default  → loa-finn/terraform.tfstate
    # armitage → env:/armitage/loa-finn/terraform.tfstate
    workspace_key_prefix = "env"
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "loa-finn"
      ManagedBy = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# Core Environment
# ---------------------------------------------------------------------------

variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment. Must match Terraform workspace name (or workspace must be 'default')."

  validation {
    condition     = contains(["production", "armitage"], var.environment)
    error_message = "environment must be one of: production, armitage."
  }
}

# ---------------------------------------------------------------------------
# Locals — Environment-Aware Naming
# ---------------------------------------------------------------------------

locals {
  # Production keeps legacy names for zero-risk migration (SDD §4.1.3).
  # Staging gets environment-suffixed names.
  service_name = var.environment == "production" ? "loa-finn" : "loa-finn-${var.environment}"

  # DNS: production uses existing hostname, staging uses Gibson convention (SDD §4.2)
  hostname = var.environment == "production" ? "loa-finn.honeyjar.xyz" : "finn-${var.environment}.arrakis.community"

  # SSM parameter path prefix
  ssm_prefix = "/loa-finn/${var.environment}"

  # DynamoDB table name suffix
  dynamodb_suffix = var.environment == "production" ? "" : "-${var.environment}"

  # ECS cluster: override via var.ecs_cluster_name or fallback to legacy naming
  ecs_cluster = var.ecs_cluster_name != "" ? var.ecs_cluster_name : "honeyjar-${var.environment}"

  # Common tags applied to all resources
  common_tags = {
    Environment = var.environment
    Service     = "loa-finn"
    ManagedBy   = "terraform"
  }
}

# ---------------------------------------------------------------------------
# Workspace Safety Check
# ---------------------------------------------------------------------------

# Prevent applying production config in staging workspace and vice versa.
# terraform.workspace is "default" for non-workspace usage (legacy production).
resource "null_resource" "workspace_environment_check" {
  count = terraform.workspace != "default" && terraform.workspace != var.environment ? 1 : 0

  provisioner "local-exec" {
    command = "echo 'ERROR: Terraform workspace (${terraform.workspace}) does not match environment variable (${var.environment}). Aborting.' && exit 1"
  }
}

# ---------------------------------------------------------------------------
# Network (shared VPC with arrakis)
# ---------------------------------------------------------------------------

variable "vpc_id" {
  type        = string
  description = "Shared VPC ID (same as arrakis)"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for ECS tasks"
}

# ---------------------------------------------------------------------------
# ECS
# ---------------------------------------------------------------------------

variable "ecr_repository_url" {
  type        = string
  description = "ECR repository URL for loa-finn Docker image"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Docker image tag (use git SHA for immutable deploys)"
}

variable "finn_cpu" {
  type        = number
  default     = 1024
  description = "ECS task CPU units (256 for staging, 1024 for production)"
}

variable "finn_memory" {
  type        = number
  default     = 2048
  description = "ECS task memory in MB (512 for staging, 2048 for production)"
}

# ---------------------------------------------------------------------------
# ALB (shared)
# ---------------------------------------------------------------------------

variable "alb_arn" {
  type        = string
  description = "Shared ALB ARN"
}

variable "alb_listener_arn" {
  type        = string
  description = "HTTPS listener ARN on shared ALB"
}

variable "alb_security_group_id" {
  type        = string
  description = "ALB security group ID for inbound rules"
}

variable "alb_dns_name" {
  type        = string
  description = "ALB DNS name for Route53 alias"
}

variable "alb_zone_id" {
  type        = string
  description = "ALB hosted zone ID for Route53 alias"
}

# ---------------------------------------------------------------------------
# Route53
# ---------------------------------------------------------------------------

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for honeyjar.xyz / arrakis.community"
}

# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------

variable "elasticache_security_group_id" {
  type        = string
  description = "ElastiCache security group ID for outbound rules"
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for JWT signing. Must be scoped to the specific key — Resource:* is prohibited."

  validation {
    condition     = can(regex("^arn:aws:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a valid KMS key ARN (arn:aws:kms:...)."
  }
}

# ---------------------------------------------------------------------------
# KMS (audit signing)
# ---------------------------------------------------------------------------

variable "ecs_cluster_name" {
  type        = string
  default     = ""
  description = "ECS cluster name override. If empty, defaults to 'honeyjar-{environment}'."
}

# NOTE: finn_task_role_arn and finn_task_role_name removed — the task role is
# created by loa-finn-ecs.tf and referenced directly via aws_iam_role.ecs_task.
# Passing the ARN as a variable created a circular dependency on first apply
# (KMS policy needed the ARN before the role existed).

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Email address for alarm notifications."
}

# ---------------------------------------------------------------------------
# Redis URL validation (staging safety — SDD §4.1.1)
# ---------------------------------------------------------------------------

variable "redis_url" {
  type        = string
  default     = ""
  description = "Redis URL for validation only. Actual URL stored in SSM."

  validation {
    condition     = var.redis_url == "" || !(var.redis_url != "" && can(regex("production", var.redis_url)))
    error_message = "Non-production environments cannot reference a Redis URL containing 'production'."
  }
}
