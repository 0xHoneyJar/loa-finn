# infrastructure/terraform/loa-finn-kms.tf — KMS Key for Audit Signing (SDD §4.6.2, T-5.5)
#
# Asymmetric RSA key for signing daily audit digests.
# ECS task role granted kms:Sign and kms:Verify.

resource "aws_kms_key" "finn_audit_signing" {
  description             = "loa-finn audit digest signing key"
  key_usage               = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days = 30
  enable_key_rotation     = false # Asymmetric keys don't support auto-rotation

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowRootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowFinnTaskRoleSignVerify"
        Effect = "Allow"
        Principal = {
          AWS = var.finn_task_role_arn
        }
        Action = [
          "kms:Sign",
          "kms:Verify",
          "kms:DescribeKey",
          "kms:GetPublicKey",
        ]
        Resource = "*"
      },
    ]
  })

  tags = {
    Project     = "loa-finn"
    Component   = "audit-trail"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_kms_alias" "finn_audit_signing" {
  name          = "alias/finn-audit-signing"
  target_key_id = aws_kms_key.finn_audit_signing.key_id
}

# ---------------------------------------------------------------------------
# IAM Policy for ECS Task Role — DynamoDB + S3 + KMS access
# ---------------------------------------------------------------------------

resource "aws_iam_role_policy" "finn_task_audit_access" {
  name = "finn-audit-trail-access"
  role = var.finn_task_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ]
        Resource = [
          aws_dynamodb_table.finn_scoring_path_log.arn,
          aws_dynamodb_table.finn_x402_settlements.arn,
          "${aws_dynamodb_table.finn_x402_settlements.arn}/index/*",
        ]
      },
      {
        Sid    = "S3AuditAccess"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.finn_audit_anchors.arn,
          "${aws_s3_bucket.finn_audit_anchors.arn}/*",
        ]
      },
      {
        Sid    = "S3CalibrationAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.finn_calibration.arn,
          "${aws_s3_bucket.finn_calibration.arn}/*",
        ]
      },
      {
        Sid    = "KMSSignVerify"
        Effect = "Allow"
        Action = [
          "kms:Sign",
          "kms:Verify",
          "kms:DescribeKey",
          "kms:GetPublicKey",
        ]
        Resource = [
          aws_kms_key.finn_audit_signing.arn,
        ]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "finn_task_role_arn" {
  description = "ARN of the ECS task role for loa-finn"
  type        = string
}

variable "finn_task_role_name" {
  description = "Name of the ECS task role for loa-finn"
  type        = string
}

variable "environment" {
  description = "Deployment environment (production, staging)"
  type        = string
  default     = "production"
}
