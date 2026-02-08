// src/agent/worker-pool.ts — Worker thread pool with priority lanes (SDD §3.1, Cycle 005)

import { Worker } from "node:worker_threads"
import { randomUUID } from "node:crypto"

// ── Error Codes ─────────────────────────────────────────────

/**
 * Typed error codes for pool operations.
 * Retry semantics:
 * - WORKER_UNAVAILABLE: Retry with exponential backoff (100ms initial, 5s max)
 * - POOL_SHUTTING_DOWN: Do not retry — server is terminating
 * - SANDBOX_DISABLED:   Do not retry — sandbox mode set to disabled
 * - EXEC_TIMEOUT:       Retry once (may succeed if transient), then report error
 * - WORKER_CRASHED:     Auto-recovered by pool — retry immediately (replacement spawned)
 */
export enum PoolErrorCode {
  WORKER_UNAVAILABLE = "WORKER_UNAVAILABLE",
  POOL_SHUTTING_DOWN = "POOL_SHUTTING_DOWN",
  SANDBOX_DISABLED = "SANDBOX_DISABLED",
  EXEC_TIMEOUT = "EXEC_TIMEOUT",
  WORKER_CRASHED = "WORKER_CRASHED",
}

export class PoolError extends Error {
  readonly code: PoolErrorCode
  constructor(code: PoolErrorCode, message: string) {
    super(message)
    this.name = "PoolError"
    this.code = code
  }
}

// ── Types ───────────────────────────────────────────────────

export interface ExecSpec {
  /** Absolute resolved path to binary (via realpath) */
  binaryPath: string
  /** Validated args array (no shell metacharacters) */
  args: string[]
  /** Realpath-resolved cwd within jail */
  cwd: string
  /** Timeout in ms (default 30_000) */
  timeoutMs: number
  /** Sanitized env — only PATH, HOME, LANG, and allowlisted vars */
  env: Record<string, string>
  /** Max stdout+stderr bytes (default 1_048_576 = 1MB) */
  maxBuffer: number
  /** Session ID for fairness scheduling (SD-016) */
  sessionId?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** true if output was truncated at maxBuffer */
  truncated: boolean
  /** wall-clock execution time in ms */
  durationMs: number
}

export type PoolLane = "interactive" | "system"

export interface WorkerPoolConfig {
  /** Number of interactive-lane workers (default: 2) */
  interactiveWorkers: number
  /** Path to sandbox-worker.ts/js (resolved at construction) */
  workerScript: string
  /** Shutdown hard deadline in ms (default: 10_000) */
  shutdownDeadlineMs: number
  /** Max queued jobs per lane (default: 10) */
  maxQueueDepth: number
}

export interface WorkerPoolStats {
  interactive: { active: number; idle: number; queued: number }
  system: { active: boolean; queued: number }
  totals: { completed: number; failed: number; timedOut: number; avgExecMs: number }
}

// ── Internal Types ──────────────────────────────────────────

interface PendingJob {
  jobId: string
  spec: ExecSpec
  jailRoot: string
  resolve: (result: ExecResult) => void
  reject: (error: Error) => void
}

interface ManagedWorker {
  worker: Worker
  state: "idle" | "busy"
  currentJobId: string | null
  pendingJob: PendingJob | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
  abortTimer: ReturnType<typeof setTimeout> | null
}

// ── WorkerPool ──────────────────────────────────────────────

export class WorkerPool {
  private readonly config: WorkerPoolConfig
  private readonly interactiveWorkers: ManagedWorker[] = []
  private readonly systemWorker: ManagedWorker
  private readonly interactiveQueue: PendingJob[] = []
  private readonly systemQueue: PendingJob[] = []
  private accepting = true

  // Stats
  private completedCount = 0
  private failedCount = 0
  private timedOutCount = 0
  private totalExecMs = 0

  constructor(config: WorkerPoolConfig) {
    this.config = config

    // Spawn interactive workers
    for (let i = 0; i < config.interactiveWorkers; i++) {
      this.interactiveWorkers.push(this.spawnWorker())
    }

    // Spawn system worker (reserved for system lane)
    this.systemWorker = this.spawnWorker()
  }

  /**
   * Execute a command via the worker pool.
   * @param spec - The execution specification
   * @param lane - Priority lane (default: "interactive")
   * @param jailRoot - Jail root path for worker-side cwd validation
   */
  async exec(spec: ExecSpec, lane: PoolLane = "interactive", jailRoot = ""): Promise<ExecResult> {
    if (!this.accepting) {
      throw new PoolError(PoolErrorCode.POOL_SHUTTING_DOWN, "Pool is shutting down")
    }

    const jobId = randomUUID()

    return new Promise<ExecResult>((resolve, reject) => {
      const job: PendingJob = { jobId, spec, jailRoot, resolve, reject }

      if (lane === "system") {
        if (this.systemWorker.state === "idle") {
          this.dispatch(this.systemWorker, job)
        } else {
          if (this.systemQueue.length >= this.config.maxQueueDepth) {
            reject(new PoolError(PoolErrorCode.WORKER_UNAVAILABLE, "System queue full"))
            return
          }
          this.systemQueue.push(job)
        }
      } else {
        // Find idle interactive worker
        const idle = this.interactiveWorkers.find((w) => w.state === "idle")
        if (idle) {
          this.dispatch(idle, job)
        } else {
          if (this.interactiveQueue.length >= this.config.maxQueueDepth) {
            reject(new PoolError(PoolErrorCode.WORKER_UNAVAILABLE, "Interactive queue full"))
            return
          }
          // Per-session fairness at >50% capacity (SD-016):
          // Round-robin by sessionId when queue > 50% full
          if (
            spec.sessionId &&
            this.interactiveQueue.length > this.config.maxQueueDepth * 0.5
          ) {
            // Insert after last job from a different session for round-robin
            const lastSameSessionIdx = this.interactiveQueue.findLastIndex(
              (j) => j.spec.sessionId === spec.sessionId,
            )
            if (lastSameSessionIdx >= 0 && lastSameSessionIdx < this.interactiveQueue.length - 1) {
              // Insert after the next different-session job
              this.interactiveQueue.splice(lastSameSessionIdx + 1, 0, job)
            } else {
              this.interactiveQueue.push(job)
            }
          } else {
            this.interactiveQueue.push(job)
          }
        }
      }
    })
  }

  /** Graceful shutdown per SDD §5.2 */
  async shutdown(): Promise<void> {
    this.accepting = false

    // Reject all queued jobs
    for (const job of this.interactiveQueue.splice(0)) {
      job.reject(new PoolError(PoolErrorCode.POOL_SHUTTING_DOWN, "Pool shutting down"))
    }
    for (const job of this.systemQueue.splice(0)) {
      job.reject(new PoolError(PoolErrorCode.POOL_SHUTTING_DOWN, "Pool shutting down"))
    }

    // Abort running jobs
    const allWorkers = [...this.interactiveWorkers, this.systemWorker]
    for (const mw of allWorkers) {
      if (mw.state === "busy" && mw.currentJobId) {
        try {
          mw.worker.postMessage({ type: "abort", jobId: mw.currentJobId })
        } catch { /* worker may already be dead */ }
      }
    }

    // Wait for workers to finish or deadline
    const hitDeadline = await Promise.race([
      Promise.all(allWorkers.map((mw) => this.waitForIdle(mw))).then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), this.config.shutdownDeadlineMs)),
    ])

    // If deadline hit, reject any still-running jobs to avoid promise leaks
    if (hitDeadline) {
      for (const mw of allWorkers) {
        if (mw.pendingJob) {
          const job = mw.pendingJob
          this.clearTimers(mw)
          this.markIdle(mw)
          job.reject(new PoolError(PoolErrorCode.POOL_SHUTTING_DOWN, "Pool shutdown deadline exceeded"))
        }
      }
    }

    // Terminate all workers
    for (const mw of allWorkers) {
      this.clearTimers(mw)
      try { await mw.worker.terminate() } catch { /* ok */ }
    }
  }

  /** Get pool stats for health endpoint */
  stats(): WorkerPoolStats {
    return {
      interactive: {
        active: this.interactiveWorkers.filter((w) => w.state === "busy").length,
        idle: this.interactiveWorkers.filter((w) => w.state === "idle").length,
        queued: this.interactiveQueue.length,
      },
      system: {
        active: this.systemWorker.state === "busy",
        queued: this.systemQueue.length,
      },
      totals: {
        completed: this.completedCount,
        failed: this.failedCount,
        timedOut: this.timedOutCount,
        avgExecMs: this.completedCount > 0
          ? Math.round(this.totalExecMs / this.completedCount)
          : 0,
      },
    }
  }

  // ── Private Methods ─────────────────────────────────────────

  private createBareWorker(): Worker {
    return new Worker(this.config.workerScript, {
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
  }

  private spawnWorker(): ManagedWorker {
    const worker = this.createBareWorker()

    const mw: ManagedWorker = {
      worker,
      state: "idle",
      currentJobId: null,
      pendingJob: null,
      timeoutTimer: null,
      abortTimer: null,
    }

    this.wireHandlers(mw)

    return mw
  }

  private wireHandlers(mw: ManagedWorker): void {
    mw.worker.on("message", (msg) => this.handleWorkerMessage(mw, msg))
    mw.worker.on("error", (err) => this.handleWorkerError(mw, err))
    mw.worker.on("exit", (code) => this.handleWorkerExit(mw, code))
  }

  private dispatch(mw: ManagedWorker, job: PendingJob): void {
    mw.state = "busy"
    mw.currentJobId = job.jobId
    mw.pendingJob = job

    // Main-thread authoritative timeout
    mw.timeoutTimer = setTimeout(() => {
      this.handleTimeout(mw)
    }, job.spec.timeoutMs)

    mw.worker.postMessage({
      type: "exec",
      jobId: job.jobId,
      spec: job.spec,
      jailRoot: job.jailRoot,
    })
  }

  private handleWorkerMessage(mw: ManagedWorker, msg: any): void {
    // Validate jobId correlation (SD-008, SD-014)
    if (!msg || !msg.jobId || msg.jobId !== mw.currentJobId) {
      return // Silently discard stale/mismatched messages
    }

    if (msg.type === "result" && mw.pendingJob) {
      const job = mw.pendingJob
      this.clearTimers(mw)
      this.markIdle(mw)
      this.completedCount++
      this.totalExecMs += msg.result.durationMs ?? 0
      job.resolve(msg.result as ExecResult)
      this.drainQueue(mw)
    } else if (msg.type === "aborted" && mw.pendingJob) {
      const job = mw.pendingJob
      this.clearTimers(mw)
      this.markIdle(mw)
      this.timedOutCount++
      job.reject(new PoolError(PoolErrorCode.EXEC_TIMEOUT, `Command timed out after ${job.spec.timeoutMs}ms`))
      this.drainQueue(mw)
    }
  }

  private handleTimeout(mw: ManagedWorker): void {
    if (mw.state !== "busy" || !mw.currentJobId) return

    // Send abort to worker
    mw.worker.postMessage({ type: "abort", jobId: mw.currentJobId })

    // Set a hard deadline — if worker doesn't respond to abort in 10s, terminate
    mw.abortTimer = setTimeout(() => {
      if (mw.state === "busy" && mw.pendingJob) {
        const job = mw.pendingJob
        this.clearTimers(mw)
        this.timedOutCount++
        this.markIdle(mw)
        job.reject(new PoolError(PoolErrorCode.EXEC_TIMEOUT, "Worker wedged — terminated and replaced"))
        this.replaceWorker(mw)
      }
    }, 10_000)
  }

  private handleWorkerError(mw: ManagedWorker, _err: Error): void {
    // Worker errored but may still be alive — wait for exit event
  }

  private handleWorkerExit(mw: ManagedWorker, _code: number): void {
    if (mw.pendingJob) {
      const job = mw.pendingJob
      this.clearTimers(mw)
      this.failedCount++
      this.markIdle(mw)
      job.reject(new PoolError(PoolErrorCode.WORKER_CRASHED, "Worker thread crashed"))
    } else {
      this.clearTimers(mw)
      this.markIdle(mw)
    }

    if (this.accepting) {
      this.replaceWorker(mw)
    }
  }

  private replaceWorker(mw: ManagedWorker): void {
    // Terminate old worker (may already be dead)
    try { mw.worker.terminate() } catch { /* ok */ }

    // Create bare Worker (no transient ManagedWorker — avoids duplicate handler leak)
    mw.worker = this.createBareWorker()
    mw.state = "idle"
    mw.currentJobId = null
    mw.pendingJob = null
    mw.timeoutTimer = null
    mw.abortTimer = null

    // Wire handlers targeting the in-place mw
    this.wireHandlers(mw)

    // Drain queue with the now-idle replacement
    this.drainQueue(mw)
  }

  private drainQueue(mw: ManagedWorker): void {
    if (mw.state !== "idle") return

    // Determine which queue this worker serves
    const isSystem = mw === this.systemWorker
    const queue = isSystem ? this.systemQueue : this.interactiveQueue

    const next = queue.shift()
    if (next) {
      this.dispatch(mw, next)
    }
  }

  private markIdle(mw: ManagedWorker): void {
    mw.state = "idle"
    mw.currentJobId = null
    mw.pendingJob = null
  }

  private clearTimers(mw: ManagedWorker): void {
    if (mw.timeoutTimer) {
      clearTimeout(mw.timeoutTimer)
      mw.timeoutTimer = null
    }
    if (mw.abortTimer) {
      clearTimeout(mw.abortTimer)
      mw.abortTimer = null
    }
  }

  private waitForIdle(mw: ManagedWorker): Promise<void> {
    if (mw.state === "idle") return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (mw.state === "idle") {
          clearInterval(check)
          clearTimeout(safety)
          resolve()
        }
      }, 100)
      // Safety: prevent interval leak if state never flips
      const safety = setTimeout(() => {
        clearInterval(check)
        resolve()
      }, this.config.shutdownDeadlineMs + 1_000)
    })
  }
}
