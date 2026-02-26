# infrastructure/terraform/loa-finn-dynamodb.tf — DynamoDB Tables (SDD §5.1, T-5.5)
#
# Tables for audit trail hash chain and x402 settlement state machine.
# Provisioned in loa-finn repo for PR visibility; applied via loa-freeside Terraform.
# Parameterized for multi-environment via local.dynamodb_suffix (cycle-036 T-3.2).

# ---------------------------------------------------------------------------
# Audit Trail: finn-scoring-path-log (§4.6.1)
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "finn_scoring_path_log" {
  name         = "finn-scoring-path-log${local.dynamodb_suffix}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "partitionId"
  range_key    = "sequenceNumber"

  attribute {
    name = "partitionId"
    type = "S"
  }

  attribute {
    name = "sequenceNumber"
    type = "N"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Project     = "loa-finn"
    Component   = "audit-trail"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ---------------------------------------------------------------------------
# x402 Settlement: finn-x402-settlements (§4.4.2)
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "finn_x402_settlements" {
  name         = "finn-x402-settlements${local.dynamodb_suffix}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "idempotencyKey"

  attribute {
    name = "idempotencyKey"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "updatedAt"
    type = "S"
  }

  # GSI for reconciliation job: query by status + updatedAt (§4.4.6)
  global_secondary_index {
    name            = "status-updated-index"
    hash_key        = "status"
    range_key       = "updatedAt"
    projection_type = "ALL"
  }

  # TTL on terminal states (confirmed, reverted, gas_failed, expired)
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Project     = "loa-finn"
    Component   = "x402-settlement"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
