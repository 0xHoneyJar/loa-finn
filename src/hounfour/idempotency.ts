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

// --- LRU Doubly-Linked List Node ---

interface LRUNode<V> {
  key: string
  value: V
  prev: LRUNode<V> | null
  next: LRUNode<V> | null
}

// --- In-Memory Implementation with LRU Eviction (T-A.9) ---

interface CacheEntry {
  result: ToolResult
  expiresAt: number
}

/**
 * In-memory idempotency cache with LRU eviction and TTL expiry.
 *
 * Scoped per trace_id to isolate concurrent orchestrator invocations.
 * Entries expire after TTL (default: maxWallTimeMs = 120s).
 * LRU eviction kicks in when maxEntries is reached (default: 10,000).
 *
 * Implementation: doubly-linked list + Map for O(1) get/set/evict.
 */
export class IdempotencyCache implements IdempotencyPort {
  private map = new Map<string, LRUNode<CacheEntry>>()
  private head: LRUNode<CacheEntry> | null = null  // most recently used
  private tail: LRUNode<CacheEntry> | null = null   // least recently used
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private ttlMs: number = 120_000,
    private maxEntries: number = 10_000,
  ) {
    // Periodic cleanup every 30s to evict expired entries
    this.cleanupInterval = setInterval(() => this.evictExpired(), 30_000)
    if (this.cleanupInterval.unref) this.cleanupInterval.unref()
  }

  async get(traceId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    const key = this.compositeKey(traceId, toolName, args)
    const node = this.map.get(key)
    if (!node) return null
    if (Date.now() > node.value.expiresAt) {
      this.removeNode(node)
      this.map.delete(key)
      return null
    }
    // Move to head (most recently used)
    this.moveToHead(node)
    return node.value.result
  }

  async set(traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    const key = this.compositeKey(traceId, toolName, args)
    const existing = this.map.get(key)

    if (existing) {
      // Update existing entry and move to head
      existing.value = { result, expiresAt: Date.now() + this.ttlMs }
      this.moveToHead(existing)
      return
    }

    // Evict LRU entry if at capacity
    if (this.map.size >= this.maxEntries && this.tail) {
      const evicted = this.tail
      this.removeNode(evicted)
      this.map.delete(evicted.key)
    }

    // Create new node at head
    const node: LRUNode<CacheEntry> = {
      key,
      value: { result, expiresAt: Date.now() + this.ttlMs },
      prev: null,
      next: null,
    }
    this.addToHead(node)
    this.map.set(key, node)
  }

  async has(traceId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await this.get(traceId, toolName, args)
    return result !== null
  }

  /** Evict all expired entries */
  private evictExpired(): void {
    const now = Date.now()
    // Walk from tail (oldest) for efficient expired eviction
    let current = this.tail
    while (current) {
      const prev = current.prev
      if (now > current.value.expiresAt) {
        this.removeNode(current)
        this.map.delete(current.key)
      }
      current = prev
    }
  }

  /** Cleanup for graceful shutdown */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.map.clear()
    this.head = null
    this.tail = null
  }

  /** For testing — current cache size */
  get size(): number {
    return this.map.size
  }

  private compositeKey(traceId: string, toolName: string, args: Record<string, unknown>): string {
    return `${traceId}:${stableKey(toolName, args)}`
  }

  // --- Linked List Operations ---

  private addToHead(node: LRUNode<CacheEntry>): void {
    node.prev = null
    node.next = this.head
    if (this.head) this.head.prev = node
    this.head = node
    if (!this.tail) this.tail = node
  }

  private removeNode(node: LRUNode<CacheEntry>): void {
    if (node.prev) node.prev.next = node.next
    else this.head = node.next

    if (node.next) node.next.prev = node.prev
    else this.tail = node.prev

    node.prev = null
    node.next = null
  }

  private moveToHead(node: LRUNode<CacheEntry>): void {
    if (node === this.head) return
    this.removeNode(node)
    this.addToHead(node)
  }
}
