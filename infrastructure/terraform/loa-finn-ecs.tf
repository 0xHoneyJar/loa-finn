# infrastructure/terraform/loa-finn-ecs.tf — ECS Fargate Task Definition (Sprint 7 Task 7.1)
#
# Single-writer WAL architecture: desiredCount=1 enforced.
# Shared VPC with arrakis. ECS Fargate on private subnet.

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment"
}

variable "vpc_id" {
  type        = string
  description = "Shared VPC ID (same as arrakis)"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for ECS tasks"
}

variable "ecr_repository_url" {
  type        = string
  description = "ECR repository URL for loa-finn Docker image"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Docker image tag"
}

variable "alb_security_group_id" {
  type        = string
  description = "ALB security group ID for inbound rules"
}

variable "elasticache_security_group_id" {
  type        = string
  description = "ElastiCache security group ID for outbound rules"
}

# ---------------------------------------------------------------------------
# IAM — Task Execution Role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name = "loa-finn-ecs-task-execution-${var.environment}"

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

# ---------------------------------------------------------------------------
# IAM — Task Role (application permissions)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task" {
  name = "loa-finn-ecs-task-${var.environment}"

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
  name = "loa-finn-task-permissions"
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
        Resource = "arn:aws:ssm:*:*:parameter/loa-finn/${var.environment}/*"
      },
      {
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Sign",
          "kms:GetPublicKey"
        ]
        Resource = "*"
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.loa_finn.arn}:*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Security Group — ECS Tasks
# ---------------------------------------------------------------------------

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "loa-finn-ecs-${var.environment}-"
  vpc_id      = var.vpc_id
  description = "loa-finn ECS task security group"

  # Inbound from ALB only
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
    description     = "HTTP from ALB"
  }

  # Outbound to ElastiCache
  egress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.elasticache_security_group_id]
    description     = "Redis to ElastiCache"
  }

  # Outbound to internet (RPC calls, R2, arrakis)
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS outbound (RPC, R2, arrakis)"
  }

  tags = {
    Name        = "loa-finn-ecs-${var.environment}"
    Environment = var.environment
    Service     = "loa-finn"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "loa_finn" {
  name              = "/ecs/loa-finn-${var.environment}"
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
  family                   = "loa-finn-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 1024 # 1 vCPU
  memory                   = 2048 # 2 GB
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
    ]

    secrets = [
      { name = "ARRAKIS_URL", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/ARRAKIS_URL" },
      { name = "FINN_S2S_SECRET", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/FINN_S2S_SECRET" },
      { name = "BASE_RPC_URL", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/BASE_RPC_URL" },
      { name = "TREASURY_ADDRESS", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/TREASURY_ADDRESS" },
      { name = "REDIS_URL", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/REDIS_URL" },
      { name = "R2_BUCKET", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/R2_BUCKET" },
      { name = "JWT_KMS_KEY_ID", valueFrom = "arn:aws:ssm:us-east-1:*:parameter/loa-finn/${var.environment}/JWT_KMS_KEY_ID" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.loa_finn.name
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
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
  name            = "loa-finn-${var.environment}"
  cluster         = "honeyjar-${var.environment}"
  task_definition = aws_ecs_task_definition.loa_finn.arn
  desired_count   = 1 # WAL single-writer invariant — DO NOT change
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }

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
  alarm_name          = "loa-finn-desired-count-drift-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DesiredTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "CRITICAL: loa-finn desired count > 1. WAL single-writer invariant violated."
  alarm_actions       = [] # PagerDuty SNS topic ARN

  dimensions = {
    ClusterName = "honeyjar-${var.environment}"
    ServiceName = aws_ecs_service.loa_finn.name
  }

  tags = {
    Environment = var.environment
    Service     = "loa-finn"
  }
}
