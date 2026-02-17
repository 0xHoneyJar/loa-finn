# deploy/terraform/finn-monitoring.tf — CloudWatch Alarms (SDD §8, cycle-024 T5)
#
# Alarms scoped to metrics guaranteed to exist for ECS Fargate services.
# DLQ alarms use custom CloudWatch metrics from health endpoint scraping —
# documented as future enhancement if not available at initial deploy.

# --- CPU Alarm ---

resource "aws_cloudwatch_metric_alarm" "finn_cpu_high" {
  alarm_name          = "finn-cpu-high"
  alarm_description   = "loa-finn CPU utilization > 80%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = data.aws_ecs_cluster.main.cluster_name
    ServiceName = aws_ecs_service.finn.name
  }

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]
}

# --- Memory Alarm ---

resource "aws_cloudwatch_metric_alarm" "finn_memory_high" {
  alarm_name          = "finn-memory-high"
  alarm_description   = "loa-finn memory utilization > 85%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = data.aws_ecs_cluster.main.cluster_name
    ServiceName = aws_ecs_service.finn.name
  }

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]
}

# --- ALB 5xx Alarm ---

resource "aws_cloudwatch_metric_alarm" "finn_5xx" {
  alarm_name          = "finn-5xx-high"
  alarm_description   = "loa-finn ALB 5xx errors > 5 in 5 minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = data.aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.finn.arn_suffix
  }

  alarm_actions = [data.aws_sns_topic.alerts.arn]
}

# --- DLQ Alarms (future enhancement) ---
# These require custom CloudWatch metrics published from health endpoint scraping
# or a Lambda that polls GET /health and extracts billing.dlq_size.
#
# When available, create:
#   - finn-dlq-warning: dlq_size > 10 (WARN, investigation needed)
#   - finn-dlq-critical: dlq_size > 50 (CRITICAL, billing settlement impaired)
#
# Metric source options:
#   1. CloudWatch Synthetics canary polling /health (recommended)
#   2. Lambda on cron publishing custom metric
#   3. Container Insights with custom metric filter on log output
