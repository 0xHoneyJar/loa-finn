# infrastructure/terraform/loa-finn-s3.tf — S3 Buckets (SDD §5.3, T-5.5)
#
# Audit anchor bucket (Object Lock COMPLIANCE) and calibration bucket (versioned).

# ---------------------------------------------------------------------------
# Audit Anchor Bucket (§4.6.2)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "finn_audit_anchors" {
  bucket = "finn-audit-anchors-${data.aws_caller_identity.current.account_id}"

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
  bucket = "finn-calibration-${data.aws_caller_identity.current.account_id}"

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
