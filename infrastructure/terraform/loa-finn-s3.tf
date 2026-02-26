# infrastructure/terraform/loa-finn-s3.tf — S3 Buckets (SDD §5.3, T-5.5)
#
# Audit anchor bucket (Object Lock COMPLIANCE) and calibration bucket (versioned).
# T-6.4: Conditional naming — default workspace keeps existing names unchanged;
# non-default workspaces append -${var.environment} for staging isolation.

locals {
  # Production (default workspace) keeps existing bucket names. Staging appends environment.
  audit_bucket_name       = terraform.workspace == "default" ? "finn-audit-anchors-${data.aws_caller_identity.current.account_id}" : "finn-audit-anchors-${var.environment}-${data.aws_caller_identity.current.account_id}"
  calibration_bucket_name = terraform.workspace == "default" ? "finn-calibration-${data.aws_caller_identity.current.account_id}" : "finn-calibration-${var.environment}-${data.aws_caller_identity.current.account_id}"
}

# ---------------------------------------------------------------------------
# Audit Anchor Bucket (§4.6.2)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "finn_audit_anchors" {
  bucket = local.audit_bucket_name

  # Object Lock must be enabled at bucket creation — cannot be added later
  object_lock_enabled = true

  tags = {
    Project     = "loa-finn"
    Component   = "audit-trail"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_versioning" "finn_audit_anchors" {
  bucket = aws_s3_bucket.finn_audit_anchors.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "finn_audit_anchors" {
  bucket = aws_s3_bucket.finn_audit_anchors.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 90
    }
  }
}

resource "aws_s3_bucket_public_access_block" "finn_audit_anchors" {
  bucket = aws_s3_bucket.finn_audit_anchors.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Calibration Bucket (§4.1.3)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "finn_calibration" {
  bucket = local.calibration_bucket_name

  tags = {
    Project     = "loa-finn"
    Component   = "goodhart-calibration"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_versioning" "finn_calibration" {
  bucket = aws_s3_bucket.finn_calibration.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "finn_calibration" {
  bucket = aws_s3_bucket.finn_calibration.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Data source for account ID
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
