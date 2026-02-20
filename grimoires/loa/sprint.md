# Sprint Plan: Bridge Convergence — Protocol Hardening

> **Version**: 1.0.0
> **Date**: 2026-02-21
> **Cycle**: cycle-029 (bridge iteration 1)
> **Source**: Bridgebuilder review of PR #92
> **Sprints**: 3 (11 tasks from 11 actionable findings)
> **Global IDs**: 118–120
> **Team**: 1 agent (Claude Opus 4.6)

---

## Sprint Overview

| Sprint | Global ID | Label | Findings Addressed | Tasks | Dependencies |
|--------|-----------|-------|--------------------|-------|-------------|
| 1 | 118 | Protocol Persistence & Correctness | high-1, high-2, high-3, high-4 | 4 | None |
| 2 | 119 | Concurrency & Resilience | medium-1, medium-2, medium-3, medium-5 | 4 | Sprint 1 |
| 3 | 120 | Security & Type Safety | medium-4, medium-6, medium-7 | 3 | None |

### Dependency Graph

```
Sprint 1 (Persistence) ── Sprint 2 (Concurrency)
Sprint 3 (Security) [independent]
```

---

## Sprint 1: Protocol Persistence & Correctness

> **Global ID**: 118 | **Priority**: HIGH | **Dependencies**: None
> **Goal**: All financial state persists across process restarts. Atomic operations prevent races. Security-critical dependencies are enforced.

### Tasks

| ID | Task | Finding | Acceptance Criteria |
|----|------|---------|-------------------|
| T1.1 | Persist rektdrop credit ledger to Postgres | high-1 | `src/credits/rektdrop-ledger.ts`: Replace in-memory Maps/Sets with Drizzle-backed storage. Add `finn_credit_accounts` and `finn_credit_transactions` tables to schema. Conservation invariant checked on every mutation via SQL. Journal entries persisted atomically with balance updates. Nonce tracking via `finn_used_nonces` table with TTL-based cleanup. Test: create account → add credits → kill process → restart → credits intact. Conservation invariant validated across restart. |
| T1.2 | Fix consumption TOCTOU race with atomic SQL | high-2 | `src/credits/consumption.ts`: Replace read-check-write pattern with single SQL conditional UPDATE (same pattern as `api-keys.ts:198-216`). `UPDATE finn_credit_accounts SET unlocked = unlocked - $amount WHERE wallet = $wallet AND unlocked >= $amount RETURNING *`. If 0 rows affected → insufficient credits. Test: 10 concurrent reserve requests against balance=5 → exactly 5 succeed, 5 fail. No overspend. |
| T1.3 | Make on-chain verifier a required dependency | high-3 | `src/credits/unlock.ts`: Remove `async () => true` default from `verifyOnChainTransfer`. Make it a required constructor parameter. TypeScript compilation fails if not provided. Add runtime check in constructor: `if (!deps.verifyOnChainTransfer) throw new Error(...)`. Update all callers to provide the verifier explicitly. Test: missing verifier → construction throws. Provided verifier → works as before. |
| T1.4 | Fix WAL replay offset tracking | high-4 | `src/billing/wal-replay.ts`: Replace ULID-based offset tracking with monotonic sequence number. Add `wal_sequence` field to `BillingWALEnvelope` (auto-incrementing integer, set by WAL writer). WAL replay tracks progress via sequence number, not billing_entry_id. Redis key: `billing:wal:last_sequence`. Test: WAL entries from different "processes" (interleaved timestamps but sequential IDs) replay in correct order. No entries skipped. |

### Testing

- Credit persistence survives process restart
- Concurrent reservation race: exactly N succeed where N = available credits
- WAL replay with interleaved entries: all entries processed in sequence order
- Missing on-chain verifier: construction fails at startup

---

## Sprint 2: Concurrency & Resilience

> **Global ID**: 119 | **Priority**: MEDIUM | **Dependencies**: Sprint 1
> **Goal**: State machine transitions are atomic. Reconciliation creates audit trails. Redis failure doesn't cascade. Memory growth is bounded.

### Tasks

| ID | Task | Finding | Acceptance Criteria |
|----|------|---------|-------------------|
| T2.1 | Add entry-level locking to billing state machine | medium-1 | `src/billing/state-machine.ts`: Before any state transition, acquire Redis lock via `SET billing:lock:{entryId} {correlationId} NX EX 30`. If lock not acquired → return error (not throw). After transition → `DEL billing:lock:{entryId}`. Lock TTL prevents deadlocks from crashed processes. Test: two concurrent commit() calls on same entry → one succeeds, one gets lock error. |
| T2.2 | Add audit trail to reconciliation corrections | medium-2 | `src/billing/reconciliation.ts`: Before overwriting Redis with derived balance, append a `RECONCILIATION_CORRECTION` event to WAL with: account, derived_balance, cached_balance, delta, timestamp, reconciliation_run_id. Test: trigger divergence → WAL contains correction entry. Correction entry includes both old and new values. |
| T2.3 | Document Redis HA + add graceful degradation mode | medium-3 | Add `src/gateway/redis-health.ts`: Redis health check with circuit breaker. When Redis unavailable: x402 nonces → fail-closed (503), rate limiting → degrade to in-memory, API key cache → direct DB lookup, SIWE nonces → fail-closed (401). Add Redis HA section to deployment docs. Test: mock Redis down → x402 returns 503. Rate limiter degrades to in-memory. API key validation falls through to DB. |
| T2.4 | Bound nonce tracking with TTL eviction | medium-5 | `src/credits/rektdrop-ledger.ts` (now Postgres-backed from T1.1): Replace Set<string> with `finn_used_nonces` table: (nonce_key TEXT PK, created_at TIMESTAMP DEFAULT now()). Add cleanup job: DELETE FROM finn_used_nonces WHERE created_at < now() - INTERVAL '24 hours'. Idempotency index: CREATE INDEX on finn_credit_transactions(idempotency_key) for O(1) lookup. Test: nonce lookup is O(1). Old nonces cleaned up. 100K nonces don't cause memory growth. |

### Testing

- Concurrent state transitions on same entry: exactly one succeeds
- Reconciliation correction creates WAL audit entry
- Redis failure: each subsystem degrades correctly (503, in-memory, DB fallback)
- Nonce cleanup: old nonces purged, recent nonces retained

---

## Sprint 3: Security & Type Safety

> **Global ID**: 120 | **Priority**: MEDIUM | **Dependencies**: None
> **Goal**: Clock skew is monitored. API inputs are validated at runtime. Overpayments are prevented.

### Tasks

| ID | Task | Finding | Acceptance Criteria |
|----|------|---------|-------------------|
| T3.1 | Add TimeProvider abstraction for clock skew monitoring | medium-4 | `src/gateway/time-provider.ts`: Injectable `TimeProvider` interface with `now()` method. Default implementation uses `Date.now()`. Add NTP drift check on startup: compare system time against an NTP server (or skip if unavailable). Log warning if drift > 1s. Export Prometheus gauge `finn_clock_drift_seconds`. Wire TimeProvider into SIWE auth, x402 receipt verifier, and consumption TTL checks. Test: mock TimeProvider with 2-minute drift → SIWE rejects (outside tolerance). Zero drift → passes. |
| T3.2 | Add Zod runtime validation for personality types | medium-6 | `src/nft/schemas.ts`: Define Zod schemas for `SignalSnapshot` (12 required fields), `DAMPFingerprint` (dials object with numeric values), `DerivedVoiceProfile`, `OnChainMetadata`. Apply validation at API boundary in personality creation/update routes. Replace `as SignalSnapshot` type assertions with `SignalSnapshotSchema.parse()`. Test: valid signals → parses. Missing field → throws ZodError with specific field name. Invalid dial value (string instead of number) → throws. |
| T3.3 | Add payment amount ceiling to x402 verification | medium-7 | `src/x402/verify.ts`: Add optional `maxPaymentAmount` to PaymentVerifier config (default: 100_000_000 = 100 USDC in micro units). Before accepting payment, check `auth.value <= maxPaymentAmount`. Exceed ceiling → reject with error code `payment_exceeds_ceiling` and clear message. Configurable via `X402_MAX_PAYMENT_AMOUNT` env var. Test: payment at $50 → accepted. Payment at $150 → rejected with ceiling error. Ceiling disabled (set to 0) → no check. |

### Testing

- Clock drift monitoring: startup logs drift, Prometheus metric exported
- Zod validation: malformed personality data rejected with clear error
- Payment ceiling: overpayments rejected, normal payments pass
- TimeProvider injection: all timestamp-dependent code uses injected time

---

## Environment Variables (New)

| Variable | Sprint | Required | Description |
|----------|--------|----------|-------------|
| `X402_MAX_PAYMENT_AMOUNT` | 3 | No | Maximum payment amount in micro-USDC (default: 100000000 = $100) |

---

## Success Criteria (Bridge Iteration)

| Metric | Target | Sprint |
|--------|--------|--------|
| Credit persistence | Survives restart | Sprint 1 |
| Concurrent safety | No overspend under contention | Sprint 1 |
| WAL correctness | No entries skipped on replay | Sprint 1 |
| State machine safety | Atomic transitions | Sprint 2 |
| Redis resilience | Graceful degradation | Sprint 2 |
| Type safety | Runtime validation at boundaries | Sprint 3 |
| Payment safety | Ceiling prevents overpayment | Sprint 3 |
