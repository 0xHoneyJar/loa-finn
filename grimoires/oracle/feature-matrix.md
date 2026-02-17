---
id: feature-matrix
type: knowledge-source
format: markdown
tags: [technical, architectural]
priority: 14
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Feature matrix across ecosystem components"
max_age_days: 60
---

# Feature Matrix

## loa-finn Gateway Features

| Feature | Status | Sprint | Notes |
|---------|--------|--------|-------|
| Hono HTTP server | Done | cycle-001 | Port 3000, /health + /api/v1/* |
| JWT authentication (ES256) | Done | cycle-001 | Bearer token, claims-based routing |
| Pool-based model routing | Done | cycle-018 | cheap, fast-code, reviewer, reasoning, architect |
| finnNFT tier routing | Done | cycle-018 | free → cheap, pro → fast-code+reasoning, enterprise → all |
| BYOK proxy mode | Done | cycle-018 | User provides own API key |
| Billing finalize (S2S) | Done | cycle-021 | ES256 JWT to arrakis /api/billing/finalize |
| DLQ persistence | Done | cycle-023 | Redis-backed dead letter queue for failed settlements |
| OTLP tracing | Done | cycle-024 | OpenTelemetry to Tempo via gRPC |
| Knowledge enrichment | Done | cycle-025 s1-2 | 10 sources, tag-based selection, trust boundaries |
| Oracle API | Done | cycle-025 s3 | /api/v1/oracle with rate limiting, auth, CORS |
| Oracle frontend | In Progress | cycle-025 s5 | oracle.arrakis.community (loa-dixie) |

## loa-hounfour Protocol Features

| Feature | Version | Notes |
|---------|---------|-------|
| Adapter interface | v1.0.0 | AnthropicAdapter, NativeRuntimeAdapter |
| Pool management | v1.0.0 | PoolId, Tier, resolvedPools |
| Budget enforcement | v1.0.0 | Per-request and per-tenant limits |
| Ensemble orchestration | v1.0.0 | Multi-model with voting/consensus |
| Protocol handshake | v5.0.0 | Capability negotiation with arrakis |
| Reservation ID propagation | v5.0.0 | JWT claim for billing settlement |

## Arrakis Infrastructure Features

| Feature | Status | Notes |
|---------|--------|-------|
| ECS Fargate cluster | Done | VPC with private subnets |
| ALB + HTTPS | Done | Wildcard cert for *.arrakis.community |
| ElastiCache Redis | Done | Multi-AZ with automatic failover |
| S2S billing endpoint | Done | /api/billing/finalize with conservation invariants |
| Token gating | Done | finnNFT ownership verification |
| CloudFront CDN | In Progress | Oracle frontend (oracle.arrakis.community) |
| GitHub OIDC | In Progress | loa-dixie deploy role |

## API Endpoints

### loa-finn

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check with subsystem status |
| `/api/v1/invoke` | POST | JWT (ES256) | Model invocation (main path) |
| `/api/v1/oracle` | POST | API key / Public | Oracle knowledge query |
| `/api/v1/usage` | GET | JWT (ES256) | Usage statistics |

### Arrakis

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/billing/finalize` | POST | S2S JWT (ES256) | Billing settlement |
| `/api/billing/health` | GET | None | Billing system health |
