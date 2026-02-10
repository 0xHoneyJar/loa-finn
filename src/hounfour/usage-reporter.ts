// src/hounfour/usage-reporter.ts — Usage Report Pipeline (SDD §3.5, T-A.7)
// Posts cost data to arrakis after each inference with durable delivery.
// Failed reports go to Redis ZSET dead-letter queue with background replay.

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { S2SJwtSigner } from "./s2s-jwt.js"
import type { RedisStateBackend } from "./redis/client.js"

// --- Types ---

export interface UsageReport {
  report_id: string
  tenant_id: string
  original_jti?: string
  pool_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_micro: number
  timestamp: string
  ensemble_id?: string
  metadata?: Record<string, unknown>
}

export interface UsageReporterConfig {
  arrakisBaseUrl: string
  /** Max retries before dead-letter (default: 3) */
  maxRetries?: number
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number
  /** Dead-letter JSONL file path fallback (default: data/dead-letter-usage-reports.jsonl) */
  deadLetterFilePath?: string
  /** Replay interval in ms (default: 300000 = 5min) */
  replayIntervalMs?: number
  /** Max items to replay per cycle (default: 10) */
  replayBatchSize?: number
}

const DEAD_LETTER_KEY = "usage-reports:dead-letter"
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_DEAD_LETTER_PATH = "data/dead-letter-usage-reports.jsonl"
const DEFAULT_REPLAY_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_REPLAY_BATCH_SIZE = 10

// --- UsageReporter ---

export class UsageReporter {
  private signer: S2SJwtSigner
  private redis: RedisStateBackend | null
  private config: Required<UsageReporterConfig>
  private replayTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    signer: S2SJwtSigner,
    redis: RedisStateBackend | null,
    config: UsageReporterConfig,
  ) {
    this.signer = signer
    this.redis = redis
    this.config = {
      arrakisBaseUrl: config.arrakisBaseUrl,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      deadLetterFilePath: config.deadLetterFilePath ?? DEFAULT_DEAD_LETTER_PATH,
      replayIntervalMs: config.replayIntervalMs ?? DEFAULT_REPLAY_INTERVAL_MS,
      replayBatchSize: config.replayBatchSize ?? DEFAULT_REPLAY_BATCH_SIZE,
    }
  }

  /**
   * Report usage to arrakis with retry and dead-letter fallback.
   * Non-blocking — errors are caught and dead-lettered, not thrown.
   */
  async report(usage: UsageReport): Promise<{ delivered: boolean; deadLettered: boolean }> {
    try {
      await this.postWithRetry(usage)
      return { delivered: true, deadLettered: false }
    } catch {
      // All retries exhausted — dead-letter
      const deadLettered = await this.deadLetter(usage)
      return { delivered: false, deadLettered }
    }
  }

  /**
   * POST usage report to arrakis with exponential backoff retry.
   * Throws if all retries fail.
   */
  private async postWithRetry(usage: UsageReport): Promise<void> {
    const url = `${this.config.arrakisBaseUrl}/internal/usage-reports`

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.baseDelayMs * Math.pow(2, attempt - 1)
        await sleep(delay)
      }

      try {
        // Sign JWT for auth header
        const authToken = await this.signer.signJWT({
          purpose: "usage-report",
          report_id: usage.report_id,
        })

        // Sign payload as JWS
        const jwsPayload = await this.signer.signPayload(usage as unknown as Record<string, unknown>)

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            report_id: usage.report_id,
            jws_payload: jwsPayload,
          }),
        })

        // 2xx = success (including 200 for duplicate report_id)
        if (res.ok) return

        // 4xx (except 429) = permanent failure, don't retry
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`Arrakis rejected usage report: ${res.status}`)
        }

        // 5xx or 429 = transient, retry
      } catch (err) {
        if (attempt === this.config.maxRetries) throw err
        // Network errors are retried
      }
    }

    throw new Error("All retries exhausted")
  }

  /**
   * Dead-letter a failed report.
   * Primary: Redis ZSET scored by timestamp.
   * Fallback: Local JSONL file.
   */
  private async deadLetter(usage: UsageReport): Promise<boolean> {
    const serialized = JSON.stringify(usage)
    const score = Date.now()

    // Try Redis first
    if (this.redis?.isConnected()) {
      try {
        const key = this.redis.key(DEAD_LETTER_KEY)
        await this.redis.getClient().zadd(key, score, serialized)
        return true
      } catch {
        // Redis write failed — fall through to file
      }
    }

    // Fallback to local JSONL file
    try {
      await mkdir(dirname(this.config.deadLetterFilePath), { recursive: true })
      await appendFile(
        this.config.deadLetterFilePath,
        serialized + "\n",
        "utf-8",
      )
      return true
    } catch (fileErr) {
      console.error("[usage-reporter] Dead-letter write failed:", fileErr)
      return false
    }
  }

  /** Start background replay job */
  startReplay(): void {
    if (this.replayTimer) return

    this.replayTimer = setInterval(async () => {
      try {
        await this.replayBatch()
      } catch (err) {
        console.error("[usage-reporter] Replay error:", err)
      }
    }, this.config.replayIntervalMs)

    if (this.replayTimer.unref) this.replayTimer.unref()
  }

  /** Stop background replay job */
  stopReplay(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer)
      this.replayTimer = null
    }
  }

  /**
   * Replay a batch of dead-lettered reports.
   * Uses ZPOPMIN to atomically dequeue items.
   */
  async replayBatch(): Promise<{ replayed: number; failed: number }> {
    if (!this.redis?.isConnected()) {
      return { replayed: 0, failed: 0 }
    }

    const key = this.redis.key(DEAD_LETTER_KEY)
    // ZPOPMIN returns [member, score, member, score, ...]
    const items = await this.redis.getClient().zpopmin(key, this.config.replayBatchSize)

    let replayed = 0
    let failed = 0

    // items: [member1, score1, member2, score2, ...]
    for (let i = 0; i < items.length; i += 2) {
      const serialized = items[i]
      if (!serialized) continue

      try {
        const usage = JSON.parse(serialized) as UsageReport
        await this.postWithRetry(usage)
        replayed++
      } catch {
        // Re-dead-letter on failure
        try {
          await this.redis.getClient().zadd(key, Date.now(), serialized)
        } catch {
          // Double failure — log and drop
          console.error("[usage-reporter] Re-dead-letter failed for:", serialized.slice(0, 100))
        }
        failed++
      }
    }

    return { replayed, failed }
  }

  /** Get dead-letter queue size (for health checks) */
  async deadLetterSize(): Promise<number> {
    if (!this.redis?.isConnected()) return -1
    const key = this.redis.key(DEAD_LETTER_KEY)
    return this.redis.getClient().zcard(key)
  }

  /** Cleanup */
  destroy(): void {
    this.stopReplay()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
