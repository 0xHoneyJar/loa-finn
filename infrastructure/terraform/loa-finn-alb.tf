# infrastructure/terraform/loa-finn-alb.tf — ALB + DNS (Sprint 7 Task 7.2)
#
# WebSocket-capable ALB target group. Route53 DNS record.
# Shares ALB with arrakis via listener rules.

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "alb_arn" {
  type        = string
  description = "Shared ALB ARN"
}

variable "alb_listener_arn" {
  type        = string
  description = "HTTPS listener ARN on shared ALB"
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for honeyjar.xyz"
}

variable "alb_dns_name" {
  type        = string
  description = "ALB DNS name for Route53 alias"
}

variable "alb_zone_id" {
  type        = string
  description = "ALB hosted zone ID for Route53 alias"
}

# ---------------------------------------------------------------------------
# Target Group — WebSocket Capable
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "loa_finn" {
  name        = "loa-finn-${var.environment}"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  # WebSocket support via stickiness
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  deregistration_delay = 30

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# ALB Listener Rule — Host-Based Routing
# ---------------------------------------------------------------------------

resource "aws_lb_listener_rule" "loa_finn" {
  listener_arn = var.alb_listener_arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.loa_finn.arn
  }

  condition {
    host_header {
      values = ["loa-finn.honeyjar.xyz"]
    }
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# Route53 DNS — A Record Alias
# ---------------------------------------------------------------------------

resource "aws_route53_record" "loa_finn" {
  zone_id = var.route53_zone_id
  name    = "loa-finn.honeyjar.xyz"
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# ECS Service → Target Group Attachment
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "loa_finn_lb" {
  # This is configured in loa-finn-ecs.tf via load_balancer block
  # Referencing here for documentation — actual attachment is in the service resource
  depends_on = [aws_lb_listener_rule.loa_finn]
}
