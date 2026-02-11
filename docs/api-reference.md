# API Reference

<!-- AGENT-CONTEXT: name=loa-finn-api, type=api, purpose=HTTP and WebSocket API endpoint documentation, key_files=[src/gateway/server.ts, src/gateway/auth.ts, src/gateway/cron-api.ts, src/gateway/workflow-api.ts, src/gateway/ws.ts, src/hounfour/jwt-auth.ts], interfaces=[createApp, authMiddleware, jwtAuthMiddleware, handleWebSocket], dependencies=[hono, ws, jose], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## Authentication Overview

<!-- provenance: CODE-FACTUAL -->
loa-finn uses a dual authentication system (`src/gateway/server.ts:44`):

| Auth Type | Scope | Mechanism | Source |
|-----------|-------|-----------|--------|
| **Bearer Token** | `/api/*` (except `/api/v1/*`) | `Authorization: Bearer <token>` with timing-safe SHA-256 comparison | `src/gateway/auth.ts` |
| **JWT (ES256)** | `/api/v1/*` | Arrakis-issued JWT with tenant claims, JWKS validation, JTI replay guard | `src/hounfour/jwt-auth.ts` |
| **WebSocket Token** | `/ws/:sessionId` | Query param `?token=` or first message `{ token: string }` | `src/gateway/ws.ts` |
| **None** | `/`, `/health`, `/dashboard`, `/.well-known/jwks.json` | Public endpoints | `src/gateway/server.ts` |

<!-- provenance: CODE-FACTUAL -->
**Dev mode**: Auth is skipped when `FINN_AUTH_TOKEN` is empty (`src/gateway/auth.ts:12`).

## Endpoint Summary

### Public Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | `src/gateway/server.ts` | Serve WebChat UI (index.html) |
| GET | `/health` | `src/gateway/server.ts` | Aggregated health check |
| GET | `/dashboard` | `src/gateway/server.ts` | Serve Dashboard UI |
| GET | `/.well-known/jwks.json` | `src/gateway/server.ts` | S2S JWT public key (Phase 5) |

### Internal Endpoints (Bearer Auth)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/sessions` | `src/gateway/server.ts` | Create agent session |
| GET | `/api/sessions` | `src/gateway/server.ts` | List active sessions |
| GET | `/api/sessions/:id` | `src/gateway/server.ts` | Get session details |
| POST | `/api/sessions/:id/message` | `src/gateway/server.ts` | Send sync message |
| POST | `/api/cron/jobs` | `src/gateway/cron-api.ts` | Create cron job |
| GET | `/api/cron/jobs` | `src/gateway/cron-api.ts` | List all cron jobs |
| PATCH | `/api/cron/jobs/:id` | `src/gateway/cron-api.ts` | Update job (field allowlist) |
| DELETE | `/api/cron/jobs/:id` | `src/gateway/cron-api.ts` | Delete job |
| POST | `/api/cron/jobs/:id/trigger` | `src/gateway/cron-api.ts` | Manually trigger job |
| GET | `/api/cron/jobs/:id/logs` | `src/gateway/cron-api.ts` | Paginated run history |
| POST | `/api/cron/kill-switch` | `src/gateway/cron-api.ts` | Global cron shutdown |
| GET | `/api/workflow/runs` | `src/gateway/workflow-api.ts` | List workflow runs |
| GET | `/api/workflow/runs/:id` | `src/gateway/workflow-api.ts` | Get workflow run |
| POST | `/api/workflow/runs/:id/steps/:step/approve` | `src/gateway/workflow-api.ts` | Approve workflow step |

### Admin Endpoints (Bearer + Dashboard Auth)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/dashboard/overview` | `src/gateway/dashboard-routes.ts` | Health snapshot (jobs, audit, rates) |
| GET | `/api/dashboard/activity` | `src/gateway/dashboard-activity-api.ts` | GitHub activity feed |
| GET | `/api/dashboard/audit` | `src/gateway/dashboard-audit-api.ts` | Paginated audit trail |
| GET | `/api/dashboard/audit/verify` | `src/gateway/dashboard-audit-api.ts` | Verify audit chain integrity |

### Multi-Tenant Endpoints (JWT Auth)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `*` | `/api/v1/*` | `src/gateway/server.ts` | JWT-authenticated routes with rate limiting |

## Per-Endpoint Details

### Public

#### `GET /health`

<!-- provenance: OPERATIONAL -->
Returns aggregated health status.

```json
{
  "status": "healthy",
  "checks": {
    "scheduler": { "status": "ok", "tasks": 4 },
    "persistence": { "status": "ok", "wal_segments": 12 },
    "providers": { "status": "ok", "available": 2 }
  }
}
```

<!-- provenance: OPERATIONAL -->
**Status codes**: 200 (healthy), 503 (degraded)

### Internal

#### `POST /api/sessions`

<!-- provenance: OPERATIONAL -->
Create a new agent session.

<!-- provenance: OPERATIONAL -->
**Request**:
```json
{
  "model": "claude-opus-4-6",
  "persona": "default"
}
```

<!-- provenance: OPERATIONAL -->
**Response** (201):
```json
{
  "sessionId": "01HXYZ...",
  "wsUrl": "ws://localhost:3000/ws/01HXYZ..."
}
```

#### `POST /api/sessions/:id/message`

<!-- provenance: OPERATIONAL -->
Send a synchronous message (non-streaming).

<!-- provenance: OPERATIONAL -->
**Request**:
```json
{
  "text": "Hello, what can you help me with?"
}
```

<!-- provenance: OPERATIONAL -->
**Response** (200):
```json
{
  "role": "assistant",
  "content": "...",
  "tool_calls": []
}
```

#### `POST /api/cron/jobs`

<!-- provenance: CODE-FACTUAL -->
Create a cron job (`src/gateway/cron-api.ts:78`).

<!-- provenance: OPERATIONAL -->
**Request**:
```json
{
  "name": "daily-sync",
  "schedule": { "expression": "0 0 * * *", "timezone": "UTC" },
  "concurrencyPolicy": "skip",
  "enabled": true
}
```

<!-- provenance: OPERATIONAL -->
**Response** (201): Full `CronJob` object with generated `id`.

#### `PATCH /api/cron/jobs/:id`

<!-- provenance: CODE-FACTUAL -->
Update job configuration. Uses field allowlist to prevent mass-assignment (`src/gateway/cron-api.ts:143`).

<!-- provenance: OPERATIONAL -->
**Allowed fields**: `name`, `schedule`, `concurrencyPolicy`, `enabled`, `oneShot`

#### `POST /api/cron/kill-switch`

<!-- provenance: OPERATIONAL -->
Toggle global cron shutdown.

<!-- provenance: OPERATIONAL -->
**Request**:
```json
{ "active": true }
```

<!-- provenance: OPERATIONAL -->
**Response** (200):
```json
{ "killSwitch": true }
```

#### `GET /api/cron/jobs/:id/logs`

<!-- provenance: CODE-FACTUAL -->
Paginated run history from JSONL logs (`src/cron/job-registry.ts:1`).

<!-- provenance: OPERATIONAL -->
**Query params**: `?limit=50&offset=0`

<!-- provenance: OPERATIONAL -->
**Response** (200):
```json
{
  "runs": [
    {
      "runUlid": "01HXYZ...",
      "startedAt": "2026-02-11T00:00:00Z",
      "status": "success",
      "durationMs": 1234
    }
  ],
  "total": 100
}
```

## WebSocket Contracts

### Connection

```
ws://localhost:3000/ws/:sessionId?token=<bearer_token>
```

<!-- provenance: CODE-FACTUAL -->
**Limits** (`src/gateway/ws.ts:23`):
- Max payload: 1 MB
- Idle timeout: 5 minutes
- Per-IP connections: 5 max

### Client → Server Messages

| Type | Schema | Description |
|------|--------|-------------|
| `prompt` | `{ type: "prompt", text: string }` | Execute agent with text |
| `steer` | `{ type: "steer", text: string }` | Provide steering input |
| `abort` | `{ type: "abort" }` | Cancel current execution |
| `ping` | `{ type: "ping" }` | Keep-alive |

### Server → Client Messages

| Type | Schema | Description |
|------|--------|-------------|
| `text_delta` | `{ type: "text_delta", data: { delta: string } }` | Streaming text chunk |
| `tool_start` | `{ type: "tool_start", data: { toolName: string, args: object } }` | Tool invocation |
| `tool_end` | `{ type: "tool_end", data: { toolName: string, result: any, isError: boolean } }` | Tool result |
| `turn_end` | `{ type: "turn_end" }` | Agent turn complete |
| `agent_end` | `{ type: "agent_end" }` | Agent session done |
| `compaction` | `{ type: "compaction", data: { reason: string } }` | Auto-compaction |
| `error` | `{ type: "error", data: { message: string, recoverable: boolean } }` | Error |
| `authenticated` | `{ type: "authenticated" }` | Auth success confirmation |
| `pong` | `{ type: "pong" }` | Ping response |

### Auth Handshake

<!-- provenance: OPERATIONAL -->
Two authentication methods:

<!-- provenance: OPERATIONAL -->
1. **Query parameter**: Include `?token=<bearer>` in WebSocket URL
2. **First message**: Send `{ "token": "YOUR_TOKEN" }` as first message after connection

<!-- provenance: OPERATIONAL -->
On success, server sends `{ type: "authenticated" }`. On failure, connection closes with code 4001.

## Error Response Format

<!-- provenance: CODE-FACTUAL -->
All API errors follow a consistent format (`src/gateway/auth.ts:34`, `src/gateway/cron-api.ts`):

```json
{
  "error": "Unauthorized",
  "code": "AUTH_REQUIRED",
  "message": "Bearer token required"
}
```

### Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AUTH_REQUIRED` | 401 | Missing auth header |
| `AUTH_INVALID` | 401 | Invalid token |
| `JWT_EXPIRED` | 401 | JWT token expired |
| `JWT_INVALID` | 401 | JWT validation failed |
| `JWT_REPLAY` | 401 | JTI already used |
| `RATE_LIMITED` | 429 | Too many requests |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request body |
| `KILL_SWITCH_ACTIVE` | 503 | Cron kill switch engaged |

### Rate Limiting

<!-- provenance: CODE-FACTUAL -->
Bearer-authenticated routes enforce per-IP rate limits (`src/gateway/rate-limit.ts:16`):
- **Window**: `FINN_RATE_LIMIT_WINDOW_MS` (default: 60s)
- **Max requests**: `FINN_RATE_LIMIT_MAX` (default: 60)
- **Headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:07:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
