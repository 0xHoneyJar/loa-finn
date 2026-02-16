# PRD: Shadow Deploy Readiness — DLQ Persistence & Production Billing Settlement

> **Version**: 2.0.0
> **GPT-5.2 Review**: Iteration 2 — 6 blocking issues from iteration 1 resolved
> **Date**: 2026-02-17
> **Author**: @janitooor
> **Status**: Draft
> **Cycle**: cycle-023
> **Command Center**: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)
> **Predecessor**: cycle-022 (Sprint B — E2E Billing Wire Verification, PR #71, merged)
> **Bridgebuilder Deep Review**: [PR #71 Deep Review](https://github.com/0xHoneyJar/loa-finn/pull/71#issuecomment-3906586861)
> **Grounding**: `src/hounfour/billing-finalize-client.ts` (276 lines), `src/hounfour/redis/` (8 files), 28 existing billing tests

---

## 1. Problem Statement

### The Problem

PR #71 proved the billing wire works end-to-end (52 tests, 4-service Docker stack, HS256 contract verified). But the DLQ that holds unsettled billing obligations is **in-memory** — a `Map<string, DLQEntry>` at `billing-finalize-client.ts:61`. If loa-finn restarts during an active billing period, all unsettled obligations are silently lost.

```typescript
// Current: in-memory, lost on restart
private readonly dlqEntries: Map<string, DLQEntry> = new Map()
```

This is the **sole remaining P0 infrastructure blocker** between the proven billing wire and shadow deployment.

### Why This Matters (Beyond the Technical)

The Bridgebuilder Deep Review reframed this gap through Elinor Ostrom's commons governance:

> *"The DLQ holds unsettled economic obligations. In a community-governed capability market, these obligations aren't just technical artifacts — they're social promises. When a community member uses their BGT conviction to access an AI model, the community has collectively vouched for that access. The finalize call settles that vouching. If the settlement is lost, the social contract is silently violated."*
>
> — Ostrom Principle 7: *Minimal recognition of rights to organize* requires that governance records be durable.

The fix isn't "add Redis" — it's "design a persistence layer that treats unsettled obligations as sovereign records."

### Why Now

- PR #71 merged — the billing wire is proven with 52 tests
- The Redis infrastructure already exists — 8 files in `src/hounfour/redis/` with port-based architecture, graceful degradation, and Lua scripts
- The Docker E2E stack already includes Redis (`tests/e2e/docker-compose.e2e.yml`)
- Shadow deploy is the next milestone on the P0 critical path (Issue #66)
- The conservation invariant in `finalize()` is implicit — needs formalization before production carries real money

> **Sources**: `billing-finalize-client.ts:57-61` (DLQ comment + Map), `redis/client.ts` (port interface), Bridgebuilder Deep Review Part III §1

### Vision

**Make the billing settlement durable.** After this cycle, unsettled obligations survive process restart, conservation properties are formally stated, and the billing system is ready for shadow deployment where real (but reversible) money flows through the wire.

---

## 2. Goals & Success Metrics

| ID | Goal | Priority | Metric |
|----|------|----------|--------|
| G-1 | DLQ entries survive process restart when Redis is configured and healthy | P0 | Kill loa-finn with entries in DLQ → restart → entries recovered and replayed |
| G-2 | DLQ works without Redis (graceful degradation to in-memory, non-durable) | P0 | Start without REDIS_URL → in-memory DLQ, no crash, existing 28 tests pass |
| G-3 | Conservation invariants formally stated with explicit durability mode semantics | P1 | `billing-invariants.ts` with property-based tests (fast-check, 100 scenarios) |
| G-4 | DLQ visibility via health endpoint with durability mode indicator | P1 | `GET /health` includes `dlq.size`, `dlq.oldest_entry_age_ms`, and `dlq.durable` |
| G-5 | Existing 52 E2E + 28 unit tests remain green | P0 | CI green, 0 regressions |
| G-6 | Shadow deploy readiness requires Redis with AOF persistence for DLQ durability | P0 | Shadow deploy checklist includes Redis persistence verification |

---

## 3. Scope

### In Scope

1. **DLQStore interface** — Port pattern matching existing Redis architecture (`redis/client.ts`)
2. **RedisDLQStore adapter** — Redis-backed implementation using existing `RedisStateBackend`
3. **InMemoryDLQStore adapter** — For testing and graceful degradation (wraps existing Map behavior)
4. **BillingFinalizeClient refactor** — Swap `Map` for `DLQStore`, add async lifecycle
5. **Billing invariants file** — Formal conservation properties as testable assertions
6. **Health endpoint DLQ metrics** — Surface DLQ size and staleness for monitoring
7. **Shadow deploy documentation** — Environment variable guide for production operators

### Out of Scope

- Ensemble batch settlement (P1, cycle-025+: requires Hounfour pool system changes)
- Event-sourced billing audit trail (P2: captured in Vision Registry from Bridgebuilder review)
- x402 crypto payment path (P2: requires Coinbase integration)
- Pricing schema migration to string micro-USD (future cycle, per NOTES.md blocker)
- arrakis-side changes or `s2sSubjectMode` migration (Issue #70)
- Production deployment / actual shadow traffic (this cycle proves readiness, not activation)
- DLQ management API (create/delete entries) — visibility only in this cycle

### Design Decision: Port Pattern, Not Direct Redis

Following the existing architecture in `src/hounfour/redis/`:
- `RedisCommandClient` is a port interface (not ioredis directly)
- Components like `circuit.ts`, `budget.ts`, `rate-limiter.ts` all use the port
- The `DLQStore` interface follows the same pattern — testable, swappable, degradation-aware

This means the DLQ adapter can be swapped to PostgreSQL, the loa-hounfour event store, or any other backend without touching `BillingFinalizeClient`.

---

## 4. Functional Requirements

### FR-1: DLQStore Interface

**The sovereignty layer** — treats unsettled obligations as durable records.

```typescript
// src/hounfour/dlq-store.ts

export interface DLQStore {
  /** Persist a DLQ entry. Upserts by reservation_id. */
  put(entry: DLQEntry): Promise<void>

  /** Get a single entry by reservation_id. */
  get(reservationId: string): Promise<DLQEntry | null>

  /** Get all entries due for replay (next_attempt_at <= now). */
  getReady(before: Date): Promise<DLQEntry[]>

  /** Remove an entry (successful finalize or terminal drop). */
  delete(reservationId: string): Promise<void>

  /** Count of all entries. */
  count(): Promise<number>

  /** Oldest entry age in milliseconds (for health monitoring). */
  oldestEntryAgeMs(): Promise<number | null>
}
```

**Acceptance Criteria:**
- [ ] Interface exported from `src/hounfour/dlq-store.ts`
- [ ] Both `RedisDLQStore` and `InMemoryDLQStore` implement it
- [ ] `BillingFinalizeClient` constructor accepts `DLQStore` instead of using internal Map

> **Source**: Bridgebuilder Deep Review Part III §1, DLQStore interface suggestion

### FR-2: RedisDLQStore Adapter

Uses the existing `RedisStateBackend` (port interface at `redis/client.ts`).

**Redis Schema (precise):**

Two Redis structures per DLQ entry, managed atomically:

1. **Payload key**: `finn:hounfour:dlq:entry:{reservation_id}` — JSON-serialized `DLQEntry` string
2. **Schedule sorted set**: `finn:hounfour:dlq:schedule` — member `{reservation_id}`, score `next_attempt_at` as Unix millis

**Atomic operations (Lua scripts or MULTI/EXEC):**

| Operation | Redis Commands | Atomicity |
|-----------|---------------|-----------|
| **put** | `SET entry:{rid} <json> EX <ttl>` + `ZADD schedule <next_ms> <rid>` | MULTI/EXEC |
| **delete** | `DEL entry:{rid}` + `ZREM schedule <rid>` | MULTI/EXEC |
| **getReady** | `ZRANGEBYSCORE schedule -inf <now_ms>` → for each: `GET entry:{rid}` | Pipeline |

**TTL**: `(maxRetries × maxBackoffMs) + 3600000` (1 hour buffer). Prevents orphaned payload keys.

**Orphan repair**: `getReady()` checks if payload exists for each schedule member. If missing, `ZREM` the orphan and log warning. This handles crash-between-set-and-zadd edge cases.

**Replay claim lock** (prevents multi-instance duplicate replay):
- Before replaying an entry, acquire `SETNX finn:hounfour:dlq:lock:{reservation_id}` with 60s TTL
- If lock acquired: proceed with replay, update attempt count atomically (Lua: `GET entry → parse → increment attempt → SET entry`), release lock on completion
- If lock not acquired: skip entry (another instance is replaying it)
- On replay success: `delete(rid)` removes payload + schedule + lock
- On replay failure: release lock, entry remains for next cycle

**Failure semantics:**

| Redis State | Behavior | Durability | Health Status |
|-------------|----------|------------|---------------|
| Connected | Read/write to Redis | **Durable** — survives finn restart | `dlq.durable: true` |
| Disconnected | Fall back to in-memory buffer | **Non-durable** — lost on finn restart | `dlq.durable: false` |
| Not configured | InMemoryDLQStore only | **Non-durable** — development mode | `dlq.durable: false` |

**No reconnection merge.** When Redis reconnects after an outage, in-memory entries accumulated during the outage are NOT automatically merged to Redis. Instead:
- The health endpoint reports `dlq.durable: false` during the outage
- The in-memory buffer is best-effort only — entries may be lost if finn restarts during the outage
- Shadow deploy readiness requires durable mode (G-6)
- This is an honest design: we don't promise durability we can't guarantee

> **Why no merge?** Multi-instance merge has race conditions (attempt counter skew, resurrecting terminal drops, conflicting writes). The correct fix for Redis outages is operational: use Redis Sentinel/Cluster for HA. The DLQ should not try to be smarter than the persistence layer.

**Acceptance Criteria:**
- [ ] Uses existing `RedisStateBackend` — no new Redis connections
- [ ] Key namespace: `finn:hounfour:dlq:*` (payload + schedule + lock)
- [ ] `getReady()` uses sorted set for O(log N) range queries with orphan repair
- [ ] Replay uses SETNX claim lock to prevent multi-instance duplicate replay
- [ ] Attempt count incremented atomically via Lua script
- [ ] TTL on payload keys prevents orphaned entries
- [ ] Graceful degradation to in-memory on Redis failure (non-durable, reported in health)
- [ ] No reconnection merge (deliberate design choice)

### FR-3: InMemoryDLQStore Adapter

Wraps the existing `Map<string, DLQEntry>` behavior for:
1. Testing (all 28 existing tests should work with minimal changes)
2. Graceful degradation when Redis is unavailable
3. Development without Redis

**Acceptance Criteria:**
- [ ] Implements `DLQStore` interface
- [ ] Behavior identical to current Map-based DLQ
- [ ] Used as default when no Redis is configured
- [ ] All 28 existing billing-finalize tests pass with `InMemoryDLQStore`

### FR-4: BillingFinalizeClient Refactor

Replace the internal `Map<string, DLQEntry>` with the `DLQStore` interface.

**Changes to `billing-finalize-client.ts`:**
1. Constructor accepts `DLQStore` (required parameter)
2. `toDLQ()` calls `await store.put(entry)` instead of `this.dlqEntries.set()`
3. `replayDeadLetters()` calls `await store.getReady(now)` instead of iterating the Map
4. `getDLQSize()` calls `await store.count()`
5. `getDLQEntries()` removed (was leaking internal state) — replaced with `getDLQSize()` + health metrics

**Critical constraint:** `finalize()` NEVER throws contract must be preserved. All `DLQStore` calls must be wrapped in try/catch. If `DLQStore.put()` fails, the entry is logged at ERROR level with full `DLQEntry` JSON for manual recovery — but `finalize()` still returns `{ ok: false, status: "dlq" }`. This is an honest degradation: the caller knows settlement failed, operators can recover from logs.

**Acceptance Criteria:**
- [ ] `finalize()` NEVER throws — contract preserved
- [ ] `DLQStore.put()` failure logs full DLQEntry JSON at ERROR for manual recovery
- [ ] `finalize()` returns `{ ok: false, status: "dlq" }` even when store.put() fails
- [ ] 409 → idempotent mapping preserved
- [ ] Terminal status codes still go straight to DLQ, no retry
- [ ] Backoff schedule unchanged
- [ ] All 28 existing tests adapted and passing
- [ ] New test: kill process with DLQ entries → restart → entries recovered (Redis mode)
- [ ] New test: DLQStore.put() throws → finalize returns dlq, entry logged

### FR-5: Billing Conservation Invariants

**File**: `src/hounfour/billing-invariants.ts`

Formally state the conservation properties that `finalize()` already enforces implicitly:

```typescript
/**
 * BILLING CONSERVATION INVARIANTS
 *
 * These properties are stated with explicit durability mode qualifiers.
 * "Durable mode" = Redis configured, connected, AOF-enabled.
 * "Degraded mode" = Redis unavailable or not configured (in-memory only).
 *
 * INV-1 (Completeness): For every finalize(req), exactly one of:
 *   - outcome = "finalized" (money moved)
 *   - outcome = "idempotent" (money already moved)
 *   - outcome = "dlq" (settlement deferred)
 *   No path exists where finalize() returns without one of these outcomes.
 *
 * INV-2 (Persistence — Durable Mode): If outcome = "dlq" AND durable mode:
 *   - DLQStore.get(reservation_id) returns a non-null entry
 *   - Entry survives process restart
 *
 * INV-2d (Persistence — Degraded Mode): If outcome = "dlq" AND degraded mode:
 *   - Entry exists in memory (best-effort, lost on restart)
 *   - Full DLQEntry JSON logged at ERROR level for manual recovery
 *   - Health endpoint reports dlq.durable = false
 *   NOTE: Degraded mode does NOT satisfy shadow deploy readiness (G-6).
 *
 * INV-3 (Idempotency): For any reservation_id R:
 *   - finalize(R) then finalize(R) → second call returns "idempotent" (via 409)
 *   - Idempotency depends on arrakis returning 409 for duplicate reservation_id
 *   - No double-billing occurs
 *
 * INV-4 (Cost Immutability): actual_cost_micro is never modified after initial computation
 *   - Stored as string-serialized BigInt
 *   - No floating-point operations in the settlement path
 *
 * INV-5 (Bounded Retry): Every DLQ entry is replayed at most maxRetries times
 *   - After exhaustion: terminal drop with logged warning
 *   - Backoff schedule: 1m → 2m → 4m → 8m → 10m (exponential with cap)
 *   - Replay claim lock prevents multi-instance duplicate replay (SETNX, 60s TTL)
 */
```

**Property-based tests** using fast-check:
- Generate random FinalizeRequests → assert INV-1 (outcome always in {finalized, idempotent, dlq})
- Generate duplicate requests → assert INV-3 (second always idempotent)
- Generate invalid costs → assert always DLQ (never throw)

**Acceptance Criteria:**
- [ ] `billing-invariants.ts` exists with all 5 invariants documented
- [ ] At least 3 property-based tests using fast-check (100 scenarios each)
- [ ] Tests verify INV-1, INV-3, and INV-5

### FR-6: Health Endpoint DLQ Metrics

Add DLQ metrics to the existing `/health` endpoint at `src/gateway/server.ts:47`.

```json
{
  "status": "ok",
  "billing": {
    "dlq_size": 0,
    "dlq_oldest_entry_age_ms": null,
    "dlq_store_type": "redis"
  }
}
```

**Acceptance Criteria:**
- [ ] `/health` response includes `billing.dlq_size`
- [ ] `/health` response includes `billing.dlq_oldest_entry_age_ms`
- [ ] `/health` response includes `billing.dlq_store_type` ("redis" or "memory")
- [ ] DLQ metrics don't slow down health check (timeout: 100ms)

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Performance
- DLQ `put()` latency: p99 < 5ms (Redis MULTI/EXEC is typically <1ms)
- DLQ `getReady()` latency: p99 < 10ms (sorted set ZRANGEBYSCORE)
- `finalize()` overall latency impact: < 2ms additional (one Redis write)

### NFR-2: Reliability
- DLQ entries survive loa-finn process restart when Redis is configured and healthy (G-1)
- DLQ entries survive Redis restart — **operational requirement**: Redis must be configured with AOF persistence (`appendonly yes`) and `maxmemory-policy noeviction` for DLQ keys. Without AOF, Redis restart loses all DLQ entries.
- Graceful degradation: no Redis → in-memory DLQ (non-durable, reported in health)
- Shadow deploy readiness checklist MUST verify Redis AOF is enabled before activating billing

### NFR-3: Observability
- Log on DLQ entry creation: `[billing-finalize] DLQ: reservation_id=... reason=... attempt=... store=redis|memory`
- Log on DLQ replay: `[billing-finalize] DLQ replay: replayed=N succeeded=N failed=N remaining=N`
- Log on DLQ terminal drop: `[billing-finalize] DLQ terminal drop: reservation_id=... attempts=N`
- Log on store degradation: `[billing-finalize] DLQ store degraded: redis→memory (reason=...)`

### NFR-4: Testing
- All 28 existing billing-finalize tests pass (with InMemoryDLQStore)
- New Redis DLQ tests (6-8 tests for persistence, recovery, degradation)
- Property-based tests for conservation invariants (3 tests, 100 scenarios each)
- E2E test: kill-restart recovery (1 test)

---

## 6. Architecture Notes

### Existing Redis Infrastructure (No New Dependencies)

The project already has comprehensive Redis support:

| Component | File | Pattern |
|-----------|------|---------|
| Connection | `redis/client.ts` | Port interface, dual connections |
| Circuit Breaker | `redis/circuit.ts` | Fail-open, pub/sub broadcast |
| Budget | `redis/budget.ts` | Fail-closed, Lua atomic operations |
| Rate Limiter | `redis/rate-limiter.ts` | Fail-open, Lua sliding window |
| Idempotency | `redis/idempotency.ts` | Dual-write (Redis + memory) |
| **DLQ** | **Not yet built** | **Fail-open (degrade to memory)** |

The DLQStore adapter slots into this existing architecture. No new Redis connections, no new dependencies.

### Bootstrap Integration

At `src/index.ts:131-162`, the Redis bootstrap already:
1. Checks for `REDIS_URL`
2. Creates `RedisStateBackend` instance
3. Connects and verifies with ping
4. Passes instance to router and budget

DLQStore creation follows the same pattern:
```typescript
const dlqStore = redis
  ? new RedisDLQStore(redis)
  : new InMemoryDLQStore()

const billingClient = new BillingFinalizeClient({ ...config, dlqStore })
```

### Relationship to Future Work

This cycle establishes the `DLQStore` interface. Future cycles extend it:

| Future Work | How DLQStore Helps |
|-------------|-------------------|
| Event sourcing (P2) | Append event log alongside DLQ put() |
| Ensemble batch settlement (P1) | Batch DLQ entries share ensemble_id |
| x402 settlement (P2) | x402 path has no DLQ (synchronous) |
| Formal state machines (P3) | DLQ states map to loa-hounfour temporal properties |

---

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Redis unavailable during finalize | DLQ entry in memory only (non-durable) | Medium | Health reports `dlq.durable: false`; full DLQEntry logged at ERROR; shadow deploy requires durable mode |
| Multi-instance DLQ replay race | Duplicate finalize attempts, attempt counter skew | Medium | SETNX claim lock per reservation_id (60s TTL); atomic attempt increment via Lua; 409 idempotency as safety net |
| Redis restart without AOF | All DLQ entries lost | Medium | Operational requirement: AOF persistence + noeviction policy; shadow deploy checklist verifies Redis config |
| Orphaned schedule zset members | Replay loops for missing payloads | Low | `getReady()` orphan repair: ZREM members with missing payload keys + log warning |
| Fast-check discovers invariant violation | Conservation property broken | Low | Fix immediately — this is the purpose of the invariant file |
| Existing tests break with DLQStore refactor | Regression | Medium | InMemoryDLQStore preserves exact Map behavior |
| arrakis idempotency behavior unverified | 409 assumption may not hold | Low | Add E2E test verifying arrakis returns 409 for duplicate reservation_id finalize |

---

## 8. Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Should DLQ use Redis List, Hash, or Sorted Set? | Sorted Set for schedule + Hash for data (dual structure, atomic via MULTI) |
| What happens to entries when max retries exhausted? | Terminal drop with log warning (existing behavior, preserved) |
| Should DLQ entries have TTL in Redis? | Yes — based on max retries × max backoff + buffer (prevents orphaned keys) |
| Fail-open or fail-closed on Redis failure? | Fail-open (degrade to in-memory) — capability delivery is primary obligation |

---

## 9. Success Definition

**This cycle is complete when:**
1. `billing-finalize-client.ts` uses `DLQStore` interface instead of `Map`
2. Redis-backed DLQ persists entries across process restart (proven by test)
3. Conservation invariants are formally stated and property-tested
4. Health endpoint surfaces DLQ metrics
5. All existing tests pass (52 E2E + 28 billing + new DLQ tests)
6. The billing system is ready for shadow deployment

**This cycle is NOT complete if:**
- Any of the 5 conservation invariants are violated
- DLQ entries are lost on process restart (with Redis available)
- Existing behavior changes for users without Redis (graceful degradation broken)

---

*"The gap between 'infrastructure ready' and 'users can use it' is not measured in features. It's measured in the durability of the economic promises the infrastructure makes."*
— Bridgebuilder Deep Review, Issue #66

---

## 10. Strategic Context — The Road Ahead

This is the **last infrastructure-focused cycle** before the product pivot. After cycle-023:

| Cycle | Focus | What It Enables |
|-------|-------|----------------|
| **023** (this) | DLQ Persistence + Billing Invariants | Shadow deploy, durable settlement |
| **024** | **Product Pivot**: Agent Experience & MVP | User-facing surfaces, agent homepage, conversation engine |
| 025+ | Ensemble & Multi-Model Launch | Batch settlement, trilateral review, Gemini pool integration |

The Bridgebuilder Deep Review established that loa-finn has crossed from "does each piece work?" to "when these five systems compose, what emerges?" (the Cambrian Explosion parallel). This cycle makes the economic settlement durable. The next cycle asks: **what does the user experience when they interact with this economic protocol?**

Issue #66's open questions become cycle-024's PRD inputs:
- Should finnNFT agents have persistent memory at launch?
- What surfaces beyond Discord/Telegram?
- What's the MVP that proves the economic protocol works for real communities?

> **Sources**: Bridgebuilder Deep Review (PR #71), Issue #66 (Launch Readiness), Issue #31 (Hounfour RFC), NOTES.md blockers
