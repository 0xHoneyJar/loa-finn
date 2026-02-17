# deploy/terraform/finn.tf — loa-finn ECS Task Definition + Networking (SDD §4.1, cycle-024 T5)
#
# PREREQUISITE RESOURCES (must exist in arrakis account):
#   - VPC with private subnets (data.aws_vpc.main, data.aws_subnets.private)
#   - ECS cluster (data.aws_ecs_cluster.main)
#   - ALB + HTTPS listener (data.aws_lb.main, data.aws_lb_listener.https)
#   - Redis security group (data.aws_security_group.redis)
#   - Tempo/OTLP security group (data.aws_security_group.tempo)
#   - SNS alerts topic (data.aws_sns_topic.alerts)
#   - Cloud Map namespace (data.aws_service_discovery_http_namespace.main)
#   - ECR repository (aws_ecr_repository.finn)
#
# This file is designed for the arrakis repo. Written in loa-finn for review,
# submitted as PR to 0xHoneyJar/arrakis.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# --- Variables ---

variable "finn_image_tag" {
  description = "Docker image tag for loa-finn (SHA from CI, never :latest)"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

variable "cloud_map_namespace_name" {
  description = "Cloud Map namespace name"
  type        = string
  default     = "arrakis.local"
}

variable "tempo_service_name" {
  description = "Cloud Map service name for Tempo OTLP collector"
  type        = string
  default     = "tempo"
}

variable "finn_cpu" {
  description = "CPU units for Fargate task"
  type        = number
  default     = 512
}

variable "finn_memory" {
  description = "Memory (MiB) for Fargate task"
  type        = number
  default     = 1024
}

# --- Data Sources (pre-existing arrakis resources) ---

data "aws_vpc" "main" {
  tags = { Name = "arrakis-vpc" }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  tags = { Tier = "private" }
}

data "aws_ecs_cluster" "main" {
  cluster_name = "arrakis"
}

data "aws_lb" "main" {
  tags = { Name = "arrakis-alb" }
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.main.arn
  port              = 443
}

data "aws_security_group" "alb" {
  tags = { Name = "arrakis-alb-sg" }
}

data "aws_security_group" "redis" {
  tags = { Name = "arrakis-redis-sg" }
}

data "aws_security_group" "tempo" {
  tags = { Name = "arrakis-tempo-sg" }
}

data "aws_sns_topic" "alerts" {
  name = "arrakis-alerts"
}

data "aws_service_discovery_http_namespace" "main" {
  name = var.cloud_map_namespace_name
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# --- ECR Repository ---

resource "aws_ecr_repository" "finn" {
  name                 = "loa-finn"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# --- EFS Persistent Storage (SDD §4.1 — EFS-backed /data for JSONL ledger) ---

resource "aws_efs_file_system" "finn_data" {
  creation_token = "finn-data"
  encrypted      = true

  tags = {
    Name = "finn-data"
  }
}

resource "aws_efs_access_point" "finn_data" {
  file_system_id = aws_efs_file_system.finn_data.id

  posix_user {
    uid = 1001
    gid = 1001
  }

  root_directory {
    path = "/finn-data"
    creation_info {
      owner_uid   = 1001
      owner_gid   = 1001
      permissions = "755"
    }
  }
}

resource "aws_efs_mount_target" "finn_data" {
  for_each = toset(data.aws_subnets.private.ids)

  file_system_id  = aws_efs_file_system.finn_data.id
  subnet_id       = each.value
  security_groups = [aws_security_group.finn_efs.id]
}

resource "aws_security_group" "finn_efs" {
  name_prefix = "finn-efs-"
  description = "EFS access for loa-finn"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.finn.id]
    description     = "NFS from finn tasks"
  }

  tags = {
    Name = "finn-efs-sg"
  }
}

# --- IAM ---

resource "aws_iam_role" "finn_task_execution" {
  name = "finn-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "finn_task_execution" {
  role       = aws_iam_role.finn_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "finn_secrets" {
  name = "finn-secrets-access"
  role = aws_iam_role.finn_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
      ]
      Resource = [
        aws_secretsmanager_secret.finn_anthropic_key.arn,
        aws_secretsmanager_secret.finn_s2s_private_key.arn,
        aws_secretsmanager_secret.finn_auth_token.arn,
        aws_secretsmanager_secret.finn_redis_url.arn,
      ]
    }]
  })
}

resource "aws_iam_role" "finn_task" {
  name = "finn-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "finn_task_efs" {
  name = "finn-efs-access"
  role = aws_iam_role.finn_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite",
      ]
      Resource = aws_efs_file_system.finn_data.arn
    }]
  })
}

# --- ECS Task Definition ---

resource "aws_ecs_task_definition" "finn" {
  family                   = "finn"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.finn_cpu
  memory                   = var.finn_memory
  execution_role_arn       = aws_iam_role.finn_task_execution.arn
  task_role_arn            = aws_iam_role.finn_task.arn

  container_definitions = jsonencode([{
    name      = "finn"
    image     = "${aws_ecr_repository.finn.repository_url}:${var.finn_image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = "3000" },
      { name = "DATA_DIR", value = "/data" },
      { name = "FINN_S2S_JWT_ALG", value = "ES256" },
      { name = "OTLP_ENDPOINT", value = "http://${var.tempo_service_name}.${var.cloud_map_namespace_name}:4317" },
    ]

    secrets = [
      { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.finn_anthropic_key.arn },
      { name = "FINN_S2S_PRIVATE_KEY", valueFrom = aws_secretsmanager_secret.finn_s2s_private_key.arn },
      { name = "FINN_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.finn_auth_token.arn },
      { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.finn_redis_url.arn },
    ]

    mountPoints = [{
      sourceVolume  = "finn-data"
      containerPath = "/data"
      readOnly      = false
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"const h=require('http');const r=h.get('http://127.0.0.1:3000/health',res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.finn.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "finn"
      }
    }
  }])

  volume {
    name = "finn-data"

    efs_volume_configuration {
      file_system_id          = aws_efs_file_system.finn_data.id
      transit_encryption      = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.finn_data.id
        iam             = "ENABLED"
      }
    }
  }
}

# --- ECS Service ---
# CONSTRAINT: desired_count=1 — JSONL ledger is local file, multi-task would produce
# inconsistent usage views. Autoscaling DISABLED until ledger centralized to shared store.

resource "aws_ecs_service" "finn" {
  name            = "finn"
  cluster         = data.aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.finn.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.private.ids
    security_groups  = [aws_security_group.finn.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.finn.arn
    container_name   = "finn"
    container_port   = 3000
  }

  service_registries {
    registry_arn = aws_service_discovery_service.finn.arn
  }

  depends_on = [aws_lb_listener_rule.finn]
}

# --- ALB Target Group + Listener Rule ---

resource "aws_lb_target_group" "finn" {
  name        = "finn"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener_rule" "finn" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.finn.arn
  }

  condition {
    host_header {
      values = ["finn.arrakis.community"]
    }
  }
}

# --- Security Group ---

resource "aws_security_group" "finn" {
  name_prefix = "finn-"
  description = "loa-finn ECS tasks"
  vpc_id      = data.aws_vpc.main.id

  # Ingress: ALB → finn on port 3000
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [data.aws_security_group.alb.id]
    description     = "HTTP from ALB"
  }

  # Egress: HTTPS (NAT gateway for external APIs)
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS outbound (provider APIs, ECR, Secrets Manager)"
  }

  # Egress: Redis (ElastiCache)
  egress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [data.aws_security_group.redis.id]
    description     = "Redis (ElastiCache)"
  }

  # Egress: EFS (NFS)
  egress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.finn_efs.id]
    description     = "EFS (NFS)"
  }

  # Egress: Tempo OTLP (gRPC)
  egress {
    from_port       = 4317
    to_port         = 4317
    protocol        = "tcp"
    security_groups = [data.aws_security_group.tempo.id]
    description     = "Tempo OTLP (gRPC)"
  }

  tags = {
    Name = "finn-sg"
  }
}

# --- Service Discovery ---

resource "aws_service_discovery_service" "finn" {
  name = "finn"

  dns_config {
    namespace_id = data.aws_service_discovery_http_namespace.main.id

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# --- CloudWatch Logs ---

resource "aws_cloudwatch_log_group" "finn" {
  name              = "/ecs/finn"
  retention_in_days = 30
}
