# Gateway — HTTP & WebSocket API

<!-- AGENT-CONTEXT: name=gateway, type=module, purpose=HTTP and WebSocket entry points with auth and rate limiting, key_files=[src/gateway/server.ts, src/gateway/auth.ts, src/gateway/ws.ts, src/gateway/cron-api.ts, src/gateway/csrf.ts], interfaces=[createApp, authMiddleware, corsMiddleware, handleWebSocket, CronApi], dependencies=[hono, @hono/node-server, ws], version=1ef38a64bfda4b35c37707c710fc9b796ada7ee5 -->

## Purpose

<!-- provenance: CODE-FACTUAL -->
The gateway module provides all external-facing entry points — HTTP routes, WebSocket streaming, authentication middleware, rate limiting, and dashboard APIs. It uses Hono v4 as the HTTP framework with ws for WebSocket support (`src/gateway/server.ts:1`).

## Key Interfaces

### createApp (`src/gateway/server.ts`)

```typescript
function createApp(config: FinnConfig, options: AppOptions): { app: Hono, router: SessionRouter }
```

<!-- provenance: CODE-FACTUAL -->
Registers all routes and middleware in a single Hono application (`src/gateway/server.ts:1`).

### Auth Middleware (`src/gateway/auth.ts`)

<!-- provenance: CODE-FACTUAL -->
| Middleware | Scope | Mechanism |
|-----------|-------|-----------|
| `authMiddleware(config)` | `/api/*` | Bearer token, timing-safe SHA-256 |
| `corsMiddleware(config)` | All routes | Origin whitelist with wildcards |
| `validateWsToken(token, config)` | WebSocket | Same as bearer auth |

(Reference: `src/gateway/auth.ts:1`)

### WebSocket Handler (`src/gateway/ws.ts`)

<!-- provenance: CODE-FACTUAL -->
Handles `/ws/:sessionId` connections with streaming events. 8 server-to-client message types: `text_delta`, `tool_start`, `tool_end`, `turn_end`, `agent_end`, `compaction`, `error`, `authenticated` (`src/gateway/ws.ts:1`).

<!-- provenance: CODE-FACTUAL -->
**Limits**: 1MB payload, 5min idle timeout, 5 connections per IP (`src/gateway/ws.ts:1`).

## Architecture

<!-- provenance: INFERRED -->
```
Client → Hono App
          ├─→ CORS Middleware
          ├─→ CSRF Middleware (dashboard)
          ├─→ Auth (Bearer or JWT)
          ├─→ Rate Limiter
          ├─→ Route Handler
          │     ├─→ Session API (create, list, message)
          │     ├─→ Cron API (CRUD + trigger + kill-switch)
          │     ├─→ Workflow API (runs + approval)
          │     └─→ Dashboard API (overview, audit, activity)
          └─→ WebSocket Upgrade → ws handler
```

## Components (17 files)

<!-- provenance: CODE-FACTUAL -->
| File | Responsibility |
|------|---------------|
| `server.ts` | Route registration, middleware composition |
| `auth.ts` | Bearer token and CORS middleware |
| `ws.ts` | WebSocket handler with streaming events |
| `csrf.ts` | Double-submit cookie CSRF protection |
| `rate-limit.ts` | Per-IP sliding window rate limiter |
| `redaction-middleware.ts` | Secret field redaction in responses |
| `cron-api.ts` | Cron job CRUD + trigger + kill-switch |
| `workflow-api.ts` | Workflow run listing and step approval |
| `dashboard-routes.ts` | Health overview aggregation |
| `dashboard-auth.ts` | Dashboard RBAC (viewer/operator roles) |
| `dashboard-rate-limit.ts` | Dashboard-specific rate limiting |
| `dashboard-audit-api.ts` | Paginated audit trail API |
| `dashboard-activity-api.ts` | GitHub activity feed API |
| `sessions.ts` | Session router and management |
| `stream-bridge.ts` | Agent event to WebSocket bridge |
| `ws-broadcast.ts` | WebSocket broadcast utilities |

(Reference: `src/gateway/server.ts:1`)

## Dependencies

<!-- provenance: CODE-FACTUAL -->
- **Internal**: `src/hounfour/` (JWT auth), `src/safety/` (audit trail, redaction), `src/cron/` (job service)
- **External**: `hono` v4, `@hono/node-server`, `ws` v8 (`src/gateway/server.ts:1`)

## Known Limitations

<!-- provenance: CODE-FACTUAL -->
- No horizontal scaling — single Hono instance per deployment (`src/gateway/server.ts:1`)
- Max 5 concurrent WebSocket connections per IP (`src/gateway/ws.ts:1`)

<!-- ground-truth-meta: head_sha=689a777 generated_at=2026-02-11T01:12:00Z features_sha=689a777 limitations_sha=689a777 ride_sha=689a777 -->
