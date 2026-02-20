// src/billing/dlq.ts — DLQ Processor for async arrakis finalize (SDD §3.3, Sprint 1 Task 1.3)
//
// Uses Redis Streams (billing:dlq) with consumer group per service instance.
// Exponential backoff retry. Poison message handling.
// Three distinct hold concepts explicitly separated.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { BillingEntryId } from "./types.js"
import { getTracer } from "../tracing/otlp.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DLQ_STREAM = "billing:dlq"
export const DLQ_POISON_STREAM = "billing:dlq:poison"
export const DLQ_CONSUMER_GROUP = "billing_finalize_group"
export const PENDING_COUNT_KEY = "billing:pending_count"

export const RESERVE_TTL_SECONDS = 300 // 5 minutes
export const MAX_DLQ_RETRIES = 5
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000] // 1s, 2s, 4s, 8s, 16s
export const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours
export const MAX_PENDING_RISK_LIMIT_CU = 500 // CreditUnit cap for capped-risk unblocking

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DLQEntry {
  billing_entry_id: string
  account_id: string
  actual_cost_micro: string
  correlation_id: string
  attempt: number
  reason: string
  created_at: string // ISO-8601
  next_retry_at: string // ISO-8601
}

export interface DLQProcessorDeps {
  redis: RedisCommandClient
  consumerId: string // e.g. ECS task ID
  onFinalize: (billingEntryId: string, accountId: string, actualCostMicro: string, correlationId: string) => Promise<boolean>
  onPoisonMessage: (entry: DLQEntry) => Promise<void>
  onEscalation: (entry: DLQEntry) => Promise<void>
  onAlert: (type: string, message: string, details: Record<string, unknown>) => Promise<void>
}

export interface DLQReplayResult {
  processed: number
  succeeded: number
  failed: number
  poisoned: number
}

// ---------------------------------------------------------------------------
// DLQ Processor
// ---------------------------------------------------------------------------

export class DLQProcessor {
  private readonly deps: DLQProcessorDeps
  private processingTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: DLQProcessorDeps) {
    this.deps = deps
  }

  /**
   * Initialize the consumer group. Idempotent — MKSTREAM creates if not exists.
   */
  async initialize(): Promise<void> {
    try {
      await this.deps.redis.eval(
        `redis.call('XGROUP', 'CREATE', KEYS[1], ARGV[1], '0', 'MKSTREAM')
         return 'OK'`,
        1,
        DLQ_STREAM,
        DLQ_CONSUMER_GROUP,
      )
    } catch (err: unknown) {
      // BUSYGROUP means group already exists — that's fine
      if (err instanceof Error && err.message.includes("BUSYGROUP")) {
        return
      }
      throw err
    }
  }

  /**
   * Enqueue a finalize entry to the DLQ stream.
   */
  async enqueue(
    billingEntryId: string,
    accountId: string,
    actualCostMicro: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.finalize", {
      attributes: {
        billing_entry_id: billingEntryId,
        attempt: 0,
        correlation_id: correlationId,
      },
    })

    const now = new Date()
    const entry: DLQEntry = {
      billing_entry_id: billingEntryId,
      account_id: accountId,
      actual_cost_micro: actualCostMicro,
      correlation_id: correlationId,
      attempt: 0,
      reason,
      created_at: now.toISOString(),
      next_retry_at: new Date(now.getTime() + BACKOFF_SCHEDULE_MS[0]).toISOString(),
    }

    await this.deps.redis.eval(
      `redis.call('XADD', KEYS[1], '*',
        'billing_entry_id', ARGV[1],
        'account_id', ARGV[2],
        'actual_cost_micro', ARGV[3],
        'correlation_id', ARGV[4],
        'attempt', ARGV[5],
        'reason', ARGV[6],
        'created_at', ARGV[7],
        'next_retry_at', ARGV[8])
       redis.call('INCRBY', KEYS[2], 1)
       return 'OK'`,
      2,
      DLQ_STREAM,
      PENDING_COUNT_KEY,
      entry.billing_entry_id,
      entry.account_id,
      entry.actual_cost_micro,
      entry.correlation_id,
      String(entry.attempt),
      entry.reason,
      entry.created_at,
      entry.next_retry_at,
    )

    span?.setAttribute("next_retry_at", entry.next_retry_at)
    span?.end()
  }

  /**
   * Process pending DLQ entries. Called by background timer or manual trigger.
   */
  async processEntries(): Promise<DLQReplayResult> {
    const result: DLQReplayResult = { processed: 0, succeeded: 0, failed: 0, poisoned: 0 }

    try {
      // Read pending entries from consumer group
      const entries = await this.readPendingEntries(10)

      for (const { streamId, entry } of entries) {
        result.processed++

        const attempt = parseInt(entry.attempt, 10) || 0

        // Check for poison message (max retries exceeded)
        if (attempt >= MAX_DLQ_RETRIES) {
          await this.handlePoisonMessage(streamId, entry)
          result.poisoned++
          continue
        }

        // Check retry timing
        const nextRetryAt = new Date(entry.next_retry_at).getTime()
        if (Date.now() < nextRetryAt) {
          continue // Not yet ready for retry
        }

        // Attempt finalize
        const success = await this.deps.onFinalize(
          entry.billing_entry_id,
          entry.account_id,
          entry.actual_cost_micro,
          entry.correlation_id,
        )

        if (success) {
          // Acknowledge and remove from stream
          await this.deps.redis.eval(
            `redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
             redis.call('XDEL', KEYS[1], ARGV[2])
             redis.call('DECRBY', KEYS[2], 1)
             return 'OK'`,
            2,
            DLQ_STREAM,
            PENDING_COUNT_KEY,
            DLQ_CONSUMER_GROUP,
            streamId,
          )
          result.succeeded++
        } else {
          // Increment attempt, schedule next retry
          const newAttempt = attempt + 1
          const backoffIndex = Math.min(newAttempt, BACKOFF_SCHEDULE_MS.length - 1)
          const nextRetry = new Date(Date.now() + BACKOFF_SCHEDULE_MS[backoffIndex]).toISOString()

          // Re-enqueue with updated attempt count
          await this.deps.redis.eval(
            `redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
             redis.call('XDEL', KEYS[1], ARGV[2])
             redis.call('XADD', KEYS[1], '*',
               'billing_entry_id', ARGV[3],
               'account_id', ARGV[4],
               'actual_cost_micro', ARGV[5],
               'correlation_id', ARGV[6],
               'attempt', ARGV[7],
               'reason', ARGV[8],
               'created_at', ARGV[9],
               'next_retry_at', ARGV[10])
             return 'OK'`,
            1,
            DLQ_STREAM,
            DLQ_CONSUMER_GROUP,
            streamId,
            entry.billing_entry_id,
            entry.account_id,
            entry.actual_cost_micro,
            entry.correlation_id,
            String(newAttempt),
            entry.reason,
            entry.created_at,
            nextRetry,
          )
          result.failed++
        }
      }
    } catch (err) {
      console.error("[dlq] Error processing entries:", err instanceof Error ? err.message : String(err))
    }

    return result
  }

  /**
   * Handle poison message: move to poison stream, fire alert, write WAL entry.
   */
  private async handlePoisonMessage(streamId: string, entry: DLQEntry): Promise<void> {
    // Move to poison stream
    await this.deps.redis.eval(
      `redis.call('XADD', KEYS[1], '*',
        'billing_entry_id', ARGV[1],
        'account_id', ARGV[2],
        'actual_cost_micro', ARGV[3],
        'correlation_id', ARGV[4],
        'attempt', ARGV[5],
        'reason', ARGV[6],
        'created_at', ARGV[7],
        'poisoned_at', ARGV[8])
       redis.call('XACK', KEYS[2], ARGV[9], ARGV[10])
       redis.call('XDEL', KEYS[2], ARGV[10])
       return 'OK'`,
      2,
      DLQ_POISON_STREAM,
      DLQ_STREAM,
      entry.billing_entry_id,
      entry.account_id,
      entry.actual_cost_micro,
      entry.correlation_id,
      String(entry.attempt),
      entry.reason,
      entry.created_at,
      new Date().toISOString(),
      DLQ_CONSUMER_GROUP,
      streamId,
    )

    await this.deps.onPoisonMessage(entry)
    await this.deps.onAlert("billing_finalize_poison", `DLQ max retries exceeded for ${entry.billing_entry_id}`, {
      billing_entry_id: entry.billing_entry_id,
      account_id: entry.account_id,
      attempts: entry.attempt,
    })
  }

  /**
   * Check escalation: entries in FINALIZE_FAILED for >24h should trigger escalation alert.
   */
  async checkEscalations(): Promise<number> {
    let escalated = 0
    try {
      // Read poison stream for entries older than escalation window
      const entries = await this.readPoisonEntries(50)
      for (const { entry } of entries) {
        const createdAt = new Date(entry.created_at).getTime()
        if (Date.now() - createdAt > ESCALATION_WINDOW_MS) {
          await this.deps.onEscalation(entry)
          escalated++
        }
      }
    } catch (err) {
      console.error("[dlq] Error checking escalations:", err instanceof Error ? err.message : String(err))
    }
    return escalated
  }

  /**
   * Bulk replay: replay all FINALIZE_FAILED entries (admin recovery action).
   * Flatline SKP-003: POST /api/v1/admin/billing/bulk-replay
   */
  async bulkReplay(concurrency: number = 5): Promise<DLQReplayResult> {
    const result: DLQReplayResult = { processed: 0, succeeded: 0, failed: 0, poisoned: 0 }

    try {
      const entries = await this.readPoisonEntries(100)

      // Process in batches of `concurrency`
      for (let i = 0; i < entries.length; i += concurrency) {
        const batch = entries.slice(i, i + concurrency)
        const results = await Promise.allSettled(
          batch.map(async ({ streamId, entry }) => {
            result.processed++
            const success = await this.deps.onFinalize(
              entry.billing_entry_id,
              entry.account_id,
              entry.actual_cost_micro,
              entry.correlation_id,
            )
            if (success) {
              // Remove from poison stream
              await this.deps.redis.eval(
                `redis.call('XDEL', KEYS[1], ARGV[1])
                 redis.call('DECRBY', KEYS[2], 1)
                 return 'OK'`,
                2,
                DLQ_POISON_STREAM,
                PENDING_COUNT_KEY,
                streamId,
              )
              result.succeeded++
            } else {
              result.failed++
            }
          }),
        )
      }
    } catch (err) {
      console.error("[dlq] Error in bulk replay:", err instanceof Error ? err.message : String(err))
    }

    return result
  }

  /**
   * Get pending reconciliation count.
   */
  async getPendingCount(): Promise<number> {
    const count = await this.deps.redis.get(PENDING_COUNT_KEY)
    return count ? parseInt(count, 10) : 0
  }

  /**
   * Check capped risk: whether an account can still create reserves
   * despite having FINALIZE_PENDING/FAILED entries.
   * Flatline SKP-003: MAX_PENDING_RISK_LIMIT
   */
  async checkCappedRisk(accountId: string, pendingCostCU: number): Promise<boolean> {
    return pendingCostCU <= MAX_PENDING_RISK_LIMIT_CU
  }

  /**
   * Start background processing timer.
   */
  startProcessingTimer(intervalMs: number = 5000): void {
    if (this.processingTimer) return
    this.processingTimer = setInterval(() => {
      void this.processEntries()
    }, intervalMs)
    if (this.processingTimer.unref) {
      this.processingTimer.unref()
    }
  }

  /**
   * Stop background processing timer.
   */
  stopProcessingTimer(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer)
      this.processingTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async readPendingEntries(count: number): Promise<Array<{ streamId: string; entry: DLQEntry }>> {
    // XREADGROUP to claim pending entries
    const raw = await this.deps.redis.eval(
      `return redis.call('XREADGROUP', 'GROUP', ARGV[1], ARGV[2], 'COUNT', ARGV[3], 'BLOCK', '5000', 'STREAMS', KEYS[1], '>')`,
      1,
      DLQ_STREAM,
      DLQ_CONSUMER_GROUP,
      this.deps.consumerId,
      String(count),
    ) as [string, Array<[string, string[]]>][] | null

    if (!raw || raw.length === 0) return []

    const results: Array<{ streamId: string; entry: DLQEntry }> = []
    for (const [, messages] of raw) {
      for (const [streamId, fields] of messages) {
        const entry = this.parseStreamFields(fields)
        if (entry) {
          results.push({ streamId, entry })
        }
      }
    }
    return results
  }

  private async readPoisonEntries(count: number): Promise<Array<{ streamId: string; entry: DLQEntry }>> {
    const raw = await this.deps.redis.eval(
      `return redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', ARGV[1])`,
      1,
      DLQ_POISON_STREAM,
      String(count),
    ) as Array<[string, string[]]> | null

    if (!raw) return []

    const results: Array<{ streamId: string; entry: DLQEntry }> = []
    for (const [streamId, fields] of raw) {
      const entry = this.parseStreamFields(fields)
      if (entry) {
        results.push({ streamId, entry })
      }
    }
    return results
  }

  private parseStreamFields(fields: string[]): DLQEntry | null {
    const map = new Map<string, string>()
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1])
    }

    const billingEntryId = map.get("billing_entry_id")
    if (!billingEntryId) return null

    return {
      billing_entry_id: billingEntryId,
      account_id: map.get("account_id") ?? "",
      actual_cost_micro: map.get("actual_cost_micro") ?? "0",
      correlation_id: map.get("correlation_id") ?? "",
      attempt: parseInt(map.get("attempt") ?? "0", 10),
      reason: map.get("reason") ?? "unknown",
      created_at: map.get("created_at") ?? new Date().toISOString(),
      next_retry_at: map.get("next_retry_at") ?? new Date().toISOString(),
    }
  }
}
