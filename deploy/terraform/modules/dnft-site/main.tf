# deploy/terraform/modules/dnft-site/main.tf — S3 + CloudFront + Route53 static site (SDD §8.1)
#
# Reusable module for hosting static dNFT sites on S3 with CloudFront CDN.
# Security: private bucket, OAI access, HSTS, CSP, X-Frame-Options.

data "aws_caller_identity" "current" {}

# --- S3 Bucket (private, CloudFront OAI only) ---
# Bucket name includes account ID for global uniqueness (GPT-5.2 Fix #6)

resource "aws_s3_bucket" "site" {
  bucket = "${var.subdomain}-site-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.subdomain}-site"
    Type = "dnft-site"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- CloudFront Origin Access Identity ---

resource "aws_cloudfront_origin_access_identity" "site" {
  comment = "${var.subdomain}.${var.domain} OAI"
}

# --- S3 Bucket Policy (CloudFront OAI only) ---

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontOAI"
      Effect    = "Allow"
      Principal = { AWS = aws_cloudfront_origin_access_identity.site.iam_arn }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
    }]
  })
}

# --- CloudFront Response Headers Policy (CSP + HSTS) ---

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.subdomain}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${var.api_domain}; frame-ancestors 'none'"
      override                = true
    }
  }
}

# --- CloudFront Distribution ---

resource "aws_cloudfront_distribution" "site" {
  origin {
    domain_name = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id   = "s3-${var.subdomain}"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.site.cloudfront_access_identity_path
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = ["${var.subdomain}.${var.domain}"]

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "s3-${var.subdomain}"
    viewer_protocol_policy     = "redirect-to-https"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  # SPA fallback — serve index.html for all unmatched routes
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "${var.subdomain}-site-cdn"
    Type = "dnft-site"
  }
}

# --- Route 53 Records (A + AAAA) ---

resource "aws_route53_record" "site_a" {
  zone_id = var.zone_id
  name    = "${var.subdomain}.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = "Z2FDTNDATAQYW2" # CloudFront hosted zone ID (global constant)
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  zone_id = var.zone_id
  name    = "${var.subdomain}.${var.domain}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
