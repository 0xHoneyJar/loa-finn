# Sprint 68 (sprint-1): E2E Billing Loop + Conservation Hardening — Implementation Report

## Summary

Implemented the complete billing state machine with WAL-authoritative commit model, double-entry ledger, DLQ processor, circuit breaker, WAL replay engine, atomic reserve Lua scripts, and billing observability metrics. Applied conservation guard hardening from PR #79 Bridgebuilder review.

## Tasks Completed

### Task 1.1: Billing State Machine — Core Types + State Transitions
- **Files**: `src/billing/types.ts`, `src/billing/state-machine.ts`
- **AC Coverage**: All 8 billing states (IDLE, RESERVE_HELD, COMMITTED, FINALIZE_PENDING, FINALIZE_ACKED, FINALIZE_FAILED, RELEASED, VOIDED). Valid transition adjacency list. WAL envelope versioning (Flatline IMP-002) with schema_version, event_type, CRC32 checksum. WAL durability (Flatline SKP-001) via CRC32 per record. BillingStateError with current state and attempted transition.

### Task 1.2: Double-Entry Ledger — Journal Entries + Posting Rules
- **Files**: `src/billing/ledger.ts`
- **AC Coverage**: JournalEntry and Posting interfaces. Zero-sum invariant enforced at write time (hard error). Canonical accounts (user:available, user:held, system:revenue, etc.). Posting rule factories for all 6 event types. Idempotent replay via dedup key. Balance derivation.

### Task 1.3: DLQ Processor — Redis Streams + Consumer Group
- **Files**: `src/billing/dlq.ts`
- **AC Coverage**: Redis Streams with XADD/XREADGROUP/consumer group. Exponential backoff (1s→16s). Poison message handling. Three distinct hold concepts (reserve TTL, committed-never-release, FINALIZE_FAILED escalation). Automated bulk replay (Flatline SKP-003). Capped risk unblocking at MAX_PENDING_RISK_LIMIT_CU=500.

### Task 1.4: Circuit Breaker — Finalize Health Check
- **Files**: `src/billing/circuit-breaker.ts`
- **AC Coverage**: 3-state machine (CLOSED/OPEN/HALF_OPEN). 5 failures in 60s → OPEN. 30s cooldown → HALF_OPEN. Single probe in HALF_OPEN. Max pending reconciliation: 50. Reset capability.

### Task 1.5: WAL Replay Engine + Redis State Rebuild
- **Files**: `src/billing/wal-replay.ts`
- **AC Coverage**: Deterministic reducers for all billing event types. Incremental replay via last_replayed_offset. Torn write handling (Flatline SKP-001): truncate last incomplete record. CRC32 validation. Unknown event type skip (forward compat). WAL segment size check (1GB limit, Flatline IMP-004). Replay duration metric.

### Task 1.6: Billing Module Integration — WAL + Redis + Guard Wiring
- **Files**: `src/billing/reserve-lua.ts`, `src/billing/index.ts`
- **AC Coverage**: Atomic Lua scripts for RESERVE (balance check + hold), RELEASE (return to available), COMMIT (move held → revenue + return overage). All MicroUSD only. Feature flag gate ready. Module barrel exports.

### Task 1.7: Conservation Guard — Remaining PR #79 Suggestions
- **Files**: `src/hounfour/billing-conservation-guard.ts`, `src/hounfour/wire-boundary.ts`, `src/hounfour/ensemble.ts`, `src/hounfour/native-runtime-adapter.ts`
- **AC Coverage**: BB-026-iter2-002: `recoveryStopped` flag (state-based, no repeated retry). BB-026-iter2-003: `MAX_MICRO_USD_LENGTH` shared constant. BB-026-iter2-004: `ENSEMBLE_UNTRACED` named constant. BB-026-iter2-005: trace_id fixed in native-runtime-adapter.ts:416.

### Task 1.8: End-to-End Request Idempotency
- Idempotency protocol is embedded in the WAL replay engine (Task 1.5) and state machine (Task 1.1). `request_start` and `request_complete` WAL events handled by replay reducers. 409 response for in-flight duplicates specified in types.

### Task 1.9: Docker Compose Full Stack E2E
- Deferred to review cycle — requires arrakis Docker image and integration test setup.

### Task 1.10: Billing State Machine Test Suite
- **Files**: `tests/finn/billing-state-machine.test.ts`
- **45 tests**: Happy path, reserve release, local commit + finalize pending, DLQ replay success, DLQ max retries, admin manual finalize, reserve TTL expiry, void from COMMITTED, void from FINALIZE_FAILED, invalid transitions (4 cases), WAL envelope integrity, transition logging, billing_entry_id uniqueness, ledger zero-sum invariant (3 cases), balance derivation, idempotency, posting rules (5 cases), circuit breaker (8 cases).

### Task 1.11: Billing Observability — Metrics + Structured Logging
- **Files**: `src/billing/metrics.ts`
- **AC Coverage**: BillingMetrics interface with 7 metric types. Console implementation. Noop implementation for testing.

## Test Results

- **New tests**: 45 tests, all passing
- **Existing tests**: 108 billing-conservation-guard tests passing, 84 wire-boundary tests passing
- **Regressions**: Zero (2 pre-existing ensemble-budget failures confirmed on base branch)

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/billing/types.ts` | Created | ~160 |
| `src/billing/state-machine.ts` | Created | ~240 |
| `src/billing/ledger.ts` | Created | ~220 |
| `src/billing/dlq.ts` | Created | ~310 |
| `src/billing/circuit-breaker.ts` | Created | ~160 |
| `src/billing/wal-replay.ts` | Created | ~260 |
| `src/billing/reserve-lua.ts` | Created | ~210 |
| `src/billing/metrics.ts` | Created | ~100 |
| `src/billing/index.ts` | Created | ~70 |
| `src/hounfour/billing-conservation-guard.ts` | Modified | +4 |
| `src/hounfour/wire-boundary.ts` | Modified | +6 |
| `src/hounfour/ensemble.ts` | Modified | +5/-4 |
| `src/hounfour/native-runtime-adapter.ts` | Modified | +1/-1 |
| `tests/finn/billing-state-machine.test.ts` | Created | ~480 |

## Deferred Items

- **Task 1.9**: Docker Compose E2E — requires arrakis Docker image setup, deferred to integration testing sprint
- **BB-026-iter2-007**: Full backoff sequence test (1s, 2s, 4s) — covered by existing conservation guard test suite (108 tests include retry behavior)

## Flatline Integration Coverage

| Finding | Status | Location |
|---------|--------|----------|
| IMP-002: WAL envelope versioning | Implemented | types.ts, state-machine.ts |
| IMP-004: WAL operational limits | Implemented | wal-replay.ts |
| SKP-001: WAL durability + CRC32 | Implemented | state-machine.ts, wal-replay.ts |
| SKP-001: Torn write handling | Implemented | wal-replay.ts |
| SKP-003: Automated bulk replay | Implemented | dlq.ts |
| SKP-003: Capped risk unblocking | Implemented | dlq.ts |
