// src/scheduler/scheduler.ts — Configurable periodic task execution (SDD §3.4.1, T-4.1)

import { CircuitBreaker, type CircuitBreakerState } from "../persistence/upstream.js"

export interface ScheduledTaskDef {
  id: string
  name: string
  intervalMs: number
  jitterMs: number
  handler: () => Promise<void>
  circuitBreakerConfig?: { maxFailures?: number; resetTimeMs?: number }
}

interface RunningTask {
  def: ScheduledTaskDef
  timer: ReturnType<typeof setTimeout> | undefined
  circuitBreaker: CircuitBreaker
  lastRun: number | undefined
  lastError: string | undefined
  running: boolean
}

export interface TaskStatus {
  id: string
  name: string
  state: "running" | "waiting" | "error"
  lastRun: number | undefined
  lastError: string | undefined
  circuitBreakerState: CircuitBreakerState
  circuitBreakerFailures: number
}

export class Scheduler {
  private tasks = new Map<string, RunningTask>()
  private started = false
  private onCircuitChange?: (taskId: string, from: string, to: string) => void

  /** Register a callback for circuit breaker state changes. */
  onCircuitTransition(cb: (taskId: string, from: string, to: string) => void): void {
    this.onCircuitChange = cb
  }

  register(def: ScheduledTaskDef): void {
    const taskId = def.id
    const cb = new CircuitBreaker(
      {
        maxFailures: def.circuitBreakerConfig?.maxFailures ?? 3,
        resetTimeMs: def.circuitBreakerConfig?.resetTimeMs ?? 300_000,
        halfOpenRetries: 1,
      },
      {
        onStateChange: this.onCircuitChange
          ? (from, to) => this.onCircuitChange!(taskId, from, to)
          : undefined,
      },
    )

    this.tasks.set(def.id, {
      def,
      timer: undefined,
      circuitBreaker: cb,
      lastRun: undefined,
      lastError: undefined,
      running: false,
    })
  }

  start(): void {
    if (this.started) return
    this.started = true

    for (const task of this.tasks.values()) {
      this.scheduleNext(task)
    }
  }

  stop(): void {
    this.started = false
    for (const task of this.tasks.values()) {
      if (task.timer) {
        clearTimeout(task.timer)
        task.timer = undefined
      }
    }
  }

  getStatus(): TaskStatus[] {
    return Array.from(this.tasks.values()).map((t) => {
      const cbState = t.circuitBreaker.getState()
      let state: "running" | "waiting" | "error" = "waiting"
      if (t.running) state = "running"
      else if (t.lastError && cbState === "OPEN") state = "error"

      return {
        id: t.def.id,
        name: t.def.name,
        state,
        lastRun: t.lastRun,
        lastError: t.lastError,
        circuitBreakerState: cbState,
        circuitBreakerFailures: t.circuitBreaker.getFailureCount(),
      }
    })
  }

  /** Get a specific task's circuit breaker (for testing). */
  getCircuitBreaker(taskId: string): CircuitBreaker | undefined {
    return this.tasks.get(taskId)?.circuitBreaker
  }

  private scheduleNext(task: RunningTask): void {
    if (!this.started) return

    const jitter = task.def.jitterMs * (2 * Math.random() - 1) // ±jitter
    const delay = Math.max(1000, task.def.intervalMs + jitter)

    task.timer = setTimeout(async () => {
      await this.runTask(task)
      this.scheduleNext(task)
    }, delay)

    // Allow Node to exit cleanly if only timers remain
    task.timer.unref()
  }

  private async runTask(task: RunningTask): Promise<void> {
    task.running = true
    try {
      await task.circuitBreaker.execute(task.def.handler)
      task.lastRun = Date.now()
      task.lastError = undefined
    } catch (err) {
      task.lastRun = Date.now()
      task.lastError = err instanceof Error ? err.message : String(err)
      console.error(`[scheduler] task ${task.def.id} failed:`, task.lastError)
    } finally {
      task.running = false
    }
  }
}
