# Background Jobs

> Source: `src/scheduler/scheduler.ts`, `src/cron/service.ts`, `src/agent/worker-pool.ts`, `src/index.ts`

## Scheduler (Periodic Tasks)

- **Source**: `src/scheduler/scheduler.ts` → `Scheduler` class
- **Pattern**: Register tasks with `intervalMs` + `jitterMs`, start/stop lifecycle
- **Circuit breaker**: Wraps each handler; states: CLOSED → OPEN → HALF_OPEN
- **Timer management**: Uses `.unref()` to allow process exit

### Registered Tasks (from `src/index.ts`)

| Task | Interval Env | Default | Handler |
|------|-------------|---------|---------|
| `r2_sync` | `SYNC_INTERVAL_MS` | 30s | WAL → R2 checkpoint sync |
| `git_sync` | `GIT_SYNC_INTERVAL_MS` | 1h | Git archive snapshot |
| `health` | `HEALTH_INTERVAL_MS` | 5m | Subsystem health check |
| `wal_prune` | `SYNC_INTERVAL_MS` | 30s | WAL segment pruning |

## CronService (User-Defined Jobs)

- **Source**: `src/cron/service.ts` → `CronService extends EventEmitter`
- **Registry**: `src/cron/job-registry.ts` → `JobRegistry` (JSON + JSONL persistence)
- **Scheduling**: Cron expressions parsed by `croner` package
- **Tick loop**: 15-second default check interval

### Features

| Feature | Description |
|---------|-------------|
| Circuit breaker | Per-job state tracking (closed/open/half_open) |
| Concurrency policies | `skip` (ignore concurrent), `queue` (await), `replace` (abort prev) |
| Stuck detection | 2-hour default timeout → auto-disable |
| One-shot jobs | Auto-disable after first success |
| Kill switch | Global shutdown for all jobs |
| CAS concurrency | Compare-and-swap based run claiming via ULID |

### Events Emitted

| Event | When |
|-------|------|
| `job:armed` | Timer set for next run |
| `job:started` | Execution began (with `runUlid`) |
| `job:completed` | Execution finished (success/failure) |
| `job:stuck` | Timeout exceeded, auto-disabled |
| `job:disabled` | One-shot or admin disable |

### Run Records

Stored at `data/cron/runs/<jobId>.jsonl`:
```json
{
  "jobId": "...", "runUlid": "...",
  "startedAt": "...", "completedAt": "...",
  "status": "success|failure",
  "durationMs": 12345, "itemsProcessed": 42, "toolCalls": 7,
  "error": "..."
}
```

## Worker Pool

- **Source**: `src/agent/worker-pool.ts` → `WorkerPool`
- **Pattern**: Worker threads with two execution lanes
- **Lanes**: `interactive` (prompt execution) and `system` (maintenance)
- **Config**: `FINN_WORKER_POOL_SIZE` (default: 2 or CPU-1), `FINN_WORKER_SHUTDOWN_MS` (10s), `FINN_WORKER_QUEUE_DEPTH` (10)
- **Shutdown**: Graceful with configurable deadline

## Boot Sequence (from `src/index.ts`)

Order: config → validate → identity → persistence → recovery → beads → compound → activityFeed → workerPool → redis → hounfour → sidecar/orchestrator → gateway → scheduler → HTTP serve → WS handler

Graceful shutdown order: scheduler → identity → HTTP → sidecar → pool → redis → R2 sync → WAL
