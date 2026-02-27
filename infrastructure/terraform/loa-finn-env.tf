# infrastructure/terraform/loa-finn-env.tf — SSM Parameter Store (Sprint 7 Task 7.1)
#
# All environment variables stored in SSM Parameter Store.
# Referenced by ECS task definition via secrets.
# Parameterized for multi-environment via local.ssm_prefix (cycle-036 T-3.2).

# ---------------------------------------------------------------------------
# SSM Parameters — Application Config
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "anthropic_api_key" {
  name  = "${local.ssm_prefix}/ANTHROPIC_API_KEY"
  type  = "SecureString"
  value = "PLACEHOLDER" # Required: Anthropic API key for Claude model access

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "arrakis_url" {
  name  = "${local.ssm_prefix}/ARRAKIS_URL"
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
  name  = "${local.ssm_prefix}/FINN_S2S_SECRET"
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
  name  = "${local.ssm_prefix}/BASE_RPC_URL"
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
  name  = "${local.ssm_prefix}/TREASURY_ADDRESS"
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
  name  = "${local.ssm_prefix}/REDIS_URL"
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
  name  = "${local.ssm_prefix}/R2_BUCKET"
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
  name  = "${local.ssm_prefix}/JWT_KMS_KEY_ID"
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

# ---------------------------------------------------------------------------
# SSM Parameters — Staging-Only (Goodhart + Routing Config)
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "finn_reputation_routing" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/FINN_REPUTATION_ROUTING"
  type  = "String"
  value = "shadow" # Staging starts in shadow mode

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "dixie_base_url" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/DIXIE_BASE_URL"
  type  = "SecureString"
  value = "PLACEHOLDER" # Dixie reputation API endpoint

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "cheval_hmac_secret" {
  name  = "${local.ssm_prefix}/CHEVAL_HMAC_SECRET"
  type  = "SecureString"
  value = "PLACEHOLDER" # HMAC secret for Cheval model invocations

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "finn_calibration_bucket" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/FINN_CALIBRATION_BUCKET_NAME"
  type  = "String"
  value = "PLACEHOLDER" # S3 bucket for calibration data

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "finn_calibration_hmac" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/FINN_CALIBRATION_HMAC_KEY"
  type  = "SecureString"
  value = "PLACEHOLDER" # HMAC key for calibration data integrity

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "finn_metrics_bearer_token" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/FINN_METRICS_BEARER_TOKEN"
  type  = "SecureString"
  value = "PLACEHOLDER" # Bearer token for /metrics endpoint auth

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_ssm_parameter" "x402_settlement_mode" {
  count = var.environment != "production" ? 1 : 0

  name  = "${local.ssm_prefix}/X402_SETTLEMENT_MODE"
  type  = "String"
  value = "verify_only" # Staging uses verify_only (SDD §4.4)

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
