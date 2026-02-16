# Sprint Plan: Shadow Deploy Readiness — DLQ Persistence & Production Billing Settlement

> **Cycle**: cycle-023
> **PRD**: `grimoires/loa/prd.md` (v2.0.0, GPT-5.2 APPROVED iteration 2)
> **SDD**: `grimoires/loa/sdd.md` (v2.0.0, GPT-5.2 APPROVED iteration 2)
> **Team**: 1 developer (solo)
> **Global Sprint IDs**: 56-57

---

## Sprint 1: DLQStore Port Interface + Redis Adapter (Global ID: 56)

**Goal**: Create the DLQStore interface, both adapters (InMemory + Redis), all Lua scripts, and the billing-invariants module with full unit test coverage.

### Tasks

#### T1: DLQStore Interface + InMemoryDLQStore
**File**: `src/hounfour/dlq-store.ts` (~90 lines)

- Define `DLQStore` interface with: `put()`, `get()`, `getReady(before)`, `delete()`, `count()`, `oldestEntryAgeMs()`, `durable` property
- Implement `InMemoryDLQStore` with:
  - Atomic upsert in `put()` (increment `attempt_count` if entry exists, preserve `created_at`)
  - Bounded batch in `getReady()` (default limit 50)
  - Correct `oldestEntryAgeMs()` using `created_at` field
- Update `DLQEntry` type to include `created_at: string` (ISO timestamp, set once on first enqueue)

**Acceptance Criteria**:
- [x] DLQStore interface matches SDD §3.1 exactly
- [x] InMemoryDLQStore passes all CRUD operations
- [x] `put()` upsert increments attempt_count for existing entries
- [x] `getReady()` respects batch limit
- [x] `oldestEntryAgeMs()` computes from `created_at`, not `next_attempt_at`

#### T2: RedisDLQStore Adapter + Lua Scripts
**File**: `src/hounfour/redis/dlq.ts` (~220 lines)

- Implement 4 Lua scripts: `DLQ_UPSERT`, `DLQ_DELETE`, `DLQ_INCREMENT_ATTEMPT`, `DLQ_TERMINAL_DROP`
- All Lua scripts use `{rid}` as canonical ZSET member (never the full payload key)
- `DLQ_UPSERT`: atomic create-or-increment with payload TTL + ZADD schedule
- `DLQ_DELETE`: removes payload + schedule member + claim lock
- `DLQ_INCREMENT_ATTEMPT`: updates payload + ZADD new schedule score (prevents tight replay loops)
- `DLQ_TERMINAL_DROP`: moves payload to `finn:hounfour:dlq:terminal:{rid}` with 7-day TTL, cleans active keys
- `getReady()`: bounded ZRANGEBYSCORE with LIMIT, orphan repair (ZREM by rid when payload missing)
- `claimForReplay()`: SETNX with 60s TTL
- `releaseClaim()`: DEL lock key
- `incrementAttempt()`: calls `DLQ_INCREMENT_ATTEMPT` Lua with schedule score update
- `terminalDrop()`: calls `DLQ_TERMINAL_DROP` Lua
- `validatePersistence()`: checks Redis `appendonly` config via CONFIG GET; never throws; returns `{ aofVerified: boolean, checked: boolean, reason?: string }` — distinguishes "AOF off" from "CONFIG command blocked"

**Acceptance Criteria**:
- [x] All Lua scripts use `{rid}` as ZSET member, not full key path
- [x] `DLQ_UPSERT` atomically increments attempt if entry exists
- [x] `DLQ_INCREMENT_ATTEMPT` updates both payload AND schedule ZSET score
- [x] `DLQ_TERMINAL_DROP` preserves entry in terminal keyspace with 7-day TTL
- [x] `getReady()` bounded by `batchLimit` (default 50)
- [x] Orphan repair: missing payload → ZREM rid from schedule + warn log
- [x] `claimForReplay()` returns false if lock already held
- [x] `validatePersistence()` never throws; returns `{ aofVerified, checked, reason? }`
- [x] When CONFIG blocked: `{ aofVerified: false, checked: false, reason: "CONFIG restricted" }`

#### T3: Billing Invariants Module
**File**: `src/hounfour/billing-invariants.ts` (~60 lines)

- Export `BILLING_INVARIANTS` constant with INV-1 through INV-5 (including INV-2d degraded mode)
- Export `assertCompleteness(result)` helper for INV-1 validation
- Constants used by property-based tests and inline assertions

**Acceptance Criteria**:
- [x] All 5 invariants documented as constants matching PRD §5
- [x] `assertCompleteness()` throws on invalid FinalizeResult states
- [x] Module has zero runtime dependencies (pure assertions)

#### T4: Unit Tests — DLQStore
**File**: `tests/finn/dlq-store.test.ts` (~300 lines)

- 14 tests covering both InMemoryDLQStore and RedisDLQStore:
  - InMemory: CRUD, upsert, getReady filter, batch limit, count/oldest with `created_at`
  - Redis: put/get round-trip, upsert atomicity, getReady+LIMIT, ZSET member=rid, orphan repair, claim lock+release, incrementAttempt updates ZSET score, terminalDrop, delete cleans all keys
- Redis tests use mock `RedisStateBackend` with eval capture for Lua verification
- Claim contention test: two concurrent replayers call `claimForReplay()` on same rid — only one proceeds; loser does NOT call `incrementAttempt`/`delete`/`terminalDrop`

**Acceptance Criteria**:
- [x] All 18 tests pass (exceeded spec: 18 vs 15 planned)
- [x] Redis Lua scripts verified via eval argument capture
- [x] Orphan repair test: payload missing → ZREM + warn log
- [x] Claim lock test: second claim returns false
- [x] Contention test: two concurrent claimers — loser skips, winner proceeds, no double-processing

#### T5: Unit Tests — Billing Invariants
**File**: `tests/finn/billing-invariants.test.ts` (~180 lines)

- 6 tests:
  - INV-1: random requests → always valid outcome (fast-check, 100 scenarios)
  - INV-3: duplicate reservation_id → idempotent (fast-check, 100 scenarios)
  - INV-5: replay exhausts retries → terminal drop (fast-check, 50 scenarios)
  - Store failure → finalize returns dlq, entry logged
  - replayDeadLetters NEVER throws on Redis error
  - Terminal drop preserves audit record

**Acceptance Criteria**:
- [x] fast-check property tests pass for INV-1, INV-3, INV-5
- [x] Store failure test verifies NEVER-throws contract
- [x] Terminal drop test verifies entry preserved in terminal keyspace

---

## Sprint 2: BillingFinalizeClient Refactor + Integration (Global ID: 57)

**Goal**: Refactor BillingFinalizeClient from internal Map to DLQStore, wire bootstrap and health endpoint, add E2E persistence tests. All 28 existing billing tests must continue to pass.

### Tasks

#### T1: BillingFinalizeClient Refactor
**File**: `src/hounfour/billing-finalize-client.ts` (~40 lines changed)

- Add `dlqStore: DLQStore` to `BillingFinalizeConfig`
- Remove `private readonly dlqEntries: Map<string, DLQEntry>`
- `toDLQ()`: becomes async, uses `store.put()` with atomic upsert (no get-then-put)
  - Sets `created_at` on new entries
  - DLQ_UPSERT Lua handles atomic increment for existing entries
- `replayDeadLetters()`: uses `store.getReady()` + claim lock with try/finally
  - Outer try/catch for NEVER-throws contract
  - try/finally around each claimed entry for leak-safe claim lifecycle
  - Terminal drop via `store.terminalDrop()` (Redis) or `store.delete()` (InMemory) with structured audit log
  - `incrementAttempt()` updates both payload AND schedule score
  - Returns `{ replayed, succeeded, failed, terminal }`
- `getDLQSize()`: becomes async, returns `store.count()`
- `getDLQOldestAgeMs()`: new method, returns `store.oldestEntryAgeMs()`
- `isDurable()`: new method, returns `store.durable`
- `isAofVerified()`: new method, returns AOF check result from bootstrap
- Remove `getDLQEntries()` (was leaking internal state)

**Per-entry replay flow** (multi-instance safety invariant):
1. `getReady()` returns candidates (bounded batch, no claim yet)
2. For each candidate: `claimForReplay(rid)` via SETNX — if false, skip (another instance owns it)
3. If claim acquired: `try { sendFinalize(); if ok → delete(); else → incrementAttempt() } finally { releaseClaim() }`
4. Failed claim → no mutation (no incrementAttempt, no delete, no terminalDrop)
5. Terminal drop (attempt_count >= maxRetries) runs before claim — no lock needed for terminal entries

**Acceptance Criteria**:
- [x] All 28 existing billing tests pass with InMemoryDLQStore
- [x] `toDLQ()` never does get-then-put (atomic via store)
- [x] `replayDeadLetters()` wrapped in outer try/catch (NEVER throws)
- [x] Claim lock released in finally block (no leaked locks)
- [x] Terminal drops use `terminalDrop()` for Redis, `delete()` for InMemory
- [x] Terminal drop log includes tenant_id, actual_cost_micro, created_at, attempt_count
- [x] Failed claim → entry skipped entirely (no mutation to attempts/schedule)
- [x] Per-entry flow matches the 5-step invariant above

#### T2: Bootstrap Integration + Durable/Degraded Mode Matrix
**File**: `src/index.ts` (~20 lines added)

- After Redis init block (L131-162):
  - If Redis connected: create `RedisDLQStore`, run `validatePersistence()`, log AOF status
  - If no Redis: create `InMemoryDLQStore`
- Pass `dlqStore` to `BillingFinalizeClient` constructor
- Log store type and durability status at startup
- **Mode is set once at startup and never changes** (PRD: no reconnection merge)

**Mode Matrix** (defines runtime behavior for all code paths):

| Condition | Store | `durable` | `aofVerified` | Shadow-deploy ready? |
|-----------|-------|-----------|---------------|---------------------|
| Redis connected, AOF on | RedisDLQStore | true | true | Yes |
| Redis connected, AOF off | RedisDLQStore | true | false | No (warn) |
| Redis connected, CONFIG blocked | RedisDLQStore | true | false (checked=false) | No (warn) |
| Redis absent/unreachable | InMemoryDLQStore | false | false | No |
| Redis error mid-flight | Same store (no switch) | unchanged | unchanged | unchanged |

- No mode switching at runtime: if Redis fails mid-flight, store errors are caught per-call (NEVER-throws), but we do NOT fall back to InMemory
- Mode determines health endpoint fields: `dlq_durable`, `dlq_aof_verified`, `dlq_store_type`

**Acceptance Criteria**:
- [x] Bootstrap follows existing Redis init pattern (L131-162)
- [x] AOF validation runs at startup, result logged
- [x] Fallback to InMemoryDLQStore when Redis unavailable at startup
- [x] No startup failure if Redis is absent (graceful degradation)
- [x] No mode switching after startup (store is immutable for process lifetime)
- [x] Redis error mid-flight: caught by NEVER-throws, no fallback to InMemory

#### T3: Health Endpoint Integration
**File**: `src/gateway/server.ts` (~15 lines added)

- Extend `/health` response with `billing` object:
  - `dlq_size`, `dlq_oldest_entry_age_ms`, `dlq_store_type`, `dlq_durable`, `dlq_aof_verified`
- Health endpoint billing metrics wrapped in try/catch (never throws)
- On Redis failure: return `{ dlq_size: null, dlq_store_type: "unknown", dlq_durable: false }`

**Acceptance Criteria**:
- [x] Health endpoint returns billing DLQ metrics
- [x] Health endpoint never throws on Redis failure (returns nulls/defaults)
- [x] `dlq_aof_verified` reflects startup AOF check result
- [x] `dlq_oldest_entry_age_ms` uses `created_at`, not schedule score
- [x] Mode matrix reflected in health: `dlq_durable` + `dlq_aof_verified` match bootstrap state

#### T4: E2E Persistence Tests
**File**: `tests/finn/dlq-persistence.test.ts` (~180 lines)

- 6 tests:
  - **Kill-restart recovery**: put entries via RedisDLQStore → flush all local process state → verify Redis keys exist directly (SCAN/GET/ZRANGE) → create fresh RedisDLQStore → entries survive getReady(). This proves persistence across process boundary, not just client re-instantiation.
  - Arrakis 409 idempotency: E2E finalize twice → second returns 409
  - AOF validation: appendonly=yes → `{ aofVerified: true, checked: true }`
  - AOF unavailable: CONFIG command blocked → `{ aofVerified: false, checked: false, reason: ... }`, startup continues
  - Redis reachable but AOF off → expected mode + health fields (durable=true, aofVerified=false)
  - Health endpoint Redis error: mock store.count() throws → health returns `{ dlq_size: null, dlq_store_type: "unknown" }`

**Acceptance Criteria**:
- [x] Kill-restart test verifies Redis keys persist by reading raw keys before creating second client
- [x] AOF available test: `checked=true, aofVerified=true`
- [x] CONFIG blocked test: `checked=false`, startup does not fail
- [x] Mode test: Redis+no-AOF → `dlq_durable: true, dlq_aof_verified: false`
- [x] Health error test: Redis failure → null metrics, no throw
- [x] All tests pass in Docker E2E environment

#### T5: Existing Test Adaptation
**File**: `tests/finn/billing-finalize.test.ts` (modify existing)

- Update existing 28 tests to use `InMemoryDLQStore` injection
- Verify `DLQEntry` type change (`created_at` field) doesn't break existing tests
- Adapt any tests that used `getDLQEntries()` (removed method)

**Acceptance Criteria**:
- [x] All 28 existing tests pass unchanged or with minimal adaptation
- [x] No test uses removed `getDLQEntries()` method
- [x] `created_at` field present in all DLQ assertions

---

## Sprint Summary

| Sprint | Global ID | Tasks | New Lines (est.) | Modified Lines (est.) |
|--------|-----------|-------|------------------|-----------------------|
| Sprint 1 | 56 | 5 | ~850 (3 source + 2 test files) | 0 |
| Sprint 2 | 57 | 5 | ~180 (1 test file) | ~75 (3 source files + 1 test file) |
| **Total** | | **10** | **~1030** | **~75** |

## Dependencies

- Sprint 2 depends on Sprint 1 (DLQStore interface must exist before refactoring client)
- No external dependencies (Redis already in Docker stack, fast-check available via vitest)

## Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Redis Lua script bugs | Medium | High | Mock eval capture in unit tests + Docker E2E |
| Existing test breakage | Low | High | Run all 28 billing tests after each change |
| ZSET member confusion | Low | Critical | Canonical member = `{rid}` enforced everywhere, tested explicitly |
| Claim lock leaks | Low | Medium | try/finally pattern, 60s TTL safety net |

## Success Criteria (Cycle-Level)

1. All 28 existing billing tests pass
2. 27+ new tests pass (15 DLQ store + 6 invariants + 6 persistence)
3. Health endpoint reports `dlq_durable: true` with Redis
4. Health endpoint reports `dlq_aof_verified: true` with AOF-enabled Redis
5. Kill-restart persistence test proves DLQ survives across process boundary (raw Redis key verification)
6. No `getDLQEntries()` method leaking internal state
7. NEVER-throws contract verified: Redis failure during replay → swallowed error, zero-state return
8. Mode matrix verified: no mode switching after startup; Redis mid-flight error → caught, no fallback
9. Claim contention verified: two concurrent claimers → only one processes, loser skips cleanly
