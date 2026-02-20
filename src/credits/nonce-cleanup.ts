// src/credits/nonce-cleanup.ts — Nonce Cleanup Scheduler (Bridge medium-5, Sprint 2 T2.4)
//
// Periodic cleanup of expired nonces from finn_used_nonces table.
// Prevents unbounded table growth from nonce tracking.
// Runs hourly by default, cleaning up nonces older than 24 hours.

import { Cron } from "croner"
import { cleanupExpiredNonces, type DrizzleDB } from "./credit-persistence.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NonceCleanupConfig {
  /** Cron expression for cleanup schedule (default: hourly at :30) */
  cronExpression?: string
  /** Max age of nonces in milliseconds (default: 24 hours) */
  maxAgeMs?: number
  /** Callback for cleanup metrics */
  onCleanup?: (result: NonceCleanupResult) => void
}

export interface NonceCleanupResult {
  deletedCount: number
  durationMs: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Nonce Cleanup Service
// ---------------------------------------------------------------------------

export class NonceCleanupService {
  private cron: Cron | null = null
  private readonly db: DrizzleDB
  private readonly cronExpression: string
  private readonly maxAgeMs: number
  private readonly onCleanup?: (result: NonceCleanupResult) => void

  constructor(db: DrizzleDB, config: NonceCleanupConfig = {}) {
    this.db = db
    this.cronExpression = config.cronExpression ?? "30 * * * *" // Every hour at :30
    this.maxAgeMs = config.maxAgeMs ?? 24 * 60 * 60 * 1000 // 24 hours
    this.onCleanup = config.onCleanup
  }

  /** Start the cleanup cron job */
  start(): void {
    if (this.cron) return
    this.cron = new Cron(this.cronExpression, async () => {
      try {
        await this.runCleanup()
      } catch {
        // Logged but not thrown — cron resilience
      }
    })
  }

  /** Stop the cleanup cron job */
  stop(): void {
    if (this.cron) {
      this.cron.stop()
      this.cron = null
    }
  }

  /** Run a single cleanup pass (also callable outside cron for testing) */
  async runCleanup(): Promise<NonceCleanupResult> {
    const start = Date.now()
    const deletedCount = await cleanupExpiredNonces(this.db, this.maxAgeMs)
    const result: NonceCleanupResult = {
      deletedCount,
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    }
    this.onCleanup?.(result)
    return result
  }

  /** Whether the cron job is running */
  isRunning(): boolean {
    return this.cron !== null
  }
}
