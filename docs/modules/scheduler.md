# Scheduler — Periodic Task Management

<!-- AGENT-CONTEXT: name=scheduler, type=module, purpose=Periodic task scheduling with circuit breaker isolation and health aggregation, key_files=[src/scheduler/scheduler.ts, src/scheduler/health.ts, src/scheduler/circuit-breaker.ts], interfaces=[Scheduler, HealthAggregator, CircuitBreaker], dependencies=[], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5, priority_files=[src/scheduler/scheduler.ts, src/scheduler/health.ts, src/scheduler/circuit-breaker.ts], trust_level=low, model_hints=[code,review] -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
The scheduler module manages periodic background tasks (R2 sync, Git sync, health checks, WAL pruning) with per-task circuit breaker isolation and jitter-based interval randomization. It also provides the `HealthAggregator` for subsystem health roll-up (`src/scheduler/scheduler.ts:1`).

## Key Interfaces

### Scheduler (`src/scheduler/scheduler.ts`)

```typescript
class Scheduler {
  register(def: ScheduledTaskDef): void
  start(): void
  stop(): void
  getStatus(): TaskStatus[]
  onCircuitTransition(cb: (taskId, from, to) => void): void
}
```

<!-- provenance: CODE-FACTUAL -->
**Task registration** accepts `id`, `name`, `intervalMs`, `jitterMs`, and `handler` (`src/scheduler/scheduler.ts:5`). Jitter randomizes execution timing to prevent thundering herd patterns.

<!-- provenance: CODE-FACTUAL -->
**Timer management**: Uses `setInterval` with `.unref()` so timers don't prevent process exit during shutdown (`src/scheduler/scheduler.ts:123`).

### HealthAggregator (`src/scheduler/health.ts`)

```typescript
class HealthAggregator {
  check(): HealthReport
}
```

<!-- provenance: CODE-FACTUAL -->
Runs on `HEALTH_INTERVAL_MS` (5m default, `src/config.ts:179`). Collects status from all scheduler tasks, cron jobs, WAL, and provider health probes.

### CircuitBreaker (`src/scheduler/circuit-breaker.ts`)

<!-- provenance: CODE-FACTUAL -->
Per-task circuit breaker with configurable thresholds. States: `closed`, `open`, `half-open` (`src/scheduler/circuit-breaker.ts:3`).

| State | Behavior |
|-------|----------|
| CLOSED | Normal execution, counting failures |
| OPEN | All executions blocked, waiting for recovery interval |
| HALF_OPEN | Single test execution allowed |

<!-- provenance: CODE-FACTUAL -->
Transition: failure count exceeds `failureThreshold` (default 3, `src/scheduler/circuit-breaker.ts:6`) → OPEN → `cooldownMs` expires (default 300s, `src/scheduler/circuit-breaker.ts:37`) → HALF_OPEN → success → CLOSED (`src/scheduler/circuit-breaker.ts:27`).

## Registered Tasks

<!-- provenance: CODE-FACTUAL -->
Registered in `src/index.ts:1` during boot:

| Task ID | Interval | Purpose |
|---------|----------|---------|
| `r2_sync` | `SYNC_INTERVAL_MS` (30s) | WAL → R2 checkpoint sync |
| `git_sync` | `GIT_SYNC_INTERVAL_MS` (1h) | Git archive snapshot |
| `health` | `HEALTH_INTERVAL_MS` (5m) | Subsystem health check |
| `wal_prune` | `SYNC_INTERVAL_MS` (30s) | WAL segment pruning |

## Architecture

```
Boot (src/index.ts)
  └─→ Scheduler.register(task × 4)
        └─→ Scheduler.start()
              ├─→ setInterval(task.handler, intervalMs ± jitterMs)
              │     └─→ CircuitBreaker.wrap(handler)
              │
              └─→ HealthAggregator.check()
                    ├─→ Scheduler task states
                    ├─→ CronService job states
                    ├─→ WAL metrics
                    └─→ Provider health probes
```

## Components (4 files)

| File | Responsibility |
|------|---------------|
| `scheduler.ts` | Task registration, interval management, jitter |
| `health.ts` | Health aggregation across subsystems |
| `circuit-breaker.ts` | CLOSED/OPEN/HALF_OPEN state machine |
| `index.ts` | Barrel exports |

## Dependencies

<!-- provenance: INFERRED -->
- **Internal**: `src/persistence/` (WAL metrics), `src/cron/` (job states), `src/hounfour/` (provider health)
- **External**: None (pure Node.js timers)

## Known Limitations

<!-- provenance: CODE-FACTUAL -->
- No distributed scheduling — single-instance only, timers are local to the process (`src/scheduler/scheduler.ts:1`)
- Circuit breaker state is in-memory — lost on restart (Redis-backed state available via `src/hounfour/redis/ioredis-factory.ts:1` integration)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:13:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
