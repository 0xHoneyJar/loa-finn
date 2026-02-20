# infrastructure/terraform/loa-finn-monitoring.tf — Monitoring (Sprint 7 Task 7.3)
#
# CloudWatch alarms for operational visibility.
# Prometheus metrics served by application at /metrics.

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Email address for alarm notifications. Subscription will remain PendingConfirmation until manually confirmed out-of-band."
}

# ---------------------------------------------------------------------------
# SNS Topic — Alarm Notifications (Task 11.2, Bridgebuilder Deep Review §VIII)
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "loa_finn_alarms" {
  name = "loa-finn-alarms-${var.environment}"

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
  alarm_name          = "loa-finn-cpu-high-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "WARNING: loa-finn CPU > 80%"
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  dimensions = {
    ClusterName = "honeyjar-${var.environment}"
    ServiceName = "loa-finn-${var.environment}"
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "loa-finn-memory-high-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "WARNING: loa-finn memory > 80%"
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  dimensions = {
    ClusterName = "honeyjar-${var.environment}"
    ServiceName = "loa-finn-${var.environment}"
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
  name           = "loa-finn-5xx-${var.environment}"
  pattern        = "\"status\":5"
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "5xxErrorCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "error_5xx_rate" {
  alarm_name          = "loa-finn-5xx-rate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5xxErrorCount"
  namespace           = "LoaFinn/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "CRITICAL: loa-finn 5xx error rate > 1% (>10 in 5min)"
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
  name           = "loa-finn-billing-pending-${var.environment}"
  pattern        = "\"billing_pending_reconciliation\""
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "BillingPendingCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_pending_high" {
  alarm_name          = "loa-finn-billing-pending-high-${var.environment}"
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
  name           = "loa-finn-settlement-circuit-open-${var.environment}"
  pattern        = "{ $.metric = \"settlement.circuit.state_change\" && $.to = \"OPEN\" }"
  log_group_name = aws_cloudwatch_log_group.loa_finn.name

  metric_transformation {
    name      = "SettlementCircuitOpenCount"
    namespace = "LoaFinn/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "settlement_circuit_open" {
  alarm_name          = "loa-finn-settlement-circuit-open-${var.environment}"
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
