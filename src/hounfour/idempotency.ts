// src/hounfour/idempotency.ts — Single-process idempotency cache (SDD §4.6.5, T-1.6)

import { createHash } from "node:crypto"

// --- Port Interface ---

/**
 * Idempotency cache port — allows Redis swap in Sprint 2 without Orchestrator changes.
 */
export interface IdempotencyPort {
  get(traceId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult | null>
  set(traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void>
  has(traceId: string, toolName: string, args: Record<string, unknown>): Promise<boolean>
}

export interface ToolResult {
  output: string
  is_error: boolean
}

// --- Canonical JSON ---

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
 *
 * Key = sha256(toolName + ":" + canonicalJSON(args))[0:32]
 *
 * Recursive canonicalization ensures nested objects with different
 * key ordering produce the same hash.
 */
export function stableKey(toolName: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(args))
  return createHash("sha256").update(toolName + ":" + canonical).digest("hex").slice(0, 32)
}

// --- In-Memory Implementation ---

interface CacheEntry {
  result: ToolResult
  expiresAt: number
}

/**
 * In-memory idempotency cache with TTL eviction.
 *
 * Scoped per trace_id to isolate concurrent orchestrator invocations.
 * Entries expire after TTL (default: maxWallTimeMs = 120s).
 *
 * Sprint 1: single-process only.
 * Sprint 2: Redis-backed implementation via IdempotencyPort.
 */
export class IdempotencyCache implements IdempotencyPort {
  // Map<compositeKey, CacheEntry> where compositeKey = traceId:stableKey
  private cache = new Map<string, CacheEntry>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(private ttlMs: number = 120_000) {
    // Periodic cleanup every 30s to prevent unbounded growth
    this.cleanupInterval = setInterval(() => this.evictExpired(), 30_000)
    if (this.cleanupInterval.unref) this.cleanupInterval.unref()
  }

  async get(traceId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    const key = this.compositeKey(traceId, toolName, args)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    return entry.result
  }

  async set(traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    const key = this.compositeKey(traceId, toolName, args)
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  async has(traceId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await this.get(traceId, toolName, args)
    return result !== null
  }

  /** Evict all expired entries */
  private evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }

  /** Cleanup for graceful shutdown */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.cache.clear()
  }

  /** For testing — current cache size */
  get size(): number {
    return this.cache.size
  }

  private compositeKey(traceId: string, toolName: string, args: Record<string, unknown>): string {
    return `${traceId}:${stableKey(toolName, args)}`
  }
}
