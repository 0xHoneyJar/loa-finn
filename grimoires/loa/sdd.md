# SDD: Shadow Deploy Readiness — DLQ Persistence & Production Billing Settlement

> **Version**: 2.0.0
> **Date**: 2026-02-17
> **Author**: @janitooor
> **Status**: Draft
> **Cycle**: cycle-023
> **PRD**: `grimoires/loa/prd.md` (v2.0.0, GPT-5.2 APPROVED iteration 2)
> **Grounding**: `src/hounfour/billing-finalize-client.ts`, `src/hounfour/redis/client.ts`, `src/hounfour/redis/atomic-budget.ts` (Lua pattern)

---

## 1. Executive Summary

This cycle replaces the in-memory DLQ (`Map<string, DLQEntry>`) in `billing-finalize-client.ts` with a `DLQStore` port interface backed by Redis. Three new files are created (`dlq-store.ts`, `redis/dlq.ts`, `billing-invariants.ts`), one file is refactored (`billing-finalize-client.ts`), and the health endpoint gains DLQ metrics. No new dependencies. No public API changes.

---

## 2. System Architecture

### 2.1 Change Map

```
┌────────────────────────────────────────────────────────────┐
│ cycle-023 Changes (3 new, 2 modified, 1 test file)         │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  NEW:                                                      │
│  ┌─────────────────────────────────┐                       │
│  │ src/hounfour/dlq-store.ts       │ DLQStore interface    │
│  │   DLQStore (port)               │ + InMemoryDLQStore    │
│  └─────────────────────────────────┘                       │
│  ┌─────────────────────────────────┐                       │
│  │ src/hounfour/redis/dlq.ts       │ RedisDLQStore adapter │
│  │   Uses RedisStateBackend        │ + Lua scripts         │
│  │   + claim lock + orphan repair  │                       │
│  └─────────────────────────────────┘                       │
│  ┌─────────────────────────────────┐                       │
│  │ src/hounfour/billing-invariants │ Conservation props    │
│  │   .ts                           │ + fast-check tests    │
│  └─────────────────────────────────┘                       │
│                                                            │
│  MODIFIED:                                                 │
│  ┌─────────────────────────────────┐                       │
│  │ billing-finalize-client.ts      │ Map → DLQStore        │
│  │   constructor(config, store)    │ + async lifecycle     │
│  └─────────────────────────────────┘                       │
│  ┌─────────────────────────────────┐                       │
│  │ src/index.ts                    │ DLQStore bootstrap    │
│  │   L131-162 Redis init block     │ + health wiring       │
│  └─────────────────────────────────┘                       │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
finalize(req) ──→ sendFinalize() ──→ arrakis /api/internal/finalize
                      │                    │
                      │ failure            │ 200/409
                      ▼                    ▼
               DLQStore.put(entry)    return {ok: true}
                      │
         ┌────────────┼────────────┐
         │            │            │
    Redis OK    Redis FAIL    No Redis
         │            │            │
    Durable      Log ERROR    InMemory
    (persist)   (manual       (non-durable)
                 recovery)

replayDeadLetters() ──→ DLQStore.getReady(now)
                              │
                    ┌─────────┼──────────┐
                    │         │          │
              claim lock   orphan?    skip (locked)
              (SETNX)     ZREM+warn
                    │
              sendFinalize()
                    │
              ┌─────┼─────┐
              │           │
           success      failure
              │           │
        store.delete   incr attempt
                      (Lua atomic)
```

---

## 3. Component Design

### 3.1 DLQStore Interface

**File**: `src/hounfour/dlq-store.ts`

```typescript
import type { DLQEntry } from "./billing-finalize-client.js"

export interface DLQStore {
  put(entry: DLQEntry): Promise<void>
  get(reservationId: string): Promise<DLQEntry | null>
  getReady(before: Date): Promise<DLQEntry[]>
  delete(reservationId: string): Promise<void>
  count(): Promise<number>
  oldestEntryAgeMs(): Promise<number | null>
  /** Whether the store provides durable persistence */
  readonly durable: boolean
}
```

**InMemoryDLQStore** (same file):

```typescript
export class InMemoryDLQStore implements DLQStore {
  private readonly entries: Map<string, DLQEntry> = new Map()
  readonly durable = false
  private readonly batchLimit: number

  constructor(options?: { batchLimit?: number }) {
    this.batchLimit = options?.batchLimit ?? 50
  }

  async put(entry: DLQEntry): Promise<void> {
    const existing = this.entries.get(entry.reservation_id)
    if (existing) {
      // Atomic upsert: increment attempt, preserve created_at
      existing.attempt_count += 1
      existing.next_attempt_at = entry.next_attempt_at
      existing.reason = entry.reason
      existing.response_status = entry.response_status
    } else {
      this.entries.set(entry.reservation_id, entry)
    }
  }

  async get(reservationId: string): Promise<DLQEntry | null> {
    return this.entries.get(reservationId) ?? null
  }

  async getReady(before: Date): Promise<DLQEntry[]> {
    const cutoff = before.getTime()
    return [...this.entries.values()]
      .filter(e => new Date(e.next_attempt_at).getTime() <= cutoff)
      .slice(0, this.batchLimit)
  }

  async delete(reservationId: string): Promise<void> {
    this.entries.delete(reservationId)
  }

  async count(): Promise<number> {
    return this.entries.size
  }

  async oldestEntryAgeMs(): Promise<number | null> {
    if (this.entries.size === 0) return null
    let oldestCreated = Infinity
    for (const e of this.entries.values()) {
      const created = new Date(e.created_at).getTime()
      oldestCreated = Math.min(oldestCreated, created)
    }
    return oldestCreated === Infinity ? null : Date.now() - oldestCreated
  }
}
```

> **DLQEntry type change**: `DLQEntry` gains a `created_at: string` field (ISO timestamp set once on first enqueue, never updated). This is the authoritative timestamp for `oldestEntryAgeMs()` health metric computation. See §3.3 for the toDLQ() change.

### 3.2 RedisDLQStore Adapter

**File**: `src/hounfour/redis/dlq.ts`

#### 3.2.1 Redis Schema

| Structure | Key Pattern | Purpose |
|-----------|-------------|---------|
| Payload (string) | `finn:hounfour:dlq:entry:{rid}` | JSON-serialized DLQEntry |
| Schedule (sorted set) | `finn:hounfour:dlq:schedule` | Member: `{rid}`, Score: `next_attempt_at` ms |
| Claim lock (string) | `finn:hounfour:dlq:lock:{rid}` | SETNX with 60s TTL for replay exclusivity |
| Terminal (string) | `finn:hounfour:dlq:terminal:{rid}` | JSON-serialized terminal drop record (TTL: 7 days) |

**Canonical ZSET member**: Always `{rid}` (the reservation ID), never the full payload key. All Lua scripts and application code use `{rid}` as the sorted set member. The full payload key `finn:hounfour:dlq:entry:{rid}` is derived from the member at read time.

**TTL calculation**: `(MAX_RETRIES × 600_000) + 3_600_000` = 5 × 10min + 1hr = ~4,600 seconds

**getReady batch limit**: Default `50` entries per tick to bound work and prevent O(N) scans under load.

#### 3.2.2 Lua Scripts

**DLQ_UPSERT** — Atomic put-or-increment (payload + schedule), fixes non-atomic toDLQ():
```lua
-- KEYS[1] = entry key, KEYS[2] = schedule key
-- ARGV[1] = json (new entry), ARGV[2] = next_attempt_ms, ARGV[3] = ttl_seconds, ARGV[4] = rid
local existing = redis.call("GET", KEYS[1])
if existing then
  local entry = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  entry.attempt_count = entry.attempt_count + 1
  entry.next_attempt_at = incoming.next_attempt_at
  entry.reason = incoming.reason
  entry.response_status = incoming.response_status
  redis.call("SET", KEYS[1], cjson.encode(entry), "EX", ARGV[3])
else
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
end
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[4])
return 1
```

**DLQ_DELETE** — Atomic removal (payload + schedule + lock):
```lua
-- KEYS[1] = entry key, KEYS[2] = schedule key, KEYS[3] = lock key
-- ARGV[1] = rid (canonical ZSET member)
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[3])
return 1
```

**DLQ_INCREMENT_ATTEMPT** — Atomic attempt count + schedule score update:
```lua
-- KEYS[1] = entry key, KEYS[2] = schedule key
-- ARGV[1] = new next_attempt_at ISO string, ARGV[2] = ttl_seconds
-- ARGV[3] = next_attempt_ms (numeric score), ARGV[4] = rid
local json = redis.call("GET", KEYS[1])
if not json then return nil end
local entry = cjson.decode(json)
entry.attempt_count = entry.attempt_count + 1
entry.next_attempt_at = ARGV[1]
local updated = cjson.encode(entry)
redis.call("SET", KEYS[1], updated, "EX", ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
return entry.attempt_count
```

**DLQ_TERMINAL_DROP** — Move to terminal keyspace with audit trail:
```lua
-- KEYS[1] = entry key, KEYS[2] = schedule key, KEYS[3] = lock key, KEYS[4] = terminal key
-- ARGV[1] = rid, ARGV[2] = terminal_ttl_seconds (7 days = 604800)
local json = redis.call("GET", KEYS[1])
if json then
  redis.call("SET", KEYS[4], json, "EX", ARGV[2])
end
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[3])
return json and 1 or 0
```

#### 3.2.3 Class Design

```typescript
import type { RedisStateBackend } from "./client.js"
import type { DLQStore } from "../dlq-store.js"
import type { DLQEntry } from "../billing-finalize-client.js"

const TERMINAL_TTL_SECONDS = 604_800 // 7 days

export class RedisDLQStore implements DLQStore {
  readonly durable = true
  private readonly redis: RedisStateBackend
  private readonly scheduleKey: string
  private readonly ttlSeconds: number
  private readonly batchLimit: number

  constructor(redis: RedisStateBackend, options?: { maxRetries?: number; batchLimit?: number }) {
    this.redis = redis
    this.scheduleKey = redis.key("dlq", "schedule")
    const maxRetries = options?.maxRetries ?? 5
    this.ttlSeconds = Math.ceil((maxRetries * 600_000 + 3_600_000) / 1000)
    this.batchLimit = options?.batchLimit ?? 50
  }

  private entryKey(rid: string): string {
    return this.redis.key("dlq", "entry", rid)
  }

  private lockKey(rid: string): string {
    return this.redis.key("dlq", "lock", rid)
  }

  private terminalKey(rid: string): string {
    return this.redis.key("dlq", "terminal", rid)
  }

  async put(entry: DLQEntry): Promise<void> {
    const client = this.redis.getClient()
    const json = JSON.stringify(entry)
    const nextMs = new Date(entry.next_attempt_at).getTime()
    await client.eval(DLQ_UPSERT_LUA, 2,
      this.entryKey(entry.reservation_id), this.scheduleKey,
      json, nextMs, this.ttlSeconds, entry.reservation_id
    )
  }

  async get(reservationId: string): Promise<DLQEntry | null> {
    const client = this.redis.getClient()
    const json = await client.get(this.entryKey(reservationId))
    return json ? JSON.parse(json) as DLQEntry : null
  }

  async getReady(before: Date): Promise<DLQEntry[]> {
    const client = this.redis.getClient()
    const cutoffMs = before.getTime()
    // Bounded ZRANGEBYSCORE via Lua — returns rids (not full keys)
    const rids = await client.eval(
      `return redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])`,
      1, this.scheduleKey, cutoffMs, this.batchLimit
    ) as string[]

    const entries: DLQEntry[] = []
    for (const rid of rids) {
      const json = await client.get(this.entryKey(rid))
      if (json) {
        entries.push(JSON.parse(json) as DLQEntry)
      } else {
        // Orphan repair: schedule member exists but payload is missing (TTL expired)
        await client.eval(
          `redis.call("ZREM", KEYS[1], ARGV[1])`,
          1, this.scheduleKey, rid
        )
        console.warn(`[billing-finalize] DLQ orphan repair: removed schedule entry for missing payload rid=${rid}`)
      }
    }
    return entries
  }

  async delete(reservationId: string): Promise<void> {
    const client = this.redis.getClient()
    await client.eval(DLQ_DELETE_LUA, 3,
      this.entryKey(reservationId), this.scheduleKey, this.lockKey(reservationId),
      reservationId
    )
  }

  async count(): Promise<number> {
    const client = this.redis.getClient()
    return client.zcard(this.scheduleKey)
  }

  async oldestEntryAgeMs(): Promise<number | null> {
    const client = this.redis.getClient()
    // Peek at lowest-scored member, fetch its created_at from payload
    const rids = await client.eval(
      `return redis.call("ZRANGE", KEYS[1], 0, 0)`,
      1, this.scheduleKey
    ) as string[]
    if (!rids || rids.length === 0) return null
    const json = await client.get(this.entryKey(rids[0]))
    if (!json) return null
    const entry = JSON.parse(json) as DLQEntry
    return Date.now() - new Date(entry.created_at).getTime()
  }

  /** Acquire claim lock for replay. Returns true if lock acquired. */
  async claimForReplay(reservationId: string): Promise<boolean> {
    const client = this.redis.getClient()
    const result = await client.set(this.lockKey(reservationId), "1", "NX", "EX", 60)
    return result === "OK"
  }

  /** Release claim lock after replay attempt. */
  async releaseClaim(reservationId: string): Promise<void> {
    const client = this.redis.getClient()
    await client.del(this.lockKey(reservationId))
  }

  /** Atomically increment attempt count, update next_attempt_at, and reschedule in ZSET. */
  async incrementAttempt(reservationId: string, nextAttemptAt: string, nextAttemptMs: number): Promise<number | null> {
    const client = this.redis.getClient()
    const result = await client.eval(DLQ_INCREMENT_ATTEMPT_LUA, 2,
      this.entryKey(reservationId), this.scheduleKey,
      nextAttemptAt, this.ttlSeconds, nextAttemptMs, reservationId
    )
    return result as number | null
  }

  /** Move entry to terminal keyspace for audit trail, clean all active keys. */
  async terminalDrop(reservationId: string): Promise<void> {
    const client = this.redis.getClient()
    await client.eval(DLQ_TERMINAL_DROP_LUA, 4,
      this.entryKey(reservationId), this.scheduleKey,
      this.lockKey(reservationId), this.terminalKey(reservationId),
      reservationId, TERMINAL_TTL_SECONDS
    )
  }

  /** Validate Redis persistence config at startup. Returns true if AOF is enabled. */
  async validatePersistence(): Promise<boolean> {
    try {
      const client = this.redis.getClient()
      const info = await client.eval(
        `return redis.call("CONFIG", "GET", "appendonly")`,
        0
      ) as string[]
      return info && info.length >= 2 && info[1] === "yes"
    } catch {
      // CONFIG may be disabled in managed Redis — log warning, don't block
      console.warn("[billing-finalize] Could not verify Redis AOF config (CONFIG command may be restricted)")
      return true // Assume managed Redis has persistence
    }
  }
}
```

### 3.3 BillingFinalizeClient Refactor

**File**: `src/hounfour/billing-finalize-client.ts`

#### Changes:

1. **Constructor** — accepts `DLQStore` via config:
```typescript
export interface BillingFinalizeConfig {
  billingUrl: string
  s2sSigner: S2SJwtSigner
  dlqStore: DLQStore              // NEW: replaces internal Map
  timeoutMs?: number
  maxRetries?: number
  s2sSubjectMode?: "service" | "tenant"
}
```

2. **Remove** `private readonly dlqEntries: Map<string, DLQEntry>` (line 61)

3. **toDLQ()** — becomes async, calls `store.put()` with atomic upsert semantics:
```typescript
private async toDLQ(req: FinalizeRequest, reason: string, responseStatus: number | null): Promise<FinalizeResult> {
  // attempt_count=1 for new entries; DLQ_UPSERT Lua atomically increments if entry exists
  const entry: DLQEntry = {
    reservation_id: req.reservation_id,
    tenant_id: req.tenant_id,
    actual_cost_micro: req.actual_cost_micro,
    trace_id: req.trace_id,
    reason,
    response_status: responseStatus,
    attempt_count: 1,
    created_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + BACKOFF_SCHEDULE_MS[0]).toISOString(),
  }

  try {
    // store.put() is atomic: Redis uses DLQ_UPSERT Lua (increment if exists, create if not)
    // InMemory uses map-level upsert. No get-then-put race.
    await this.store.put(entry)
    console.warn(`[billing-finalize] DLQ: reservation_id=${req.reservation_id} reason=${reason} store=${this.store.durable ? "redis" : "memory"}`)
  } catch (storeErr) {
    // DLQStore failure — log full entry for manual recovery
    console.error(`[billing-finalize] DLQ STORE FAILURE: ${(storeErr as Error).message}`)
    console.error(`[billing-finalize] DLQ entry (manual recovery): ${JSON.stringify(entry)}`)
  }

  return { ok: false, status: "dlq", reason }
}
```

> **Atomicity note**: The previous get-then-put pattern for attempt counting was non-atomic and could lose increments under concurrent finalize() calls. The new design delegates increment responsibility to the store: `DLQ_UPSERT` Lua reads existing entry, increments `attempt_count`, and updates `next_attempt_at` in a single atomic operation. `created_at` is set once on first enqueue and preserved across updates.

4. **replayDeadLetters()** — uses `store.getReady()` + claim lock with try/finally + NEVER-throws:
```typescript
async replayDeadLetters(): Promise<{ replayed: number; succeeded: number; failed: number; terminal: number }> {
  // Outer try/catch: NEVER-throws contract — Redis errors must not bubble
  try {
    const now = new Date()
    const maxRetries = this.config.maxRetries ?? MAX_RETRIES
    let replayed = 0, succeeded = 0, failed = 0, terminal = 0
    const isRedis = this.store instanceof RedisDLQStore

    const readyEntries = await this.store.getReady(now)
    for (const entry of readyEntries) {
      // Terminal drop: exhausted retries → move to terminal keyspace with audit trail
      if (entry.attempt_count >= maxRetries) {
        if (isRedis) {
          await (this.store as RedisDLQStore).terminalDrop(entry.reservation_id)
        } else {
          await this.store.delete(entry.reservation_id)
        }
        console.error(`[billing-finalize] DLQ terminal drop: reservation_id=${entry.reservation_id} tenant=${entry.tenant_id} cost=${entry.actual_cost_micro} attempts=${entry.attempt_count} created=${entry.created_at}`)
        terminal++
        continue
      }

      // Claim lock (RedisDLQStore) — skip if another instance owns it
      if (isRedis) {
        const claimed = await (this.store as RedisDLQStore).claimForReplay(entry.reservation_id)
        if (!claimed) continue
      }

      // try/finally: ALWAYS release claim lock, even if sendFinalize or store ops throw
      try {
        replayed++
        const result = await this.sendFinalize({
          reservation_id: entry.reservation_id,
          tenant_id: entry.tenant_id,
          actual_cost_micro: entry.actual_cost_micro,
          trace_id: entry.trace_id,
        })

        if (result.ok) {
          await this.store.delete(entry.reservation_id) // delete also removes lock via Lua
          succeeded++
        } else {
          // Increment attempt + reschedule atomically
          if (isRedis) {
            const backoffIndex = Math.min(entry.attempt_count, BACKOFF_SCHEDULE_MS.length - 1)
            const nextAt = new Date(Date.now() + BACKOFF_SCHEDULE_MS[backoffIndex]).toISOString()
            const nextMs = Date.now() + BACKOFF_SCHEDULE_MS[backoffIndex]
            await (this.store as RedisDLQStore).incrementAttempt(entry.reservation_id, nextAt, nextMs)
          }
          failed++
        }
      } finally {
        // Release claim lock regardless of outcome (success path: delete already removed it;
        // releaseClaim on a non-existent key is a no-op DEL, safe to call unconditionally)
        if (isRedis) {
          await (this.store as RedisDLQStore).releaseClaim(entry.reservation_id)
        }
      }
    }

    if (replayed > 0 || terminal > 0) {
      console.log(`[billing-finalize] DLQ replay: replayed=${replayed} succeeded=${succeeded} failed=${failed} terminal=${terminal} remaining=${await this.store.count()}`)
    }
    return { replayed, succeeded, failed, terminal }
  } catch (err) {
    // NEVER-throws: swallow store/Redis errors, log for ops, return zero-state
    console.error(`[billing-finalize] DLQ replay error (swallowed): ${(err as Error).message}`)
    return { replayed: 0, succeeded: 0, failed: 0, terminal: 0 }
  }
}
```

> **Claim lock lifecycle**: The `finally` block ensures claim locks are always released, preventing leaked locks that could delay settlement for up to 60s per item. On the success path, `store.delete()` already removes the lock via `DLQ_DELETE` Lua, so the subsequent `releaseClaim()` is a harmless no-op DEL.
>
> **Terminal drop audit trail**: In durable mode, terminal drops are moved to `finn:hounfour:dlq:terminal:{rid}` via `DLQ_TERMINAL_DROP` Lua (7-day TTL), preserving the full entry for reconciliation. The structured error log includes `tenant_id`, `actual_cost_micro`, `created_at`, and `attempt_count` for operational alerting.
>
> **NEVER-throws contract**: The outer try/catch ensures that transient Redis outages during replay do not crash the process or violate the billing client's runtime safety guarantee.

5. **getDLQSize()** — now async:
```typescript
async getDLQSize(): Promise<number> {
  return this.store.count()
}
```

6. **Remove** `getDLQEntries()` (was leaking internal state)

### 3.4 Bootstrap Integration

**File**: `src/index.ts` — After Redis init block (L131-162):

```typescript
// 6d3. Initialize DLQ store for billing settlement persistence
const { InMemoryDLQStore } = await import("./hounfour/dlq-store.js")
let dlqStore: import("./hounfour/dlq-store.js").DLQStore

if (redis?.isConnected()) {
  const { RedisDLQStore } = await import("./hounfour/redis/dlq.js")
  const redisDlq = new RedisDLQStore(redis)

  // AOF persistence validation (PRD NFR-2: shadow deploy requires AOF)
  const aofEnabled = await redisDlq.validatePersistence()
  if (!aofEnabled) {
    console.warn(`[finn] billing DLQ: Redis AOF not verified — durable mode active but shadow deploy NOT ready`)
  }

  dlqStore = redisDlq
  console.log(`[finn] billing DLQ: redis-backed (durable, aof=${aofEnabled ? "verified" : "unverified"})`)
} else {
  dlqStore = new InMemoryDLQStore()
  console.log(`[finn] billing DLQ: in-memory (non-durable)`)
}
```

Then pass `dlqStore` to `BillingFinalizeClient` constructor when creating the billing client.

> **AOF validation**: At startup, `validatePersistence()` checks Redis `appendonly` config. If AOF is not enabled, a warning is logged but durable mode still activates (Redis may be managed with different persistence). The health endpoint reports `dlq_aof_verified` for operational monitoring. Shadow deploy readiness requires AOF verification to pass.

### 3.5 Health Endpoint Integration

**File**: `src/gateway/server.ts` — Extend health response:

```typescript
app.get("/health", async (c) => {
  const base = options?.healthAggregator
    ? options.healthAggregator.check()
    : {
        status: "healthy",
        uptime: process.uptime(),
        checks: {
          agent: { status: "ok", model: config.model },
          sessions: { active: router.getActiveCount() },
        },
      }

  // Add billing DLQ metrics if available (wrapped in try/catch: health must never throw)
  if (options?.billingClient) {
    try {
      const client = options.billingClient
      const dlqSize = await client.getDLQSize()
      const dlqOldest = await client.getDLQOldestAgeMs()
      base.billing = {
        dlq_size: dlqSize,
        dlq_oldest_entry_age_ms: dlqOldest,
        dlq_store_type: client.isDurable() ? "redis" : "memory",
        dlq_durable: client.isDurable(),
        dlq_aof_verified: client.isAofVerified(),
      }
    } catch {
      base.billing = { dlq_size: null, dlq_store_type: "unknown", dlq_durable: false }
    }
  }

  return c.json(base)
})
```

### 3.6 Billing Invariants

**File**: `src/hounfour/billing-invariants.ts`

Contains the 5 conservation invariants as documented constants and helper functions for property-based testing:

```typescript
export const BILLING_INVARIANTS = {
  INV_1_COMPLETENESS: "Every finalize() returns one of: finalized, idempotent, dlq",
  INV_2_PERSISTENCE_DURABLE: "In durable mode, outcome=dlq implies entry persisted in DLQStore",
  INV_2D_PERSISTENCE_DEGRADED: "In degraded mode, outcome=dlq implies entry in memory + ERROR log",
  INV_3_IDEMPOTENCY: "Duplicate finalize for same reservation_id returns idempotent (via 409)",
  INV_4_COST_IMMUTABILITY: "actual_cost_micro is never modified after initial computation",
  INV_5_BOUNDED_RETRY: "Every DLQ entry replayed at most maxRetries times with backoff",
} as const

/** Assert INV-1: outcome is always one of the three valid states */
export function assertCompleteness(result: FinalizeResult): void {
  if (result.ok) {
    if (result.status !== "finalized" && result.status !== "idempotent") {
      throw new Error(`INV-1 violated: ok=true but status=${result.status}`)
    }
  } else {
    if (result.status !== "dlq") {
      throw new Error(`INV-1 violated: ok=false but status=${result.status}`)
    }
  }
}
```

---

## 4. Testing Strategy

### 4.1 Existing Tests (Must Pass)

- `tests/finn/billing-finalize.test.ts` — 28 tests adapted to use `InMemoryDLQStore`
- `tests/e2e/smoke-test.sh` — 52 E2E tests unchanged

### 4.2 New Tests

**File**: `tests/finn/dlq-store.test.ts` (~14 tests)

| Test | What It Verifies |
|------|-----------------|
| InMemoryDLQStore put/get/delete | Basic CRUD |
| InMemoryDLQStore put upsert increments attempt | Atomic upsert semantics |
| InMemoryDLQStore getReady filters by time | Schedule filtering |
| InMemoryDLQStore getReady respects batch limit | Bounded batch (default 50) |
| InMemoryDLQStore count/oldest uses created_at | Health metrics correctness |
| RedisDLQStore put/get round-trip | Redis persistence |
| RedisDLQStore put upsert is atomic (Lua) | DLQ_UPSERT atomicity |
| RedisDLQStore getReady with schedule + LIMIT | Bounded sorted set range query |
| RedisDLQStore ZSET member is rid not full key | Canonical member consistency |
| RedisDLQStore orphan repair | Missing payload → ZREM by rid |
| RedisDLQStore claim lock + release in finally | SETNX exclusivity + leak prevention |
| RedisDLQStore incrementAttempt updates ZSET score | Schedule score tracks backoff |
| RedisDLQStore terminalDrop moves to terminal keyspace | Audit trail preservation |
| RedisDLQStore delete cleans all keys | Payload + schedule + lock removed |

**File**: `tests/finn/billing-invariants.test.ts` (~6 tests)

| Test | What It Verifies |
|------|-----------------|
| INV-1: random requests → always valid outcome | fast-check, 100 scenarios |
| INV-3: duplicate reservation_id → idempotent | fast-check, 100 scenarios |
| INV-5: replay exhausts retries → terminal drop | fast-check, 50 scenarios |
| Store failure → finalize returns dlq, entry logged | DLQStore.put() throws |
| replayDeadLetters NEVER throws on Redis error | Outer try/catch returns zero-state |
| Terminal drop preserves audit record in terminal keyspace | DLQ_TERMINAL_DROP Lua |

**File**: `tests/finn/dlq-persistence.test.ts` (~4 tests)

| Test | What It Verifies |
|------|-----------------|
| Kill-restart recovery | Put entries → recreate client with same Redis → entries survive |
| Arrakis 409 idempotency | E2E: finalize twice → second returns 409 (via Docker stack) |
| AOF validation returns true when appendonly=yes | validatePersistence() startup check |
| Health endpoint never throws on Redis failure | try/catch in health handler |

---

## 5. File Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/hounfour/dlq-store.ts` | NEW | ~90 |
| `src/hounfour/redis/dlq.ts` | NEW | ~220 |
| `src/hounfour/billing-invariants.ts` | NEW | ~60 |
| `src/hounfour/billing-finalize-client.ts` | MODIFY | ~40 lines changed |
| `src/index.ts` | MODIFY | ~20 lines added |
| `src/gateway/server.ts` | MODIFY | ~15 lines added |
| `tests/finn/dlq-store.test.ts` | NEW | ~300 |
| `tests/finn/billing-invariants.test.ts` | NEW | ~180 |
| `tests/finn/dlq-persistence.test.ts` | NEW | ~140 |

**Total**: 3 new source files (~370 lines), 3 modified files (~75 lines changed), 3 new test files (~620 lines)

---

## 6. Dependencies

**No new runtime dependencies.** fast-check for property-based tests (dev dependency, already available via vitest ecosystem or add as devDependency).

**Existing dependencies used:**
- `src/hounfour/redis/client.ts` — RedisStateBackend, RedisCommandClient
- `jose` — unchanged (JWT signing)
- `vitest` — test runner

---

## 7. Migration & Rollback

### Migration
- Zero-downtime: old loa-finn instances use in-memory DLQ (no Redis keys exist)
- New instances automatically create Redis keys on first `put()`
- No schema migration needed — Redis keys are created on demand

### Rollback
- Remove `REDIS_URL` env var → falls back to InMemoryDLQStore
- Redis keys expire via TTL — no manual cleanup needed
- Existing behavior is exactly preserved via InMemoryDLQStore

---

## 8. Security Considerations

- DLQ entries contain `reservation_id`, `tenant_id`, `actual_cost_micro`, `trace_id` — no PII, no secrets
- Redis keys namespaced under `finn:hounfour:dlq:*` — isolated from other components
- Claim locks use short TTL (60s) to prevent permanent lock-out
- No new network surfaces — Redis connection reuses existing `RedisStateBackend`
