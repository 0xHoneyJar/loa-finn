# loa-finn

<!-- AGENT-CONTEXT: name=loa-finn, type=overview, purpose=AI agent runtime with multi-model orchestration and persistence, key_files=[src/index.ts, src/gateway/server.ts, src/hounfour/router.ts, src/persistence/wal.ts], interfaces=[HounfourRouter, WAL, CronService, AuditTrail], dependencies=[hono, @mariozechner/pi-ai, @aws-sdk/client-s3, jose, ws], version=0.1.0 -->

loa-finn is an AI agent runtime that provides multi-model orchestration, tool execution sandboxing, and durable persistence for Claude-powered applications. It exposes an HTTP and WebSocket API for session management, routes LLM requests across providers with budget enforcement, and maintains a write-ahead log with R2 cloud storage backup (`src/index.ts`).

The architecture follows a similar pattern to Kubernetes' control plane: a central orchestrator (`src/index.ts`) coordinates specialized subsystems (model routing, job scheduling, persistence) that communicate through well-defined interfaces rather than direct coupling.

## Key Capabilities

- **Multi-Model Routing** — Route LLM requests across providers with alias resolution, capability matching, budget enforcement, and automatic fallback chains (`src/hounfour/router.ts:invoke`)
- **Tool-Call Orchestration** — Execute multi-step tool-call loops with configurable iteration limits (20), wall time (120s), and total tool call caps (50) (`src/hounfour/orchestrator.ts`)
- **Write-Ahead Log Persistence** — Append-only WAL with R2 checkpoint sync and Git archive snapshots for crash recovery (`src/persistence/wal.ts`)
- **Cron Job System** — Enterprise cron with per-job circuit breakers, stuck detection, concurrency policies, and a kill switch (`src/cron/service.ts`)
- **Tool Execution Sandbox** — Worker-thread isolation with filesystem jail, command allowlists, and 30s timeout enforcement (`src/agent/sandbox.ts`)
- **Hash-Chained Audit Trail** — SHA-256 chained JSONL with optional HMAC signing across 4 phases: intent, result, denied, dry_run (`src/safety/audit-trail.ts`)
- **JWT Multi-Tenant Auth** — ES256 JWT validation with JWKS caching, JTI replay prevention, and tenant-aware model pool routing (`src/hounfour/jwt-auth.ts`)
- **BridgeBuilder PR Automation** — Automated GitHub PR review pipeline with R2-backed run leases and persona injection (`src/bridgebuilder/entry.ts`)
- **WebSocket Streaming** — Real-time agent streaming with 8 event types, per-IP connection limits, and automatic compaction (`src/gateway/ws.ts`)
- **Activity Dashboard** — Aggregated health snapshot with audit trail browsing and GitHub activity feed (`src/gateway/dashboard-routes.ts`)

## Quick Start

### Prerequisites

- Node.js 22+ (`"engines": { "node": ">=22" }` in `package.json`)
- `ANTHROPIC_API_KEY` environment variable set

### Run Locally

```bash
# Clone and install
git clone <repo-url> && cd loa-finn
npm install

# Set required environment
export ANTHROPIC_API_KEY=sk-ant-...

# Start development server (tsx watch)
npm run dev
```

The server starts at `http://localhost:3000` with health check at `GET /health` (`src/gateway/server.ts`).

### Run with Docker

```bash
docker compose up
```

For GPU-accelerated local models (vLLM + Qwen):

```bash
docker compose -f docker-compose.gpu.yml up
```

### Deploy BridgeBuilder (Railway)

The `railway.toml` configures automated PR review as a cron job running every 30 minutes:

```bash
npm run bridgebuilder
```

## Module Map

| Module | Purpose | Documentation |
|--------|---------|---------------|
| **hounfour** | Multi-model routing, budget, JWT, orchestration | [docs/modules/hounfour.md](docs/modules/hounfour.md) |
| **gateway** | HTTP API, WebSocket, auth, rate limiting | [docs/modules/gateway.md](docs/modules/gateway.md) |
| **persistence** | WAL, R2 sync, Git sync, recovery | [docs/modules/persistence.md](docs/modules/persistence.md) |
| **cron** | Scheduled job system with circuit breakers | [docs/modules/cron.md](docs/modules/cron.md) |
| **agent** | Session management, sandbox, worker pool | [docs/modules/agent.md](docs/modules/agent.md) |
| **safety** | Audit trail, firewall, secret redaction | [docs/modules/safety.md](docs/modules/safety.md) |
| **bridgebuilder** | GitHub PR automation pipeline | [docs/modules/bridgebuilder.md](docs/modules/bridgebuilder.md) |
| **scheduler** | Periodic task scheduling with health | [docs/modules/scheduler.md](docs/modules/scheduler.md) |

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, layers, component interactions |
| [Operations](docs/operations.md) | Deployment, configuration, monitoring, troubleshooting |
| [API Reference](docs/api-reference.md) | HTTP endpoints, WebSocket contracts, auth |
| [Security](SECURITY.md) | Auth architecture, audit trail, vulnerability reporting |
| [Contributing](CONTRIBUTING.md) | Development setup, workflow, code standards |
| [Changelog](CHANGELOG.md) | Version history and release notes |

## Links

- **Repository**: [GitHub](https://github.com/0xHoneyJar/loa-finn)
- **Issues**: [GitHub Issues](https://github.com/0xHoneyJar/loa-finn/issues)
- **Upstream**: [Loa Framework](https://github.com/0xHoneyJar/loa)

## Known Limitations

- Single-writer WAL — no concurrent sessions per WAL file (`src/persistence/wal.ts`)
- No horizontal scaling — single Hono instance per deployment (`src/gateway/server.ts`)
- Tool sandbox 30s default timeout — long-running tools may be killed (`src/config.ts`)
- BridgeBuilder can only COMMENT on PRs, not APPROVE or REQUEST_CHANGES (`src/bridgebuilder/entry.ts`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:06:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
