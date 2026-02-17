# deploy/terraform/oracle-site.tf — Oracle frontend site + wildcard cert (SDD §8.2, Sprint 4 Task 4.2)

# CloudFront requires ACM certs in us-east-1 (GPT-5.2 Fix #7)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# --- Wildcard Certificate (us-east-1 for CloudFront) ---

resource "aws_acm_certificate" "wildcard" {
  provider          = aws.us_east_1
  domain_name       = "*.arrakis.community"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "arrakis-wildcard"
  }
}

# --- DNS Validation Records ---

resource "aws_route53_record" "wildcard_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.arrakis.zone_id
}

resource "aws_acm_certificate_validation" "wildcard" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for record in aws_route53_record.wildcard_validation : record.fqdn]
}

# --- Route 53 Hosted Zone Data Source ---

data "aws_route53_zone" "arrakis" {
  name = "arrakis.community"
}

# --- Oracle Site (first dNFT using the module) ---

module "oracle_site" {
  source = "./modules/dnft-site"

  subdomain           = "oracle"
  domain              = "arrakis.community"
  zone_id             = data.aws_route53_zone.arrakis.zone_id
  acm_certificate_arn = aws_acm_certificate.wildcard.arn
  api_domain          = "finn.arrakis.community"
  environment         = var.environment

  depends_on = [aws_acm_certificate_validation.wildcard]
}
