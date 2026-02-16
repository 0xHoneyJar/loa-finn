// src/hounfour/redis/dlq.ts — RedisDLQStore adapter + Lua scripts (SDD §3.2, Sprint 1 T2)
//
// Durable DLQ persistence backed by Redis. Uses Lua scripts for atomicity.
// Canonical ZSET member = {rid} (reservation ID), never the full key path.

import type { RedisStateBackend } from "./client.js"
import type { DLQStore } from "../dlq-store.js"
import type { DLQEntry } from "../billing-finalize-client.js"

// --- Lua Scripts ---

// Atomic put-or-increment (payload + schedule)
const DLQ_UPSERT_LUA = `
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
`

// Atomic removal (payload + schedule + lock)
const DLQ_DELETE_LUA = `
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[3])
return 1
`

// Atomic attempt count + schedule score update
const DLQ_INCREMENT_ATTEMPT_LUA = `
local json = redis.call("GET", KEYS[1])
if not json then return nil end
local entry = cjson.decode(json)
entry.attempt_count = entry.attempt_count + 1
entry.next_attempt_at = ARGV[1]
local updated = cjson.encode(entry)
redis.call("SET", KEYS[1], updated, "EX", ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
return entry.attempt_count
`

// Move to terminal keyspace with audit trail
const DLQ_TERMINAL_DROP_LUA = `
local json = redis.call("GET", KEYS[1])
if json then
  redis.call("SET", KEYS[4], json, "EX", ARGV[2])
end
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[3])
return json and 1 or 0
`

// Bounded ZRANGEBYSCORE
const DLQ_GET_READY_LUA = `return redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])`

// Orphan repair: remove schedule entry for missing payload
const DLQ_ORPHAN_REPAIR_LUA = `redis.call("ZREM", KEYS[1], ARGV[1])`

// Scan all members, find min created_at from payloads (DLQ bounded by batchLimit)
const DLQ_OLDEST_CREATED_LUA = `
local rids = redis.call("ZRANGE", KEYS[1], 0, -1)
local oldest = nil
for _, rid in ipairs(rids) do
  local json = redis.call("GET", KEYS[2] .. rid)
  if json then
    local entry = cjson.decode(json)
    if entry.created_at then
      if oldest == nil or entry.created_at < oldest then
        oldest = entry.created_at
      end
    end
  end
end
return oldest
`

// --- Constants ---

const TERMINAL_TTL_SECONDS = 604_800 // 7 days
const CLAIM_TTL_SECONDS = 60

// --- Persistence validation result ---

export interface PersistenceCheckResult {
  aofVerified: boolean
  checked: boolean
  reason?: string
}

// --- RedisDLQStore ---

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
    const rids = await client.eval(
      DLQ_GET_READY_LUA,
      1, this.scheduleKey, cutoffMs, this.batchLimit
    ) as string[]

    const entries: DLQEntry[] = []
    for (const rid of rids) {
      const json = await client.get(this.entryKey(rid))
      if (json) {
        entries.push(JSON.parse(json) as DLQEntry)
      } else {
        // Orphan repair: schedule member exists but payload is missing (TTL expired)
        await client.eval(DLQ_ORPHAN_REPAIR_LUA, 1, this.scheduleKey, rid)
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
    // Scans all DLQ payloads to find min created_at (DLQ bounded by batchLimit, typically <50)
    const entryPrefix = this.redis.key("dlq", "entry", "")
    const oldestCreatedAt = await client.eval(
      DLQ_OLDEST_CREATED_LUA, 2, this.scheduleKey, entryPrefix
    ) as string | null
    if (!oldestCreatedAt) return null
    return Date.now() - new Date(oldestCreatedAt).getTime()
  }

  /** Acquire claim lock for replay. Returns true if lock acquired. */
  async claimForReplay(reservationId: string): Promise<boolean> {
    const client = this.redis.getClient()
    const result = await client.set(this.lockKey(reservationId), "1", "NX", "EX", CLAIM_TTL_SECONDS)
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

  /**
   * Validate Redis persistence config at startup. Never throws.
   * Returns { aofVerified, checked, reason? } to distinguish AOF-off from CONFIG-restricted.
   */
  async validatePersistence(): Promise<PersistenceCheckResult> {
    try {
      const client = this.redis.getClient()
      const info = await client.eval(
        `return redis.call("CONFIG", "GET", "appendonly")`,
        0
      ) as string[]
      if (info && info.length >= 2) {
        return {
          aofVerified: info[1] === "yes",
          checked: true,
        }
      }
      return { aofVerified: false, checked: true, reason: "unexpected CONFIG response" }
    } catch (err) {
      // CONFIG may be disabled in managed Redis — never throw
      return {
        aofVerified: false,
        checked: false,
        reason: `CONFIG restricted: ${(err as Error).message}`,
      }
    }
  }
}
