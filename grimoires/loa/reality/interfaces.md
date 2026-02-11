# Exported Interfaces

> Source: Direct read of module exports across `src/`

## Hounfour (`src/hounfour/`)

### Core Types (`types.ts`)

| Type | Description |
|------|-------------|
| `ProviderEntry` | LLM provider configuration (name, type, models, options) |
| `ModelEntry` | Model metadata (id, capabilities, limits) |
| `ModelCapabilities` | Feature matrix (tool_calling, thinking_traces, vision, streaming) |
| `CompletionRequest` | Unified request: messages, tools, options, metadata |
| `CompletionResult` | Response: content, thinking, tool_calls, usage |
| `CanonicalMessage` | Role-based message (system\|user\|assistant\|tool) |
| `ToolCall` | Tool invocation (id, function.name, function.arguments) |
| `ToolDefinition` | Tool schema (type, function.name/description/parameters) |
| `ExecutionContext` | Request scope (resolved model, scopeMeta, binding, pricing) |
| `ScopeMeta` | Tracking (project_id, phase_id, sprint_id) |
| `BudgetSnapshot` | Cost state (scope, spent_usd, limit_usd, percent_used, exceeded) |
| `LedgerEntry` | Cost record (16 fields: timestamp through nft_id) |
| `RoutingConfig` | Strategy (default_model, fallback chains, downgrade, disabled_providers) |
| `HealthProbeConfig` | Tuning (interval_ms, timeout_ms, failure_threshold, recovery_interval_ms) |
| `ChevalRequest` | Serialized request for subprocess/sidecar transport |
| `StreamChunk` | Event union (chunk, tool_call, usage, done, error) |
| `JWTClaims` | Arrakis JWT payload (tenant_id, tier, nft_id, model_preferences, byok, req_hash) |

### Key Classes

| Class | Source | Public Methods |
|-------|--------|----------------|
| `HounfourRouter` | router.ts | `invoke()`, `invokeForTenant()`, `invokeWithTools()`, `healthCheck()` |
| `ToolCallOrchestrator` | orchestrator.ts | `invoke(request, port, options)` → `OrchestratorResult` |
| `BudgetEnforcer` | budget.ts | Cost enforcement with scope key derivation |
| `S2SJwtSigner` | s2s-jwt.ts | `init()`, `signJWT()`, `signJWS()`, `getJWKS()` |
| `HealthProber` | health.ts | Active health monitoring with latency tracking |

### Interfaces

| Interface | Methods |
|-----------|---------|
| `ModelPortBase` | `complete()`, `capabilities()`, `healthCheck()` |
| `ModelPortStreaming` | Extends base with `stream()` async generator |

## Persistence (`src/persistence/`)

| Class/Interface | Source | Key Methods |
|-----------------|--------|-------------|
| `ICheckpointStorage` | r2-storage.ts | `readFile`, `writeFile`, `deleteFile`, `listFiles`, `verifyChecksum`, `stat` |
| `R2CheckpointStorage` | r2-storage.ts | Implements `ICheckpointStorage` via `@aws-sdk/client-s3` |
| `WAL` | wal.ts | `initialize()`, `append()`, `truncateAfter()`, `readEntry()`, `snapshot()`, `getStatus()`, `getMetrics()` |
| `GitSync` | git-sync.ts | `snapshot(label, walSeq)`, `checkRemote()`, `getStatus()` |
| `runRecovery()` | recovery.ts | Recovery cascade (R2 → Git → WAL) |

### WAL Types

| Type | Description |
|------|-------------|
| `WALEntry` | Typed entry (type, data, timestamp) |
| `WALEntryType` | Enum: session, bead, memory, config |
| `RecoveryMode` | Enum: strict, degraded, clean |

## Cron (`src/cron/`)

| Class | Source | Key Methods |
|-------|--------|-------------|
| `CronService` | service.ts | `start()`, `stop()`, `createJob()`, `updateJob()`, `deleteJob()`, `triggerJob()`, `getBreaker()`, `detectStuckJobs()`, `runDueJobs()` |
| `JobRegistry` | job-registry.ts | `init()`, `getJobs()`, `getJob()`, `addJob()`, `updateJob()`, `deleteJob()`, `tryClaimRun()`, `releaseRun()`, `isKillSwitchActive()`, `appendRunRecord()` |
| `CircuitBreaker` | circuit-breaker.ts | State machine (closed/open/half_open) |

### Cron Types

| Type | Description |
|------|-------------|
| `CronJob` | Full job record (20+ fields) |
| `CronRunRecord` | Execution log (jobId, runUlid, status, durationMs, etc.) |
| `ConcurrencyPolicy` | Enum: skip, queue, replace |
| `JobStatus` | Enum: enabled, disabled, armed, running, stuck |

## Agent (`src/agent/`)

| Class/Interface | Source | Key API |
|-----------------|--------|---------|
| `LoaSession` | session.ts | `prompt()`, `steer()`, `abort()`, `subscribe()`, `.state`, `.isStreaming`, `.messages` |
| `ToolSandbox` | sandbox.ts | `execute(command)` → `SandboxResult` |
| `WorkerPool` | worker-pool.ts | `exec(spec, lane?)`, `shutdown(deadline?)`, `getStats()` |

### Agent Types

| Type | Description |
|------|-------------|
| `SandboxCommand` | Tool invocation (tool, args, context) |
| `SandboxResult` | Outcome (status, stdout, stderr, exitCode) |
| `CommandPolicy` | Constraints (allowedTools, bashBlacklist, networkBlacklist) |

## Safety (`src/safety/`)

| Class | Source | Key Methods |
|-------|--------|-------------|
| `AuditTrail` | audit-trail.ts | `record()`, `getRecords()`, `verifyChain()`, `getRecordCount()` |
| `AlertService` | alert-service.ts | `fire(severity, triggerType, context)` |
| `GithubFirewall` | github-firewall.ts | Intent/dry-run/result phase validation |
| `SecretRedactor` | secret-redactor.ts | Pattern-based secret redaction |

### Safety Types

| Type | Description |
|------|-------------|
| `AuditRecord` | Immutable log (id, action, phase, timestamp, actor, result, hash, prevHash) |
| `AuditPhase` | Enum: intent, result, denied, dry_run |
| `AlertSeverity` | Enum: critical, error, warning, info |
| `AlertChannel` | Enum: github_issue, webhook, log |

## Gateway (`src/gateway/`)

| Export | Source | Signature |
|--------|--------|-----------|
| `createApp()` | server.ts | `(config, options) → { app: Hono, router: SessionRouter }` |
| `authMiddleware()` | auth.ts | `(config) → middleware` |
| `corsMiddleware()` | auth.ts | `(config) → middleware` |
| `validateWsToken()` | auth.ts | `(token, config) → boolean` |
| `handleWebSocket()` | ws.ts | `(ws, sessionId, clientIp, options) → void` |

## Gateway — Additional Middleware (`src/gateway/`)

| Class/Interface | Source | Description |
|-----------------|--------|-------------|
| `CsrfConfig` | csrf.ts | CSRF token config (tokenLength, cookieName, headerName, formFieldName) |
| `CsrfResult` | csrf.ts | Validation result (valid, error, token, cookieHeader) |
| `ResponseRedactor` | redaction-middleware.ts | Deep-redact sensitive fields from response objects |
| `DashboardRateLimiter` | dashboard-rate-limit.ts | Per-IP sliding window rate limiter |
| `DashboardAuditApi` | dashboard-audit-api.ts | Paginated, filterable audit trail API |
| `DashboardActivityApi` | dashboard-activity-api.ts | GitHub activity feed API |

## Scheduler (`src/scheduler/`)

| Class | Source | Key Methods |
|-------|--------|-------------|
| `Scheduler` | scheduler.ts | `register()`, `start()`, `stop()`, `getStatus()`, `onCircuitTransition()` |
| `HealthAggregator` | health.ts | `check()` → `HealthReport` |

### Scheduler Types

| Type | Description |
|------|-------------|
| `ScheduledTaskDef` | Config (id, name, intervalMs, jitterMs, handler, circuitBreakerConfig) |
| `TaskStatus` | Runtime (id, name, state, lastRun, lastError, circuitBreakerState) |

## BridgeBuilder (`src/bridgebuilder/`)

| Class | Source | Key Methods |
|-------|--------|-------------|
| `R2Client` | r2-client.ts | `get()`, `put()`, `delete()`, `putIfAbsent()`, `putIfMatch()` |
| `RunLease` | lease.ts | `claim(runId)`, `release(runId, token)` |

## Dashboard (`src/dashboard/`)

| Class | Source | Key Methods |
|-------|--------|-------------|
| `ActivityFeed` | activity-feed.ts | `refresh()`, `getActivity(since?)` |
