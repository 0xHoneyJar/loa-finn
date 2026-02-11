// src/hounfour/redis/idempotency.ts — Redis-backed idempotency cache (SDD §4.6.5, T-2.11)
//
// Cross-replica tool-call deduplication via Redis. Falls back to in-memory
// Map when Redis is unavailable. Also provides nonce replay protection.

import { createHash } from "node:crypto"
import type { RedisStateBackend } from "./client.js"
import type { IdempotencyPort, ToolResult } from "../idempotency.js"

// --- Stable Key ---

/**
 * Recursively canonicalize a value for deterministic serialization:
 *   - Objects: sort keys at ALL depths, recurse into values
 *   - Arrays: preserve order, recurse into elements
 *   - Primitives: pass through unchanged
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Compute stable idempotency key from tool name + arguments.
 * Uses SHA-256 hash of canonicalized arguments for deterministic keys
 * regardless of JSON key ordering.
 */
export function stableKey(toolName: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(args))
  return createHash("sha256").update(toolName + ":" + canonical).digest("hex").slice(0, 32)
}

// --- RedisIdempotencyCache ---

/**
 * Redis-backed idempotency cache for tool-call deduplication.
 *
 * Key schema:
 *   finn:hounfour:idempotency:{trace_id}:{stable_key} → JSON(ToolResult)
 *
 * TTL: configurable (default 120s = maxWallTimeMs).
 *
 * Fallback: in-memory Map scoped to current process.
 */
export class RedisIdempotencyCache implements IdempotencyPort {
  private memoryFallback = new Map<string, ToolResult>()

  constructor(
    private redis: RedisStateBackend | null,
    private ttlMs: number = 120_000,
  ) {}

  async get(traceId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    const sk = stableKey(toolName, args)
    const compositeKey = `${traceId}:${sk}`

    // Try Redis first
    if (this.redis?.isConnected()) {
      try {
        const redisKey = this.redis.key("idempotency", compositeKey)
        const value = await this.redis.getClient().get(redisKey)
        if (value !== null) {
          const result = JSON.parse(value) as ToolResult
          // Also cache in memory
          this.memoryFallback.set(compositeKey, result)
          return result
        }
      } catch {
        // Fall through to memory
      }
    }

    // Memory fallback
    return this.memoryFallback.get(compositeKey) ?? null
  }

  async set(traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    const sk = stableKey(toolName, args)
    const compositeKey = `${traceId}:${sk}`

    // Always write to memory
    this.memoryFallback.set(compositeKey, result)

    // Write to Redis if available
    if (this.redis?.isConnected()) {
      try {
        const redisKey = this.redis.key("idempotency", compositeKey)
        const ttlSeconds = Math.ceil(this.ttlMs / 1000)
        await this.redis.getClient().set(redisKey, JSON.stringify(result), "EX", ttlSeconds)
      } catch {
        // Non-fatal — memory fallback is still available
      }
    }
  }

  async has(traceId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await this.get(traceId, toolName, args)
    return result !== null
  }
}

// --- Nonce Replay Protection ---

/**
 * Redis-backed HMAC nonce replay protection (multi-replica safe).
 *
 * Key schema:
 *   finn:hounfour:hmac:nonce:{nonce}:{issued_at_bucket} → "" (SET NX)
 *
 * TTL: 60s (2 × skew tolerance). SET NX ensures uniqueness.
 * If Redis unavailable and required=true → reject (503).
 * If Redis unavailable and required=false → LRU-only mode (degraded).
 */
export class RedisNonceStore {
  private lruFallback = new Set<string>()
  private lruOrder: string[] = []
  private maxLruSize: number

  constructor(
    private redis: RedisStateBackend | null,
    private required: boolean = true,
    maxLruSize: number = 10_000,
  ) {
    this.maxLruSize = maxLruSize
  }

  /**
   * Check if a nonce has been seen. Returns true if the nonce is new (first use).
   * Returns false if it's a replay.
   * Throws if Redis required but unavailable.
   */
  async checkAndStore(nonce: string, issuedAt: string): Promise<boolean> {
    const bucket = issuedAt.slice(0, 16) // Minute-level bucket
    const key = `${nonce}:${bucket}`

    // Try Redis
    if (this.redis?.isConnected()) {
      try {
        const redisKey = this.redis.key("hmac", "nonce", key)
        // SET NX with EX 60 — returns "OK" if set (new nonce), null if exists (replay)
        const result = await this.redis.getClient().set(redisKey, "", "EX", 60, "NX")
        return result === "OK"
      } catch {
        if (this.required) {
          throw new Error("NONCE_UNAVAILABLE: Redis not available for nonce check (required=true)")
        }
        // Fall through to LRU
      }
    } else if (this.required) {
      throw new Error("NONCE_UNAVAILABLE: Redis not connected for nonce check (required=true)")
    }

    // LRU fallback
    if (this.lruFallback.has(key)) return false

    this.lruFallback.add(key)
    this.lruOrder.push(key)

    // Evict oldest if over limit
    while (this.lruOrder.length > this.maxLruSize) {
      const oldest = this.lruOrder.shift()!
      this.lruFallback.delete(oldest)
    }

    return true
  }

  /** Whether we're in degraded LRU-only mode */
  isDegraded(): boolean {
    return !this.redis?.isConnected() && !this.required
  }
}
