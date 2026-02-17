# deploy/terraform/oracle-redis.tf — ElastiCache Redis for Oracle rate limiting (SDD §6.2, Sprint 4 Task 4.7)
#
# Multi-AZ with automatic failover. Shared with existing finn Redis usage.
# Connection string stored in Secrets Manager (finn-secrets.tf).

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t3.micro"
}

# --- Subnet Group (private subnets) ---

resource "aws_elasticache_subnet_group" "finn" {
  name       = "finn-redis"
  subnet_ids = data.aws_subnets.private.ids

  tags = {
    Name = "finn-redis-subnet-group"
  }
}

# --- Security Group (ECS → Redis on 6379) ---

resource "aws_security_group" "oracle_redis" {
  name_prefix = "oracle-redis-"
  description = "ElastiCache Redis for Oracle rate limiting"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.finn.id]
    description     = "Redis from finn ECS tasks"
  }

  tags = {
    Name = "oracle-redis-sg"
  }
}

# --- ElastiCache Replication Group (Multi-AZ) ---

resource "aws_elasticache_replication_group" "finn" {
  replication_group_id = "finn-redis"
  description          = "Redis for loa-finn Oracle rate limiting and auth"

  node_type            = var.redis_node_type
  num_cache_clusters   = 2
  automatic_failover_enabled = true

  engine               = "redis"
  engine_version       = "7.1"
  port                 = 6379
  parameter_group_name = "default.redis7"

  subnet_group_name  = aws_elasticache_subnet_group.finn.name
  security_group_ids = [aws_security_group.oracle_redis.id]

  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  tags = {
    Name = "finn-redis"
  }
}

# --- Outputs ---

output "redis_primary_endpoint" {
  description = "Redis primary endpoint for REDIS_URL"
  value       = aws_elasticache_replication_group.finn.primary_endpoint_address
}

output "redis_reader_endpoint" {
  description = "Redis reader endpoint (read replicas)"
  value       = aws_elasticache_replication_group.finn.reader_endpoint_address
}
