# Environment Variables

> Source: `src/config.ts` (FinnConfig interface, `loadConfig()` function)

## Required

| Variable | Type | Description |
|----------|------|-------------|
| `ANTHROPIC_API_KEY` | string | Claude API key (required for LLM operations) |

## Core

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `MODEL` | `claude-opus-4-6` | string | Primary LLM model |
| `THINKING_LEVEL` | `medium` | `low\|medium\|high` | Claude thinking depth |
| `BEAUVOIR_PATH` | `grimoires/loa/BEAUVOIR.md` | string | Identity document path |
| `PORT` | `3000` | number | HTTP server port |
| `HOST` | `0.0.0.0` | string | Bind address |
| `DATA_DIR` | `./data` | string | Persistence root (sessions, WAL) |
| `NODE_ENV` | — | string | Environment mode |

## Auth

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_AUTH_TOKEN` | `` | string | Bearer token for API auth (required in prod) |
| `FINN_CORS_ORIGINS` | `localhost:*` | comma-separated | CORS whitelist with wildcard support |

## Sandbox

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_ALLOW_BASH` | `false` | boolean | Enable bash sandbox execution |
| `FINN_SANDBOX_JAIL_ROOT` | `${DATA_DIR}` | string | Sandbox filesystem jail path |
| `FINN_SANDBOX_TIMEOUT` | `30000` | number (ms) | Max command execution time |
| `FINN_SANDBOX_MAX_OUTPUT` | `65536` | number (bytes) | Max stderr/stdout buffer |
| `SANDBOX_MODE` | `worker` | `worker\|child_process\|disabled` | Execution mode |
| `SANDBOX_SYNC_FALLBACK` | `false` | boolean | Dev-only sync fallback (forbidden in prod) |

## Persistence — R2

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `R2_ENDPOINT` | `` | string | Cloudflare R2 endpoint URL |
| `R2_BUCKET` | `loa-finn-data` | string | R2 bucket name |
| `R2_ACCESS_KEY_ID` | `` | string | R2 access key |
| `R2_SECRET_ACCESS_KEY` | `` | string | R2 secret key |

## Persistence — Git

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `GIT_REMOTE` | `origin` | string | Git remote name for archive |
| `GIT_BRANCH` | `main` | string | Git branch for code fetch |
| `GIT_ARCHIVE_BRANCH` | `finn/archive` | string | Git branch for checkpoint storage |
| `GIT_TOKEN` | `` | string | GitHub PAT for git operations |

## Scheduling

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `SYNC_INTERVAL_MS` | `30000` | number (ms) | WAL sync frequency |
| `GIT_SYNC_INTERVAL_MS` | `3600000` | number (ms) | Git archive snapshot interval (1h) |
| `HEALTH_INTERVAL_MS` | `300000` | number (ms) | Health check tick (5m) |

## Rate Limiting

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_RATE_LIMIT_WINDOW_MS` | `60000` | number (ms) | Rate limit bucket window |
| `FINN_RATE_LIMIT_MAX` | `60` | number | Max requests per window |

## Worker Pool

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_WORKER_POOL_SIZE` | `2` or CPU-1 | number | Interactive worker threads |
| `FINN_WORKER_SHUTDOWN_MS` | `10000` | number (ms) | Worker graceful shutdown deadline |
| `FINN_WORKER_QUEUE_DEPTH` | `10` | number | Max queued jobs per lane |

## Redis (Optional)

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `REDIS_URL` | `` | string | Redis connection (`redis://host:port`) |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | number (ms) | Connection timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | `3000` | number (ms) | Command execution timeout |

## Multi-Model (Phase 5 — Hounfour)

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `CHEVAL_MODE` | `subprocess` | `subprocess\|sidecar` | Model invocation transport |
| `FINN_POOLS_CONFIG` | `` | string | Model pool registry config path |

## S2S JWT (Phase 5)

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_S2S_PRIVATE_KEY` | `` | string | ES256 private key PEM |
| `FINN_S2S_KID` | `loa-finn-v1` | string | JWT key ID |
| `FINN_S2S_ISSUER` | `loa-finn` | string | S2S JWT issuer |
| `FINN_S2S_AUDIENCE` | `arrakis` | string | S2S JWT audience |

## JWT Validation (Phase 5)

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FINN_JWT_ENABLED` | `false` | boolean | Enable JWT validation for `/api/v1/*` |
| `FINN_JWT_ISSUER` | `arrakis` | string | Expected JWT issuer |
| `FINN_JWT_AUDIENCE` | `loa-finn` | string | Expected JWT audience |
| `FINN_JWKS_URL` | `` | string | JWKS endpoint for token validation |
| `FINN_JWT_CLOCK_SKEW` | `30` | number (seconds) | Clock skew tolerance |
| `FINN_JWT_MAX_LIFETIME` | `3600` | number (seconds) | Max token age |

## GitHub Integration

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `GITHUB_TOKEN` | `` | string | GitHub API token (activity feed) |
| `BRIDGEBUILDER_REPOS` | `` | comma-separated | Repos to monitor for activity |
| `BRIDGEBUILDER_BOT_USER` | `` | string | Bot username for activity filtering |
