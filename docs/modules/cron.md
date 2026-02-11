# Cron — Scheduled Job System

<!-- AGENT-CONTEXT: name=cron, type=module, purpose=Enterprise cron job orchestration with circuit breakers, key_files=[src/cron/service.ts, src/cron/job-registry.ts, src/cron/circuit-breaker.ts], interfaces=[CronService, JobRegistry, CircuitBreaker], dependencies=[croner, ulid], version=0.1.0 -->

## Purpose

The cron module provides user-defined scheduled jobs with enterprise reliability patterns: per-job circuit breakers, stuck detection, concurrency policies, and a global kill switch. It extends `EventEmitter` for observable job lifecycle events (`src/cron/service.ts`).

## Key Interfaces

### CronService (`src/cron/service.ts`)

```typescript
class CronService extends EventEmitter {
  async start(): Promise<void>
  async stop(): Promise<void>
  async createJob(partial): Promise<CronJob>
  async updateJob(id, updates): Promise<boolean>
  async deleteJob(id): Promise<boolean>
  async triggerJob(id): Promise<boolean>
  getBreaker(jobId): CircuitBreaker | undefined
  async detectStuckJobs(): Promise<void>
  async runDueJobs(): Promise<void>
}
```

**Events**: `job:armed`, `job:started`, `job:completed`, `job:stuck`, `job:disabled`.

### JobRegistry (`src/cron/job-registry.ts`)

Persistence layer — JSON for job config, JSONL for run records at `data/cron/runs/<jobId>.jsonl`.

```typescript
class JobRegistry {
  async tryClaimRun(jobId, runUlid): Promise<boolean>   // CAS-based concurrency
  async releaseRun(jobId, runUlid): Promise<boolean>
  async appendRunRecord(record: CronRunRecord): Promise<void>
  isKillSwitchActive(): boolean
}
```

## Architecture

```
CronService
  ├─→ Tick Loop (15s interval)
  │     ├─→ Check due jobs (croner expression evaluation)
  │     ├─→ Check stuck jobs (2h default timeout)
  │     └─→ Run due jobs
  │
  ├─→ Per-Job Circuit Breaker
  │     └─→ CLOSED → OPEN → HALF_OPEN
  │
  ├─→ Concurrency Policy
  │     ├─→ skip (ignore if running)
  │     ├─→ queue (await completion)
  │     └─→ replace (abort previous)
  │
  └─→ JobRegistry (JSON + JSONL persistence)
```

## Configuration

Jobs are managed via the Cron API (`src/gateway/cron-api.ts`):
- `POST /api/cron/jobs` — Create
- `PATCH /api/cron/jobs/:id` — Update
- `POST /api/cron/jobs/:id/trigger` — Manual trigger
- `POST /api/cron/kill-switch` — Global shutdown

## Dependencies

- **Internal**: `src/gateway/cron-api.ts` (HTTP API), `src/safety/alert-service.ts` (alerts)
- **External**: `croner` (cron expression parsing), `ulid` (run ID generation)

## Known Limitations

- Stuck detection defaults to 2h — long-running jobs auto-disabled (`src/cron/service.ts`)
- Single-instance only — no distributed locking across replicas

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:12:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
