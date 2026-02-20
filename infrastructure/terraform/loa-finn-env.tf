# infrastructure/terraform/loa-finn-env.tf — SSM Parameter Store (Sprint 7 Task 7.1)
#
# All environment variables stored in SSM Parameter Store.
# Referenced by ECS task definition via secrets.

# ---------------------------------------------------------------------------
# SSM Parameters — Application Config
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "arrakis_url" {
  name  = "/loa-finn/${var.environment}/ARRAKIS_URL"
  type  = "SecureString"
  value = "PLACEHOLDER" # Set via AWS Console or CLI

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "finn_s2s_secret" {
  name  = "/loa-finn/${var.environment}/FINN_S2S_SECRET"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "base_rpc_url" {
  name  = "/loa-finn/${var.environment}/BASE_RPC_URL"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "treasury_address" {
  name  = "/loa-finn/${var.environment}/TREASURY_ADDRESS"
  type  = "String"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/loa-finn/${var.environment}/REDIS_URL"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "r2_bucket" {
  name  = "/loa-finn/${var.environment}/R2_BUCKET"
  type  = "String"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "jwt_kms_key_id" {
  name  = "/loa-finn/${var.environment}/JWT_KMS_KEY_ID"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
