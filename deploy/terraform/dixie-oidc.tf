# deploy/terraform/dixie-oidc.tf — GitHub Actions OIDC for loa-dixie deploys (SDD §8.3, Sprint 4 Task 4.3)

# OIDC provider for GitHub Actions (may already exist in arrakis account)
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# --- IAM Role for loa-dixie Site Deployment ---

resource "aws_iam_role" "dixie_site_deploy" {
  name = "dixie-site-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:0xHoneyJar/loa-dixie:ref:refs/heads/main"
        }
      }
    }]
  })

  tags = {
    Name = "dixie-site-deploy"
  }
}

# --- Least-Privilege Policy: S3 + CloudFront ---
# References module outputs for ARN scoping (GPT-5.2 Fix #8)

resource "aws_iam_role_policy" "dixie_site_deploy" {
  name = "dixie-site-deploy-policy"
  role = aws_iam_role.dixie_site_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3SiteAccess"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
        ]
        Resource = module.oracle_site.s3_bucket_arn
      },
      {
        Sid    = "S3SiteObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObject",
        ]
        Resource = "${module.oracle_site.s3_bucket_arn}/*"
      },
      {
        Sid    = "CloudFrontInvalidation"
        Effect = "Allow"
        Action = ["cloudfront:CreateInvalidation"]
        Resource = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${module.oracle_site.cloudfront_distribution_id}"
      },
    ]
  })
}
