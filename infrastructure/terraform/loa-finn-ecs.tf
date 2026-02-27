# infrastructure/terraform/loa-finn-ecs.tf — ECS Fargate Task Definition (Sprint 7 Task 7.1)
#
# Single-writer WAL architecture: desiredCount=1 enforced.
# Shared VPC with arrakis. ECS Fargate on private subnet.
# Parameterized for multi-environment via local.service_name (cycle-036 T-3.2).

# Variables moved to variables.tf (cycle-036 T-3.1)

# ---------------------------------------------------------------------------
# IAM — Task Execution Role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.service_name}-ecs-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_policy" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ECS execution role needs SSM read access to inject secrets into containers.
# AmazonECSTaskExecutionRolePolicy does NOT include ssm:GetParameters.
# Without this, tasks fail with "ResourceInitializationError: unable to pull secrets".
resource "aws_iam_role_policy" "ecs_task_execution_ssm" {
  name = "${local.service_name}-execution-ssm"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "SSMGetParameters"
      Effect = "Allow"
      Action = [
        "ssm:GetParameters",
        "ssm:GetParameter"
      ]
      Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — Task Role (application permissions)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task" {
  name = "${local.service_name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_permissions" {
  name = "${local.service_name}-task-permissions"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SSMRead"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      },
      {
        # Scoped to specific audit signing key created by loa-finn-kms.tf.
        # Previously used var.kms_key_arn (placeholder) — now references the
        # actual resource to eliminate circular dependency on first apply.
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Sign",
          "kms:GetPublicKey"
        ]
        Resource = aws_kms_key.finn_audit_signing.arn
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.loa_finn.arn}:*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Security Group — ECS Tasks
# ---------------------------------------------------------------------------

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "${local.service_name}-ecs-"
  vpc_id      = var.vpc_id
  description = "${local.service_name} ECS task security group"

  # Inbound from ALB only
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
    description     = "HTTP from ALB"
  }

  # NOTE: Redis egress moved to standalone aws_security_group_rule below
  # to break cycle with aws_security_group.elasticache (which has ingress from this SG).

  # Outbound to internet (RPC calls, R2, arrakis)
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS outbound (RPC, R2, arrakis)"
  }

  tags = {
    Name        = "${local.service_name}-ecs"
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# Standalone rule breaks the SG cycle: ecs_tasks ↔ elasticache.
# Inline rules on both SGs would create a Terraform dependency loop.
resource "aws_security_group_rule" "ecs_to_redis" {
  type                     = "egress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.ecs_tasks.id
  source_security_group_id = aws_security_group.elasticache.id
  description              = "Redis to finn dedicated ElastiCache"
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "loa_finn" {
  name              = "/ecs/${local.service_name}"
  retention_in_days = 30

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# ECS Task Definition
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "loa_finn" {
  family                   = local.service_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.finn_cpu
  memory                   = var.finn_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "loa-finn"
    image     = "${var.ecr_repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "FINN_ENVIRONMENT", value = var.environment },
    ]

    secrets = [
      { name = "ARRAKIS_URL", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/ARRAKIS_URL" },
      { name = "FINN_S2S_SECRET", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/FINN_S2S_SECRET" },
      { name = "BASE_RPC_URL", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/BASE_RPC_URL" },
      { name = "TREASURY_ADDRESS", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/TREASURY_ADDRESS" },
      { name = "REDIS_URL", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/REDIS_URL" },
      { name = "R2_BUCKET", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/R2_BUCKET" },
      { name = "JWT_KMS_KEY_ID", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/JWT_KMS_KEY_ID" },
      { name = "CHEVAL_HMAC_SECRET", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/CHEVAL_HMAC_SECRET" },
      { name = "FINN_REPUTATION_ROUTING", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/FINN_REPUTATION_ROUTING" },
      { name = "DIXIE_BASE_URL", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/DIXIE_BASE_URL" },
      { name = "FINN_CALIBRATION_BUCKET_NAME", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/FINN_CALIBRATION_BUCKET_NAME" },
      { name = "FINN_CALIBRATION_HMAC_KEY", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/FINN_CALIBRATION_HMAC_KEY" },
      { name = "FINN_METRICS_BEARER_TOKEN", valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/FINN_METRICS_BEARER_TOKEN" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.loa_finn.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"const h=require('http');const r=h.get('http://127.0.0.1:3000/health',res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# ECS Service — Single Writer (desiredCount=1)
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "loa_finn" {
  name            = local.service_name
  cluster         = local.ecs_cluster
  task_definition = aws_ecs_task_definition.loa_finn.arn
  desired_count   = 1 # WAL single-writer invariant — DO NOT change
  launch_type     = "FARGATE"

  load_balancer {
    target_group_arn = aws_lb_target_group.loa_finn.arn
    container_name   = "loa-finn"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener_rule.loa_finn]

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  # Stop-before-start: prevent dual-writer window during rolling updates.
  # Old task stops before new task starts (brief downtime during deploys).
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Prevent accidental deletion of single-writer service
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
    WALWriter   = "single-writer-enforced"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Alarm — Desired Count Drift (Task 7.7)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_desired_count_drift" {
  alarm_name          = "${local.service_name}-desired-count-drift"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DesiredTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "CRITICAL: ${local.service_name} desired count > 1. WAL single-writer invariant violated."
  alarm_actions       = [aws_sns_topic.loa_finn_alarms.arn]

  dimensions = {
    ClusterName = local.ecs_cluster
    ServiceName = aws_ecs_service.loa_finn.name
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
