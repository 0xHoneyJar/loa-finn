// src/hounfour/audit/buffered-audit-chain.ts — BufferedAuditChain (SDD §3.1, cycle-035 T-1.5)
//
// Wraps cycle-034's DynamoAuditChain with a bounded in-memory buffer.
// Preserves hash-chain continuity + KMS signing through buffer→flush path.
//
// Fail-closed for critical actions (routing_mode_change, settlement):
//   throws when buffer full AND DynamoDB+KMS unavailable.
// Non-critical actions drop with warning when buffer full.
//
// Crash resume (Flatline IMP-002): On startup, DynamoAuditChain.init()
// reads last committed record from DynamoDB to recover prev_hash.
// Gap detection: missing sequence numbers create a verifiable discontinuity.
//
// Single-writer per process (Flatline SKP-003): internal mutex ensures
// sequential ordering when multiple async callers attempt concurrent appends.

import type { DynamoAuditChain } from "./dynamo-audit.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferedEntry {
  action: string
  payload: Record<string, unknown>
  timestamp: string
  sequenceHint: number
}

export interface BufferedAuditChainOptions {
  /** Maximum buffer entries before fail-closed. Default: 100. */
  maxBufferSize?: number
  /** Maximum age in ms before discarding buffered entries. Default: 300000 (5min). */
  maxEntryAgeMs?: number
  /** Flush interval in ms. Default: 5000 (5s). */
  flushIntervalMs?: number
}

/** Actions that require audit-first semantics. Buffer full → throw (fail-closed). */
const CRITICAL_ACTIONS = new Set(["routing_mode_change", "settlement", "admin_action"])

// ---------------------------------------------------------------------------
// BufferedAuditChain
// ---------------------------------------------------------------------------

export class BufferedAuditChain {
  private readonly inner: DynamoAuditChain
  private readonly maxBufferSize: number
  private readonly maxEntryAgeMs: number
  private readonly flushIntervalMs: number
  private buffer: BufferedEntry[] = []
  private flushing = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private sequenceHint = 0
  // Single-writer mutex: ensures sequential ordering for concurrent appenders
  private mutexPromise: Promise<void> = Promise.resolve()

  constructor(inner: DynamoAuditChain, options?: BufferedAuditChainOptions) {
    this.inner = inner
    this.maxBufferSize = options?.maxBufferSize ?? 100
    this.maxEntryAgeMs = options?.maxEntryAgeMs ?? 300_000
    this.flushIntervalMs = options?.flushIntervalMs ?? 5_000
  }

  /**
   * Initialize the chain. Delegates to inner DynamoAuditChain.init()
   * which reads last committed hash from DynamoDB for crash resume.
   */
  async init(partitionIdOverride?: string): Promise<void> {
    await this.inner.init(partitionIdOverride)
    this.startFlushTimer()
  }

  /**
   * Append an entry. Tries direct write first; on failure, buffers.
   * Critical actions throw when buffer full AND DynamoDB unavailable (fail-closed).
   * Non-critical actions drop with warning when buffer full.
   *
   * Returns hash on direct success, null on buffered/dropped.
   */
  async append(action: string, payload: Record<string, unknown>): Promise<string | null> {
    // Acquire mutex for sequential ordering
    const release = await this.acquireMutex()
    try {
      return await this._appendInner(action, payload)
    } finally {
      release()
    }
  }

  private async _appendInner(action: string, payload: Record<string, unknown>): Promise<string | null> {
    // Try direct write first
    try {
      const hash = await this.inner.append(action, payload)
      if (hash !== null) return hash
    } catch {
      // DynamoDB unavailable — fall through to buffer
    }

    // Inner returned null (degraded) or threw — buffer the entry
    const isCritical = CRITICAL_ACTIONS.has(action)

    if (this.buffer.length >= this.maxBufferSize) {
      if (isCritical) {
        throw new Error(
          `BufferedAuditChain: buffer full (${this.maxBufferSize}) and DynamoDB unavailable. ` +
          `Critical action "${action}" cannot proceed (fail-closed).`,
        )
      }
      // Non-critical: drop with warning
      console.warn(JSON.stringify({
        metric: "audit.buffer.dropped",
        action,
        buffer_size: this.buffer.length,
        reason: "buffer_full",
        timestamp: Date.now(),
      }))
      return null
    }

    this.buffer.push({
      action,
      payload,
      timestamp: new Date().toISOString(),
      sequenceHint: ++this.sequenceHint,
    })

    console.log(JSON.stringify({
      metric: "audit.buffer.enqueued",
      action,
      buffer_size: this.buffer.length,
      timestamp: Date.now(),
    }))

    return null
  }

  /**
   * Flush buffered entries to DynamoDB in-order.
   * Discards entries older than maxEntryAgeMs.
   * Called automatically by timer and can be called manually.
   */
  async flush(): Promise<{ flushed: number; expired: number; failed: number }> {
    if (this.flushing || this.buffer.length === 0) {
      return { flushed: 0, expired: 0, failed: 0 }
    }
    this.flushing = true

    const now = Date.now()
    let flushed = 0
    let expired = 0
    let failed = 0
    const remaining: BufferedEntry[] = []

    for (const entry of this.buffer) {
      const entryAge = now - new Date(entry.timestamp).getTime()

      // Discard expired entries
      if (entryAge > this.maxEntryAgeMs) {
        expired++
        console.warn(JSON.stringify({
          metric: "audit.buffer.expired",
          action: entry.action,
          age_ms: entryAge,
          timestamp: now,
        }))
        continue
      }

      // Try to flush via inner chain (preserves hash-chain + KMS signing)
      try {
        const hash = await this.inner.append(entry.action, entry.payload)
        if (hash !== null) {
          flushed++
        } else {
          // Still degraded — keep in buffer
          failed++
          remaining.push(entry)
        }
      } catch {
        // DynamoDB still unavailable — keep in buffer for next cycle
        failed++
        remaining.push(entry)
        // Stop flushing on first failure — preserve ordering
        for (const rest of this.buffer.slice(this.buffer.indexOf(entry) + 1)) {
          remaining.push(rest)
        }
        break
      }
    }

    this.buffer = remaining
    this.flushing = false

    if (flushed > 0 || expired > 0) {
      console.log(JSON.stringify({
        metric: "audit.buffer.flush",
        flushed,
        expired,
        failed,
        remaining: remaining.length,
        timestamp: now,
      }))
    }

    return { flushed, expired, failed }
  }

  /** Start periodic flush timer. */
  private startFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error(JSON.stringify({
          metric: "audit.buffer.flush_error",
          error: (err as Error).message,
          timestamp: Date.now(),
        }))
      })
    }, this.flushIntervalMs)
    this.flushTimer.unref()
  }

  /** Stop flush timer and attempt final flush. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    // Final flush attempt
    await this.flush()
  }

  // --- Mutex ---

  private async acquireMutex(): Promise<() => void> {
    let release: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    const prev = this.mutexPromise
    this.mutexPromise = prev.then(() => next)
    // Wait for previous operation to complete before proceeding
    await prev
    return release!
  }

  // --- Accessors ---

  /** Current buffer size (for health reporting). */
  get bufferSize(): number { return this.buffer.length }

  /** Whether the inner chain is in a ready state. */
  get innerState() { return this.inner.currentState }

  /** Delegate partition ID from inner chain. */
  get partitionId() { return this.inner.currentPartitionId }

  /** Delegate sequence number from inner chain. */
  get sequenceNumber() { return this.inner.currentSequenceNumber }
}
