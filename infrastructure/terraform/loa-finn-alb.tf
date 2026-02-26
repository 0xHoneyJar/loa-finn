# infrastructure/terraform/loa-finn-alb.tf — ALB + DNS (Sprint 7 Task 7.2)
#
# WebSocket-capable ALB target group. Route53 DNS record.
# Shares ALB with arrakis via listener rules.
# Parameterized for multi-environment via local.service_name/hostname (cycle-036 T-3.2).

# Variables moved to variables.tf (cycle-036 T-3.1)

# ---------------------------------------------------------------------------
# Target Group — WebSocket Capable
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "loa_finn" {
  name        = local.service_name
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
  # Production: priority 200, staging: 210 (SDD §4.2)
  priority = var.environment == "production" ? 200 : 210

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.loa_finn.arn
  }

  condition {
    host_header {
      values = [local.hostname]
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
  name    = local.hostname
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}
