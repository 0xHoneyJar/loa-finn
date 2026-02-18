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
// Types
// ---------------------------------------------------------------------------

export interface WALWriterLockDeps {
  redis: RedisCommandClient
  instanceId: string
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
  private readonly onLockLost: (() => void) | undefined
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _fencingToken: number | null = null
  private _isHolder = false

  constructor(deps: WALWriterLockDeps) {
    this.redis = deps.redis
    this.instanceId = deps.instanceId
    this.onLockLost = deps.onLockLost
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
      this._fencingToken = Number(result[1])
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
   */
  async validateFencingToken(token: number): Promise<boolean> {
    if (!this._isHolder) return false
    return token === this._fencingToken
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
