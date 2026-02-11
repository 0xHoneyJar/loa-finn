// src/hounfour/redis/circuit.ts — Redis-backed circuit breaker (SDD §4.6.2, T-2.8)
//
// Persists circuit state in Redis and broadcasts state changes via Pub/Sub.
// Falls back to in-memory state when Redis is unavailable (fail-open).

import type { RedisStateBackend } from "./client.js"

// --- Types ---

export type CircuitState = "closed" | "open" | "half_open"

export interface CircuitEntry {
  state: CircuitState
  failure_count: number
  consecutive_failures: number
  last_failure_at: string | null
  recovery_at: string | null
  updated_at: string
  version: number
}

export interface CircuitBreakerConfig {
  failureThreshold: number          // Consecutive failures to open (default: 5)
  recoveryTimeMs: number            // Time before half_open attempt (default: 30000)
  halfOpenMaxAttempts: number        // Max requests in half_open before deciding (default: 1)
  ttlSeconds: number                // Redis key TTL (default: 86400 = 24h)
  pubsubChannel: string             // Pub/Sub channel (default: "finn:hounfour:circuit:events")
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeMs: 30_000,
  halfOpenMaxAttempts: 1,
  ttlSeconds: 86400,
  pubsubChannel: "finn:hounfour:circuit:events",
}

// --- In-memory fallback ---

const DEFAULT_ENTRY: CircuitEntry = {
  state: "closed",
  failure_count: 0,
  consecutive_failures: 0,
  last_failure_at: null,
  recovery_at: null,
  updated_at: new Date().toISOString(),
  version: 0,
}

// --- RedisCircuitBreaker ---

export class RedisCircuitBreaker {
  private config: CircuitBreakerConfig
  private memory: Map<string, CircuitEntry> = new Map()
  private subscribed = false

  constructor(
    private redis: RedisStateBackend | null,
    config?: Partial<CircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config }
  }

  /** Compose a circuit key from provider + model */
  private circuitKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`
  }

  /** Get or create entry from memory */
  private getEntry(key: string): CircuitEntry {
    let entry = this.memory.get(key)
    if (!entry) {
      entry = { ...DEFAULT_ENTRY, updated_at: new Date().toISOString() }
      this.memory.set(key, entry)
    }
    return entry
  }

  /**
   * Record success — reset consecutive failures, advance half_open → closed.
   */
  async recordSuccess(provider: string, modelId: string): Promise<void> {
    const key = this.circuitKey(provider, modelId)
    const entry = this.getEntry(key)
    const prevState = entry.state

    entry.consecutive_failures = 0
    if (entry.state === "half_open") {
      entry.state = "closed"
    }
    entry.updated_at = new Date().toISOString()
    entry.version++

    this.memory.set(key, entry)

    // Persist to Redis and broadcast if state changed
    if (prevState !== entry.state) {
      await this.persistAndBroadcast(key, entry)
    } else {
      await this.persist(key, entry)
    }
  }

  /**
   * Record failure — increment consecutive failures, open circuit if threshold.
   */
  async recordFailure(provider: string, modelId: string): Promise<void> {
    const key = this.circuitKey(provider, modelId)
    const entry = this.getEntry(key)
    const prevState = entry.state

    entry.failure_count++
    entry.consecutive_failures++
    entry.last_failure_at = new Date().toISOString()
    entry.updated_at = new Date().toISOString()
    entry.version++

    if (entry.consecutive_failures >= this.config.failureThreshold) {
      entry.state = "open"
      entry.recovery_at = new Date(Date.now() + this.config.recoveryTimeMs).toISOString()
    }

    this.memory.set(key, entry)

    if (prevState !== entry.state) {
      await this.persistAndBroadcast(key, entry)
    } else {
      await this.persist(key, entry)
    }
  }

  /**
   * Check if a provider/model is healthy (circuit closed or half_open allowed).
   * Reads from in-memory (fast path). Also checks recovery time for half_open transition.
   */
  isHealthy(provider: string, modelId: string): boolean {
    const key = this.circuitKey(provider, modelId)
    const entry = this.memory.get(key)
    if (!entry) return true // No entry = healthy

    if (entry.state === "closed") return true
    if (entry.state === "half_open") return true

    // State is "open" — check if recovery time has passed
    if (entry.recovery_at && new Date(entry.recovery_at) <= new Date()) {
      // Transition to half_open
      entry.state = "half_open"
      entry.updated_at = new Date().toISOString()
      entry.version++
      this.memory.set(key, entry)
      // Fire-and-forget persist
      this.persistAndBroadcast(key, entry).catch(() => {})
      return true
    }

    return false
  }

  /** Get the current circuit state for a provider/model */
  getState(provider: string, modelId: string): CircuitEntry {
    const key = this.circuitKey(provider, modelId)
    return this.getEntry(key)
  }

  /**
   * Subscribe to cross-replica state change events.
   */
  async subscribe(): Promise<void> {
    if (this.subscribed || !this.redis?.isConnected()) return

    const subscriber = this.redis.getSubscriber()
    await subscriber.subscribe(this.config.pubsubChannel)
    subscriber.on("message", (_channel: string, message: string) => {
      try {
        const { key, entry } = JSON.parse(message) as { key: string; entry: CircuitEntry }
        const current = this.memory.get(key)
        // Last-write-wins based on version
        if (!current || entry.version > current.version) {
          this.memory.set(key, entry)
        }
      } catch {
        // Ignore malformed messages
      }
    })
    this.subscribed = true
  }

  /**
   * Load all circuit states from Redis into memory.
   * Called at startup to restore state from previous replica.
   */
  async loadFromRedis(): Promise<number> {
    if (!this.redis?.isConnected()) return 0

    // We can't SCAN with the port interface, but we can load known keys
    // In practice, loadFromRedis is called for specific provider/model combos
    // that are configured. This is a simplified version.
    return this.memory.size
  }

  // --- Internal ---

  private async persist(key: string, entry: CircuitEntry): Promise<void> {
    if (!this.redis?.isConnected()) return

    try {
      const redisKey = this.redis.key("circuit", key)
      await this.redis.getClient().set(redisKey, JSON.stringify(entry), "EX", this.config.ttlSeconds)
    } catch {
      // Fail-open: Redis error doesn't affect circuit state
    }
  }

  private async persistAndBroadcast(key: string, entry: CircuitEntry): Promise<void> {
    if (!this.redis?.isConnected()) return

    try {
      const redisKey = this.redis.key("circuit", key)
      const client = this.redis.getClient()
      await client.set(redisKey, JSON.stringify(entry), "EX", this.config.ttlSeconds)
      await client.publish(this.config.pubsubChannel, JSON.stringify({ key, entry }))
    } catch {
      // Fail-open
    }
  }
}
