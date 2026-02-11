# Route Registrations

> Source: `src/gateway/server.ts`, `src/gateway/cron-api.ts`, `src/gateway/workflow-api.ts`, `src/gateway/dashboard-routes.ts`, `src/gateway/ws.ts`

## HTTP Routes

### Public (No Auth)

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| GET | `/` | server.ts | Serve WebChat UI (index.html) |
| GET | `/health` | server.ts | Health aggregator with subsystem checks |
| GET | `/dashboard` | server.ts | Serve Dashboard UI (dashboard.html) |
| GET | `/.well-known/jwks.json` | server.ts | S2S JWT public key (Phase 5) |

### Bearer Token Auth (`/api/*` except `/api/v1/*`)

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| POST | `/api/sessions` | server.ts | Create agent session (returns sessionId + wsUrl) |
| GET | `/api/sessions` | server.ts | List all active sessions |
| GET | `/api/sessions/:id` | server.ts | Get session state, message count |
| POST | `/api/sessions/:id/message` | server.ts | Sync prompt with tool collection |
| GET | `/api/dashboard/activity` | server.ts | BridgeBuilder activity feed |
| POST | `/api/cron/jobs` | cron-api.ts | Create cron job |
| GET | `/api/cron/jobs` | cron-api.ts | List all jobs |
| PATCH | `/api/cron/jobs/:id` | cron-api.ts | Update job config (field allowlist) |
| DELETE | `/api/cron/jobs/:id` | cron-api.ts | Delete job |
| POST | `/api/cron/jobs/:id/trigger` | cron-api.ts | Manual trigger execution |
| GET | `/api/cron/jobs/:id/logs` | cron-api.ts | Paginated run history (JSONL) |
| POST | `/api/cron/kill-switch` | cron-api.ts | Global cron shutdown control |
| GET | `/api/workflow/runs` | workflow-api.ts | List workflow runs (filterable) |
| GET | `/api/workflow/runs/:id` | workflow-api.ts | Get specific run record |
| POST | `/api/workflow/runs/:id/steps/:step/approve` | workflow-api.ts | Multi-step approval |
| GET | `/api/dashboard/overview` | dashboard-routes.ts | Aggregated health snapshot |

### Dashboard APIs (Bearer + RBAC)

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| GET | `/api/dashboard/audit` | dashboard-audit-api.ts | Paginated audit trail with filters |
| GET | `/api/dashboard/audit/verify` | dashboard-audit-api.ts | Verify audit chain integrity |
| GET | `/api/dashboard/activity` | dashboard-activity-api.ts | GitHub activity feed (grouped by type) |

### JWT Auth (`/api/v1/*` — Phase 5 arrakis)

| Method | Path | Source | Purpose |
|--------|------|--------|---------|
| `*` | `/api/v1/*` | server.ts | JWT middleware + rate limiting |

## WebSocket

- **Path**: `/ws/:sessionId`
- **Source**: `src/gateway/ws.ts`
- **Auth**: Bearer token via query param `?token=` or first message `{ token: string }`
- **Limits**: 1MB payload, 5 min idle timeout, 5 connections per IP

### Client → Server Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `prompt` | `text: string` | Execute agent |
| `steer` | `text: string` | Steering input |
| `abort` | — | Cancel execution |
| `ping` | — | Keep-alive |

### Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `text_delta` | `delta: string` | Streaming text |
| `tool_start` | `toolName, args` | Tool invocation |
| `tool_end` | `toolName, result, isError` | Tool result |
| `turn_end` | — | Turn complete |
| `agent_end` | — | Agent done |
| `compaction` | `reason` | Auto-compaction triggered |
| `error` | `message, recoverable` | Error |
| `authenticated` | — | Auth success |
| `pong` | — | Ping response |

## Scheduled Tasks (registered in `src/index.ts`)

| Task ID | Interval | Source |
|---------|----------|--------|
| `r2_sync` | `SYNC_INTERVAL_MS` (30s default) | WAL → R2 checkpoint sync |
| `git_sync` | `GIT_SYNC_INTERVAL_MS` (1h default) | Git archive snapshot |
| `health` | `HEALTH_INTERVAL_MS` (5m default) | Health check tick |
| `wal_prune` | `SYNC_INTERVAL_MS` (30s default) | WAL segment pruning |
