# infrastructure/terraform/loa-finn-redis.tf — Dedicated ElastiCache (Sprint 7 Task 7.2)
#
# Dedicated Redis for loa-finn (Flatline SKP-002: separate from shared Redis).
# Multi-AZ replication, AOF persistence, automated backups (Flatline SKP-004).
# Key namespace prefixes: billing:*, conv:*, x402:*, session:*

# ---------------------------------------------------------------------------
# ElastiCache Subnet Group
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "loa_finn" {
  name       = "loa-finn-redis-${var.environment}"
  subnet_ids = var.private_subnet_ids

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# Security Group — ElastiCache
# ---------------------------------------------------------------------------

resource "aws_security_group" "elasticache" {
  name_prefix = "loa-finn-redis-${var.environment}-"
  vpc_id      = var.vpc_id
  description = "loa-finn dedicated ElastiCache"

  # Inbound from ECS tasks only
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
    description     = "Redis from ECS tasks"
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# ElastiCache Replication Group — Multi-AZ with AOF (Flatline SKP-004)
# ---------------------------------------------------------------------------

resource "aws_elasticache_replication_group" "loa_finn" {
  replication_group_id = "loa-finn-${var.environment}"
  description          = "loa-finn dedicated Redis — billing, conversations, x402, sessions"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.small"
  num_cache_clusters   = 2 # Primary + 1 replica (Multi-AZ)
  parameter_group_name = aws_elasticache_parameter_group.loa_finn.name

  # Multi-AZ replication (Flatline SKP-004)
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # Network
  subnet_group_name  = aws_elasticache_subnet_group.loa_finn.name
  security_group_ids = [aws_security_group.elasticache.id]

  # TLS in transit
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  # Automated backups (Flatline SKP-004)
  snapshot_retention_limit = 7  # 7-day retention
  snapshot_window          = "03:00-04:00"
  maintenance_window       = "sun:04:00-sun:05:00"

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
    Purpose     = "billing-conversations-x402-sessions"
  }
}

# ---------------------------------------------------------------------------
# Parameter Group — noeviction + AOF (Flatline SKP-004)
# ---------------------------------------------------------------------------

resource "aws_elasticache_parameter_group" "loa_finn" {
  name   = "loa-finn-redis7-${var.environment}"
  family = "redis7"

  # Critical: noeviction prevents silent data loss for billing state
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  # AOF persistence with everysec fsync (Flatline SKP-004)
  parameter {
    name  = "appendonly"
    value = "yes"
  }

  parameter {
    name  = "appendfsync"
    value = "everysec"
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Alarm — Redis Memory (Flatline SKP-004)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis_memory_warning" {
  alarm_name          = "loa-finn-redis-memory-high-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Maximum"
  threshold           = 70
  alarm_description   = "WARNING: loa-finn Redis memory > 70%. Investigate billing key growth."
  alarm_actions       = [] # SNS topic ARN

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.loa_finn.id
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
