# deploy/terraform/finn-secrets.tf — Secrets Manager resources (SDD §4.1, cycle-024 T5)
#
# All secret VALUES are populated manually by @janitooor after initial terraform apply.
# Terraform only creates the empty secret shells.

resource "aws_secretsmanager_secret" "finn_anthropic_key" {
  name        = "finn/anthropic-api-key"
  description = "Anthropic API key for loa-finn model routing"
}

resource "aws_secretsmanager_secret" "finn_s2s_private_key" {
  name        = "finn/s2s-private-key"
  description = "ES256 private key (PEM) for S2S JWT signing to arrakis"
}

resource "aws_secretsmanager_secret" "finn_auth_token" {
  name        = "finn/auth-token"
  description = "Bearer token for direct API access (non-JWT path)"
}

resource "aws_secretsmanager_secret" "finn_redis_url" {
  name        = "finn/redis-url"
  description = "Full rediss:// URL with TLS + auth token for ElastiCache"
}
