# Sprint 119: Concurrency & Resilience — Implementation Report

> **Sprint**: 119 (local: sprint-9) | **Cycle**: cycle-029 (bridge iteration 1)
> **Date**: 2026-02-21
> **Agent**: Claude Opus 4.6
> **Dependencies**: Sprint 118 (Protocol Persistence & Correctness)

---

## Summary

Sprint 119 addresses 4 MEDIUM findings from the Bridgebuilder review (medium-1, medium-2, medium-3, medium-5). State machine transitions are now atomic via entry-level locking. Reconciliation creates WAL audit trails. Redis failure triggers graceful degradation. Nonce cleanup prevents unbounded growth.

**36 new tests, 158 total passing** (Sprint 118 + 119 combined).

---

## Task Implementations

### T2.1: Entry-Level Locking for Billing State Machine (medium-1)

**Files Modified:**
- `src/billing/state-machine.ts` — Added locking deps, locked transition methods, and `withEntryLock` helper

**Files Created:**
- `tests/billing/entry-locking.test.ts` — 9 tests

**Implementation:**

Added optional `acquireLock` and `releaseLock` to `BillingStateMachineDeps` interface. Lock pattern: `SET billing:lock:{entryId} {correlationId} NX EX 30`. When lock not acquired, returns `{ ok: false, reason: "lock_contention" }` (not throw — graceful contention handling).

Three locked methods: `lockedCommit`, `lockedRelease`, `lockedVoid`. Each wraps the corresponding unlocked method with `withEntryLock`, which:
1. Checks if `acquireLock` is provided (backward compat — direct execution without lock if not)
2. Acquires lock; returns `lock_contention` if held by another correlation
3. Executes transition in try/finally to guarantee lock release

**Acceptance Criteria:**
- ✅ Before any state transition, acquire Redis lock via `SET NX EX 30`
- ✅ If lock not acquired → return error (not throw)
- ✅ After transition → release lock
- ✅ Lock TTL prevents deadlocks from crashed processes
- ✅ Test: two concurrent calls → one succeeds, one gets lock error

### T2.2: Audit Trail for Reconciliation Corrections (medium-2)

**Files Modified:**
- `src/billing/reconciliation.ts` — Added RECONCILIATION_CORRECTION WAL entries, `generateRunId` dep, `reconciliationRunId` tracking

**Files Created:**
- `tests/billing/reconciliation-audit.test.ts` — 4 tests

**Implementation:**

Before overwriting Redis with derived balance, the reconciliation service now appends a `RECONCILIATION_CORRECTION` event to WAL containing:
- `account`: the divergent account
- `derived_balance`: WAL-derived correct balance
- `cached_balance`: stale Redis balance
- `delta`: the difference
- `reconciliation_run_id`: unique ID for this reconciliation run
- `timestamp`: when the correction occurred

The `generateRunId` dep is optional — falls back to `recon-{timestamp}-{random}` if not provided. The final summary WAL entry also includes the `reconciliation_run_id` for correlation.

**Acceptance Criteria:**
- ✅ Before overwriting Redis, append RECONCILIATION_CORRECTION to WAL
- ✅ Correction entry includes both old and new values
- ✅ Reconciliation run ID links corrections to their summary
- ✅ Test: divergence triggers WAL correction entry

### T2.3: Redis Health + Graceful Degradation Mode (medium-3)

**Files Created:**
- `src/gateway/redis-health.ts` — Circuit breaker + degradation modes
- `tests/gateway/redis-health.test.ts` — 17 tests

**Implementation:**

`RedisHealthMonitor` implements the circuit breaker pattern:
- **CLOSED** → normal operation, Redis available
- **OPEN** → Redis unavailable, all operations degraded (after `failureThreshold` consecutive failures)
- **HALF_OPEN** → single probe allowed after `resetTimeoutMs` (success → CLOSED, failure → OPEN)

`SUBSYSTEM_DEGRADATION` map defines per-subsystem behavior:
- `x402_nonce`: FAIL_CLOSED (503) — cannot verify payment without nonce store
- `siwe_nonce`: FAIL_CLOSED (401) — cannot authenticate without nonce store
- `rate_limit`: IN_MEMORY_FALLBACK — degrade to in-memory token bucket
- `api_key_cache`: DB_FALLBACK — fall through to Postgres

`withRedisGuard` helper wraps Redis operations: if circuit is open, returns degradation mode immediately without attempting Redis. On failure, records failure and returns degradation mode.

**Acceptance Criteria:**
- ✅ Circuit breaker with CLOSED → OPEN → HALF_OPEN → CLOSED transitions
- ✅ x402 returns 503 when Redis down
- ✅ SIWE returns 401 when Redis down
- ✅ Rate limiter degrades to in-memory
- ✅ API key validation falls through to DB
- ✅ `onStateChange` callback for observability

### T2.4: Nonce Cleanup Scheduling (medium-5)

**Files Created:**
- `src/credits/nonce-cleanup.ts` — Cron-based cleanup service
- `tests/credits/nonce-cleanup.test.ts` — 6 tests

**Implementation:**

`NonceCleanupService` wraps `cleanupExpiredNonces` (from Sprint 118's `credit-persistence.ts`) in a Croner cron job:
- Default schedule: every hour at :30 (`30 * * * *`)
- Default max age: 24 hours
- `onCleanup` callback for Prometheus metrics integration
- `runCleanup()` also callable outside cron for ad-hoc/testing
- `start()`/`stop()` lifecycle (idempotent)
- Cron wrapper catches errors (resilience — matches `ReconciliationService` pattern)

**Acceptance Criteria:**
- ✅ Nonces older than 24h cleaned up periodically
- ✅ Cleanup job runs on schedule (hourly default)
- ✅ Metrics callback for observability
- ✅ Cron resilience — errors don't crash the service

---

## Test Results

```
Test Files  11 passed (11)
     Tests  158 passed (158)
  Duration  569ms
```

All 122 Sprint 118 tests + 36 new Sprint 119 tests pass.

**New test files:**
| File | Tests | Coverage |
|------|-------|----------|
| `tests/billing/entry-locking.test.ts` | 9 | Lock acquire/release, contention, backward compat, concurrent access |
| `tests/billing/reconciliation-audit.test.ts` | 4 | Correction WAL entries, no-divergence, multi-account, run ID |
| `tests/gateway/redis-health.test.ts` | 17 | Circuit breaker states, degradation modes, withRedisGuard |
| `tests/credits/nonce-cleanup.test.ts` | 6 | Cleanup execution, config, lifecycle, error handling |

---

## Files Changed

| File | Change | Task |
|------|--------|------|
| `src/billing/state-machine.ts` | Modified — added locking deps, locked methods, withEntryLock | T2.1 |
| `src/billing/reconciliation.ts` | Modified — added RECONCILIATION_CORRECTION WAL entries | T2.2 |
| `src/gateway/redis-health.ts` | New — circuit breaker + degradation modes | T2.3 |
| `src/credits/nonce-cleanup.ts` | New — cron-based nonce cleanup service | T2.4 |
| `tests/billing/entry-locking.test.ts` | New — 9 tests | T2.1 |
| `tests/billing/reconciliation-audit.test.ts` | New — 4 tests | T2.2 |
| `tests/gateway/redis-health.test.ts` | New — 17 tests | T2.3 |
| `tests/credits/nonce-cleanup.test.ts` | New — 6 tests | T2.4 |
