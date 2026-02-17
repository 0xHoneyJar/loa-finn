# deploy/terraform/modules/dnft-site/outputs.tf — dNFT site module outputs (SDD §8.1)

output "s3_bucket_name" {
  description = "S3 bucket name for site content"
  value       = aws_s3_bucket.site.id
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN for IAM policies (GPT-5.2 Fix #8)"
  value       = aws_s3_bucket.site.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for cache invalidation"
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.site.domain_name
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN for IAM policies"
  value       = aws_cloudfront_distribution.site.arn
}

output "site_url" {
  description = "Public URL of the site"
  value       = "https://${var.subdomain}.${var.domain}"
}
