// src/billing/wal-writer-lock.ts — Redis SETNX Leader Lock (Sprint 7 Task 7.7)
//
// Enforces WAL single-writer invariant at runtime.
// SETNX with 30s TTL, 10s keepalive refresh.
// Fencing token (Flatline SKP-002): monotonic INCR for WAL append validation.

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_KEY = "wal:writer:lock"
const FENCE_KEY = "wal:writer:fence"
const LOCK_TTL_SECONDS = 30
const KEEPALIVE_INTERVAL_MS = 10_000

// ---------------------------------------------------------------------------
// Fencing Token Monotonicity — Atomic CAS (Bridgebuilder Deep Review §II)
// ---------------------------------------------------------------------------
// Lua script that atomically validates and advances the last accepted fencing
// token. Prevents stale writers after Redis failover (Kleppmann's Redlock gap).
// Tokens bounded to <= 2^53-1 (JS safe integer) — at 1 acq/sec this lasts
// ~285 million years.
//
// Returns: "OK" (advanced), "STALE" (rejected), "CORRUPT" (fail-closed)

const WAL_FENCING_CAS_SCRIPT = `
  local key = KEYS[1]
  local incoming = ARGV[1]
  local stored_str = redis.call('GET', key)

  -- Missing key: treat as 0 (first-ever token)
  if not stored_str then
    redis.call('SET', key, incoming)
    return "OK"
  end

  -- Validate stored value: must be numeric, non-negative, <= 2^53-1
  local stored = tonumber(stored_str)
  if stored == nil or stored < 0 or stored > 9007199254740991 then
    return "CORRUPT"
  end

  local incoming_num = tonumber(incoming)
  if incoming_num > stored then
    redis.call('SET', key, incoming)
    return "OK"
  end

  return "STALE"
`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WALWriterLockDeps {
  redis: RedisCommandClient
  instanceId: string
  environment?: string
  onLockLost?: () => void
}

export interface LockAcquisitionResult {
  acquired: boolean
  fencingToken: number | null
  currentHolder: string | null
}

// ---------------------------------------------------------------------------
// WAL Writer Lock
// ---------------------------------------------------------------------------

export class WALWriterLock {
  private readonly redis: RedisCommandClient
  private readonly instanceId: string
  private readonly environment: string
  private readonly onLockLost: (() => void) | undefined
  private readonly fencingCasKey: string
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _fencingToken: number | null = null
  private _isHolder = false

  constructor(deps: WALWriterLockDeps) {
    this.redis = deps.redis
    this.instanceId = deps.instanceId
    this.environment = deps.environment ?? "production"
    this.onLockLost = deps.onLockLost
    this.fencingCasKey = `wal:writer:last_accepted:${this.environment}`
  }

  get isHolder(): boolean {
    return this._isHolder
  }

  get fencingToken(): number | null {
    return this._fencingToken
  }

  /**
   * Attempt to acquire the WAL writer lock.
   * Returns fencing token on success, null on failure.
   */
  async acquire(): Promise<LockAcquisitionResult> {
    // Try SETNX via eval (atomic SET NX EX)
    const script = `
      local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
      if acquired then
        local token = redis.call('INCR', KEYS[2])
        return {1, token}
      else
        local holder = redis.call('GET', KEYS[1])
        return {0, holder or ''}
      end
    `

    const result = await this.redis.eval(
      script,
      [LOCK_KEY, FENCE_KEY],
      [this.instanceId, String(LOCK_TTL_SECONDS)],
    )

    // Parse result — eval returns differ by Redis client
    if (Array.isArray(result) && result[0] === 1) {
      const newToken = Number(result[1])
      // Token issuance bound: reject if token exceeds safe integer range
      if (!Number.isSafeInteger(newToken)) {
        // System-level alert — not recoverable
        console.error(JSON.stringify({
          metric: "wal.fencing_token.overflow",
          token: String(result[1]),
          severity: "critical",
        }))
        return { acquired: false, fencingToken: null, currentHolder: null }
      }
      this._fencingToken = newToken
      this._isHolder = true
      this.startKeepalive()
      return { acquired: true, fencingToken: this._fencingToken, currentHolder: this.instanceId }
    }

    const currentHolder = Array.isArray(result) ? String(result[1]) : null
    return { acquired: false, fencingToken: null, currentHolder }
  }

  /**
   * Release the lock (graceful shutdown).
   */
  async release(): Promise<void> {
    this.stopKeepalive()

    if (!this._isHolder) return

    // Only delete if we still hold it (CAS via eval)
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `

    await this.redis.eval(script, [LOCK_KEY], [this.instanceId])
    this._isHolder = false
    this._fencingToken = null
  }

  /**
   * Validate that a fencing token is current (not stale).
   * @deprecated Use validateAndAdvanceFencingToken for monotonicity guarantee.
   */
  async validateFencingToken(token: number): Promise<boolean> {
    if (!this._isHolder) return false
    return token === this._fencingToken
  }

  /**
   * Atomically validate and advance the fencing token via Redis CAS.
   * Returns "OK" if token is fresh and was accepted, "STALE" if token is
   * not greater than last accepted, "CORRUPT" if stored state is invalid.
   *
   * Kleppmann's Redlock analysis: after Redis failover, two instances could
   * hold valid-looking tokens. The WAL storage must reject writes with
   * fencing_token <= last_accepted_token.
   */
  async validateAndAdvanceFencingToken(token: number): Promise<"OK" | "STALE" | "CORRUPT"> {
    if (!this._isHolder) return "STALE"

    // CAS input bound: reject non-safe-integer tokens before they reach Redis
    if (!Number.isSafeInteger(token) || token < 0) {
      console.error(JSON.stringify({
        metric: "wal.fencing_token.invalid_input",
        token: String(token),
        severity: "critical",
      }))
      return "CORRUPT"
    }

    try {
      const result = await this.redis.eval(
        WAL_FENCING_CAS_SCRIPT,
        [this.fencingCasKey],
        [String(token)],
      ) as string

      if (result === "STALE") {
        console.warn(JSON.stringify({
          metric: "wal.fencing_token.stale",
          token,
          cas_key: this.fencingCasKey,
        }))
      } else if (result === "CORRUPT") {
        console.error(JSON.stringify({
          metric: "wal.fencing_token.corrupt",
          cas_key: this.fencingCasKey,
          severity: "critical",
        }))
      }

      return result as "OK" | "STALE" | "CORRUPT"
    } catch (err) {
      // Redis failure during CAS — log but don't block WAL append
      // (WAL is authoritative; next successful CAS re-establishes monotonicity)
      console.warn(JSON.stringify({
        metric: "wal.fencing_token.redis_sync_failed",
        token,
        error: err instanceof Error ? err.message : "unknown",
      }))
      return "OK" // Fail-open for Redis connectivity issues only
    }
  }

  // ---------------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------------

  private startKeepalive(): void {
    this.stopKeepalive()

    this.keepaliveTimer = setInterval(async () => {
      try {
        // Refresh TTL only if we still hold the lock
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            redis.call('EXPIRE', KEYS[1], ARGV[2])
            return 1
          end
          return 0
        `

        const result = await this.redis.eval(
          script,
          [LOCK_KEY],
          [this.instanceId, String(LOCK_TTL_SECONDS)],
        )

        if (result === 0 || result === null) {
          // Lost the lock
          this._isHolder = false
          this._fencingToken = null
          this.stopKeepalive()
          this.onLockLost?.()
        }
      } catch {
        // Redis connection issue — lock may expire
        // Continue trying; if TTL expires, another instance can acquire
      }
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }
}
