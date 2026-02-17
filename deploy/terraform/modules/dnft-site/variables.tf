# deploy/terraform/modules/dnft-site/variables.tf — dNFT site module inputs (SDD §8.1)

variable "subdomain" {
  description = "Subdomain for the dNFT site (e.g., 'oracle' → oracle.arrakis.community)"
  type        = string
}

variable "domain" {
  description = "Base domain"
  type        = string
  default     = "arrakis.community"
}

variable "zone_id" {
  description = "Route 53 hosted zone ID"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (wildcard)"
  type        = string
}

variable "api_domain" {
  description = "Backend API domain for CSP connect-src"
  type        = string
  default     = "finn.arrakis.community"
}

variable "environment" {
  description = "Environment (production, staging)"
  type        = string
  default     = "production"
}
