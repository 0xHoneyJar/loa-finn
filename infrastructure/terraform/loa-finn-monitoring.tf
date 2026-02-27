# infrastructure/terraform/loa-finn-monitoring.tf — Monitoring (Sprint 7 Task 7.3)
#
# CloudWatch alarms for operational visibility.
# Prometheus metrics served by application at /metrics.
# Parameterized for multi-environment via local.service_name (cycle-036 T-3.2).

# Variables moved to variables.tf (cycle-036 T-3.1)

# ---------------------------------------------------------------------------
# SNS Topic — Alarm Notifications (Task 11.2, Bridgebuilder Deep Review §VIII)
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "loa_finn_alarms" {
  name = "${local.service_name}-alarms"

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.loa_finn_alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms — Application Health
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${local.service_name}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "WARNING: ${local.service_name} CPU > 80%"
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  dimensions = {
    ClusterName = local.ecs_cluster
    ServiceName = local.service_name
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "${local.service_name}-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "WARNING: ${local.service_name} memory > 80%"
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  dimensions = {
    ClusterName = local.ecs_cluster
    ServiceName = local.service_name
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Metric Filter — 5xx Error Rate
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "error_5xx" {
  name           = "${local.service_name}-5xx"
  pattern        = "\"status\":5"
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "5xxErrorCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "error_5xx_rate" {
  alarm_name          = "${local.service_name}-5xx-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5xxErrorCount"
  namespace           = "LoaFinn/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "CRITICAL: ${local.service_name} 5xx error rate > 1% (>10 in 5min)"
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Metric Filter — Billing Pending Reconciliation
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "billing_pending" {
  name           = "${local.service_name}-billing-pending"
  pattern        = "\"billing_pending_reconciliation\""
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "BillingPendingCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_pending_high" {
  alarm_name          = "${local.service_name}-billing-pending-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BillingPendingCount"
  namespace           = "LoaFinn/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "CRITICAL: billing pending reconciliation > 10. Manual investigation required."
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Metric Filter — Settlement Circuit Breaker Open (Task 12.3)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "settlement_circuit_open" {
  name           = "${local.service_name}-settlement-circuit-open"
  pattern        = "{ $.metric = \"settlement.circuit.state_change\" && $.to = \"OPEN\" }"
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "SettlementCircuitOpenCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "settlement_circuit_open" {
  alarm_name          = "${local.service_name}-settlement-circuit-open"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SettlementCircuitOpenCount"
  namespace           = "LoaFinn/${var.environment}"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "P1: Settlement circuit breaker OPEN — facilitator failing, all payments falling back to direct settlement."
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
