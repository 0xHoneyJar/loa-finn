# infrastructure/terraform/loa-finn-kms.tf — KMS Key for Audit Signing (SDD §4.6.2, T-5.5)
#
# Asymmetric RSA key for signing daily audit digests.
# ECS task role granted kms:Sign and kms:Verify.
# Parameterized for multi-environment via local.service_name (cycle-036 T-3.2).

resource "aws_kms_key" "finn_audit_signing" {
  description              = "${local.service_name} audit digest signing key"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days  = 30
  enable_key_rotation      = false # Asymmetric keys don't support auto-rotation

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
  name          = "alias/${local.service_name}-audit-signing"
  target_key_id = aws_kms_key.finn_audit_signing.key_id
}

# ---------------------------------------------------------------------------
# IAM Policy for ECS Task Role — DynamoDB + S3 + KMS access
# ---------------------------------------------------------------------------

resource "aws_iam_role_policy" "finn_task_audit_access" {
  name = "${local.service_name}-audit-trail-access"
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
        ]
        Resource = [
          aws_dynamodb_table.finn_scoring_path_log.arn,
          aws_dynamodb_table.finn_x402_settlements.arn,
          "${aws_dynamodb_table.finn_x402_settlements.arn}/index/*",
        ]
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
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
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      },
      {
        # Scoped to environment prefix — staging can only read armitage/ path (SDD §4.1.1)
        Sid    = "S3CalibrationAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.finn_calibration.arn,
          "${aws_s3_bucket.finn_calibration.arn}/${var.environment}/*",
        ]
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
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
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      },
    ]
  })
}

# Variables moved to variables.tf (cycle-036 T-3.1)
