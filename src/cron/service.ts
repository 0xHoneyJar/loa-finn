// src/cron/service.ts — CronService: job lifecycle, timer, stuck detection (SDD §5.2)

import { EventEmitter } from "node:events"
import { ulid } from "ulid"
import { CircuitBreaker } from "./circuit-breaker.js"
import { computeNextRunAtMs } from "./schedule.js"
import type { JobRegistry } from "./job-registry.js"
import type { CronJob, CronRunRecord } from "./types.js"

// ── Types ───────────────────────────────────────────────────

/** Duck-typed alert service for dependency injection. */
export interface AlertServiceLike {
  fire(
    severity: string,
    triggerType: string,
    context: { jobId?: string; message: string; details?: Record<string, unknown> },
  ): Promise<boolean>
}

/** Job executor callback — CronService delegates actual work to this. */
export type JobExecutor = (job: CronJob, runUlid: string) => Promise<void>

/** CronService configuration. */
export interface CronServiceConfig {
  tickIntervalMs?: number          // Default: 15_000 (15 seconds)
  stuckJobTimeoutMs?: number       // Default: 7_200_000 (2 hours)
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_TICK_MS = 15_000
const DEFAULT_STUCK_TIMEOUT_MS = 2 * 60 * 60 * 1_000  // 2 hours

// ── CronService ─────────────────────────────────────────────

/**
 * Orchestrates cron job lifecycle: scheduling, timer management,
 * execution gating (circuit breaker + kill switch), stuck detection,
 * and one-shot auto-disable.
 *
 * Emits events for dashboard subscriptions:
 *   job:armed, job:started, job:completed, job:stuck, job:disabled
 */
export class CronService extends EventEmitter {
  private readonly registry: JobRegistry
  private readonly alertService?: AlertServiceLike
  private readonly now: () => number
  private readonly config: Required<CronServiceConfig>
  private readonly breakers = new Map<string, CircuitBreaker>()
  private executor?: JobExecutor

  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly runningJobs = new Set<string>()

  constructor(
    registry: JobRegistry,
    opts?: {
      alertService?: AlertServiceLike
      now?: () => number
      config?: CronServiceConfig
    },
  ) {
    super()
    this.registry = registry
    this.alertService = opts?.alertService
    this.now = opts?.now ?? Date.now
    this.config = {
      tickIntervalMs: opts?.config?.tickIntervalMs ?? DEFAULT_TICK_MS,
      stuckJobTimeoutMs: opts?.config?.stuckJobTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS,
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /** Set the executor callback invoked when a job fires. */
  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  /** Start the service: load registry, arm enabled jobs, begin tick loop. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.registry.init()

    // Restore circuit breakers and arm all enabled jobs
    for (const job of this.registry.getJobs()) {
      this.restoreBreaker(job)
      if (job.enabled && job.status !== "running") {
        await this.armTimer(job.id)
      }
    }

    this.scheduleTick()
  }

  /** Stop the service: cancel timer, wait for running jobs, persist state. */
  async stop(): Promise<void> {
    this.running = false

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    // Wait for all running jobs to drain (up to 30s)
    const deadline = this.now() + 30_000
    while (this.runningJobs.size > 0 && this.now() < deadline) {
      await sleep(100)
    }

    // Persist circuit breaker states back to registry
    for (const [jobId, breaker] of this.breakers) {
      await this.registry.updateJob(jobId, { circuitBreaker: breaker.state })
    }
  }

  /** Create a new job, add to registry, arm its timer. */
  async createJob(partial: Omit<CronJob, "createdAt" | "updatedAt" | "circuitBreaker"> & { circuitBreaker?: CronJob["circuitBreaker"] }): Promise<CronJob> {
    const now = this.now()
    const job: CronJob = {
      ...partial,
      circuitBreaker: partial.circuitBreaker ?? { state: "closed", failures: 0, successes: 0 },
      createdAt: now,
      updatedAt: now,
    }

    await this.registry.addJob(job)
    this.restoreBreaker(job)

    if (job.enabled) {
      await this.armTimer(job.id)
    }

    return job
  }

  /** Update job fields in the registry. Re-arms timer if schedule changed. */
  async updateJob(id: string, updates: Partial<CronJob>): Promise<boolean> {
    const ok = await this.registry.updateJob(id, updates)
    if (!ok) return false

    const job = this.registry.getJob(id)
    if (job && job.enabled) {
      await this.armTimer(id)
    }

    return true
  }

  /** Delete a job from the registry and clean up its breaker. */
  async deleteJob(id: string): Promise<boolean> {
    const ok = await this.registry.deleteJob(id)
    if (ok) {
      this.breakers.delete(id)
    }
    return ok
  }

  /** Trigger a job immediately, bypassing schedule. */
  async triggerJob(id: string): Promise<boolean> {
    const job = this.registry.getJob(id)
    if (!job) return false
    await this.executeJob(job)
    return true
  }

  /** Get the circuit breaker for a job (or undefined). */
  getBreaker(jobId: string): CircuitBreaker | undefined {
    return this.breakers.get(jobId)
  }

  // ── Timer system ────────────────────────────────────────────

  /** Compute next run time for a job and persist it. */
  async armTimer(jobId: string): Promise<void> {
    const job = this.registry.getJob(jobId)
    if (!job) return

    const nextMs = computeNextRunAtMs(job.schedule, this.now())
    if (nextMs === null) return

    await this.registry.updateJob(jobId, {
      nextRunAtMs: nextMs,
      status: "armed",
    })

    this.emit("job:armed", { jobId, nextRunAtMs: nextMs })
  }

  /** Schedule the next tick using setTimeout + unref(). */
  private scheduleTick(): void {
    if (!this.running) return

    this.timer = setTimeout(() => {
      void this.tick()
    }, this.config.tickIntervalMs)

    // unref() so the timer won't keep the process alive
    this.timer.unref()
  }

  /** Single tick: detect stuck jobs, then run due jobs, then reschedule. */
  private async tick(): Promise<void> {
    if (!this.running) return

    try {
      await this.detectStuckJobs()
      await this.runDueJobs()
    } catch (err) {
      // Tick errors should not crash the service
      console.error("[CronService] tick error:", err)
    }

    this.scheduleTick()
  }

  // ── Job execution ───────────────────────────────────────────

  /** Scan for due jobs and execute them. */
  async runDueJobs(): Promise<void> {
    if (this.registry.isKillSwitchActive()) return

    const now = this.now()
    const pending: Promise<void>[] = []

    for (const job of this.registry.getJobs()) {
      if (!job.enabled) continue
      if (job.status === "running") continue
      if (!job.nextRunAtMs || job.nextRunAtMs > now) continue

      pending.push(this.executeJob(job))
    }

    // Await all executions so callers (including tests) can observe results
    await Promise.allSettled(pending)
  }

  /** Execute a single job with full gating (kill switch, circuit breaker, CAS). */
  private async executeJob(job: CronJob): Promise<void> {
    // Kill switch check
    if (this.registry.isKillSwitchActive()) return

    // Circuit breaker check
    const breaker = this.breakers.get(job.id)
    if (breaker && !breaker.canExecute()) return

    // Concurrency: skip if already running
    if (job.concurrencyPolicy === "skip" && job.currentRunUlid) return

    // Generate run ULID and claim via CAS
    const runUlid = ulid(this.now())
    const claimed = await this.registry.tryClaimRun(job.id, runUlid)
    if (!claimed) return

    const startMs = this.now()
    this.runningJobs.add(job.id)

    // Update lastRunAtMs for stuck detection
    await this.registry.updateJob(job.id, { lastRunAtMs: startMs })

    this.emit("job:started", { jobId: job.id, runUlid })

    // Build initial run record
    const record: CronRunRecord = {
      jobId: job.id,
      runUlid,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      itemsProcessed: 0,
      toolCalls: 0,
    }

    let success = false
    let error: string | undefined

    try {
      if (this.executor) {
        await this.executor(job, runUlid)
      }
      success = true
      breaker?.recordSuccess()
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err)
      breaker?.recordFailure("transient")
    }

    const endMs = this.now()
    const durationMs = endMs - startMs

    // Update run record
    record.completedAt = new Date(endMs).toISOString()
    record.status = success ? "success" : "failure"
    record.durationMs = durationMs
    if (error) record.error = error

    // Release CAS
    await this.registry.releaseRun(job.id, runUlid)
    this.runningJobs.delete(job.id)

    // Update job stats
    const jobUpdates: Partial<CronJob> = {
      lastStatus: success ? "success" : "failure",
      lastDurationMs: durationMs,
      lastError: error,
      circuitBreaker: breaker?.state ?? job.circuitBreaker,
    }

    // One-shot: disable after successful execution
    if (success && job.oneShot) {
      jobUpdates.enabled = false
      jobUpdates.status = "disabled"
      await this.registry.updateJob(job.id, jobUpdates)
      this.emit("job:disabled", { jobId: job.id, reason: "one-shot completed" })
    } else {
      await this.registry.updateJob(job.id, jobUpdates)
      // Re-arm for next run
      if (job.enabled && !job.oneShot) {
        await this.armTimer(job.id)
      }
    }

    // Persist run record
    await this.registry.appendRunRecord(record)

    this.emit("job:completed", {
      jobId: job.id,
      runUlid,
      success,
      durationMs,
      error,
    })
  }

  // ── Stuck job detection ─────────────────────────────────────

  /** Detect jobs that have been running longer than the stuck timeout. */
  async detectStuckJobs(): Promise<void> {
    const now = this.now()
    const maxAge = this.config.stuckJobTimeoutMs

    for (const job of this.registry.getJobs()) {
      if (job.status !== "running") continue
      if (!job.currentRunUlid) continue
      if (!job.lastRunAtMs) continue

      if (now - job.lastRunAtMs > maxAge) {
        // Mark stuck
        await this.registry.updateJob(job.id, {
          status: "stuck",
          lastStatus: "timeout",
        })

        // Release the CAS token
        await this.registry.releaseRun(job.id, job.currentRunUlid)
        this.runningJobs.delete(job.id)

        this.emit("job:stuck", { jobId: job.id, runUlid: job.currentRunUlid })

        // Alert
        if (this.alertService) {
          await this.alertService.fire("error", "stuck_job", {
            jobId: job.id,
            message: `Job ${job.name} (${job.id}) stuck for ${Math.round((now - job.lastRunAtMs) / 60_000)}m`,
            details: { lastRunAtMs: job.lastRunAtMs, currentRunUlid: job.currentRunUlid },
          })
        }
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  /** Restore or create a CircuitBreaker instance for a job. */
  private restoreBreaker(job: CronJob): void {
    const breaker = new CircuitBreaker(undefined, this.now)
    if (job.circuitBreaker) {
      breaker.restoreState(job.circuitBreaker)
    }
    this.breakers.set(job.id, breaker)
  }
}

// ── Utility ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
