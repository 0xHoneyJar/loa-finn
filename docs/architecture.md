# Architecture Overview

<!-- AGENT-CONTEXT: name=loa-finn-architecture, type=overview, purpose=System architecture and component interaction documentation, key_files=[src/index.ts, src/hounfour/router.ts, src/persistence/wal.ts, src/cron/service.ts, src/gateway/server.ts], interfaces=[HounfourRouter, WAL, CronService, Scheduler, AuditTrail, WorkerPool], dependencies=[hono, @mariozechner/pi-ai, @aws-sdk/client-s3, ws, jose, croner], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## System Overview

<!-- provenance: CODE-FACTUAL -->
loa-finn is structured as a layered runtime where a central boot orchestrator (`src/index.ts:1`) initializes subsystems in dependency order and wires them together through typed interfaces. This follows the same pattern as Envoy proxy's filter chain architecture: each subsystem registers capabilities and the orchestrator composes them into a running service.

<!-- provenance: CODE-FACTUAL -->
The system has 15 source modules organized into 5 architectural layers, with strict unidirectional dependency flow from top to bottom (`docs/archive/architecture/separation-of-concerns.md:1`).

## Architecture Layers

### Layer 1: Gateway (Entry Points)

<!-- provenance: INFERRED -->
The gateway layer handles all external communication — HTTP, WebSocket, and dashboard APIs.

| Component | Source | Responsibility |
|-----------|--------|---------------|
| HTTP Server | `src/gateway/server.ts` | Hono v4 route registration, middleware composition |
| WebSocket Handler | `src/gateway/ws.ts` | Streaming sessions, per-IP limits (5 max) |
| Auth Middleware | `src/gateway/auth.ts` | Bearer token (timing-safe SHA-256), CORS |
| JWT Middleware | `src/hounfour/jwt-auth.ts` | ES256 validation, tenant context extraction |
| CSRF Protection | `src/gateway/csrf.ts` | Double-submit cookie pattern |
| Rate Limiting | `src/gateway/rate-limit.ts` | Per-IP sliding window |
| Redaction | `src/gateway/redaction-middleware.ts` | Secret field redaction in responses |

<!-- provenance: INFERRED -->
The gateway layer depends on the orchestration layer for request handling and the safety layer for auth validation. It never accesses persistence directly.

### Layer 2: Orchestration (Model Routing)

<!-- provenance: INFERRED -->
The orchestration layer manages LLM provider routing, tool execution, and budget enforcement. This layer is analogous to an API gateway's routing mesh — it resolves model aliases, checks budgets, and falls back through provider chains.

| Component | Source | Responsibility |
|-----------|--------|---------------|
| HounfourRouter | `src/hounfour/router.ts` | Alias → capability → budget → fallback resolution |
| ToolCallOrchestrator | `src/hounfour/orchestrator.ts` | Multi-step tool-call loop (20 iter/120s/50 calls) |
| BudgetEnforcer | `src/hounfour/budget.ts` | Scope-based cost tracking with circuit breaker |
| PoolRegistry | `src/hounfour/pool-registry.ts` | Tenant-aware model pool configuration |
| SidecarManager | `src/hounfour/sidecar-manager.ts` | Cheval subprocess/sidecar transport |
| S2SJwtSigner | `src/hounfour/s2s-jwt.ts` | Outbound ES256 JWT signing |
| HealthProber | `src/hounfour/health.ts` | Active health monitoring with latency tracking |

<!-- provenance: CODE-FACTUAL -->
**Routing Resolution Order** (`src/hounfour/router.ts:1`):
1. Alias resolution → canonical model name
2. Capability check → model supports required features
3. Budget check → downgrade if budget exceeded
4. Availability fallback → next provider in chain

### Layer 3: Scheduling (Job Management)

<!-- provenance: INFERRED -->
The scheduling layer handles periodic tasks and user-defined cron jobs with enterprise reliability patterns.

| Component | Source | Responsibility |
|-----------|--------|---------------|
| Scheduler | `src/scheduler/scheduler.ts` | Periodic task registration with jitter |
| CronService | `src/cron/service.ts` | User-defined jobs with circuit breakers |
| JobRegistry | `src/cron/job-registry.ts` | JSON + JSONL persistence, CAS concurrency |
| CircuitBreaker | `src/scheduler/circuit-breaker.ts` | Per-task/per-job failure isolation |
| HealthAggregator | `src/scheduler/health.ts` | Subsystem health roll-up |

<!-- provenance: CODE-FACTUAL -->
The scheduler registers 4 built-in tasks (`src/index.ts:1`): `r2_sync` (30s), `git_sync` (1h), `health` (5m), `wal_prune` (30s). Each task is wrapped in a circuit breaker that transitions through CLOSED → OPEN → HALF_OPEN states on failure.

### Layer 4: Persistence (Data Durability)

<!-- provenance: INFERRED -->
The persistence layer implements a 3-tier durability strategy: local WAL → R2 cloud storage → Git archive. This follows the same pattern as PostgreSQL's WAL + checkpoint architecture but with cloud object storage as the checkpoint target.

| Component | Source | Responsibility |
|-----------|--------|---------------|
| WAL | `src/persistence/wal.ts` | Append-only log with mutex serialization |
| R2CheckpointStorage | `src/persistence/r2-storage.ts` | S3-compatible cloud checkpoint via `@aws-sdk/client-s3` |
| R2Sync | `src/persistence/r2-sync.ts` | WAL → R2 sync coordination |
| GitSync | `src/persistence/git-sync.ts` | Snapshot to `GIT_ARCHIVE_BRANCH` |
| Recovery | `src/persistence/recovery.ts` | Cascade: R2 → Git → WAL with strict/degraded/clean modes |
| WALPruner | `src/persistence/pruner.ts` | Segment cleanup after confirmed sync |

<!-- provenance: CODE-FACTUAL -->
**Recovery Cascade** (`src/persistence/recovery.ts:1`):
1. Try R2 checkpoint → if available, replay from checkpoint
2. Try Git snapshot → if R2 unavailable, restore from Git
3. Fall back to local WAL → replay all local segments

### Layer 5: Safety (Security & Compliance)

<!-- provenance: INFERRED -->
The safety layer provides security enforcement, audit logging, and execution isolation.

| Component | Source | Responsibility |
|-----------|--------|---------------|
| AuditTrail | `src/safety/audit-trail.ts` | SHA-256 hash chain, optional HMAC, 10MB rotation |
| GithubFirewall | `src/safety/github-firewall.ts` | Intent/dry-run/result phase validation |
| ToolSandbox | `src/agent/sandbox.ts` | Worker-thread isolation with filesystem jail |
| WorkerPool | `src/agent/worker-pool.ts` | Interactive/system lane execution |
| SecretRedactor | `src/safety/secret-redactor.ts` | Pattern-based secret removal |
| ToolRegistry | `src/safety/tool-registry.ts` | Tool allowlist and policy enforcement |
| BootValidation | `src/safety/boot-validation.ts` | Structured exit codes on boot failure |

## Component Interactions

```
Client → Gateway (HTTP/WS)
           │
           ├─→ Auth (Bearer/JWT/CSRF)
           │
           ├─→ Orchestration
           │     ├─→ HounfourRouter → Provider (Claude/OpenAI/Sidecar)
           │     ├─→ ToolCallOrchestrator → ToolSandbox → WorkerPool
           │     └─→ BudgetEnforcer → Redis (optional)
           │
           ├─→ Scheduling
           │     ├─→ Scheduler (r2_sync, git_sync, health, wal_prune)
           │     └─→ CronService → JobRegistry → JSONL
           │
           ├─→ Persistence
           │     ├─→ WAL (local) → R2 (cloud) → Git (archive)
           │     └─→ Recovery (R2 → Git → WAL)
           │
           └─→ Safety
                 ├─→ AuditTrail (hash-chained JSONL)
                 ├─→ GithubFirewall (intent → dry_run → result)
                 └─→ SecretRedactor (response filtering)
```

## Design Principles

<!-- provenance: CODE-FACTUAL -->
**Fail-open for non-critical paths** — Redis state backend is optional; circuit breakers and rate limiters fail open on Redis unavailability. Budget enforcement fails closed to prevent cost overrun (`src/hounfour/budget.ts:1`).

<!-- provenance: CODE-FACTUAL -->
**Unidirectional dependencies** — Each layer depends only on layers below it. Gateway never accesses persistence directly; it routes through orchestration or scheduling (`docs/archive/architecture/separation-of-concerns.md:1`).

<!-- provenance: CODE-FACTUAL -->
**Graceful shutdown ordering** — The boot sequence (`src/index.ts:1`) defines both startup and shutdown order: scheduler → identity → HTTP → sidecar → pool → redis → R2 sync → WAL. This ensures in-flight requests complete before persistence layers close.

<!-- provenance: CODE-FACTUAL -->
**Circuit breaker isolation** — Every scheduled task and cron job gets its own circuit breaker instance (`src/scheduler/circuit-breaker.ts:1`). A failing R2 sync does not affect the health check or cron service.

<!-- provenance: CODE-FACTUAL -->
**Hash-chain integrity** — The audit trail uses SHA-256 chaining where each record includes the hash of the previous record (`src/safety/audit-trail.ts:1`). This provides tamper detection similar to a blockchain's Merkle chain but without distributed consensus overhead.

## What This Architecture Enables

<!-- provenance: CODE-FACTUAL -->
The layered architecture with typed interfaces allows independent evolution of each subsystem. Adding a new LLM provider requires only implementing the `ModelPortBase` interface (`src/hounfour/types.ts:1`) — no changes to gateway, persistence, or scheduling layers. Similarly, swapping R2 for a different S3-compatible store requires only a new `ICheckpointStorage` implementation (`src/persistence/r2-storage.ts:1`).

<!-- provenance: INFERRED -->
The 3-tier persistence strategy (WAL → R2 → Git) means the system can recover from any single failure — local disk loss, R2 outage, or Git corruption — as long as at least one tier has recent data.

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:06:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
