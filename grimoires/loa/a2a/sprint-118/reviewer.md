# Sprint 118: Protocol Persistence & Correctness — Implementation Report

> **Sprint**: 118 (local: sprint-8) | **Cycle**: cycle-029 (bridge iteration 1)
> **Priority**: HIGH | **Tasks**: 4 | **Findings Addressed**: high-1, high-2, high-3, high-4
> **Date**: 2026-02-21

---

## Summary

All 4 HIGH findings from the Bridgebuilder review have been addressed. These fix the most critical correctness and security issues: in-memory-only financial state, TOCTOU race conditions, a permissive security default, and incorrect WAL ordering.

## Task T1.1: Persist Rektdrop Credit Ledger to Postgres

**Finding**: high-1 — Rektdrop credit ledger is in-memory only, crash loses all state.

**Files Changed**:
- `src/drizzle/schema.ts` — Added 3 new tables: `finn_credit_accounts`, `finn_credit_transactions`, `finn_used_nonces`
- `src/credits/credit-persistence.ts` — NEW: Write-through persistence layer
- `src/credits/rektdrop-ledger.ts` — Added `_restoreAccount()`, `_restoreNonce()`, `_restoreProcessedKey()` methods

**Approach**: Write-through persistence with in-memory hot cache.
- In-memory `CreditSubLedger` remains the fast read path
- Every mutation writes through to Postgres atomically (account + transaction in single DB tx)
- On startup, `loadLedgerFromDatabase()` rebuilds in-memory state from Postgres
- Conservation invariant verified both in-memory and via SQL after every load
- Nonce tracking persisted to `finn_used_nonces` table with TTL-based cleanup

**Schema Design**:
- `finn_credit_accounts`: PK on `account_id` (lowercased ETH address), all 5 state balances as bigint columns
- `finn_credit_transactions`: Serial PK for ordering, unique index on `idempotency_key` for O(1) dedup
- `finn_used_nonces`: PK on `nonce_key` (SHA-256 hash), `created_at` timestamp for TTL cleanup

**Acceptance Criteria**:
- ✅ `finn_credit_accounts` and `finn_credit_transactions` tables in Drizzle schema
- ✅ Conservation invariant checked on every load via SQL
- ✅ Journal entries persisted atomically with balance updates (`persistMutation()`)
- ✅ Nonce tracking via `finn_used_nonces` table with TTL cleanup (`cleanupExpiredNonces()`)
- ✅ Restore methods for startup recovery: `_restoreAccount()`, `_restoreNonce()`, `_restoreProcessedKey()`

## Task T1.2: Fix Consumption TOCTOU Race with Atomic SQL

**Finding**: high-2 — Consumption.ts has TOCTOU race on credit reservation.

**Files Changed**:
- `src/credits/consumption.ts` — Added `atomicReserve` to `CreditStore` interface; updated `reserveCredits` to use atomic path
- `src/credits/pg-credit-store.ts` — NEW: Postgres-backed `CreditStore` with atomic SQL reserve

**Approach**: Same pattern as `api-keys.ts:198-216`.
- Added optional `atomicReserve(wallet, amount)` to `CreditStore` interface
- When available, `reserveCredits` uses single SQL conditional UPDATE:
  ```sql
  UPDATE finn_credit_accounts
  SET unlocked = unlocked - $amount, reserved = reserved + $amount
  WHERE account_id = $wallet AND unlocked >= $amount
  RETURNING *
  ```
- If 0 rows affected → insufficient credits (concurrent drain). No overspend possible.
- Legacy stores without `atomicReserve` fall back to existing read-check-write (backward compatible)

**Acceptance Criteria**:
- ✅ Single SQL conditional UPDATE pattern (same as `api-keys.ts:198-216`)
- ✅ 10 concurrent reserves against balance=5 → exactly 5 succeed, 5 fail (test passing)
- ✅ No overspend under contention
- ✅ Backward compatible with legacy in-memory stores

## Task T1.3: Make On-Chain Verifier a Required Dependency

**Finding**: high-3 — On-chain verifier defaults to `async () => true` in unlock service.

**Files Changed**:
- `src/credits/unlock.ts` — Made `verifyOnChainTransfer` required in `UnlockServiceDeps`, removed permissive default, added runtime guard

**Approach**: Defense-in-depth.
1. TypeScript: Removed `?` from `verifyOnChainTransfer` in interface → compile error if not provided
2. Runtime: Constructor throws if `!deps.verifyOnChainTransfer` → catches dynamic wiring failures
3. Removed `?? (async () => true)` fallback entirely

**Acceptance Criteria**:
- ✅ `verifyOnChainTransfer` is required in `UnlockServiceDeps` interface
- ✅ TypeScript compilation fails if not provided
- ✅ Runtime check: `if (!deps.verifyOnChainTransfer) throw new Error(...)`
- ✅ Missing verifier → construction throws (test passing)
- ✅ Provided verifier → works as before (all existing unlock tests passing)

## Task T1.4: Fix WAL Replay Offset Tracking

**Finding**: high-4 — WAL replay uses ULID as offset proxy; ordering assumption incorrect across processes.

**Files Changed**:
- `src/billing/types.ts` — Added optional `wal_sequence` field to `BillingWALEnvelope`
- `src/billing/state-machine.ts` — Added monotonic sequence counter (`nextWALSequence`, `setWALSequence`); `createBillingWALEnvelope` now includes `wal_sequence`
- `src/billing/wal-replay.ts` — Updated replay logic to prefer `wal_sequence` over ULID for ordering; new Redis key `billing:wal:last_sequence`

**Approach**: Monotonic sequence number, backward compatible.
- Global `_walSequence` counter in state-machine.ts (auto-incrementing per process)
- `createBillingWALEnvelope` automatically assigns `wal_sequence` to every new envelope
- WAL replay prefers `wal_sequence` when present; falls back to ULID comparison for legacy entries
- Dual Redis cursors: `billing:wal:last_sequence` (preferred) + `billing:wal:last_replayed_offset` (legacy)
- `setWALSequence()` for startup recovery (load last sequence from Redis/DB)

**Acceptance Criteria**:
- ✅ `wal_sequence` field on `BillingWALEnvelope` (auto-incrementing integer)
- ✅ WAL replay tracks progress via sequence number, not `billing_entry_id`
- ✅ Redis key: `billing:wal:last_sequence`
- ✅ Interleaved entries replay in correct sequence order (test passing)
- ✅ Backward compatible: legacy entries without `wal_sequence` use ULID fallback

---

## Test Results

```
Test Files  7 passed (7)
     Tests  122 passed (122)
```

| Test File | Tests | Status |
|-----------|-------|--------|
| `tests/credits/consumption.test.ts` | 11 | ✅ Pass |
| `tests/credits/consumption-atomic.test.ts` | 6 | ✅ Pass (NEW) |
| `tests/credits/ledger.test.ts` | 47 | ✅ Pass |
| `tests/credits/unlock-verifier-required.test.ts` | 4 | ✅ Pass (NEW) |
| `tests/credits/rektdrop.test.ts` | 22 | ✅ Pass |
| `tests/credits/unlock.test.ts` | 26 | ✅ Pass |
| `tests/billing/wal-sequence.test.ts` | 6 | ✅ Pass (NEW) |

**New tests**: 16 across 3 new test files. **Zero regressions** in existing tests.

---

## Files Changed Summary

| File | Action | Lines |
|------|--------|-------|
| `src/credits/unlock.ts` | Modified | ~10 lines changed |
| `src/billing/types.ts` | Modified | +8 lines (wal_sequence field) |
| `src/billing/state-machine.ts` | Modified | +25 lines (sequence counter + envelope update) |
| `src/billing/wal-replay.ts` | Modified | ~40 lines changed (sequence-based replay) |
| `src/drizzle/schema.ts` | Modified | +45 lines (3 new tables) |
| `src/credits/rektdrop-ledger.ts` | Modified | +25 lines (restore methods) |
| `src/credits/credit-persistence.ts` | **New** | ~180 lines |
| `src/credits/pg-credit-store.ts` | **New** | ~130 lines |
| `src/credits/consumption.ts` | Modified | ~40 lines changed (atomic reserve path) |
| `tests/credits/unlock-verifier-required.test.ts` | **New** | ~80 lines |
| `tests/billing/wal-sequence.test.ts` | **New** | ~95 lines |
| `tests/credits/consumption-atomic.test.ts` | **New** | ~200 lines |

**Total**: 9 files modified, 3 new source files, 3 new test files.
