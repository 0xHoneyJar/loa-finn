# Operations Guide

<!-- AGENT-CONTEXT: name=loa-finn-operations, type=operations, purpose=Deployment configuration monitoring and troubleshooting guide, key_files=[src/config.ts, src/index.ts, docker-compose.yml, docker-compose.gpu.yml, railway.toml], interfaces=[FinnConfig, Scheduler, HealthAggregator], dependencies=[hono, @hono/node-server, @aws-sdk/client-s3, ioredis], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## Prerequisites

| Requirement | Minimum | Source |
|-------------|---------|--------|
| Node.js | 22+ | `package.json:engines` |
| npm | 9+ | Included with Node.js 22 |
| `ANTHROPIC_API_KEY` | Required | `src/config.ts` — only required env var |

<!-- provenance: OPERATIONAL -->
**Optional services** (enable features when configured):

| Service | Config | Enables |
|---------|--------|---------|
| Cloudflare R2 | `R2_*` env vars | Cloud checkpoint persistence |
| Redis | `REDIS_URL` | Distributed state: circuit breakers, budget, rate limiting |
| GitHub | `GITHUB_TOKEN` | Activity feed, BridgeBuilder PR automation |
| Git remote | `GIT_*` env vars | Archive snapshots |

## Deployment Modes

### Local Development

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev    # tsx watch — auto-reloads on changes
```

<!-- provenance: CODE-FACTUAL -->
Server binds to host 0.0.0.0 on port 3000 by default (`src/config.ts:77`, `src/config.ts:78`).

### Docker (Single Container)

```bash
docker compose up
```

<!-- provenance: OPERATIONAL -->
Uses `docker-compose.yml` — mounts `./data` for WAL persistence and `./grimoires` for agent identity.

### Docker + GPU (vLLM Stack)

```bash
docker compose -f docker-compose.gpu.yml up
```

<!-- provenance: OPERATIONAL -->
Full stack: loa-finn + vLLM (Qwen-7B, Qwen-1.5B) + Redis. Requires NVIDIA GPU with Docker GPU runtime (`docker-compose.gpu.yml`).

### Railway (BridgeBuilder Cron)

<!-- provenance: OPERATIONAL -->
Configured via `railway.toml` — runs `npm run bridgebuilder` every 30 minutes for automated PR review. Requires `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` in Railway environment.

### Production Deployment

```bash
npm run build    # Compile TypeScript to dist/
node dist/index.js
```

<!-- provenance: CODE-FACTUAL -->
**Required for production**:
- Set `FINN_AUTH_TOKEN` — empty token disables auth entirely (`src/gateway/auth.ts:12`)
- Set `NODE_ENV=production` — blocks `SANDBOX_SYNC_FALLBACK` (`src/config.ts:108`)
- Configure R2 credentials for durable persistence

## Environment Variables

### Required

| Variable | Type | Description |
|----------|------|-------------|
| `ANTHROPIC_API_KEY` | string | Claude API key |

### Core

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `MODEL` | `claude-opus-4-6` | Primary LLM model | `src/config.ts` |
| `THINKING_LEVEL` | `medium` | Claude thinking depth (low/medium/high) | `src/config.ts` |
| `PORT` | `3000` | HTTP server port | `src/config.ts` |
| `HOST` | `0.0.0.0` | Bind address | `src/config.ts` |
| `DATA_DIR` | `./data` | Persistence root directory | `src/config.ts` |
| `BEAUVOIR_PATH` | `grimoires/loa/BEAUVOIR.md` | Identity document path | `src/config.ts` |

### Auth

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `FINN_AUTH_TOKEN` | `` (disabled) | Bearer token for API auth | `src/config.ts` |
| `FINN_CORS_ORIGINS` | `localhost:*` | CORS whitelist (comma-separated, supports wildcards) | `src/config.ts` |

### Persistence

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `R2_ENDPOINT` | — | Cloudflare R2 endpoint URL | `src/config.ts` |
| `R2_BUCKET` | `loa-finn-data` | R2 bucket name | `src/config.ts` |
| `R2_ACCESS_KEY_ID` | — | R2 access key | `src/config.ts` |
| `R2_SECRET_ACCESS_KEY` | — | R2 secret key | `src/config.ts` |
| `SYNC_INTERVAL_MS` | `30000` | WAL → R2 sync frequency | `src/config.ts` |
| `GIT_ARCHIVE_BRANCH` | `finn/archive` | Git branch for checkpoint storage | `src/config.ts` |
| `GIT_SYNC_INTERVAL_MS` | `3600000` | Git snapshot interval (1h) | `src/config.ts` |

### Sandbox

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `SANDBOX_MODE` | `worker` | Execution mode (worker/child_process/disabled) | `src/config.ts` |
| `FINN_SANDBOX_TIMEOUT` | `30000` | Max command execution time (ms) | `src/config.ts` |
| `FINN_WORKER_POOL_SIZE` | `2` | Worker threads (auto-tunes to CPU count) | `src/config.ts` |

### Redis (Optional)

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `REDIS_URL` | — | Redis connection string | `src/config.ts` |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | Connection timeout | `src/config.ts` |
| `REDIS_COMMAND_TIMEOUT_MS` | `3000` | Command timeout | `src/config.ts` |

### Multi-Tenant (Phase 5)

| Variable | Default | Description | Source |
|----------|---------|-------------|--------|
| `FINN_JWT_ENABLED` | `false` | Enable JWT for `/api/v1/*` | `src/config.ts` |
| `FINN_JWKS_URL` | — | JWKS endpoint for token validation | `src/config.ts` |
| `FINN_POOLS_CONFIG` | — | Model pool registry config path | `src/config.ts` |
| `CHEVAL_MODE` | `subprocess` | Model transport (subprocess/sidecar) | `src/config.ts` |

## Configuration Precedence

<!-- provenance: CODE-FACTUAL -->
Resolution order (highest priority first), per `src/config.ts:130`:

<!-- provenance: CODE-FACTUAL -->
1. **CLI flags** — Not currently supported (`src/config.ts:130`)
2. **Environment variables** — Primary configuration method
3. **Defaults** — Hardcoded in `loadConfig()` (`src/config.ts`)

<!-- provenance: CODE-FACTUAL -->
All configuration is loaded once at boot via `loadConfig()` (`src/config.ts:130`) and passed as `FinnConfig` to all subsystems. There is no runtime config reloading.

## Health Checks

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `GET /health` | GET | None | Aggregated health with subsystem checks |
| `GET /api/dashboard/overview` | GET | Bearer | Detailed health: jobs, audit, rate limits |

### Health Aggregator

<!-- provenance: CODE-FACTUAL -->
The `HealthAggregator` (`src/scheduler/health.ts:150`) runs on a 5-minute interval (`HEALTH_INTERVAL_MS`) and checks:

<!-- provenance: CODE-FACTUAL -->
- **Scheduler tasks**: Circuit breaker states for r2_sync, git_sync, health, wal_prune (`src/scheduler/health.ts:150`)
- **Cron jobs**: Active/stuck/disabled counts
- **WAL**: Segment count, last sync timestamp
- **Provider health**: Per-model latency and availability (via `HealthProber` at `src/hounfour/health.ts`)

## Monitoring

### Cost Reports

<!-- provenance: CODE-FACTUAL -->
Budget tracking is per-scope (project, phase, sprint) via `BudgetEnforcer` (`src/hounfour/budget.ts:161`). Cost data stored in Redis (if available) or in-memory.

<!-- provenance: CODE-FACTUAL -->
Ledger entries recorded to `LedgerEntry` records with 16 fields including `provider`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, and `latency_ms` (`src/hounfour/types.ts:163`).

### Circuit Breaker States

<!-- provenance: CODE-FACTUAL -->
Each scheduled task and cron job maintains independent circuit breaker state (`src/scheduler/circuit-breaker.ts:1`):

| State | Behavior |
|-------|----------|
| CLOSED | Normal execution |
| OPEN | Requests blocked, waiting for recovery interval |
| HALF_OPEN | Single test request allowed |

<!-- provenance: INFERRED -->
Transition: failure threshold exceeded → OPEN → recovery interval → HALF_OPEN → success → CLOSED (or failure → OPEN).

### Audit Trail

<!-- provenance: CODE-FACTUAL -->
Hash-chained JSONL at `${DATA_DIR}/audit.jsonl` with 10MB rotation (`src/safety/audit-trail.ts:179`). Verify chain integrity via `AuditTrail.verifyChain()` or `GET /api/dashboard/audit/verify`.

## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| `AUTH_REQUIRED` on API calls | Missing `Authorization: Bearer` header | Set `FINN_AUTH_TOKEN` env var and include in requests (`src/gateway/auth.ts`) |
| R2 sync failures (circuit OPEN) | R2 credentials invalid or endpoint unreachable | Verify `R2_*` env vars; check R2 endpoint with `curl` (`src/persistence/r2-storage.ts`) |
| WebSocket `429 Too Many Connections` | Per-IP limit exceeded (5 max) | Close existing connections or increase limit (`src/gateway/ws.ts`) |
| Cron job auto-disabled | Stuck detection triggered (2h default) | Check job logs at `data/cron/runs/<jobId>.jsonl`; re-enable via `PATCH /api/cron/jobs/:id` (`src/cron/service.ts`) |
| `SANDBOX_SYNC_FALLBACK` error in production | Sync fallback forbidden when `NODE_ENV=production` | Remove `SANDBOX_SYNC_FALLBACK=true` or set `SANDBOX_MODE=worker` (`src/config.ts`) |
| Boot validation failure | Missing required config or file | Check exit code against structured codes in `src/safety/boot-validation.ts` |
| Budget exceeded, model downgraded | Scope cost limit reached | Increase budget limit or reset scope via Redis (`src/hounfour/budget.ts`) |
| Git sync failures | Invalid `GIT_TOKEN` or remote unreachable | Verify `GIT_TOKEN` permissions and `GIT_REMOTE` accessibility (`src/persistence/git-sync.ts`) |

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:07:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
