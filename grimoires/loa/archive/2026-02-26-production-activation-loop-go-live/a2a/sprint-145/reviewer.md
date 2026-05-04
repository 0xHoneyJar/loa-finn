# Sprint 145 (Sprint 2): Admin API + Dixie Transport + Graduation Metrics — Implementation Report

> **Cycle**: cycle-035 — Production Activation & Loop Go-Live
> **Sprint**: 2 (Global ID: 145)
> **Status**: ALL TASKS COMPLETE (8/8)
> **Tests**: 33 passing across 3 test files
> **Branch**: `feature/hounfour-v820-upgrade`

---

## Task Summary

| Task | Title | Status | Files |
|------|-------|--------|-------|
| T-2.1 | Admin API routes (JWKS + audit-first) | CLOSED | `src/gateway/routes/admin.ts` (rewrite) |
| T-2.2 | Wire admin JWKS into boot + server | CLOSED | `src/gateway/server.ts` (modified) |
| T-2.3 | DixieHttpTransport (circuit breaker + DNS) | CLOSED | `src/hounfour/goodhart/dixie-transport.ts` (rewrite) |
| T-2.4 | Register in GracefulShutdown | CLOSED | Via AppOptions pattern (no separate file) |
| T-2.5 | Prometheus graduation metrics | CLOSED | `src/hounfour/graduation-metrics.ts` (new) |
| T-2.6 | Wire metrics into routing engine | CLOSED | `src/hounfour/goodhart/mechanism-interaction.ts` (modified) |
| T-2.7 | Unit tests: Admin API | CLOSED | `tests/finn/gateway/admin-routes.test.ts` (new) |
| T-2.8 | Unit tests: Transport + metrics | CLOSED | `tests/finn/hounfour/dixie-transport.test.ts`, `tests/finn/hounfour/graduation-metrics.test.ts` (new) |

---

## Implementation Details

### T-2.1: Admin API (`src/gateway/routes/admin.ts`)

**Rewritten.** Two-tier auth:
- **JWKS JWT (ES256)**: For routing mode changes (`GET/POST /mode`). Uses `jose.jwtVerify()` with `createLocalJWKSet` key resolver. Role check: requires `operator` or `admin`.
- **FINN_AUTH_TOKEN**: For seed-credits (preserved from Sprint 3 E2E support).

Audit-first semantics for mode change:
1. Write audit intent via `auditAppend()` BEFORE Redis set
2. If audit fails → 503 (fail-closed, `AUDIT_FAILED`)
3. If Redis fails after audit → 503 (`MODE_CHANGE_FAILED`, detectable state)
4. Best-effort failure audit on Redis error

Per-subject rate limit: 5 mode changes per subject per hour (in-memory Map with 1h window reset).

### T-2.3: DixieHttpTransport (`src/hounfour/goodhart/dixie-transport.ts`)

**Rewritten.** Upgraded from raw `fetch()` to production-ready transport:
- **Circuit breaker**: 3-failure threshold → open → 5min cooldown → half-open probe
- **Timeout**: 300ms default via `AbortSignal.timeout()`, composed with caller's signal via `AbortSignal.any()`
- **DNS warming**: `dns.promises.lookup()` on construction + periodic refresh (60s default, `unref`'d)
- **Keep-alive**: Node.js fetch uses undici internally with keep-alive by default
- **Shutdown**: Clears DNS timer on shutdown

### T-2.5: Graduation Metrics (`src/hounfour/graduation-metrics.ts`)

**New module.** Lightweight Prometheus text format without external dependencies:
- Counters: `finn_shadow_total`, `finn_shadow_diverged`, `finn_reputation_query_total`, `finn_exploration_total`, `finn_ema_updates_total`, `finn_routing_mode_transitions_total`
- Histogram: `finn_reputation_query_duration_seconds` (buckets: 10ms, 50ms, 100ms, 300ms, 500ms, 1s, 5s)
- Fixed label sets (tier, status) — no nftId/poolId to prevent cardinality explosion
- Convenience methods: `recordShadowDecision()`, `recordReputationQuery()`, etc.

### T-2.6: Metrics Wiring (`mechanism-interaction.ts`)

Added optional `metrics` field to `MechanismConfig`. Wired in:
- Shadow path: `metrics.recordShadowDecision(tier, diverged)` — increments `finn_shadow_total` and conditionally `finn_shadow_diverged`
- Exploration path: `metrics.recordExploration(tier)`

### T-2.2/T-2.4: Server Wiring

Added to `AppOptions`: `adminJwksResolver`, `runtimeConfig`, `auditAppend`, `graduationMetrics`. Admin routes receive all deps. `/metrics` endpoint serves Prometheus text format.

---

## Test Coverage

| File | Tests | Coverage |
|------|-------|----------|
| `admin-routes.test.ts` | 14 | JWT: missing/invalid/wrong-kid/wrong-role/valid-operator/valid-admin/no-JWKS. Mode change: audit-first, invalid mode, audit failure (503), Redis failure (503), rate limit. Seed-credits: no token env, valid token. |
| `dixie-transport.test.ts` | 8 | Stub: null. HTTP: circuit breaker open/reset, timeout, valid response, 404, shutdown, URL validation. |
| `graduation-metrics.test.ts` | 11 | Counters: shadow/diverged/query/exploration/EMA/transitions. Histogram: latency buckets. Export: Prometheus format. Reset. Label cardinality. |

---

## Files Changed

### New Files (4)
- `src/hounfour/graduation-metrics.ts`
- `tests/finn/gateway/admin-routes.test.ts`
- `tests/finn/hounfour/dixie-transport.test.ts`
- `tests/finn/hounfour/graduation-metrics.test.ts`

### Modified Files (4)
- `src/gateway/routes/admin.ts` — Rewritten with JWKS JWT auth + audit-first mode change
- `src/hounfour/goodhart/dixie-transport.ts` — Rewritten with circuit breaker + DNS warming
- `src/hounfour/goodhart/mechanism-interaction.ts` — Added metrics config + wiring
- `src/gateway/server.ts` — Added admin JWKS/metrics/runtimeConfig AppOptions + /metrics endpoint

---

## Acceptance Criteria Verification

- **AC8/AC9**: Dixie up → reputation response; Dixie down → null (deterministic routing)
- **AC10**: Circuit breaker opens after 3 failures — verified in test
- **AC7**: `/metrics` returns Prometheus-format counters — verified in graduation-metrics test
- **AC15**: Shadow total + diverged counters wired into mechanism-interaction
- **Audit-first**: Audit intent written BEFORE Redis set — verified in admin-routes test
- **Fail-closed**: Audit failure → 503 — verified in test
- **Rate limit**: 5/hour per subject — verified in test
- **JWT auth**: ES256, kid selection, role check — verified in 7 auth tests
